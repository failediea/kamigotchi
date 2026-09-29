#!/usr/bin/env bash
# lease-transition-gate.sh - READ-ONLY. Is it safe to restart a v16 worker now?
#
# Exit 0 = safe, 3 = REFUSE (a lease is mid-transition), 1 = could not decide
# (treated as refuse by deploy-worker-patch.sh). Runs on the VPS (reads the
# worker state files + chain); deploy-worker-patch.sh pipes it over ssh.
#
# The rule (documented in README "Mid-transition rule"):
#   A market is safe to restart only when every lease it knows about is either
#   fully returned or in steady ACTIVE farming far from expiry. Concretely, REFUSE if
#   J1  a non-returned worker job has factory stage 1 REQUESTED, 2 PREPARING,
#       4 CANCEL_REQUESTED, 5 FINALIZED, 6/7 RECOVERY_*, or stage 0 (custody return
#       still pending in the worker);
#   J2  a non-returned job is ACTIVE (3) but the listing is ending, or leaseEnd is
#       less than GATE_EXPIRY_MARGIN_SEC away (or already past);
#   J3  a non-returned job's chain pod differs from the job's pod;
#   C1  any listing on the market has factory stage in {1,2,4,5,6,7}, or is leased
#       and ending, even if the worker has not ingested it yet;
#   C2  any leased listing (renter != 0) has no non-returned job in the worker state;
#   R1  a reservation bound to a signed quote (attestedDigest set) is younger than
#       GATE_INFLIGHT_SEC: a renter may be submitting the create tx right now;
#   T1  the worker state records a transaction still in flight (tx tracker keys
#       txs / pendingTxs / inflightTxs with a pending-like status).
#   Steady ACTIVE leases (stage 3, not ending, > margin to expiry) are allowed:
#   a restart only pauses reconciliation for ~30 s while Kamibots keeps farming.
#   Set GATE_ALLOW_ACTIVE=0 to refuse those too.
#
# Usage: lease-transition-gate.sh [--market musu|vipp]... (default both)
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

MARKETS_ARG=""
while [ $# -gt 0 ]; do
  case "$1" in
    --market) MARKETS_ARG="$MARKETS_ARG ${2:?}"; shift ;;
    --dry-run) ;; # always read-only
    -h|--help) sed -n '2,32p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

