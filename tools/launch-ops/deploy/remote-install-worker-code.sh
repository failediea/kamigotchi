#!/usr/bin/env bash
# remote-install-worker-code.sh - VPS half of deploy-worker-patch.sh. Do not run by hand
# unless you know why; deploy-worker-patch.sh pipes it over ssh with explicit args.
#
#   --action install   back up the market's code files + a state snapshot, copy code
#                      files from STAGING/code, create HALT for the verify window (only
#                      if absent), restart, verify, auto-rollback on failure
#   --action rollback  restore code files from BACKUP_DIR (no heartbeat needed)
#   --action guards    read-only: check the market .env launch guards (below); exit 8
#                      when the deploy must be refused. Prints counts, never values.
#   --action test      run the vault-kit tests in STAGING/full (the whole vault-kit tree
#                      of the ref, so test fixtures in subdirectories exist) or, for an
#                      old staging dir without full/, in STAGING/code. Nothing live changes.
#                      Runs niced (nice 19, ionice idle, --test-concurrency=1) and refuses
#                      (exit 9) while MemAvailable < --min-mem-mb (default 300; 0 = off),
#                      so it cannot OOM the live workers. Does not need root (off-box runs).
#
# Launch guards (checked by --action guards and again by --action install, which
# refuses with exit 8 before touching anything):
#   - RENTER_ALLOWLIST in the market .env must be non-empty (soft launch is allowlisted
#     and fails CLOSED) unless --allow-open-rentals 1 (deploy: ALLOW_OPEN_RENTALS=true);
#     every entry must be a 0x + 40-hex address, parsed exactly like the worker
#     (first non-empty line wins, trimmed, surrounding quotes stripped, comma separated);
#   - numeric worker knobs present in .env must be positive integers (the worker
#     would otherwise refuse to boot and the verify would roll back);
#   - install only: MAX_ACTIVE_LEASES_PER_RENTER=2 is appended when absent (atomic,
#     same mode/owner; the only .env write a deploy ever makes).
#
# Every rollback (manual or automatic) does, in order:
#   1. stop the unit;
#   2. wait (up to --pending-wait sec) until every state.pendingTxs entry is mined or
#      dropped. The pre-hardening worker has no tx tracker and would re-send the same
#      action. Still in flight at the deadline -> the CURRENT code is started again,
#      nothing is restored, exit 5 (a human decides; --force skips this wait). Once all
#      are resolved, the resolved entries (and txNonceHints) are pruned from the state
#      file, so the next deploy's gate T1 does not see them as in flight forever;
#   3. merge the reservation store (<state>.reservations.json, written by the patched
#      worker) back into the state file's "reservations", then rename the store to
#      <store>.rolled-back-<ts>. The pre-hardening worker only reads reservations from
#      the state file; without this merge a renter's create tx for a quote signed by
#      the patched worker would wedge ingest. A merge conflict -> current code started
#      again, exit 6;
#   4. restore the backed-up code files and start the unit; verify.
#
# Only code files are ever written: names must match renter-pod-*.mjs,
# kamibots-rental-config*.mjs or *.env.example. node_modules is never touched, and
# .env only gets the one guard line above. The state file is only rewritten by a
# rollback (pendingTxs prune + reservation merge; atomic, same mode/owner), and HALT
# only when this script created it.
# RPC for the pendingTxs checks: the market .env YOMINET_RPC (the node the worker
# sends through; never printed), else YOMINET_RPC_PUBLIC, else the public RPC.
# Backups hold code files plus state-snapshot/ (state + reservation store, mode 600:
# they contain operator keys). .env is NOT copied (a deploy never changes it).
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

ACTION="" MARKET="" STAGING="" BACKUP_DIR="" VERIFY_SEC=120 REQUIRE_HEARTBEAT=1
VERIFY_HALT=1 FORCE=0 PENDING_WAIT_SEC="${ROLLBACK_PENDING_WAIT_SEC:-300}"
ALLOW_OPEN_RENTALS="${ALLOW_OPEN_RENTALS:-0}" MIN_MEM_MB="${TEST_MIN_MEM_MB:-300}"
while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="$2"; shift ;;
    --market) MARKET="$2"; shift ;;
    --staging) STAGING="$2"; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift ;;
    --verify-sec) VERIFY_SEC="$2"; shift ;;
    --require-heartbeat) REQUIRE_HEARTBEAT="$2"; shift ;;
    --verify-halt) VERIFY_HALT="$2"; shift ;;
    --pending-wait) PENDING_WAIT_SEC="$2"; shift ;;
    --allow-open-rentals) ALLOW_OPEN_RENTALS="$2"; shift ;;
    --min-mem-mb) MIN_MEM_MB="$2"; shift ;;
    --force) FORCE=1 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$ALLOW_OPEN_RENTALS" in 1|true) ALLOW_OPEN_RENTALS=1 ;; *) ALLOW_OPEN_RENTALS=0 ;; esac

KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v20.20.0/bin/node}"
NODE_MODULES="${NODE_MODULES:-$KAMI_ROOT/vault-kit/node_modules}"
RPC="${YOMINET_RPC_PUBLIC:-https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz}"
RPC_SRC="public default"
PENDING_POLL_SEC="${PENDING_POLL_SEC:-10}"
TS_NOW=$(date -u +%Y%m%dT%H%M%SZ)
log() { printf '%s [remote %s] %s\n' "$(date -u +%FT%TZ)" "${MARKET:-test}" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }

is_code() { case "$1" in renter-pod-*.mjs|kamibots-rental-config*.mjs|*.env.example) return 0 ;; *) return 1 ;; esac; }

if [ "$ACTION" = test ]; then
  # Off-box runs (deploy-worker-patch.sh --tests local) need no root. On the VPS the
  # suite runs next to the live workers: memory guard first, then niced + serial.
  [[ "$MIN_MEM_MB" =~ ^[0-9]+$ ]] || die "--min-mem-mb must be a number"
  if [ "$MIN_MEM_MB" -gt 0 ] && [ -r /proc/meminfo ]; then
    avail_mb=$(( $(awk '/^MemAvailable:/{print $2}' /proc/meminfo) / 1024 ))
    if [ "$avail_mb" -lt "$MIN_MEM_MB" ]; then
      log "ERROR: MemAvailable ${avail_mb} MB < ${MIN_MEM_MB} MB: not running the test suite next to the live workers (it peaks ~135 MB RSS). Test off-box instead: deploy-worker-patch.sh --tests local" >&2
      exit 9
    fi
    log "memory guard: MemAvailable ${avail_mb} MB >= ${MIN_MEM_MB} MB"
  fi
  [ -d "$STAGING/code" ] || die "no staging code at $STAGING/code"
  TESTDIR="$STAGING/code"
  if [ -d "$STAGING/full" ]; then
    TESTDIR="$STAGING/full"
    # the files that get installed must be exactly the ones that were tested
    for f in "$STAGING/code"/*; do
      cmp -s "$f" "$TESTDIR/$(basename "$f")" || die "staged $(basename "$f") differs from the tested tree"
    done
  else
    log "WARN: no $STAGING/full; testing the code files only (tests that read fixtures in subdirectories will fail)"
  fi
  ln -sfn "$NODE_MODULES" "$TESTDIR/node_modules"
  cd "$TESTDIR"
  LOWPRI=(nice -n 19)
  command -v ionice >/dev/null 2>&1 && LOWPRI+=(ionice -c 3)
  log "running: ${LOWPRI[*]} node --test --test-concurrency=1 *.test.mjs (in $TESTDIR)"
  if timeout 900 "${LOWPRI[@]}" "$NODE_BIN" --test --test-concurrency=1 ./*.test.mjs > "$STAGING/test.log" 2>&1; then
    grep -E '^# (tests|pass|fail|skipped|todo|cancelled)' "$STAGING/test.log" || true
    log "tests PASSED"
    exit 0
  fi
  tail -40 "$STAGING/test.log"
  grep -E '^# (tests|pass|fail|skipped)' "$STAGING/test.log" || true
  die "tests FAILED (full log: $STAGING/test.log); nothing live was changed"
fi

[ "$(id -u)" = 0 ] || die "must run as root"
case "$MARKET" in musu) PORT=8791 ;; vipp) PORT=8792 ;; *) die "--market musu|vipp" ;; esac
DIR="$KAMI_ROOT/vault-kit-v16-$MARKET"
UNIT="kami-renter-pod-v16-$MARKET"
[ -d "$DIR" ] || die "$DIR missing"

env_value() { # KEY -> value as the worker's .env loader reads it (first non-empty line wins,
  # trimmed, one pair of surrounding quotes stripped). Never printed by callers.
  [ -r "$DIR/.env" ] || return 0
  tr -d '\r' < "$DIR/.env" | sed -nE "s/^$1=(.+)\$/\\1/p" | head -1 \
    | sed -E 's/^[[:space:]]+|[[:space:]]+$//g; s/^"(.*)"$/\1/; s/^'"'"'(.*)'"'"'$/\1/'
}
env_path() { # KEY default -> absolute path
  local v=""
  v=$(env_value "$1")
  [ -n "$v" ] || v="$2"
  case "$v" in /*) ;; *) v="$DIR/$v" ;; esac
  printf '%s' "$v"
}
worker_rpc=$(env_value YOMINET_RPC)
if [ -n "$worker_rpc" ]; then RPC=$worker_rpc; RPC_SRC="worker .env YOMINET_RPC"; fi
SF=$(env_path WORKER_STATE_FILE "$DIR/renter-pod-worker-state.json")
HB="$(dirname "$SF")/heartbeat.json"
STORE=$(env_path RESERVATION_STATE_FILE "$(dirname "$SF")/$(basename "$SF" .json).reservations.json")
HALT=$(env_path WORKER_HALT_FILE "$(dirname "$SF")/HALT")

# State-file operations in node (present on the box for the worker; jq is not needed).
# Never prints keys: only counts, job keys, tx hashes and labels.
STATE_JS='
const fs = require("fs"), path = require("path");
const op = process.env.OP, SF = process.env.SF, STORE = process.env.STORE;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
function writeAtomic(f, obj) {
  const st = fs.statSync(f);
  const tmp = path.join(path.dirname(f), "." + path.basename(f) + ".rollback-tmp");
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n", { mode: st.mode & 0o777 });
  try { fs.chownSync(tmp, st.uid, st.gid); } catch {}
  fs.renameSync(tmp, f);
}
async function rpc(method, params) {
  const r = await fetch(process.env.RPC, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + (j.error.message || "rpc error"));
  return j.result;
}
(async () => {
  if (op === "pending") {
    const pend = readJson(SF).pendingTxs || {};
    let open = 0;
    for (const [k, v] of Object.entries(pend)) {
      if (!v || !v.hash) continue;
      try {
        if (await rpc("eth_getTransactionReceipt", [v.hash])) { console.log(`resolved ${k} ${v.hash} mined`); continue; }
        if (await rpc("eth_getTransactionByHash", [v.hash])) { open++; console.log(`inflight ${k} ${v.hash} label=${v.label} nonce=${v.nonce}`); continue; }
        console.log(`resolved ${k} ${v.hash} dropped`);
      } catch (e) { open++; console.log(`unknown ${k} ${v.hash} (${String(e.message).slice(0, 80)})`); }
    }
    console.log("PENDING " + open);
  } else if (op === "prune-resolved") {
    // Rollback only, with the unit stopped and every entry already resolved: drop the
    // mined/dropped pendingTxs entries (the pre-hardening worker saves them verbatim,
    // and gate T1 would count them as in flight forever) and, once none are left,
    // txNonceHints. An entry that is not provably resolved is kept.
    const state = readJson(SF);
    const pend = state.pendingTxs && typeof state.pendingTxs === "object" ? state.pendingTxs : {};
    let pruned = 0, kept = 0;
    for (const [k, v] of Object.entries(pend)) {
      let resolved = false;
      if (v && v.hash) {
        try {
          if (await rpc("eth_getTransactionReceipt", [v.hash])) resolved = true;
          else if (!(await rpc("eth_getTransactionByHash", [v.hash]))) resolved = true;
        } catch { resolved = false; }
      }
      if (resolved) { delete pend[k]; pruned++; } else kept++;
    }
    let hints = 0;
    if (kept === 0 && state.txNonceHints && typeof state.txNonceHints === "object") {
      hints = Object.keys(state.txNonceHints).length;
      delete state.txNonceHints;
    }
    if (pruned > 0 || hints > 0) { if ("pendingTxs" in state) state.pendingTxs = pend; writeAtomic(SF, state); }
    console.log(`PRUNED ${pruned} kept=${kept} txNonceHints=${hints}`);
  } else if (op === "merge") {
    if (!fs.existsSync(STORE)) { console.log("MERGED 0 (no reservation store)"); return; }
    const raw = readJson(STORE);
    const stored = raw && typeof raw === "object" && "reservations" in raw ? raw.reservations : raw;
    const state = readJson(SF);
    const res = state.reservations && typeof state.reservations === "object" ? state.reservations : {};
    let n = 0;
    for (const [nonce, r] of Object.entries(stored || {})) {
      const key = nonce.toLowerCase();
      const cur = res[key];
      if (cur && String(cur.operator).toLowerCase() !== String(r.operator).toLowerCase()) {
        throw new Error(`reservation ${key} differs between the state file and the store`);
      }
      if (!cur) { res[key] = r; n++; }
    }
    if (n > 0) { state.reservations = res; writeAtomic(SF, state); }
    console.log("MERGED " + n);
  } else {
    throw new Error("unknown OP " + op);
  }
})().catch((e) => { console.error("ERROR " + e.message); process.exit(1); });
'
state_op() { OP="$1" SF="$SF" STORE="$STORE" RPC="$RPC" "$NODE_BIN" -e "$STATE_JS"; }

# Launch guards over the market .env, parsed like the worker (renter-pod-worker.mjs
# loader + renter-pod-config.mjs parseRenterAllowlist). Prints counts and knob
# numbers only: never an address, token, key or URL.
GUARD_JS='
const fs = require("fs");
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const problems = [];
const env = {};
if (!fs.existsSync(process.env.ENV_FILE)) problems.push("no .env in the market dir");
else {
  const unquote = (v) => {
    const t = v.trim();
    return t.length >= 2 && (t[0] === "\"" || t[0] === "\x27") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
  };
  // Mirror renter-pod-config.mjs parseEnvText + loadEnvFile exactly: optional
  // "export ", any-case keys, LAST line wins (a later empty line overrides an
  // earlier value), and an empty final value means the key is not loaded.
  const raw = {};
  for (const line of fs.readFileSync(process.env.ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) raw[m[1]] = unquote(m[2]);
  }
  for (const [k, v] of Object.entries(raw)) if (v) env[k] = v;
}
let renters = 0;
const list = String(env.RENTER_ALLOWLIST ?? "").trim().replace(/^["\x27]|["\x27]$/g, "");
if (list) {
  const set = new Set();
  list.split(",").forEach((entry, i) => {
    const a = entry.trim();
    if (!a) return;
    if (!ADDRESS_RE.test(a)) problems.push(`RENTER_ALLOWLIST entry ${i + 1} is not a 0x+40-hex address (length ${a.length}): the worker refuses to start`);
    else set.add(a.toLowerCase());
  });
  renters = set.size;
}
const knobs = { MAX_ACTIVE_LEASES: 1, MAX_ACTIVE_LEASES_PER_RENTER: 1, MAX_LIVE_RESERVATIONS: 1, MAX_RESERVATIONS_PER_RENTER: 1,
  RESERVATION_TTL_SEC: 1, EXIT_RESERVE_ACTIONS: 1, EXIT_RESUME_HEADROOM_ACTIONS: 0 };
const shown = [];
for (const [k, min] of Object.entries(knobs)) {
  if (env[k] === undefined) continue;
  const n = Number(env[k]);
  if (!Number.isSafeInteger(n) || n < min) problems.push(`${k} is not an integer >= ${min}: the worker refuses to start`);
  else shown.push(`${k}=${n}`);
}
console.log("ALLOWLIST " + renters);
console.log("PER_RENTER " + (env.MAX_ACTIVE_LEASES_PER_RENTER === undefined ? "absent" : "present"));
console.log("KNOBS " + (shown.join(" ") || "none-set(defaults)"));
for (const p of problems) console.log("PROBLEM " + p);
'
GUARD_PER_RENTER=""
launch_guards() { # -> 0 ok, 8 refuse (logs why); sets GUARD_PER_RENTER=present|absent
  local out n p refuse=0 per
  out=$(ENV_FILE="$DIR/.env" "$NODE_BIN" -e "$GUARD_JS" 2>&1) || { log "launch guards: REFUSE cannot evaluate $DIR/.env"; return 8; }
  n=$(sed -n 's/^ALLOWLIST //p' <<<"$out"); n=${n:-0}
  GUARD_PER_RENTER=$(sed -n 's/^PER_RENTER //p' <<<"$out")
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    log "launch guards: REFUSE $p"; refuse=1
  done < <(sed -n 's/^PROBLEM //p' <<<"$out")
  if [ "$n" = 0 ]; then
    if [ "$ALLOW_OPEN_RENTALS" = 1 ]; then
      log "launch guards: WARNING RENTER_ALLOWLIST is empty or missing and ALLOW_OPEN_RENTALS=true: the keeper will attest quotes for ANY renter (open rentals, not a gated soft launch)"
    else
      log "launch guards: REFUSE RENTER_ALLOWLIST is empty or missing in $DIR/.env: the soft launch is allowlisted and fails closed. Append an UNQUOTED line RENTER_ALLOWLIST=0x..,0x.. (the same list as Vercel LEASE_RENTER_ALLOWLIST), or run the deploy with ALLOW_OPEN_RENTALS=true to open rentals on purpose"
      refuse=1
    fi
  fi
  per="present (kept)"; [ "$GUARD_PER_RENTER" = present ] || per="absent (install appends MAX_ACTIVE_LEASES_PER_RENTER=2)"
  log "launch guards [$MARKET]: allowlist=$n renter(s) openRentals=$([ "$ALLOW_OPEN_RENTALS" = 1 ] && echo allowed || echo refused) knobs: $(sed -n 's/^KNOBS //p' <<<"$out") perRenterCap=$per"
  [ "$refuse" = 0 ] || return 8
}
append_env_line() { # line: atomic append to the market .env, same mode/owner, value never printed
  local envf="$DIR/.env" tmp="$DIR/.env.launch-guard-tmp"
  [ -f "$envf" ] || die "$envf missing"
  cp -p "$envf" "$tmp"
  [ -z "$(tail -c1 "$tmp")" ] || printf '\n' >> "$tmp"
  printf '%s\n' "$1" >> "$tmp"
  mv -f "$tmp" "$envf"
}

if [ "$ACTION" = guards ]; then
  rc=0; launch_guards || rc=$?
  exit "$rc"
fi

protected_sums() { # md5 of files that must never change because of a deploy
  ( cd "$DIR" && for f in .env .env.*; do [ -f "$f" ] && md5sum "$f"; done ) 2>/dev/null || true
}

copy_code_from() { # srcdir -> copies code files; prints names
  local src="$1" f base
  for f in "$src"/*; do
    base=$(basename "$f")
    [ -f "$f" ] || continue
    is_code "$base" || continue
    cp "$f" "$DIR/.$base.new"
    chmod 644 "$DIR/.$base.new"
    chown root:root "$DIR/.$base.new" 2>/dev/null || true
    mv -f "$DIR/.$base.new" "$DIR/$base"
    echo "$base"
  done
}

hb_ts() { # heartbeat ts without jq (flat object of scalars, shared contract)
  local t
  t=$(tr -d '\n' < "$HB" 2>/dev/null | sed -nE 's/.*"ts"[[:space:]]*:[[:space:]]*([0-9]+).*/\1/p')
  printf '%s' "${t:-0}"
}

