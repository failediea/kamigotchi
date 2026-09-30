#!/usr/bin/env bash
# worker-alerts v2 - Kami Lease Market (Yominet v16) health alerts -> ntfy.
#
# Extends the live /root/kamigotchi/tools/alerts/worker-alerts.sh (baseline
# copy in ./baseline/). Everything the baseline checked is still checked, with
# the same 60-min per-condition cooldown and the same state dir.
#
# Checks (each fires one ntfy push per condition key per COOLDOWN_SECS):
#   units      v15/v16 workers, caddy, kami-worker-alerts.timer not active
#   errors     >= ERR_THRESHOLD error-ish journal lines since the last run (baseline)
#   lease-alert any "[LEASE-ALERT] <CODE>" line from a worker or ops timer (one alert per code)
#   stuck-text  legacy wedge messages that match no error keyword (VPS-2)
#   heartbeat  heartbeat.json older than HEARTBEAT_STALE_SEC (falls back to the
#              state-file mtime while the running worker predates heartbeats)
#   tick       heartbeat lastTickOk=false on TICK_FAIL_RUNS consecutive runs
#   job-error  a non-returned job keeps job.error set on JOB_ERROR_RUNS runs
#   chain      keeper balance < KEEPER_MIN_WEI; VIPP feeFloatClaimsLeft() <
#              FEE_FLOAT_MIN_CLAIMS; backingShortfall() > 0 on both v16 markets;
#              per-job stage age (PREPARING too long, expired-but-not-ending,
#              ending past the 2-day grace) and operator gas below the exit reserve
#              (stages 3-5, and stage 0 while the listing is not re-leased: the
#              custody return is operator-signed with allowPull=false)
#   quote-store the patched worker's quote key store (<state>.reservations.json +
#              .journal: operator keys of quotes in flight): snapshot + journal bytes
#              > QUOTE_STORE_MAX_MB or heartbeat liveReservations > QUOTE_STORE_MAX_LIVE
#              (QUOTE_STORE_SIZE), free space on its filesystem < QUOTE_STORE_MIN_FREE_MB
#              (QUOTE_STORE_DISK: a full disk makes every quote 503), a key file (store,
#              journal, state file) not mode 600 (QUOTE_STORE_MODE), and the worker's
#              "operator key store write failed" (KEY_STORE_UNAVAILABLE) / "quote key
#              store compaction|delete failed" (QUOTE_STORE_COMPACT) journal lines
#   ingress    lease-musu / lease-vipp answer something other than 404
#   tls        certificate expires in < TLS_MIN_DAYS days
#   host       disk use > DISK_MAX_PCT, MemAvailable < MEM_MIN_MB
#   self       previous successful run older than SELF_GAP_SEC (timer or script broke)
#
# Modes:
#   --dry-run (default)  run every check, print what WOULD be sent; sends
#                        nothing and writes no state (safe to pipe over ssh)
#   --apply              send notifications, update cooldown / cursor state
#   --self-test          fire exactly one test notification (needs --apply to send)
#   --notify-failure U   OnFailure= hook: push "unit U failed" (needs --apply)
#
# Config: LAUNCH_OPS_ENV (default /etc/kami-lease-ops/launch-ops.env) is
# sourced if present. NTFY_TOPIC must come from there or the environment; it
# is never printed. See ../launch-ops.env.example for every knob.
#
# Rollback: see README.md "Rollback: alerts v2" (reinstall the baseline unit,
# which still points at tools/alerts/worker-alerts.sh, untouched by v2).
{ # the whole script is one block: bash parses it fully before running, so piping it into `bash -s` is safe
set -euo pipefail

MODE="dry-run"
SELF_TEST=0
FAILED_UNIT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --self-test) SELF_TEST=1 ;;
    --notify-failure) FAILED_UNIT="${2:?--notify-failure needs a unit name}"; shift ;;
    -h|--help) sed -n '2,48p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

