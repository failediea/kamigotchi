#!/usr/bin/env bash
# remote-install-worker-code.sh - VPS half of deploy-worker-patch.sh. Do not run by hand
# unless you know why; deploy-worker-patch.sh pipes it over ssh with explicit args.
#
#   --action install   back up the market's code files + a state snapshot, copy code
#                      files from STAGING/code, create HALT for the verify window (only
#                      if absent), restart, verify, auto-rollback on failure
#   --action rollback  restore code files from BACKUP_DIR (no heartbeat needed)
#   --action drain     create HALT (the patched worker answers 503 to reserve and attest,
#                      so it signs nothing new) and wait up to --drain-wait sec until no
#                      signed quote in the quote key store can still become a pod (every
#                      quoteDeadline + --drain-margin is past). Exit 0 drained, 10 not yet
#                      (HALT kept). Run before a rollback onto a pre-change worker.
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
# refuses with exit 8 before touching anything). The launch is OPEN (no allowlist):
#   - rentals: RENTER_ALLOWLIST is optional and off by default. Without one the deploy
#     needs open rentals acknowledged: ALLOW_OPEN_RENTALS=true in the market .env, or
#     --allow-open-rentals 1 (deploy: ALLOW_OPEN_RENTALS=true), which install then
#     writes into .env so the worker logs the plain "open rentals" line. Neither -> refuse.
#     A set RENTER_ALLOWLIST is parsed exactly like the worker (last non-empty line
#     wins, trimmed, surrounding quotes stripped, comma separated, every entry 0x + 40
#     hex); with ALLOW_OPEN_RENTALS=true as well it is a loud warning (the list wins);
#   - knobs: every worker knob the .env sets must parse the way the worker parses it
#     (strict integers, minimums/ranges, RESERVATION_TTL_SEC >= 900, TICK_WATCHDOG_SEC
#     above TX_WAIT_TIMEOUT_MS, on/off switches, OPERATOR_TX_PRICING), or the worker
#     holds with [LEASE-ALERT] CONFIG_ERROR and the verify rolls back. install also runs
#     the STAGED renter-pod-config.mjs hardeningConfigFromEnv() over the .env (the
#     worker's own parser) and refuses on any CONFIG_ERROR (the key is named, never
#     the value);
#   - retired knobs (MAX_LIVE_RESERVATIONS, MAX_RESERVATIONS_PER_RENTER, ... : quotes
#     no longer hold capacity) are listed as ignored, never a refusal;
#   - install only, .env appends (atomic, same mode/owner; the only .env writes a
#     deploy makes): MAX_ACTIVE_LEASES_PER_RENTER=2 when absent, and
#     ALLOW_OPEN_RENTALS=true when open rentals were acknowledged by the deploy only.
#
# Quote key store: the patched worker keeps each quote's operator key in
# <state>.reservations.json (snapshot) + <state>.reservations.journal (append-only,
# fsync'd), both mode 600. A pre-change worker (one whose code has no
# renter-pod-quote-store.mjs) reads keys only from the state file and never reads
# the journal, so it must NEVER take over while a quote signed by the patched worker
# can still become a pod: that renter's pod would have no operator key. Rule: HALT +
# drain (--action drain, or `touch HALT` and wait out RESERVATION_TTL_SEC + 60 s),
# then roll back. Quotes the pre-change worker signed itself before the install (in
# the backup's state snapshot) do not count.
#
# Every rollback (manual or automatic) does, in order:
#   1. stop the unit;
#   2. wait (up to --pending-wait sec) until every state.pendingTxs entry is mined or
#      dropped. The pre-hardening worker has no tx tracker and would re-send the same
#      action. Still in flight at the deadline -> the CURRENT code is started again,
#      nothing is restored, exit 5 (a human decides; --force skips this wait). Once all
#      are resolved, the resolved entries (and txNonceHints) are pruned from the state
#      file, so the next deploy's gate T1 does not see them as in flight forever;
#   3. fold the journal into the snapshot with the worker's own CLI
#      (node renter-pod-quote-store.mjs compact, worker stopped), then read the store
#      (snapshot + journal, with the worker's readQuoteStore). If the rollback target
#      has no renter-pod-quote-store.mjs and a quote signed by the patched worker
#      (attested, not in the backup's state snapshot) has quoteDeadline +
#      --drain-margin still ahead: the current code is started again under HALT
#      (created if absent), nothing is restored, exit 10 (drain, then retry). --force
#      does not skip this: waiting at most RESERVATION_TTL_SEC + 60 s always works;
#   4. target without the store module: merge every store entry back into the state
#      file's "reservations" (what the pre-change worker reads), then rename BOTH store
#      files to *.rolled-back-<ts>. A merge conflict -> current code started again,
#      exit 6. Target with the module: the compacted store is left in place (it reads it);
#   5. restore the backed-up code files and start the unit; verify. A HALT that
#      --action drain (or step 3) created is removed once the rollback verifies.
#
# Only code files are ever written: names must match renter-pod-*.mjs,
# kamibots-rental-config*.mjs or *.env.example. node_modules is never touched, and
# .env only gets the guard lines above. The state file is only rewritten by a
# rollback (pendingTxs prune + reservation merge; atomic, same mode/owner), the store
# only by the worker's own compaction during a rollback, and HALT only when this
# script created it.
# RPC for the pendingTxs checks: the market .env YOMINET_RPC (the node the worker
# sends through; never printed), else YOMINET_RPC_PUBLIC, else the public RPC.
# Backups hold code files plus state-snapshot/ (state file + store snapshot + journal,
# mode 600: they contain operator keys). .env is NOT copied (a deploy never changes it).
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