verify() { # start_ts require_hb -> 0 ok
  local start="$1" need_hb="$2" end=$(( $1 + VERIFY_SEC )) ok_hb=0 now ts la
  while :; do
    now=$(date +%s)
    if [ "$need_hb" = 1 ]; then
      if [ -r "$HB" ]; then
        ts=$(hb_ts)
        if [ "$ts" -ge "$start" ] && [ $((now - ts)) -le 120 ]; then ok_hb=1; fi
      fi
    else
      if [ -e "$SF" ] && [ "$(stat -c %Y "$SF")" -ge "$start" ]; then ok_hb=1; fi
    fi
    [ "$now" -ge "$end" ] && break
    sleep "${VERIFY_POLL_SEC:-5}"
  done
  local active port nrestarts
  active=$(systemctl is-active "$UNIT" || true)
  port=$(ss -Hltn "sport = :$PORT" | wc -l)
  la=$(journalctl -u "$UNIT" --since "@$start" -o cat --no-pager 2>/dev/null | grep -cF '[LEASE-ALERT]' || true)
  nrestarts=$(systemctl show "$UNIT" -p NRestarts --value)
  log "verify: active=$active port${PORT}=$port heartbeatFresh=$ok_hb (required=$need_hb) leaseAlerts=$la NRestarts=$nrestarts"
  journalctl -u "$UNIT" --since "@$start" -o cat --no-pager 2>/dev/null | tail -8 | sed 's/^/    | /' || true
  # NRESTARTS_BEFORE is read right after our own restart, so any increase means
  # systemd had to auto-restart a crashed worker inside the verify window.
  [ "$active" = active ] && [ "$port" -ge 1 ] && [ "$ok_hb" = 1 ] && [ "${la:-0}" = 0 ] && [ "$nrestarts" = "$NRESTARTS_BEFORE" ]
}