LAUNCH_OPS_ENV="${LAUNCH_OPS_ENV:-/etc/kami-lease-ops/launch-ops.env}"
if [ -r "$LAUNCH_OPS_ENV" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$LAUNCH_OPS_ENV"
  set +a
fi

# ---- knobs (defaults match the shared launch contract) ----------------------
RPC="${YOMINET_RPC_PUBLIC:-https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz}"
RPC_TIMEOUT_SEC="${RPC_TIMEOUT_SEC:-15}"
KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
LEGACY_UNITS="${LEGACY_UNITS-kami-renter-pod-v15-musu kami-renter-pod-v15-vipp}" # empty = none
V16_MARKETS="${V16_MARKETS:-musu vipp}"
INFRA_UNITS="${INFRA_UNITS-caddy}"
SELF_TIMER="${SELF_TIMER:-kami-worker-alerts.timer}"
OPS_UNITS="${OPS_UNITS-kami-lease-expiry-keeper.service kami-lease-gas-sponsor.service}"
WINDOW="${WINDOW:-10 minutes ago}"
ERR_THRESHOLD="${ERR_THRESHOLD:-20}"
ERR_PATTERN="${ERR_PATTERN:-error|insufficient|fail|missing revert|reverted}"
STUCK_PATTERN="${STUCK_PATTERN:-lease ending paused|walk expected room|pod stopped in room|no longer farmable|operator key missing|operator key mismatch|operator gas health failed|second active RoomPod event|DEAD}"
COOLDOWN_SECS="${COOLDOWN_SECS:-3600}"
STATE="${ALERT_STATE_DIR:-/run/kami-worker-alerts}"
PERSIST_DIR="${ALERT_PERSIST_DIR:-/var/lib/kami-lease-ops}"
HEARTBEAT_STALE_SEC="${HEARTBEAT_STALE_SEC:-180}"
HEARTBEAT_MISSING_MODE="${HEARTBEAT_MISSING_MODE:-state-mtime}" # state-mtime | alert
TICK_FAIL_RUNS="${TICK_FAIL_RUNS:-2}"
JOB_ERROR_RUNS="${JOB_ERROR_RUNS:-2}"
KEEPER_ADDR="${KEEPER_ADDR:-0x0d0294C57B01ED7189b8A9ba354cf77b935abcDc}"
KEEPER_MIN_WEI="${KEEPER_MIN_WEI:-400000000000000}"
MUSU_MARKET="${MUSU_MARKET:-0x1FeF5Ce51f9d3BACD0C3f707eEeBbD7A44d69319}"
VIPP_MARKET="${VIPP_MARKET:-0x4A34d4847D8E2958E4017353e71fAB7afb85bD23}"
FEE_FLOAT_MIN_CLAIMS="${FEE_FLOAT_MIN_CLAIMS:-20}"
PREPARING_MAX_SEC="${PREPARING_MAX_SEC:-21600}"
EXPIRED_UNENDED_MAX_SEC="${EXPIRED_UNENDED_MAX_SEC:-3600}"
EXIT_RESERVE_ACTIONS="${EXIT_RESERVE_ACTIONS:-3}"
OPERATOR_ACTION_GAS_FLOOR="${OPERATOR_ACTION_GAS_FLOOR:-1700000}"
OPERATOR_TX_PRICING="${OPERATOR_TX_PRICING:-eip1559}" # must match the worker .env (default eip1559)
LEASE_HOSTS="${LEASE_HOSTS-lease-musu.kamistats.com lease-vipp.kamistats.com}" # empty = skip ingress/TLS
INGRESS_EXPECT_CODE="${INGRESS_EXPECT_CODE:-404}"
TLS_MIN_DAYS="${TLS_MIN_DAYS:-14}"
DISK_MAX_PCT="${DISK_MAX_PCT:-85}"
MEM_MIN_MB="${MEM_MIN_MB:-100}"
SELF_GAP_SEC="${SELF_GAP_SEC:-1800}"
# quote key store bounds (OPERATOR-KEY-CUSTODY.md section 7: a 50-IP x 1 h burst peaks at
# ~9,200 live keys and ~12 MB; the worker bound is < 13,000 keys, snapshot ~5.5 MB)
QUOTE_STORE_MAX_MB="${QUOTE_STORE_MAX_MB:-32}"
QUOTE_STORE_MAX_LIVE="${QUOTE_STORE_MAX_LIVE:-15000}"
QUOTE_STORE_MIN_FREE_MB="${QUOTE_STORE_MIN_FREE_MB:-256}"
NTFY_SERVER="${NTFY_SERVER:-https://ntfy.sh}"

for knob in RPC_TIMEOUT_SEC ERR_THRESHOLD COOLDOWN_SECS HEARTBEAT_STALE_SEC TICK_FAIL_RUNS JOB_ERROR_RUNS \
    KEEPER_MIN_WEI FEE_FLOAT_MIN_CLAIMS PREPARING_MAX_SEC EXPIRED_UNENDED_MAX_SEC EXIT_RESERVE_ACTIONS \
    OPERATOR_ACTION_GAS_FLOOR TLS_MIN_DAYS DISK_MAX_PCT MEM_MIN_MB SELF_GAP_SEC \
    QUOTE_STORE_MAX_MB QUOTE_STORE_MAX_LIVE QUOTE_STORE_MIN_FREE_MB; do
  [[ "${!knob}" =~ ^[0-9]+$ ]] || { echo "worker-alerts-v2: $knob must be a non-negative integer without quotes (got '${!knob}')" >&2; exit 2; }
done
case "$OPERATOR_TX_PRICING" in eip1559|legacy) ;; *) echo "worker-alerts-v2: OPERATOR_TX_PRICING must be eip1559 or legacy" >&2; exit 2 ;; esac

market_dir() { printf '%s/vault-kit-v16-%s' "$KAMI_ROOT" "$1"; }
market_addr() { if [ "$1" = musu ]; then printf '%s' "$MUSU_MARKET"; else printf '%s' "$VIPP_MARKET"; fi; }

# ---- helpers ----------------------------------------------------------------
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
NOW=$(date +%s)
FIRED=0
CHECK_ERRORS=0

if [ "$MODE" = apply ]; then
  mkdir -p "$STATE" "$PERSIST_DIR"
  chmod 700 "$STATE" "$PERSIST_DIR" 2>/dev/null || true
fi