ACTION="" MARKET="" STAGING="" BACKUP_DIR="" VERIFY_SEC=120 REQUIRE_HEARTBEAT=1
VERIFY_HALT=1 FORCE=0 PENDING_WAIT_SEC="${ROLLBACK_PENDING_WAIT_SEC:-300}"
ALLOW_OPEN_RENTALS="${ALLOW_OPEN_RENTALS:-0}" MIN_MEM_MB="${TEST_MIN_MEM_MB:-300}"
DRAIN_WAIT_SEC="${ROLLBACK_DRAIN_WAIT_SEC:-1500}" DRAIN_MARGIN_SEC="${ROLLBACK_DRAIN_MARGIN_SEC:-120}"
DRAIN_POLL_SEC="${DRAIN_POLL_SEC:-30}"
while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="$2"; shift ;;
    --drain-wait) DRAIN_WAIT_SEC="$2"; shift ;;
    --drain-margin) DRAIN_MARGIN_SEC="$2"; shift ;;
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
for v in DRAIN_WAIT_SEC DRAIN_MARGIN_SEC DRAIN_POLL_SEC; do
  [[ "${!v}" =~ ^[0-9]+$ ]] || { echo "$v must be a non-negative integer" >&2; exit 2; }
done

KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
NODE_BIN="${NODE_BIN:-/opt/kami-lease/runtime/node-v22.23.4/bin/node}"
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
live_dir=$(systemctl show "$UNIT" --property=WorkingDirectory --value 2>/dev/null || true)
case "$live_dir" in /opt/kami-lease/releases/*) die "isolated immutable release: do not use the legacy in-place deploy/rollback path; follow ISOLATED-WORKER-ROLLOUT.md" ;; esac

env_value() { # KEY -> value as the worker's .env loader reads it (renter-pod-config.mjs
  # parseEnvText + loadEnvFile: optional "export ", LAST line wins, trimmed, one pair of
  # surrounding quotes stripped; an empty last value means unset). Never printed by callers.
  [ -r "$DIR/.env" ] || return 0
  tr -d '\r' < "$DIR/.env" | sed -nE "s/^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=(.*)\$/\\2/p" | tail -1 \
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
# journalFileFor() in renter-pod-quote-store.mjs: <dir>/<store name minus .json>.journal
JOURNAL="$(dirname "$STORE")/$(basename "$STORE" | sed -E 's/\.[jJ][sS][oO][nN]$//').journal"
HALT=$(env_path WORKER_HALT_FILE "$(dirname "$SF")/HALT")
# Marks a HALT that launch-ops created for a drain/rollback (removed once the rollback
# verifies). A HALT without it belongs to a human and is never removed here.
HALT_MARK="$(dirname "$HALT")/.$(basename "$HALT").launch-ops"
STORE_MODULE="$DIR/renter-pod-quote-store.mjs"
# a legacy signed entry without quoteDeadline counts as live this long (gate R1 window)
ttl=$(env_value RESERVATION_TTL_SEC); [[ "$ttl" =~ ^[0-9]+$ ]] || ttl=1200
INFLIGHT_WIN_SEC=$((ttl + 900))
BASE_SF="" BASE_STORE="" BASE_JOURNAL=""
if [ -n "$BACKUP_DIR" ]; then
  BASE_SF="$BACKUP_DIR/state-snapshot/$(basename "$SF")"
  BASE_STORE="$BACKUP_DIR/state-snapshot/$(basename "$STORE")"
  BASE_JOURNAL="$BACKUP_DIR/state-snapshot/$(basename "$JOURNAL")"
fi

# State-file operations in node (present on the box for the worker; jq is not needed).
# Never prints keys: only counts, job keys, tx hashes and labels.
STATE_JS='
const fs = require("fs"), path = require("path"), url = require("url");
const op = process.env.OP, SF = process.env.SF, STORE = process.env.STORE, JOURNAL = process.env.JOURNAL;
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
// The quote key store as the worker itself reads it: its own readQuoteStore()
// (snapshot + journal: torn tail, stale journal, journal ahead) from the market dir.
// Without that module only a snapshot can be read; a journal then is an error.
async function readStore(file, journal) {
  const mod = process.env.STORE_MODULE;
  if (mod && fs.existsSync(mod)) {
    const { readQuoteStore } = await import(url.pathToFileURL(mod).href);
    return readQuoteStore(file, { journalFile: journal }).reservations;
  }
  if (journal && fs.existsSync(journal)) {
    throw new Error(path.basename(journal) + " exists but the worker quote-store reader (renter-pod-quote-store.mjs) is not installed");
  }
  if (!file || !fs.existsSync(file)) return {};
  const raw = readJson(file);
  const stored = raw && typeof raw === "object" && "reservations" in raw ? raw.reservations : raw;
  const out = {};
  for (const [nonce, r] of Object.entries(stored || {})) out[nonce.toLowerCase()] = r;
  return out;
}
// Can this entry still become a pod? Signed (attestedDigest) and its quoteDeadline
// (+ margin for block time) is ahead; a legacy entry without quoteDeadline counts
// while it is younger than the in-flight window.
function live(r, nowSec) {
  if (!r || typeof r !== "object" || !r.attestedDigest) return false;
  const d = Number(r.quoteDeadline);
  const margin = Number(process.env.DRAIN_MARGIN_SEC || 120);
  if (d > 0) return d + margin > nowSec;
  return nowSec * 1000 - Number(r.createdAt || 0) < Number(process.env.INFLIGHT_WIN_SEC || 2100) * 1000;
}
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
  } else if (op === "store-status") {
    // Counts only. newLive = live entries whose nonce was not already signed in the
    // backup taken before the install (quotes the rollback target never saw).
    const nowSec = Math.floor(Date.now() / 1000);
    const res = await readStore(STORE, JOURNAL);
    const base = new Set();
    if (process.env.BASE_SF && fs.existsSync(process.env.BASE_SF)) {
      for (const [n, r] of Object.entries(readJson(process.env.BASE_SF).reservations || {})) if (r && r.attestedDigest) base.add(n.toLowerCase());
    }
    if (process.env.BASE_STORE) {
      for (const [n, r] of Object.entries(await readStore(process.env.BASE_STORE, process.env.BASE_JOURNAL))) if (r && r.attestedDigest) base.add(n);
    }
    let attested = 0, liveN = 0, newLive = 0, waitSec = 0, waitAllSec = 0;
    const margin = Number(process.env.DRAIN_MARGIN_SEC || 120);
    for (const [n, r] of Object.entries(res)) {
      if (r && r.attestedDigest) attested++;
      if (!live(r, nowSec)) continue;
      liveN++;
      const w = Number(r.quoteDeadline) > 0 ? Number(r.quoteDeadline) + margin - nowSec
        : Math.ceil((Number(process.env.INFLIGHT_WIN_SEC || 2100) * 1000 - (nowSec * 1000 - Number(r.createdAt || 0))) / 1000);
      waitAllSec = Math.max(waitAllSec, w);
      if (!base.has(n)) { newLive++; waitSec = Math.max(waitSec, w); }
    }
    const reader = process.env.STORE_MODULE && fs.existsSync(process.env.STORE_MODULE) ? "worker-module" : "snapshot-only";
    console.log(`STORE entries=${Object.keys(res).length} attested=${attested} live=${liveN} newLive=${newLive} waitSec=${waitSec} waitAllSec=${waitAllSec} journal=${JOURNAL && fs.existsSync(JOURNAL) ? "yes" : "no"} reader=${reader}`);
  } else if (op === "merge") {
    if (!fs.existsSync(STORE) && !(JOURNAL && fs.existsSync(JOURNAL))) { console.log("MERGED 0 (no reservation store)"); return; }
    const stored = await readStore(STORE, JOURNAL);
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
state_op() {
  OP="$1" SF="$SF" STORE="$STORE" JOURNAL="$JOURNAL" RPC="$RPC" STORE_MODULE="$STORE_MODULE" \
    BASE_SF="$BASE_SF" BASE_STORE="$BASE_STORE" BASE_JOURNAL="$BASE_JOURNAL" \
    DRAIN_MARGIN_SEC="$DRAIN_MARGIN_SEC" INFLIGHT_WIN_SEC="$INFLIGHT_WIN_SEC" "$NODE_BIN" -e "$STATE_JS"
}

# Launch guards over the market .env, parsed like the worker (renter-pod-config.mjs
# parseEnvText + loadEnvFile, parseRenterAllowlist, hardeningConfigFromEnv). Prints
# counts, knob numbers and key NAMES only: never an address, token, key or URL.
GUARD_JS='
const fs = require("fs");
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const problems = [], warnings = [];
const env = {};
// renter-pod-config.mjs stripMatchingQuotes: ONE pair of matching quotes, else unchanged
const strip = (v) => {
  const t = String(v);
  return t.length >= 2 && (t[0] === "\"" || t[0] === "\x27") && t[t.length - 1] === t[0] ? t.slice(1, -1) : t;
};
if (!fs.existsSync(process.env.ENV_FILE)) problems.push("no .env in the market dir");
else {
  // parseEnvText + loadEnvFile: optional "export ", any-case keys, LAST line wins
  // (a later empty line overrides an earlier value), an empty final value is not loaded.
  const raw = {};
  for (const line of fs.readFileSync(process.env.ENV_FILE, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    if (m) raw[m[1]] = strip(m[2].trim());
  }
  for (const [k, v] of Object.entries(raw)) if (v) env[k] = v;
}
// parseRenterAllowlist: trim, strip one pair of matching quotes, trim, split on ",",
// skip empty entries, every entry 0x + 40 hex, at least one address.
let renters = 0;
if (env.RENTER_ALLOWLIST !== undefined) {
  const list = strip(String(env.RENTER_ALLOWLIST).trim()).trim();
  const set = new Set();
  list.split(",").forEach((entry, i) => {
    const a = entry.trim();
    if (!a) return;
    if (!ADDRESS_RE.test(a)) problems.push(`RENTER_ALLOWLIST entry ${i + 1} is not a 0x+40-hex address (length ${a.length}): the worker holds with CONFIG_ERROR`);
    else set.add(a.toLowerCase());
  });
  if (list && !set.size && !problems.length) problems.push("RENTER_ALLOWLIST is set but lists no address: the worker holds with CONFIG_ERROR");
  renters = set.size;
}
// hardeningConfigFromEnv (+ prefsFloorFromEnv): name -> [min, max]
const strictInt = (raw) => { const t = strip(String(raw).trim()).trim(); return /^-?\d+$/.test(t) ? Number(t) : NaN; };
const INT = {
  MAX_ACTIVE_LEASES: [1], MAX_ACTIVE_LEASES_PER_RENTER: [1], RESERVATION_TTL_SEC: [900],
  TX_WAIT_TIMEOUT_MS: [1], FETCH_TIMEOUT_MS: [1], TICK_WATCHDOG_SEC: [1], HEARTBEAT_STALE_SEC: [1],
  EXIT_RESERVE_ACTIONS: [1], ALERT_MIN_INTERVAL_SEC: [1], STAGE_STUCK_ALERT_SEC: [1],
  KAMIBOTS_STOP_MAX_FAILURES: [1], KAMIBOTS_RETRY_MAX_SEC: [1], RETIRED_JOB_RETENTION_DAYS: [1],
  EXIT_RESUME_HEADROOM_ACTIONS: [0], STRATEGY_RESTART_MIN_INTERVAL_SEC: [0],
  LOG_CHUNK_BLOCKS: [100, 1000000], LOG_CHUNKS_PER_TICK: [1, 1000],
};
const SWITCHES = ["PREFS_CADENCE_GUARD", "REQUIRE_RENTER_BALANCE", "PREFS_FLOOR"];
const switchValue = (k) => {
  if (env[k] === undefined) return null;
  const v = strip(String(env[k]).trim()).trim().toLowerCase();
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  problems.push(`${k} must be on or off: the worker holds with CONFIG_ERROR`);
  return null;
};
const sw = {};
for (const k of SWITCHES) sw[k] = switchValue(k);
if (sw.PREFS_FLOOR !== false) {
  Object.assign(INT, {
    PREFS_FLOOR_HP_LOW_MIN: [5, 90], PREFS_FLOOR_FARM_INTERVAL_MAX_SEC: [1200, 72000],
    PREFS_FLOOR_SAFETY_MARGIN_MIN: [0, 10], PREFS_FLOOR_FEED_PERCENT_MIN: [1, 99],
    PREFS_FLOOR_REST_PCT_OF_FARM: [1, 200], PREFS_FLOOR_FAILSAFE_REST_MIN_SEC: [60, 72000],
  });
  switchValue("PREFS_FLOOR_FORCE_HP_FEED");
}
const shown = [], values = {};
for (const [k, [min, max]] of Object.entries(INT)) {
  if (env[k] === undefined) continue;
  const n = strictInt(env[k]);
  if (!Number.isSafeInteger(n) || n < min || (max !== undefined && n > max)) {
    problems.push(`${k} must be an integer ${max === undefined ? ">= " + min : "in " + min + ".." + max}: the worker holds with CONFIG_ERROR`);
  } else { values[k] = n; shown.push(`${k}=${n}`); }
}
if ((values.TICK_WATCHDOG_SEC ?? 600) * 1000 <= (values.TX_WAIT_TIMEOUT_MS ?? 120000)) {
  problems.push("TICK_WATCHDOG_SEC must exceed TX_WAIT_TIMEOUT_MS: the worker holds with CONFIG_ERROR");
}
if (env.OPERATOR_TX_PRICING !== undefined && !["eip1559", "legacy"].includes(strip(String(env.OPERATOR_TX_PRICING).trim()).trim().toLowerCase())) {
  problems.push("OPERATOR_TX_PRICING must be eip1559 or legacy: the worker holds with CONFIG_ERROR");
}
if (sw.REQUIRE_RENTER_BALANCE === false) warnings.push("REQUIRE_RENTER_BALANCE=off: the keeper attests quotes for unfunded wallets (the balance filter is off)");
// renter-pod-config.mjs RETIRED_HARDENING_KNOBS: ignored by the worker, never fatal
const RETIRED = ["MAX_LIVE_RESERVATIONS", "MAX_RESERVATIONS_PER_RENTER", "MAX_RESERVATIONS_PER_LISTING",
  "LISTING_SINGLE_CHECKOUT", "LISTING_RESERVE_COOLDOWN_SEC", "MAX_RESERVATION_ATTEMPTS_PER_RENTER"];
const retired = RETIRED.filter((k) => env[k] !== undefined);
// the worker startup log: /^(1|true|yes|on)$/i on the loaded value
const openAck = /^(1|true|yes|on)$/i.test(String(env.ALLOW_OPEN_RENTALS ?? "").trim());
console.log("ALLOWLIST " + renters);
console.log("OPEN_ACK_ENV " + (openAck ? "yes" : "no"));
console.log("PER_RENTER " + (env.MAX_ACTIVE_LEASES_PER_RENTER === undefined ? "absent" : "present"));
console.log("KNOBS " + (shown.join(" ") || "none-set(defaults)"));
console.log("RETIRED " + (retired.join(",") || "none"));
for (const w of warnings) console.log("WARN " + w);
for (const p of problems) console.log("PROBLEM " + p);
'
# The worker's OWN parser from the staged code (install only): any ConfigError is a
# refusal. Prints the offending key name only (ConfigError.key), never a value.
CONFIG_JS='
const fs = require("fs"), url = require("url");
(async () => {
  const cfg = await import(url.pathToFileURL(process.env.CONFIG_MODULE).href);
  const env = {};
  for (const [k, v] of Object.entries(cfg.parseEnvText(fs.readFileSync(process.env.ENV_FILE, "utf8")))) if (v !== "") env[k] = v;
  try { cfg.hardeningConfigFromEnv(env); console.log("CONFIG ok"); }
  catch (e) { console.log("CONFIG_ERROR " + (e && e.key ? e.key : (e && e.name) || "unknown")); }
})().catch((e) => { console.log("CONFIG_UNAVAILABLE " + String(e && e.name || "error")); });
'
GUARD_PER_RENTER="" GUARD_APPEND_OPEN=0
launch_guards() { # -> 0 ok, 8 refuse (logs why); sets GUARD_PER_RENTER=present|absent, GUARD_APPEND_OPEN
  local out n p refuse=0 per ack_env mode ack cfg retired
  out=$(ENV_FILE="$DIR/.env" "$NODE_BIN" -e "$GUARD_JS" 2>&1) || { log "launch guards: REFUSE cannot evaluate $DIR/.env"; return 8; }
  n=$(sed -n 's/^ALLOWLIST //p' <<<"$out"); n=${n:-0}
  ack_env=$(sed -n 's/^OPEN_ACK_ENV //p' <<<"$out")
  GUARD_PER_RENTER=$(sed -n 's/^PER_RENTER //p' <<<"$out")
  retired=$(sed -n 's/^RETIRED //p' <<<"$out")
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    log "launch guards: REFUSE $p"; refuse=1
  done < <(sed -n 's/^PROBLEM //p' <<<"$out")
  while IFS= read -r p; do
    [ -n "$p" ] || continue
    log "launch guards: WARNING $p"
  done < <(sed -n 's/^WARN //p' <<<"$out")
  # authoritative: the staged worker config parser (install; the dry run has no staging)
  if [ -n "$STAGING" ] && [ -f "$STAGING/code/renter-pod-config.mjs" ] && [ -f "$DIR/.env" ]; then
    cfg=$(ENV_FILE="$DIR/.env" CONFIG_MODULE="$STAGING/code/renter-pod-config.mjs" "$NODE_BIN" -e "$CONFIG_JS" 2>&1 | tail -1)
    case "$cfg" in
      "CONFIG ok") log "launch guards: the staged worker config parser accepts $DIR/.env" ;;
      CONFIG_ERROR*) log "launch guards: REFUSE the staged worker rejects $DIR/.env: [LEASE-ALERT] CONFIG_ERROR key=${cfg#CONFIG_ERROR } would hold the worker"; refuse=1 ;;
      *) log "launch guards: REFUSE cannot run the staged worker config parser (${cfg:-no output})"; refuse=1 ;;
    esac
  fi
  ack=none
  if [ "$ack_env" = yes ]; then ack=env; elif [ "$ALLOW_OPEN_RENTALS" = 1 ]; then ack=deploy; fi
  GUARD_APPEND_OPEN=0
  if [ "$n" = 0 ]; then
    mode=open
    case "$ack" in
      env) log "launch guards: open rentals (no RENTER_ALLOWLIST), acknowledged by ALLOW_OPEN_RENTALS=true in $DIR/.env: the keeper attests quotes for any renter the quote API sends" ;;
      deploy) GUARD_APPEND_OPEN=1
        log "launch guards: open rentals (no RENTER_ALLOWLIST), acknowledged by this deploy (ALLOW_OPEN_RENTALS=true); install writes ALLOW_OPEN_RENTALS=true into $DIR/.env" ;;
      *) log "launch guards: REFUSE open rentals are not acknowledged: $DIR/.env has no RENTER_ALLOWLIST and no ALLOW_OPEN_RENTALS=true. For the public launch run the deploy with ALLOW_OPEN_RENTALS=true (or add the UNQUOTED line ALLOW_OPEN_RENTALS=true to .env); to restrict renters instead set RENTER_ALLOWLIST=0x..,0x.. (the same list as Vercel LEASE_RENTER_ALLOWLIST)"
        refuse=1 ;;
    esac
  else
    mode="allowlist($n)"
    if [ "$ack" != none ]; then
      log "launch guards: WARNING ALLOW_OPEN_RENTALS=true but $DIR/.env sets RENTER_ALLOWLIST ($n renter(s)): the allowlist wins and only those renters can rent. Remove the RENTER_ALLOWLIST line for open rentals"
    fi
  fi
  per="present (kept)"; [ "$GUARD_PER_RENTER" = present ] || per="absent (install appends MAX_ACTIVE_LEASES_PER_RENTER=2)"
  [ "$retired" = none ] || log "launch guards: ignored retired settings in $DIR/.env (quotes no longer hold capacity; the worker ignores them): $retired"
  log "launch guards [$MARKET]: rentals=$mode openAck=$ack knobs: $(sed -n 's/^KNOBS //p' <<<"$out") perRenterCap=$per retired=$retired"
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

ensure_halt() { # reason: create HALT (+ the launch-ops mark) unless a HALT is already there
  if [ -e "$HALT" ]; then
    log "HALT already present at $HALT (kept)"
    return 0
  fi
  printf 'launch-ops %s %s\n' "$1" "$TS_NOW" > "$HALT_MARK"
  : > "$HALT"
  log "created $HALT ($1): the patched worker answers 503 to reserve and attest and signs nothing new; it keeps ingesting"
}
release_launch_ops_halt() { # remove a HALT that launch-ops created for a drain/rollback
  if [ -e "$HALT_MARK" ]; then
    rm -f "$HALT" "$HALT_MARK"
    log "removed $HALT (created by a launch-ops drain/rollback)"
  fi
}

STORE_NEW_LIVE="" STORE_LIVE="" STORE_WAIT="" STORE_WAIT_ALL=""
store_status() { # -> 0 when read; sets STORE_*; logs counts only
  local out line
  out=$(state_op store-status 2>&1) || { log "quote store unreadable: $(tail -1 <<<"$out")"; return 1; }
  line=$(sed -n 's/^STORE //p' <<<"$out" | tail -1)
  [ -n "$line" ] || { log "quote store status missing: $(tail -1 <<<"$out")"; return 1; }
  log "quote store: $line"
  STORE_LIVE=$(sed -nE 's/.* live=([0-9]+) .*/\1/p' <<<"$line")
  STORE_NEW_LIVE=$(sed -nE 's/.* newLive=([0-9]+) .*/\1/p' <<<"$line")
  STORE_WAIT=$(sed -nE 's/.* waitSec=(-?[0-9]+) .*/\1/p' <<<"$line")
  STORE_WAIT_ALL=$(sed -nE 's/.* waitAllSec=(-?[0-9]+) .*/\1/p' <<<"$line")
  [[ "$STORE_LIVE" =~ ^[0-9]+$ && "$STORE_NEW_LIVE" =~ ^[0-9]+$ ]] || { log "quote store status unparsable"; return 1; }
}
compact_store() { # worker STOPPED: fold the journal into the snapshot with the worker's own CLI
  local out
  [ -e "$JOURNAL" ] || { log "quote store: no journal, nothing to compact"; return 0; }
  [ -f "$STORE_MODULE" ] || { log "quote store: $(basename "$JOURNAL") exists but $STORE_MODULE is missing"; return 1; }
  out=$("$NODE_BIN" "$STORE_MODULE" compact "$STORE" 2>&1) || { log "quote store compaction failed: $(tail -1 <<<"$out")"; return 1; }
  log "quote store: $(tail -1 <<<"$out")"
}
target_reads_store() { [ -f "$BACKUP_DIR/renter-pod-quote-store.mjs" ]; }