restore_from() { # backupdir; also removes code files that did not exist in the backup
  local bdir="$1" f base
  for f in "$DIR"/*; do
    base=$(basename "$f"); [ -f "$f" ] || continue
    is_code "$base" || continue
    [ -e "$bdir/$base" ] || { log "removing new file $base"; rm -f "$f"; }
  done
  copy_code_from "$bdir" >/dev/null
}

wait_pending_resolved() { # 0 when no pendingTxs entry is still in flight
  local deadline out n
  deadline=$(( $(date +%s) + PENDING_WAIT_SEC ))
  while :; do
    out=$(state_op pending 2>&1) || out="$out"$'\n'"PENDING 1"
    n=$(sed -n 's/^PENDING //p' <<<"$out" | tail -1)
    n=${n:-1}
    if [ "$n" = 0 ]; then
      grep '^resolved ' <<<"$out" | sed 's/^/    /' || true
      return 0
    fi
    log "pendingTxs: $n transaction(s) still in flight or unreadable:"
    grep -vE '^(PENDING|resolved) ' <<<"$out" | sed 's/^/    /' || true
    [ "$(date +%s)" -lt "$deadline" ] || return 1
    sleep "$PENDING_POLL_SEC"
  done
}

merge_reservations_back() {
  local out
  out=$(state_op merge 2>&1) || { log "reservation merge failed: $out"; return 1; }
  log "reservation store -> state file: $out"
  if [ -e "$STORE" ]; then
    mv -f "$STORE" "$STORE.rolled-back-$TS_NOW"
    log "reservation store renamed to $(basename "$STORE").rolled-back-$TS_NOW (the old worker does not read it)"
  fi
}

# Rollback core, shared by --action rollback and the auto-rollback of --action install.
# Returns 0 ok, 5 pending txs (current code restarted), 6 merge failed (current code
# restarted), 7 old code started but did not verify.
rollback_to_backup() {
  local before start
  before=$(protected_sums)
  log "stopping $UNIT for the rollback"
  systemctl stop "$UNIT"
  if [ "$FORCE" = 1 ]; then
    log "WARN: --force: not waiting for pendingTxs"
  elif ! wait_pending_resolved; then
    log "[LEASE-ALERT] TX_TIMEOUT market=$MARKET unit=$UNIT rollback=blocked reason=pendingTxs-in-flight waitedSec=$PENDING_WAIT_SEC action=current-code-restarted"
    systemctl start "$UNIT"
    return 5
  else
    # every entry is mined or dropped and the unit is stopped: prune them, or the old
    # worker saves them verbatim and every later gate refuses on T1
    local pr
    if pr=$(state_op prune-resolved 2>&1); then
      log "pendingTxs: $pr"
    else
      log "pendingTxs prune failed ($pr); continuing (gate T1 resolves hashes over RPC)"
    fi
  fi
  if ! merge_reservations_back; then
    log "[LEASE-ALERT] STAGE_STUCK market=$MARKET unit=$UNIT rollback=blocked reason=reservation-merge-failed action=current-code-restarted"
    systemctl start "$UNIT"
    return 6
  fi
  restore_from "$BACKUP_DIR"
  [ "$before" = "$(protected_sums)" ] || die ".env files changed during rollback (should be impossible)"
  start=$(date +%s)
  systemctl start "$UNIT"
  NRESTARTS_BEFORE=$(systemctl show "$UNIT" -p NRestarts --value)
  verify "$start" 0 || return 7
}

if [ "$ACTION" = rollback ]; then
  [ -d "$BACKUP_DIR" ] || die "backup dir $BACKUP_DIR missing"
  log "pendingTxs RPC: $RPC_SRC"
  # Fail fast (nothing stopped yet) while the patched worker has a tx in flight.
  if [ "$FORCE" != 1 ]; then
    out=$(state_op pending 2>&1) || die "cannot read pendingTxs from the state file: $out"
    n=$(sed -n 's/^PENDING //p' <<<"$out" | tail -1)
    if [ "${n:-1}" != 0 ]; then
      grep -vE '^(PENDING|resolved) ' <<<"$out" | sed 's/^/    /' || true
      die "rollback refused: $n transaction(s) of the patched worker still in flight (the old code would re-send them). Retry once mined, or pass --force."
    fi
  fi
  rc=0; rollback_to_backup || rc=$?
  case "$rc" in
    0) log "rollback OK"; exit 0 ;;
    5|6) die "rollback blocked (code $rc); the current code was started again" ;;
    *) die "rollback verification failed; inspect: journalctl -u $UNIT -n 100" ;;
  esac
fi

[ "$ACTION" = install ] || die "--action install|rollback|test"
[ -d "$STAGING/code" ] || die "no staging code at $STAGING/code"
[ -n "$BACKUP_DIR" ] || die "--backup-dir required"

# Launch guards BEFORE anything is backed up, copied or restarted.
if ! launch_guards; then
  log "install refused by the launch guards; nothing was changed"
  exit 8
fi
if [ "$GUARD_PER_RENTER" != present ]; then
  append_env_line "MAX_ACTIVE_LEASES_PER_RENTER=2"
  log "appended MAX_ACTIVE_LEASES_PER_RENTER=2 to $DIR/.env (per-renter active-lease cap; mode/owner kept)"
fi
log "pendingTxs RPC: $RPC_SRC"

log "backup: code files + state snapshot -> $BACKUP_DIR (mode 700; .env is not copied)"
mkdir -p "$BACKUP_DIR/state-snapshot"
chmod 700 "$(dirname "$BACKUP_DIR")" "$BACKUP_DIR" "$BACKUP_DIR/state-snapshot"
for f in "$DIR"/*; do
  [ -f "$f" ] && is_code "$(basename "$f")" && cp -a "$f" "$BACKUP_DIR/"
done
for f in "$SF" "$STORE"; do
  if [ -f "$f" ]; then cp -a "$f" "$BACKUP_DIR/state-snapshot/"; chmod 600 "$BACKUP_DIR/state-snapshot/$(basename "$f")"; fi
done
before=$(protected_sums)
state_md5=$(md5sum < "$SF" | cut -c1-32)

log "copying code files:"
copy_code_from "$STAGING/code" | sed 's/^/    /'
[ "$before" = "$(protected_sums)" ] || { restore_from "$BACKUP_DIR"; die ".env files changed during copy; restored code"; }
log "protected .env files unchanged; state md5 before restart ${state_md5:0:8}"

HALT_CREATED=0
if [ "$VERIFY_HALT" = 1 ]; then
  if [ -e "$HALT" ]; then
    log "HALT already present at $HALT (left as is)"
  else
    : > "$HALT"; HALT_CREATED=1
    log "created $HALT for the verify window: the patched worker answers 503 to new quotes until verify passes"
  fi
fi
drop_halt() { if [ "$HALT_CREATED" = 1 ]; then rm -f "$HALT"; log "removed $HALT"; fi; }

start=$(date +%s)
systemctl restart "$UNIT"
NRESTARTS_BEFORE=$(systemctl show "$UNIT" -p NRestarts --value)
log "restarted $UNIT at $start; verifying for ${VERIFY_SEC}s"
if verify "$start" "$REQUIRE_HEARTBEAT"; then
  drop_halt
  log "install OK"
  exit 0
fi

log "VERIFY FAILED - auto-rollback to $BACKUP_DIR code"
rc=0; rollback_to_backup || rc=$?
case "$rc" in
  0) drop_halt; log "auto-rollback OK (old code running)"; exit 4 ;;
  # 5/6: the patched code (which failed verify) runs again. HALT is KEPT so it
  # signs no new quotes until a human has looked; remove it by hand when done.
  5) log "auto-rollback BLOCKED by in-flight txs: the patched code is running again with HALT kept ($HALT); human needed"; exit 5 ;;
  6) log "auto-rollback BLOCKED by a reservation merge conflict: the patched code is running again with HALT kept ($HALT); human needed"; exit 6 ;;
  *) drop_halt; log "auto-rollback verification ALSO failed; human needed: journalctl -u $UNIT -n 100"; exit 4 ;;
esac
}