# Small state files are written atomically (tmp + mv) and read defensively: an
# empty or corrupt file (e.g. a kill at TimeoutStartSec mid-write) reads as 0
# instead of aborting the whole run under set -e.
num_file() { # file -> digits only, 0 when missing/empty/garbage
  local v
  v=$(cat "$1" 2>/dev/null || true)
  v=${v//[^0-9]/}
  printf '%s' "${v:-0}"
}
write_atomic() { # file value
  printf '%s\n' "$2" > "$1.tmp.$$" && mv -f "$1.tmp.$$" "$1"
}

# Persistent per-condition counters (e.g. "seen on N consecutive runs").
# In dry-run the counters are read but never written.
counter_get() { num_file "$PERSIST_DIR/count-$1"; }
counter_set() { [ "$MODE" = apply ] && write_atomic "$PERSIST_DIR/count-$1" "$2"; return 0; }
SEEN_COUNTERS=""
COUNT=0
counter_hit() { # key -> sets COUNT to the new consecutive count (no subshell: SEEN_COUNTERS must persist)
  COUNT=$(( $(counter_get "$1") + 1 ))
  counter_set "$1" "$COUNT"
  SEEN_COUNTERS="$SEEN_COUNTERS $1"
}
counter_reset_unseen() { # prefix: zero every counter with this prefix not hit this run
  [ "$MODE" = apply ] || return 0
  local f k
  for f in "$PERSIST_DIR"/count-"$1"*; do
    [ -e "$f" ] || continue
    k=${f##*/count-}
    case " $SEEN_COUNTERS " in *" $k "*) ;; *) rm -f "$f" ;; esac
  done
}

send_ntfy() { # title body priority
  if [ -z "${NTFY_TOPIC:-}" ]; then
    log "WARN: NTFY_TOPIC unset; cannot deliver: $1"
    return 0
  fi
  curl -s -m 10 -H "Title: $1" -H "Priority: ${3:-default}" -H "Tags: kami-lease" \
    -d "$2" "$NTFY_SERVER/$NTFY_TOPIC" >/dev/null || log "WARN: ntfy delivery failed for: $1"
}

notify() { # key title body [priority]
  local key="$1" title="$2" body="$3" prio="${4:-default}" last
  key=$(printf '%s' "$key" | tr -c 'A-Za-z0-9_.-' '_')
  FIRED=$((FIRED + 1))
  last=$(num_file "$STATE/$key")
  if [ $((NOW - last)) -lt "$COOLDOWN_SECS" ]; then
    log "ALERT (cooldown, not re-sent) [$key] $title: $body"
    return 0
  fi
  if [ "$MODE" != apply ]; then
    log "[dry-run] WOULD ALERT [$key] $title: $body"
    return 0
  fi
  write_atomic "$STATE/$key" "$NOW"
  log "ALERT SENT [$key] $title: $body"
  send_ntfy "$title" "$body" "$prio"
}