merge_reservations_back() {
  local out f
  out=$(state_op merge 2>&1) || { log "reservation merge failed: $out"; return 1; }
  log "reservation store -> state file: $out"
  for f in "$STORE" "$JOURNAL"; do
    if [ -e "$f" ]; then
      mv -f "$f" "$f.rolled-back-$TS_NOW"
      log "$(basename "$f") renamed to $(basename "$f").rolled-back-$TS_NOW (the rollback target does not read it; it holds keys, mode kept)"
    fi
  done
}

# Rollback core, shared by --action rollback and the auto-rollback of --action install.
# Returns 0 ok, 5 pending txs (current code restarted), 6 store/merge failed (current
# code restarted), 7 old code started but did not verify, 10 quotes signed by the
# current worker not drained yet (current code restarted under HALT).
rollback_to_backup() {
  local before start
  before=$(protected_sums)
  log "stopping $UNIT for the rollback (SIGTERM: the patched worker compacts its quote store)"
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
  # the quote key store: compact (worker stopped), then read it as the worker does
  if ! compact_store || ! store_status; then
    log "[LEASE-ALERT] STAGE_STUCK market=$MARKET unit=$UNIT rollback=blocked reason=quote-store-unreadable action=current-code-restarted-with-HALT"
    ensure_halt rollback-blocked
    systemctl start "$UNIT"
    return 6
  fi
  if target_reads_store; then
    log "quote store: the rollback target has renter-pod-quote-store.mjs and reads this store itself; left in place (compacted)"
  else
    if [ "$STORE_NEW_LIVE" != 0 ]; then
      log "[LEASE-ALERT] STAGE_STUCK market=$MARKET unit=$UNIT rollback=blocked reason=quotes-not-drained live=$STORE_NEW_LIVE waitSec=$STORE_WAIT action=current-code-restarted-with-HALT"
      log "  $STORE_NEW_LIVE quote(s) signed by the current worker can still become pods, and the pre-change worker would not have their keys. HALT is set so nothing new is signed; retry the rollback in ${STORE_WAIT}s (or run --action drain first)."
      ensure_halt drain
      systemctl start "$UNIT"
      return 10
    fi
    if ! merge_reservations_back; then
      log "[LEASE-ALERT] STAGE_STUCK market=$MARKET unit=$UNIT rollback=blocked reason=reservation-merge-failed action=current-code-restarted"
      systemctl start "$UNIT"
      return 6
    fi
  fi
  restore_from "$BACKUP_DIR"
  [ "$before" = "$(protected_sums)" ] || die ".env files changed during rollback (should be impossible)"
  start=$(date +%s)
  systemctl start "$UNIT"
  NRESTARTS_BEFORE=$(systemctl show "$UNIT" -p NRestarts --value)
  verify "$start" 0 || return 7
}