RPC="${YOMINET_RPC_PUBLIC:-https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz}"
RPC_TIMEOUT_SEC="${RPC_TIMEOUT_SEC:-15}"
KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
MARKETS="${MARKETS_ARG:-musu vipp}"
MUSU_MARKET="${MUSU_MARKET:-0x1FeF5Ce51f9d3BACD0C3f707eEeBbD7A44d69319}"
VIPP_MARKET="${VIPP_MARKET:-0x4A34d4847D8E2958E4017353e71fAB7afb85bD23}"
GATE_EXPIRY_MARGIN_SEC="${GATE_EXPIRY_MARGIN_SEC:-1800}"
GATE_INFLIGHT_SEC="${GATE_INFLIGHT_SEC:-1800}"
GATE_ALLOW_ACTIVE="${GATE_ALLOW_ACTIVE:-1}"
ZERO_ADDR="0x0000000000000000000000000000000000000000"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
rpc_result() {
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
hex2dec() { local h=${1#0x}; h="${h#"${h%%[!0]*}"}"; if [ -z "$h" ]; then echo 0; elif [ ${#h} -gt 15 ]; then echo 1152921504606846975; else echo $((16#$h)); fi; }
u32word() { printf '%064x' "$1"; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
addr_word() { printf '0x%s' "$(word "$1" "$2" | cut -c25-64)"; }
market_addr() { if [ "$1" = musu ]; then printf '%s' "$MUSU_MARKET"; else printf '%s' "$VIPP_MARKET"; fi; }
state_file_for() {
  local dir="$1" v=""
  if [ -r "$dir/.env" ]; then
    v=$(grep -E '^WORKER_STATE_FILE=' "$dir/.env" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^ +| +$//g' || true)
  fi
  [ -n "$v" ] || v="$dir/renter-pod-worker-state.json"
  case "$v" in /*) ;; *) v="$dir/$v" ;; esac
  printf '%s' "$v"
}

command -v jq >/dev/null || { log "jq missing"; exit 1; }
NOW=$(date +%s)
REFUSE=0
UNDECIDED=0
refuse() { log "REFUSE $*"; REFUSE=1; }
undecided() { log "UNDECIDED $*"; UNDECIDED=1; }

for m in $MARKETS; do
  dir="$KAMI_ROOT/vault-kit-v16-$m"
  sf=$(state_file_for "$dir")
  maddr=$(market_addr "$m")
  log "== market $m ($maddr) state=$sf"
  if [ -n "${LAUNCH_OPS_TEST_STATE_JSON:-}" ]; then
    STATE_JSON=$LAUNCH_OPS_TEST_STATE_JSON # test hook only (tests/run-tests.sh); never set in production
  else
    [ -r "$sf" ] || { undecided "[$m] state file not readable"; continue; }
    STATE_JSON=$(cat "$sf")
  fi
  jq -e . >/dev/null 2>&1 <<<"$STATE_JSON" || { undecided "[$m] state file is not valid JSON"; continue; }
  f_hex=$(eth_call "$maddr" 0xe1fc685a) || { undecided "[$m] leaseFactory() read failed"; continue; }
  factory=$(addr_word "$f_hex" 0)

  # --- J1-J3: worker jobs (only tokenIndex / pod / returned are read) ---
  known_tokens=" "
  while IFS=$'\t' read -r tok pod; do
    [ -n "$tok" ] || continue
    known_tokens="$known_tokens$tok "
    r=$(eth_call "$factory" "0x0ab469b0$(u32word "$tok")") || { undecided "[$m] #$tok requests() read failed"; continue; }
    l=$(eth_call "$maddr" "0xf81c2347$(u32word "$tok")") || { undecided "[$m] #$tok listings() read failed"; continue; }
    stage=$(hex2dec "$(word "$r" 5)")
    chain_pod=$(addr_word "$r" 1)
    ending=$(hex2dec "$(word "$l" 7)")
    lease_end=$(hex2dec "$(word "$l" 12)")
    case "$stage" in
      0) refuse "[$m] J1 #$tok request cleared on chain but the worker has not finished the custody return" ;;
      1|2|4|5|6|7) refuse "[$m] J1 #$tok factory stage $stage is a transition stage" ;;
      3)
        if [ "$(lc "$chain_pod")" != "$(lc "$pod")" ]; then
          refuse "[$m] J3 #$tok chain pod $chain_pod != worker job pod $pod"
        elif [ "$ending" = 1 ]; then
          refuse "[$m] J2 #$tok is ACTIVE and ending"
        elif [ $((lease_end - NOW)) -lt "$GATE_EXPIRY_MARGIN_SEC" ]; then
          refuse "[$m] J2 #$tok leaseEnd in $((lease_end - NOW))s (< ${GATE_EXPIRY_MARGIN_SEC}s margin)"
        elif [ "$GATE_ALLOW_ACTIVE" != 1 ]; then
          refuse "[$m] #$tok steady ACTIVE (GATE_ALLOW_ACTIVE=0)"
        else
          log "ok [$m] #$tok steady ACTIVE, leaseEnd in $((lease_end - NOW))s"
        fi
        ;;
      *) undecided "[$m] #$tok unknown stage $stage" ;;
    esac
  done < <(jq -r '.jobs // {} | to_entries[] | .value | select((.returned // false) != true) | [(.tokenIndex|tostring), (.pod // "")] | @tsv' <<<"$STATE_JSON")

  # --- C1/C2: every listing on chain ---
  n_hex=$(eth_call "$maddr" 0x90af04c1) || { undecided "[$m] numListings() read failed"; continue; }
  n=$(hex2dec "$n_hex")
  for ((i = 0; i < n; i++)); do
    t_hex=$(eth_call "$maddr" "0x44d110b9$(u32word "$i")") || { undecided "[$m] tokenIndices($i) failed"; continue; }
    tok=$(hex2dec "$t_hex")
    l=$(eth_call "$maddr" "0xf81c2347$(u32word "$tok")") || { undecided "[$m] listings($tok) failed"; continue; }
    r=$(eth_call "$factory" "0x0ab469b0$(u32word "$tok")") || { undecided "[$m] requests($tok) failed"; continue; }
    renter=$(addr_word "$l" 8)
    ending=$(hex2dec "$(word "$l" 7)")
    stage=$(hex2dec "$(word "$r" 5)")
    case "$stage" in 1|2|4|5|6|7) refuse "[$m] C1 listing #$tok factory stage $stage (in transition on chain)" ;; esac
    if [ "$renter" != "$ZERO_ADDR" ]; then
      [ "$ending" = 1 ] && refuse "[$m] C1 listing #$tok leased and ending"
      case "$known_tokens" in *" $tok "*) ;; *) refuse "[$m] C2 listing #$tok is leased on chain but has no live worker job" ;; esac
    fi
  done
  log "[$m] $n listing(s) checked on chain"

  # --- R1: bound reservations (legacy: inside the state file; patched worker: *reservations*.json) ---
  inflight=0
  for rf in STATE "$(dirname "$sf")"/*reservations*.json; do
    if [ "$rf" = STATE ]; then rjson=$STATE_JSON; else [ -r "$rf" ] || continue; rjson=$(cat "$rf"); fi
    c=$(jq --argjson now "$NOW" --argjson win "$GATE_INFLIGHT_SEC" '
      (if has("reservations") then .reservations else . end) as $r
      | if ($r|type) == "object" then
          [ $r | to_entries[] | .value | select(type == "object")
            | select((.attestedDigest // "") != "")
            | select((($now * 1000) - ((.createdAt // 0) | tonumber)) < ($win * 1000)) ] | length
        else 0 end' <<<"$rjson" 2>/dev/null || echo 0)
    inflight=$((inflight + c))
  done
  if [ "$inflight" -gt 0 ]; then
    refuse "[$m] R1 $inflight reservation(s) bound to a signed quote in the last ${GATE_INFLIGHT_SEC}s (checkout in flight)"
  fi

  # --- T1: tx tracker (patched worker) ---
  pending=$(jq '[ to_entries[] | select(.key | test("^(txs|pendingTxs|inflightTxs)$")) | .value
                  | (if type == "object" then [.[]] elif type == "array" then . else [] end)[]
                  | select(type == "object")
                  | select(((.status // "pending") | tostring | test("pending|sent|inflight|submitted"; "i"))) ] | length' <<<"$STATE_JSON" 2>/dev/null || echo 0)
  if [ "$pending" -gt 0 ]; then refuse "[$m] T1 $pending transaction(s) still in flight in the worker state"; fi

  # informational: ingest lag
  lb=$(jq -r '.lastBlock // 0' <<<"$STATE_JSON")
  tip_hex=$(rpc_result eth_blockNumber '[]' || echo 0x0)
  log "[$m] worker lastBlock=$lb chain tip=$(hex2dec "$tip_hex")"
done

if [ "$REFUSE" = 1 ]; then log "GATE: REFUSE (a v16 lease is mid-transition)"; exit 3; fi
if [ "$UNDECIDED" = 1 ]; then log "GATE: UNDECIDED (reads failed; treat as refuse)"; exit 1; fi
log "GATE: SAFE for [$MARKETS]"
exit 0
}