rpc_result() { # method params_json -> result string, non-zero on any failure
  local out
  out=$(curl -sS -m "$RPC_TIMEOUT_SEC" -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC" 2>/dev/null) || return 1
  # jq-free on purpose: a JSON-RPC reply is {"jsonrpc","id","result":"0x.."} or {"error":..}
  local r
  r=$(sed -nE 's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]*)".*/\1/p' <<<"$out")
  [ -n "$r" ] || return 1
  printf '%s' "$r"
}
eth_call() { rpc_result eth_call "[{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"]"; }
word() { local h=${1#0x}; printf '%s' "${h:$(( $2 * 64 )):64}"; }
hex2dec() { # 63-bit safe; values above 2^60 are capped (only used for thresholds)
  local h=${1#0x}
  h="${h#"${h%%[!0]*}"}"
  if [ -z "$h" ]; then echo 0; elif [ ${#h} -gt 15 ]; then echo 1152921504606846975; else echo $((16#$h)); fi
}
u32word() { printf '%064x' "$1"; }
wei_eth() { awk -v w="$1" 'BEGIN{printf "%.6f", w/1e18}'; }

# ---- special modes ------------------------------------------------------------
if [ -n "$FAILED_UNIT" ]; then
  COOLDOWN_SECS=0
  notify "onfailure-$FAILED_UNIT" "UNIT FAILED: $FAILED_UNIT" \
    "[LEASE-ALERT] UNIT_FAILED unit=$FAILED_UNIT host=$(hostname) at $(date -u +%FT%TZ). Check: journalctl -u $FAILED_UNIT -n 50" high
  exit 0
fi

if [ "$SELF_TEST" = 1 ]; then
  COOLDOWN_SECS=0
  notify "self-test" "kami lease alerts self-test" \
    "Test notification from worker-alerts-v2 on $(hostname) at $(date -u +%FT%TZ). No action needed."
  if [ "$MODE" = apply ] && [ -z "${NTFY_TOPIC:-}" ]; then exit 1; fi
  exit 0
fi

log "worker-alerts-v2 mode=$MODE markets=[$V16_MARKETS] rpc=$RPC"

# ---- self gap -----------------------------------------------------------------
last_ok=$(num_file "$PERSIST_DIR/alerts-last-ok")
if [ "$last_ok" != 0 ] && [ $((NOW - last_ok)) -gt "$SELF_GAP_SEC" ]; then
  notify "self-gap" "alerts were not running" \
    "[LEASE-ALERT] ALERTS_GAP last successful alert run was $((NOW - last_ok))s ago (> ${SELF_GAP_SEC}s). Monitoring was blind in between."
fi

# ---- units ------------------------------------------------------------------------
unit_state() { systemctl is-active "$1" 2>/dev/null || true; }
V16_UNITS=""
for m in $V16_MARKETS; do V16_UNITS="$V16_UNITS kami-renter-pod-v16-$m"; done
for u in $INFRA_UNITS $SELF_TIMER; do
  st=$(unit_state "$u")
  if [ "$st" != active ]; then
    notify "dead-$u" "unit DOWN: $u" "[LEASE-ALERT] UNIT_DOWN unit=$u state=${st:-unknown}" high
  fi
done

# ---- per worker journal checks --------------------------------------------------------
# Per-lease codes are keyed per (unit, code, token): a DEAD_KAMI for token B within
# the cooldown of one for token A is a NEW condition and is pushed. Other codes (and
# per-lease lines without token=) keep one key per (unit, code).
PER_LEASE_CODES="${PER_LEASE_CODES:-DEAD_KAMI ESCROW_LOW EXIT_RESERVE_STOP STAGE_STUCK TX_TIMEOUT OPERATOR_MISMATCH}"
lease_alert_scan() { # unit lines -> one notify per distinct [LEASE-ALERT] code (per token for per-lease codes)
  local unit="$1" la codes code lines toks tok tlines cnt last prio key
  la=$(grep -F '[LEASE-ALERT]' <<<"$2" || true)
  [ -n "$la" ] || return 0
  codes=$(sed -nE 's/.*\[LEASE-ALERT\] ([A-Z0-9_]+).*/\1/p' <<<"$la" | sort -u)
  for code in $codes; do
    lines=$(grep -F "[LEASE-ALERT] $code" <<<"$la" || true)
    prio=high
    case "$code" in LEASE_CAP|RESERVATION_CAP) prio=default ;; esac
    toks="-"
    case " $PER_LEASE_CODES " in
      *" $code "*) toks=$(sed -nE 's/.*[[:space:]]token=([0-9]+).*/\1/p' <<<"$lines" | sort -un)
                   grep -vqE '[[:space:]]token=[0-9]+' <<<"$lines" && toks="$toks -" ;;
    esac
    for tok in $toks; do
      if [ "$tok" = - ]; then
        tlines=$(grep -vE '[[:space:]]token=[0-9]+' <<<"$lines" || true)
        [ "$toks" = - ] && tlines=$lines
        key="la-$unit-$code"
      else
        tlines=$(grep -E "[[:space:]]token=$tok([^0-9]|\$)" <<<"$lines" || true)
        key="la-$unit-$code-$tok"
      fi
      [ -n "$tlines" ] || continue
      cnt=$(grep -c . <<<"$tlines" || true)
      last=$(tail -1 <<<"$tlines" | sed -E 's/.*(\[LEASE-ALERT\])/\1/' | cut -c1-220)
      notify "$key" "$code on $unit" "$cnt line(s). Last: $last" "$prio"
    done
  done
}

journal_since_last() { # unit -> lines since the previous apply run (cursor), else WINDOW
  local unit="$1" cur="$STATE/cursor-$1"
  if [ "$MODE" = apply ]; then
    # --cursor-file: resume after the last line seen, and save the new position
    journalctl -u "$unit" --since "$WINDOW" --cursor-file="$cur" -o short-iso --no-pager 2>/dev/null || true
  elif [ -s "$cur" ]; then
    # dry-run: read the saved cursor, never write it
    journalctl -u "$unit" --after-cursor="$(cat "$cur")" -o short-iso --no-pager 2>/dev/null || true
  else
    journalctl -u "$unit" --since "$WINDOW" -o short-iso --no-pager 2>/dev/null || true
  fi
}

for s in $LEGACY_UNITS $V16_UNITS; do
  st=$(unit_state "$s")
  if [ "$st" != active ]; then
    notify "dead-$s" "worker DOWN" "[LEASE-ALERT] UNIT_DOWN unit=$s state=${st:-unknown}" high
    continue
  fi
  lines=$(journal_since_last "$s")
  [ -n "$lines" ] || continue

  # baseline error-rate check (kept for continuity)
  n=$(grep -ciE "$ERR_PATTERN" <<<"$lines" || true)
  if [ "${n:-0}" -ge "$ERR_THRESHOLD" ]; then
    sample=$(grep -iE "$ERR_PATTERN" <<<"$lines" | tail -1 | cut -c1-180)
    notify "errs-$s" "worker errors: $s" "$n error lines since last check. Last: $sample"
  fi

  # structured [LEASE-ALERT] lines: any line alerts, one push per code
  lease_alert_scan "$s" "$lines"

  # quote key store failures (patched worker): a failed fsync'd append means that
  # quote was answered 503 KEY_STORE_UNAVAILABLE (no address, no signature)
  ks=$(grep -F 'operator key store write failed' <<<"$lines" || true)
  if [ -n "$ks" ]; then
    notify "keystore-$s" "quote keys not durable: $s" \
      "[LEASE-ALERT] KEY_STORE_UNAVAILABLE unit=$s lines=$(grep -c . <<<"$ks") quotes are refused with 503 until the store is writable (disk full? file mode/owner?). Last: $(tail -1 <<<"$ks" | cut -c1-160)" high
  fi
  kc=$(grep -E 'quote key store (compaction|delete) failed' <<<"$lines" || true)
  if [ -n "$kc" ]; then
    notify "keycompact-$s" "quote key store maintenance failing: $s" \
      "[LEASE-ALERT] QUOTE_STORE_COMPACT unit=$s lines=$(grep -c . <<<"$kc") (the journal keeps every key; it grows until compaction works). Last: $(tail -1 <<<"$kc" | cut -c1-160)"
  fi

  # wedge messages the baseline grep never matched (VPS-2 / THR-06)
  stuck=$(grep -E "$STUCK_PATTERN" <<<"$lines" | grep -vF '[LEASE-ALERT]' || true)
  if [ -n "$stuck" ]; then
    cnt=$(wc -l <<<"$stuck" | tr -d ' ')
    notify "stuck-$s" "lease wedge text on $s" "$cnt line(s). Last: $(tail -1 <<<"$stuck" | cut -c1-200)" high
  fi
done

# ---- ops timers (expiry keeper, gas sponsor): their [LEASE-ALERT] lines --------------------
for u in $OPS_UNITS; do
  systemctl cat "$u" >/dev/null 2>&1 || continue # not installed yet
  lines=$(journal_since_last "$u")
  if [ -n "$lines" ]; then lease_alert_scan "$u" "$lines"; fi
done

# heartbeat.json is a flat object of numbers/booleans (shared contract), so a
# jq-free read keeps the heartbeat check working even where jq is missing.
hb_field() { # file key -> first scalar value for "key"
  tr -d '\n' < "$1" | sed -nE "s/.*\"$2\"[[:space:]]*:[[:space:]]*([-0-9.]+|true|false|null).*/\\1/p"
}
# Worker-state reads use jq, else node (the box has node for the workers).
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v20.20.0/bin/node}"
[ -x "$NODE_BIN" ] || NODE_BIN=$(command -v node 2>/dev/null || true)
HAVE_JQ=1
if ! command -v jq >/dev/null 2>&1 && [ -z "$NODE_BIN" ]; then
  HAVE_JQ=0
  notify "no-jq" "alerts degraded: jq missing" "[LEASE-ALERT] ALERTS_DEGRADED neither jq nor node is available on $(hostname); worker state (job errors, stage age, operator gas) is not being checked"
fi
state_jobs() { # state_file errors|all -> TSV per non-returned job (errors: token, error; all: token, operator, pod)
  if command -v jq >/dev/null 2>&1; then
    if [ "$2" = errors ]; then
      jq -r '.jobs // {} | to_entries[] | .value | select((.returned // false) != true and (.error // "") != "") | [(.tokenIndex|tostring), (.error|tostring|gsub("[\t\n]";" "))] | @tsv' "$1"
    else
      jq -r '.jobs // {} | to_entries[] | .value | select((.returned // false) != true) | [(.tokenIndex|tostring), (.operator // ""), (.pod // "")] | @tsv' "$1"
    fi
    return
  fi
  "$NODE_BIN" -e 'const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    for (const j of Object.values(s.jobs || {})) {
      if (!j || j.returned === true) continue;
      if (process.argv[2] === "errors") {
        if (j.error == null || j.error === "") continue;
        console.log(String(j.tokenIndex) + "\t" + String(j.error).replace(/[\t\n]/g, " "));
      } else {
        console.log([String(j.tokenIndex), j.operator || "", j.pod || ""].join("\t"));
      }
    }' "$1" "$2"
}

# ---- heartbeat / state per v16 worker ---------------------------------------------------------
state_file_for() { # market dir -> absolute state file path (reads only WORKER_STATE_FILE from .env)
  local dir="$1" v=""
  if [ -r "$dir/.env" ]; then
    v=$(grep -E '^WORKER_STATE_FILE=' "$dir/.env" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^ +| +$//g' || true)
  fi
  [ -n "$v" ] || v="$dir/renter-pod-worker-state.json"
  case "$v" in /*) ;; *) v="$dir/$v" ;; esac
  printf '%s' "$v"
}
store_file_for() { # market dir, state file -> quote key store snapshot (RESERVATION_STATE_FILE or the default)
  local dir="$1" sf="$2" v=""
  if [ -r "$dir/.env" ]; then
    v=$(grep -E '^[[:space:]]*(export[[:space:]]+)?RESERVATION_STATE_FILE[[:space:]]*=' "$dir/.env" | tail -1 | cut -d= -f2- | tr -d '\r' \
      | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/' || true)
  fi
  [ -n "$v" ] || v="$(dirname "$sf")/$(basename "$sf" .json).reservations.json"
  case "$v" in /*) ;; *) v="$dir/$v" ;; esac
  printf '%s' "$v"
}

# Exit reserve priced exactly like the worker (renter-pod-safety.mjs): the fee per gas
# the worker is BILLED at, max(2 x baseFee + priority, gasPrice) for the default
# OPERATOR_TX_PRICING=eip1559, times the billed action gas (OPERATOR_ACTION_GAS_FLOOR
# + 10% unused-gas charge), times EXIT_RESERVE_ACTIONS. Below it the worker cannot
# pay its own exit (stop harvest, finalize, KamiSend home).
rpc_raw() { # method params -> raw JSON reply (non-zero unless it carries a "result")
  local out
  out=$(curl -sS -m "$RPC_TIMEOUT_SEC" -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC" 2>/dev/null) || return 1
  grep -q '"result"' <<<"$out" || return 1
  printf '%s' "$out"
}
billed_fee_per_gas() { # -> FEE_PER_GAS (same rule as keeper/lease-gas-sponsor.sh); non-zero on read failure
  local gp blk bf base pr mf
  gp=$(rpc_result eth_gasPrice '[]') || return 1
  FEE_PER_GAS=$(hex2dec "$gp")
  [ "$OPERATOR_TX_PRICING" != legacy ] || return 0
  blk=$(rpc_raw eth_getBlockByNumber '["latest",false]') || return 1
  bf=$(tr -d '\n' <<<"$blk" | sed -nE 's/.*"baseFeePerGas"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]+)".*/\1/p')
  [ -n "$bf" ] || return 0
  base=$(hex2dec "$bf")
  [ "$base" -gt 0 ] || return 0
  if pr=$(rpc_result eth_maxPriorityFeePerGas '[]'); then pr=$(hex2dec "$pr"); else pr=1000000000; fi
  mf=$((2 * base + pr))
  [ "$mf" -le "$FEE_PER_GAS" ] || FEE_PER_GAS=$mf
}
EXIT_RESERVE_WEI=""
FEE_PER_GAS=""
if billed_fee_per_gas; then
  EXIT_RESERVE_WEI=$(( FEE_PER_GAS * (OPERATOR_ACTION_GAS_FLOOR + OPERATOR_ACTION_GAS_FLOOR / 10) * EXIT_RESERVE_ACTIONS ))
  log "operator exit reserve ${EXIT_RESERVE_WEI} wei (feePerGas=${FEE_PER_GAS} pricing=${OPERATOR_TX_PRICING})"
else
  CHECK_ERRORS=$((CHECK_ERRORS + 1))
fi

for m in $V16_MARKETS; do
  dir=$(market_dir "$m")
  unit="kami-renter-pod-v16-$m"
  sf=$(state_file_for "$dir")
  hb="$(dirname "$sf")/heartbeat.json"
  if [ ! -d "$dir" ]; then
    notify "nodir-$m" "v16 $m dir missing" "[LEASE-ALERT] WORKER_STALL market=$m dir=$dir missing"
    continue
  fi

  if [ -r "$hb" ]; then
    ts=$(hb_field "$hb" ts); ts=${ts%.*}
    [[ "$ts" =~ ^[0-9]+$ ]] || ts=0
    age=$((NOW - ts))
    ok=$(hb_field "$hb" lastTickOk); ok=${ok:-unknown}
    detail="lastBlock=$(hb_field "$hb" lastBlock) activeJobs=$(hb_field "$hb" activeJobs) liveReservations=$(hb_field "$hb" liveReservations) tickMs=$(hb_field "$hb" tickMs)"
    if [ "$age" -gt "$HEARTBEAT_STALE_SEC" ]; then
      notify "hb-$m" "worker heartbeat STALE: $unit" \
        "[LEASE-ALERT] WORKER_STALL market=$m age=${age}s limit=${HEARTBEAT_STALE_SEC}s $detail" high
    fi
    if [ "$ok" = false ]; then
      counter_hit "tickfail-$m"; c=$COUNT
      if [ "$c" -ge "$TICK_FAIL_RUNS" ]; then
        notify "tickfail-$m" "worker ticks failing: $unit" \
          "[LEASE-ALERT] WORKER_STALL market=$m lastTickOk=false on $c consecutive checks $detail"
      fi
    fi
  else
    if [ "$HEARTBEAT_MISSING_MODE" = alert ]; then
      notify "hbmissing-$m" "worker heartbeat MISSING: $unit" "[LEASE-ALERT] WORKER_STALL market=$m file=$hb missing" high
    elif [ -e "$sf" ]; then
      # pre-heartbeat worker: its state file is rewritten at the end of every tick
      mt=$(stat -c %Y "$sf")
      age=$((NOW - mt))
      if [ "$age" -gt "$HEARTBEAT_STALE_SEC" ]; then
        notify "hb-$m" "worker state STALE: $unit" \
          "[LEASE-ALERT] WORKER_STALL market=$m (no heartbeat.json; state mtime) age=${age}s limit=${HEARTBEAT_STALE_SEC}s" high
      fi
    fi
  fi

  # quote key store: size, free space, key-file modes (never reads the contents)
  store=$(store_file_for "$dir" "$sf")
  journal="$(dirname "$store")/$(basename "$store" | sed -E 's/\.[jJ][sS][oO][nN]$//').journal"
  qbytes=0; qdetail=""
  for f in "$store" "$journal"; do
    [ -f "$f" ] || continue
    b=$(stat -c %s "$f" 2>/dev/null || echo 0)
    qbytes=$((qbytes + b)); qdetail="$qdetail $(basename "$f")=${b}B"
  done
  live=""
  [ -r "$hb" ] && live=$(hb_field "$hb" liveReservations)
  [[ "$live" =~ ^[0-9]+$ ]] || live=""
  log "quote store $m: bytes=$qbytes${qdetail:+ (${qdetail# })} liveReservations=${live:-?}"
  if [ "$qbytes" -gt $((QUOTE_STORE_MAX_MB * 1048576)) ] || { [ -n "$live" ] && [ "$live" -gt "$QUOTE_STORE_MAX_LIVE" ]; }; then
    notify "qstore-size-$m" "quote key store large ($m)" \
      "[LEASE-ALERT] QUOTE_STORE_SIZE market=$m bytes=$qbytes limitMB=$QUOTE_STORE_MAX_MB liveReservations=${live:-?} limitLive=$QUOTE_STORE_MAX_LIVE (a quote burst beyond the web limits, or pruning stuck: is ingest advancing?)" high
  fi
  qdir=$(dirname "$store")
  if [ -d "$qdir" ]; then
    free_mb=$(df -Pk "$qdir" 2>/dev/null | awk 'NR==2{print int($4/1024)}')
    if [[ "$free_mb" =~ ^[0-9]+$ ]] && [ "$free_mb" -lt "$QUOTE_STORE_MIN_FREE_MB" ]; then
      notify "qstore-disk-$m" "quote key store disk low ($m)" \
        "[LEASE-ALERT] QUOTE_STORE_DISK market=$m freeMB=$free_mb min=$QUOTE_STORE_MIN_FREE_MB: when an fsync'd append fails every quote answers 503 KEY_STORE_UNAVAILABLE" high
    fi
  fi
  for f in "$store" "$journal" "$sf"; do
    [ -f "$f" ] || continue
    mode=$(stat -c %a "$f" 2>/dev/null || echo 0)
    [[ "$mode" =~ ^[0-7]+$ ]] || continue
    if [ $(( 8#$mode & 8#077 )) -ne 0 ]; then
      notify "qstore-mode-$m-$(basename "$f")" "key file readable by others ($m)" \
        "[LEASE-ALERT] QUOTE_STORE_MODE market=$m file=$(basename "$f") mode=$mode (holds operator keys: chmod 600)" high
    fi
  done

  [ -r "$sf" ] && [ "$HAVE_JQ" = 1 ] || continue
  # job.error that persists across runs (VPS-2). Only tokenIndex + error text leave the file.
  while IFS=$'\t' read -r tok err; do
    [ -n "$tok" ] || continue
    counter_hit "joberr-$m-$tok"; c=$COUNT
    if [ "$c" -ge "$JOB_ERROR_RUNS" ]; then
      notify "joberr-$m-$tok" "lease #$tok erroring ($m)" \
        "[LEASE-ALERT] STAGE_STUCK market=$m token=$tok error on $c consecutive checks: $(cut -c1-180 <<<"$err")" high
    fi
  done < <(state_jobs "$sf" errors 2>/dev/null || true)

  # chain-side stage age + operator gas for every non-returned job
  maddr=$(market_addr "$m")
  faddr_word=$(eth_call "$maddr" 0xe1fc685a || true) # leaseFactory()
  if [ -z "$faddr_word" ]; then
    CHECK_ERRORS=$((CHECK_ERRORS + 1))
    continue
  fi
  faddr="0x$(word "$faddr_word" 0 | cut -c25-64)"
  while IFS=$'\t' read -r tok op pod; do
    [ -n "$tok" ] || continue
    req=$(eth_call "$faddr" "0x0ab469b0$(u32word "$tok")" || true) # requests(uint32)
    lst=$(eth_call "$maddr" "0xf81c2347$(u32word "$tok")" || true) # listings(uint32)
    if [ -z "$req" ] || [ -z "$lst" ]; then CHECK_ERRORS=$((CHECK_ERRORS + 1)); continue; fi
    stage=$(hex2dec "$(word "$req" 5)")
    requested_at=$(hex2dec "$(word "$req" 4)")
    escrow=$(hex2dec "$(word "$req" 2)")
    ending=$(hex2dec "$(word "$lst" 7)")
    lease_end=$(hex2dec "$(word "$lst" 12)")
    if [ "$stage" = 2 ] && [ $((NOW - requested_at)) -gt "$PREPARING_MAX_SEC" ]; then
      notify "prep-$m-$tok" "lease #$tok stuck PREPARING ($m)" \
        "[LEASE-ALERT] STAGE_STUCK market=$m token=$tok stage=PREPARING age=$((NOW - requested_at))s limit=${PREPARING_MAX_SEC}s" high
    fi
    if [ "$stage" = 3 ] && [ "$ending" = 0 ] && [ "$lease_end" -gt 0 ] \
        && [ $((NOW - lease_end)) -gt "$EXPIRED_UNENDED_MAX_SEC" ]; then
      notify "expired-$m-$tok" "lease #$tok expired but not ending ($m)" \
        "[LEASE-ALERT] STAGE_STUCK market=$m token=$tok expired $((NOW - lease_end))s ago and endLease has not run (expiry keeper?)" high
    fi
    if [ "$stage" = 3 ] && [ "$ending" = 1 ]; then
      rr=$(eth_call "$maddr" "0x677ace85$(u32word "$tok")" || true) # recoveryReady(uint32)
      if [ -n "$rr" ] && [ "$(hex2dec "$(word "$rr" 0)")" = 1 ]; then
        notify "grace-$m-$tok" "lease #$tok ending past grace ($m)" \
          "[LEASE-ALERT] STAGE_STUCK market=$m token=$tok ending for more than the 2-day ENDING_GRACE; permissionless recovery is now open" high
      fi
    fi
    gas_check=0
    case "$stage" in
      3|4|5) gas_check=1 ;;
      # stage 0: request cleared, custody return still owed by a non-returned job;
      # only when the token is listed here and not re-leased (else a stale job)
      0) [ "$(word "$lst" 0)" != "$(printf '%064d' 0)" ] && [ "$(word "$lst" 8)" = "$(printf '%064d' 0)" ] && gas_check=1 ;;
    esac
    if [ -n "$EXIT_RESERVE_WEI" ] && [ "$gas_check" = 1 ]; then
      bal=$(rpc_result eth_getBalance "[\"$op\",\"latest\"]" || true)
      if [ -n "$bal" ]; then
        balw=$(hex2dec "$bal")
        pullable=$escrow
        [ "$stage" = 3 ] || pullable=0 # v16 pullGas is PREPARING/ACTIVE only (stage 0: allowPull=false)
        if [ $((balw + pullable)) -lt "$EXIT_RESERVE_WEI" ]; then
          notify "opgas-$m-$tok" "lease #$tok operator gas low ($m)" \
            "[LEASE-ALERT] ESCROW_LOW market=$m token=$tok stage=$stage operator=$op balance=${balw} escrow=${escrow} exitReserve=${EXIT_RESERVE_WEI} wei (gas sponsor?)" high
        fi
      else
        CHECK_ERRORS=$((CHECK_ERRORS + 1))
      fi
    fi
  done < <(state_jobs "$sf" all 2>/dev/null || true)
done
counter_reset_unseen "tickfail-"
counter_reset_unseen "joberr-"

# ---- chain: keeper, float, backing ---------------------------------------------------------------
kb=$(rpc_result eth_getBalance "[\"$KEEPER_ADDR\",\"latest\"]" || true)
if [ -z "$kb" ]; then
  CHECK_ERRORS=$((CHECK_ERRORS + 1))
else
  kbw=$(hex2dec "$kb")
  log "keeper balance ${kbw} wei ($(wei_eth "$kbw") ETH), min ${KEEPER_MIN_WEI}"
  if [ "$kbw" -lt "$KEEPER_MIN_WEI" ]; then
    notify "keeper-low" "keeper ETH low" \
      "[LEASE-ALERT] KEEPER_LOW keeper=$KEEPER_ADDR balance=$(wei_eth "$kbw") ETH < $(wei_eth "$KEEPER_MIN_WEI") ETH. Top up (shared by v15+v16 workers)." high
  fi
fi

ff=$(eth_call "$VIPP_MARKET" 0x77f38685 || true) # feeFloatClaimsLeft()
if [ -z "$ff" ]; then
  CHECK_ERRORS=$((CHECK_ERRORS + 1))
else
  ffn=$(hex2dec "$(word "$ff" 0)")
  log "VIPP feeFloatClaimsLeft=$ffn min=$FEE_FLOAT_MIN_CLAIMS"
  if [ "$ffn" -lt "$FEE_FLOAT_MIN_CLAIMS" ]; then
    notify "vipp-float" "VIPP fee float low" \
      "[LEASE-ALERT] FEE_FLOAT_LOW market=$VIPP_MARKET feeFloatClaimsLeft=$ffn < $FEE_FLOAT_MIN_CLAIMS. Send MUSU to the VIPP hub account." high
  fi
fi

for m in musu vipp; do
  maddr=$(market_addr "$m")
  bs=$(eth_call "$maddr" 0x88338767 || true) # backingShortfall()
  if [ -z "$bs" ]; then CHECK_ERRORS=$((CHECK_ERRORS + 1)); continue; fi
  bsn=$(hex2dec "$(word "$bs" 0)")
  log "$m backingShortfall=$bsn"
  if [ "$bsn" -gt 0 ]; then
    notify "shortfall-$m" "backing shortfall on $m market" \
      "[LEASE-ALERT] BACKING_SHORTFALL market=$maddr shortfall=$bsn (payItem units). Claims may not be fully backed." high
  fi
done

if [ "$CHECK_ERRORS" -gt 0 ]; then
  counter_hit "rpc-errors"; c=$COUNT
  if [ "$c" -ge 2 ]; then
    notify "rpc-errors" "alert chain checks failing" \
      "[LEASE-ALERT] RPC_UNREACHABLE $CHECK_ERRORS chain read(s) failed on $c consecutive checks via $RPC"
  fi
fi
counter_reset_unseen "rpc-errors"

# ---- ingress + TLS -------------------------------------------------------------------------------
for h in $LEASE_HOSTS; do
  code=$(curl -s -o /dev/null -m 10 -w '%{http_code}' "https://$h/" || echo 000)
  log "ingress $h http=$code (expect $INGRESS_EXPECT_CODE)"
  if [ "$code" != "$INGRESS_EXPECT_CODE" ]; then
    notify "ingress-$h" "lease host not answering: $h" \
      "[LEASE-ALERT] INGRESS_DOWN host=$h http=$code expected=$INGRESS_EXPECT_CODE (caddy or worker reservation server)" high
  fi
  end=$(echo | timeout 15 openssl s_client -servername "$h" -connect "$h:443" 2>/dev/null \
        | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)
  if [ -z "$end" ]; then
    notify "tls-$h" "TLS check failed: $h" "[LEASE-ALERT] TLS_EXPIRY host=$h could not read certificate"
    continue
  fi
  end_ts=$(date -d "$end" +%s 2>/dev/null || echo 0)
  days=$(( (end_ts - NOW) / 86400 ))
  log "tls $h expires in ${days}d"
  if [ "$days" -lt "$TLS_MIN_DAYS" ]; then
    notify "tls-$h" "TLS cert expiring: $h" "[LEASE-ALERT] TLS_EXPIRY host=$h days_left=$days (< $TLS_MIN_DAYS). Check caddy renewal." high
  fi
done

# ---- host ------------------------------------------------------------------------------------------
disk=$(df -P / | awk 'NR==2{gsub("%","",$5); print $5}')
mem_mb=$(( $(awk '/^MemAvailable:/{print $2}' /proc/meminfo) / 1024 ))
log "host disk=${disk}% memAvailable=${mem_mb}MB"
if [ "${disk:-0}" -gt "$DISK_MAX_PCT" ]; then
  notify "disk" "disk almost full" "[LEASE-ALERT] HOST_DISK / is ${disk}% used (> ${DISK_MAX_PCT}%)" high
fi
if [ "$mem_mb" -lt "$MEM_MIN_MB" ]; then
  notify "mem" "memory low" "[LEASE-ALERT] HOST_MEMORY MemAvailable=${mem_mb}MB (< ${MEM_MIN_MB}MB)" high
fi

if [ "$MODE" = apply ]; then
  write_atomic "$PERSIST_DIR/alerts-last-ok" "$NOW"
fi
log "done: $FIRED condition(s) firing, $CHECK_ERRORS chain read error(s), mode=$MODE"
exit 0
}