if [ "$ACTION" = drain ]; then
  # HALT + wait until no signed quote in the store can still become a pod. The worker
  # keeps running (ingest, pruning); only reserve/attest answer 503.
  log "drain: waiting up to ${DRAIN_WAIT_SEC}s (margin ${DRAIN_MARGIN_SEC}s past each quoteDeadline)"
  ensure_halt drain
  drain_end=$(( $(date +%s) + DRAIN_WAIT_SEC ))
  while :; do
    store_status || die "drain: cannot read the quote store (HALT kept)"
    if [ "$STORE_LIVE" = 0 ]; then
      log "drain: DRAINED (no signed quote can still become a pod); HALT stays until the rollback verifies"
      exit 0
    fi
    if [ "$(date +%s)" -ge "$drain_end" ]; then
      log "drain: NOT drained after ${DRAIN_WAIT_SEC}s: $STORE_LIVE live quote(s), about ${STORE_WAIT_ALL}s left. HALT kept; re-run --action drain"
      exit 10
    fi
    log "drain: $STORE_LIVE live quote(s), about ${STORE_WAIT_ALL}s left"
    sleep "$DRAIN_POLL_SEC"
  done
fi

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
  # Fail fast (nothing stopped yet) while quotes only the current worker knows can
  # still become pods. --force does not skip this.
  if ! target_reads_store; then
    store_status || die "rollback refused: cannot read the quote store (nothing was changed)"
    if [ "$STORE_NEW_LIVE" != 0 ]; then
      log "rollback refused: $STORE_NEW_LIVE quote(s) signed by the current worker can still become pods (keys only in its store). HALT + drain first: deploy-worker-patch.sh --rollback <ts> --drain, or on the box --action drain; about ${STORE_WAIT}s left. Nothing was changed."
      exit 10
    fi
  fi
  rc=0; rollback_to_backup || rc=$?
  case "$rc" in
    0) release_launch_ops_halt; log "rollback OK"; exit 0 ;;
    5|6) die "rollback blocked (code $rc); the current code was started again" ;;
    10) log "rollback blocked: quotes not drained; the current code was started again under HALT"; exit 10 ;;
    *) die "rollback verification failed; inspect: journalctl -u $UNIT -n 100" ;;
  esac
fi

[ "$ACTION" = install ] || die "--action install|rollback|drain|guards|test"
[ -d "$STAGING/code" ] || die "no staging code at $STAGING/code"
[ -n "$BACKUP_DIR" ] || die "--backup-dir required"

# Launch guards BEFORE anything is backed up, copied or restarted.
if ! launch_guards; then
  log "install refused by the launch guards; nothing was changed"
  exit 8
fi
if [ "$GUARD_PER_RENTER" != present ]; then
  append_env_line "MAX_ACTIVE_LEASES_PER_RENTER=2"
  log "appended MAX_ACTIVE_LEASES_PER_RENTER=2 to $DIR/.env (per-renter on-chain lease cap; mode/owner kept)"
fi
if [ "$GUARD_APPEND_OPEN" = 1 ]; then
  append_env_line "ALLOW_OPEN_RENTALS=true"
  log "appended ALLOW_OPEN_RENTALS=true to $DIR/.env (open rentals acknowledged by this deploy; mode/owner kept)"
fi
log "pendingTxs RPC: $RPC_SRC"

log "backup: code files + state snapshot (state file, quote store snapshot + journal) -> $BACKUP_DIR (mode 700; .env is not copied)"
mkdir -p "$BACKUP_DIR/state-snapshot"
chmod 700 "$(dirname "$BACKUP_DIR")" "$BACKUP_DIR" "$BACKUP_DIR/state-snapshot"
for f in "$DIR"/*; do
  [ -f "$f" ] && is_code "$(basename "$f")" && cp -a "$f" "$BACKUP_DIR/"
done
for f in "$SF" "$STORE" "$JOURNAL"; do
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
  0) drop_halt; release_launch_ops_halt; log "auto-rollback OK (old code running)"; exit 4 ;;
  # 5/6/10: the patched code (which failed verify) runs again. HALT is KEPT so it
  # signs no new quotes until a human has looked; remove it by hand when done.
  5) log "auto-rollback BLOCKED by in-flight txs: the patched code is running again with HALT kept ($HALT); human needed"; exit 5 ;;
  6) log "auto-rollback BLOCKED by the quote store or a reservation merge conflict: the patched code is running again with HALT kept ($HALT); human needed"; exit 6 ;;
  10) log "auto-rollback BLOCKED: quotes signed by the patched worker are still live (VERIFY_HALT=0?); it runs again with HALT; re-run the rollback after the quote deadlines ($HALT)"; exit 10 ;;
  *) drop_halt; log "auto-rollback verification ALSO failed; human needed: journalctl -u $UNIT -n 100"; exit 4 ;;
esac
}
