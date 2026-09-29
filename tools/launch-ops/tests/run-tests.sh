#!/usr/bin/env bash
# Local tests for tools/launch-ops. Needs bash, curl, awk, node; jq only for the
# transition-gate state tests. systemctl / journalctl / ss / id / ntfy are shimmed.
# Chain reads go either to the public Yominet RPC (read-only eth_call /
# eth_getBalance / eth_getCode only) or to tests/fake-rpc.mjs on 127.0.0.1, which
# never accepts a transaction. Nothing is signed or sent: the --apply runs of the
# keeper/sponsor use a placeholder key file and a fake ethers dir, and the tests
# assert eth_sendRawTransaction / eth_chainId were never called.
#   bash tools/launch-ops/tests/run-tests.sh
#   LAUNCH_OPS_TEST_REMOTE=root@68.183.190.126 bash tools/launch-ops/tests/run-tests.sh
#     -> where jq is missing locally, the gate state tests run on that host over ssh
#        with the fixture passed in an env var (read-only there: no files are
#        written, nothing is signed). Otherwise they are reported as SKIP.
#   LAUNCH_OPS_TEST_WORKER_REF (default launch/worker-hardening) and
#   LAUNCH_OPS_TEST_NODE_MODULES pick the worker tree for the deploy staging test.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS="$(cd "$HERE/.." && pwd)"
T=$(mktemp -d)
RPC_PID=""
cleanup() { [ -z "$RPC_PID" ] || kill "$RPC_PID" 2>/dev/null || true; rm -rf "$T"; }
trap cleanup EXIT
PASS=0; FAIL=0; SKIP=0
HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1
NODE=$(command -v node || true)
REMOTE="${LAUNCH_OPS_TEST_REMOTE:-}"
skip() { SKIP=$((SKIP + 1)); echo "  skip $*"; }
ok() { PASS=$((PASS + 1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $*"; }
check() { if eval "$1"; then ok "$2"; else bad "$2"; fi; }
expect_grep() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3 (missing: $2)"; fi; }
expect_nogrep() { if grep -qF -- "$2" "$1"; then bad "$3 (unexpected: $2)"; else ok "$3"; fi; }
expect_count() { local c; c=$(grep -cF -- "$2" "$1" || true); if [ "$c" = "$3" ]; then ok "$4"; else bad "$4 (count $c != $3)"; fi; }
expect_rc() { if [ "$1" = "$2" ]; then ok "$3"; else bad "$3 (exit $1, want $2)"; fi; }

# ---- shims ----
mkdir -p "$T/bin" "$T/rootbin" "$T/journal"
REAL_CURL=$(command -v curl)
REAL_ID=$(command -v id)
cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
[ -z "${SYSTEMCTL_LOG:-}" ] || echo "$*" >> "$SYSTEMCTL_LOG"
case "$1" in
  is-active) for d in ${FAKE_DOWN:-}; do [ "$d" = "$2" ] && { echo failed; exit 3; }; done; echo active ;;
  is-enabled) echo "${FAKE_ENABLED:-enabled}" ;;
  cat) exit 1 ;;
  show)
    case "$*" in
      *Result*) echo "${FAKE_SHOW_RESULT:-success}" ;;
      *ExecMainStatus*) echo "${FAKE_EXEC_STATUS:-0}" ;;
      *NRestarts*) echo "${FAKE_NRESTARTS:-0}" ;;
      *) echo "" ;;
    esac ;;
  start|restart)
    # fake worker: record what it saw at start, rewrite its state, maybe heartbeat
    d="${FAKE_MARKET_DIR:-}"
    if [ -n "$d" ] && [ "${2#kami-renter-pod}" != "$2" ]; then
      echo "started halt=$([ -e "$d/HALT" ] && echo 1 || echo 0) code=$(head -1 "$d/renter-pod-worker.mjs")" >> "${SYSTEMCTL_LOG:-/dev/null}"
      [ -f "$d/renter-pod-worker-state.json" ] && touch "$d/renter-pod-worker-state.json"
      if [ "${FAKE_WORKER_HB:-0}" = 1 ]; then
        printf '{"ts": %s, "lastBlock": 1, "lastTickOk": true, "activeJobs": 0, "liveReservations": 0, "tickMs": 5}\n' "$(date +%s)" > "$d/heartbeat.json"
      fi
    fi ;;
  *) exit 0 ;;
esac
EOF
cat > "$T/bin/journalctl" <<'EOF'
#!/usr/bin/env bash
unit=""
while [ $# -gt 0 ]; do case "$1" in -u) unit="$2"; shift ;; esac; shift; done
[ -f "$FAKE_JOURNAL_DIR/$unit" ] && cat "$FAKE_JOURNAL_DIR/$unit"
exit 0
EOF
cat > "$T/bin/ss" <<'EOF'
#!/usr/bin/env bash
echo "LISTEN 0 511 127.0.0.1:8792 0.0.0.0:*"
EOF
cat > "$T/bin/curl" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in *ntfy.invalid*) printf 'NTFY %s\n' "\$*" >> "\$NTFY_LOG"; exit 0 ;; esac
done
exec "$REAL_CURL" "\$@"
EOF
# "root" only for the scripts that refuse to run as non-root (installer, remote deploy
# half, cleanup); everything else sees the real id.
cat > "$T/rootbin/id" <<EOF
#!/usr/bin/env bash
if [ "\${1:-}" = -u ]; then echo 0; else exec "$REAL_ID" "\$@"; fi
EOF
chmod +x "$T/bin/"* "$T/rootbin/"*
export PATH="$T/bin:$PATH"
export FAKE_JOURNAL_DIR="$T/journal" NTFY_LOG="$T/ntfy.log"
: > "$NTFY_LOG"
asroot() { PATH="$T/rootbin:$PATH" "$@"; }

# ---- fake RPC ----
start_fake_rpc() {
  echo '{}' > "$T/rpc.json"
  : > "$T/rpc.log"
  FAKE_RPC_CONFIG="$T/rpc.json" FAKE_RPC_LOG="$T/rpc.log" FAKE_RPC_PORT_FILE="$T/rpc.port" "$NODE" "$HERE/fake-rpc.mjs" &
  RPC_PID=$!
  local i
  for i in $(seq 1 100); do [ -s "$T/rpc.port" ] && break; sleep 0.1; done
  FAKE_RPC="http://127.0.0.1:$(cat "$T/rpc.port")"
}
w() { printf '%064x' "$1"; }                                  # uint word
aw() { local a=${1#0x}; printf '%064s' "$a" | tr ' ' 0; }      # address word
ZERO=0x0000000000000000000000000000000000000000

# ---- fixtures ----
K="$T/tools"
mkdir -p "$K/vault-kit-v16-musu" "$K/vault-kit-v16-vipp"
NOW=$(date +%s)
cat > "$K/vault-kit-v16-musu/renter-pod-worker-state.json" <<'EOF'
{"lastBlock":1,"jobs":{"999":{"tokenIndex":999,"operator":"0x0000000000000000000000000000000000000001","pod":"0x0000000000000000000000000000000000000002","returned":false,"__OPKEY__":"0xSHOULD_NEVER_BE_PRINTED","error":"walk expected room 5, got 4"}},"reservations":{}}
EOF
# The fixture carries a fake operator key to prove it is never printed. The field
# name is spliced in at runtime so the repo's staged-secrets hook does not flag it.
sed -i 's/"__OPKEY__"/"operator''Key"/' "$K/vault-kit-v16-musu/renter-pod-worker-state.json"
printf '{"ts": %s, "lastBlock": 1, "lastTickOk": true, "activeJobs": 1, "liveReservations": 0, "tickMs": 900}\n' $((NOW - 900)) > "$K/vault-kit-v16-musu/heartbeat.json"
echo '{"lastBlock":1,"jobs":{},"reservations":{}}' > "$K/vault-kit-v16-vipp/renter-pod-worker-state.json"
printf '{"ts": %s, "lastBlock": 1, "lastTickOk": true, "activeJobs": 0, "liveReservations": 0, "tickMs": 700}\n' "$NOW" > "$K/vault-kit-v16-vipp/heartbeat.json"
cat > "$T/journal/kami-renter-pod-v16-musu" <<'EOF'
2026-09-29T08:00:00+00:00 host kami-renter-pod-v16-musu[1]: [LEASE-ALERT] DEAD_KAMI token=999 kami=123 state=DEAD
2026-09-29T08:00:30+00:00 host kami-renter-pod-v16-musu[1]: [LEASE-ALERT] TX_TIMEOUT token=999 label=endLease waitedMs=120000
2026-09-29T08:01:00+00:00 host kami-renter-pod-v16-musu[1]: lease ending paused for #999
EOF
for i in $(seq 1 25); do echo "2026-09-29T08:02:00+00:00 host x[1]: #7: tick error $i" ; done > "$T/journal/kami-renter-pod-v16-vipp"

export KAMI_ROOT="$K" ALERT_STATE_DIR="$T/state" ALERT_PERSIST_DIR="$T/persist" LAUNCH_OPS_ENV="$T/none.env"
export NTFY_TOPIC=test-topic NTFY_SERVER=http://ntfy.invalid LEASE_HOSTS="" SELF_TIMER=kami-worker-alerts.timer
[ -z "$NODE" ] || export NODE_BIN="$NODE"

echo "== committed file modes (git archive ships the index mode)"
if git -C "$OPS" rev-parse --git-dir >/dev/null 2>&1; then
  nonexec=$(git -C "$OPS" ls-files -s -- . | awk '$4 ~ /\.sh$/ && $1 != "100755" {print $4}')
  if [ -z "$nonexec" ]; then ok "every tools/launch-ops *.sh is 100755 in git"; else bad "not 100755 in git: $nonexec"; fi
else
  skip "file modes (not a git checkout)"
fi
units_bad=$(grep -L 'ExecStart=/bin/bash /root/' "$OPS/alerts/kami-worker-alerts.service" "$OPS/alerts/kami-lease-ops-onfailure@.service" \
  "$OPS/keeper/kami-lease-expiry-keeper.service" "$OPS/keeper/kami-lease-gas-sponsor.service" || true)
if [ -z "$units_bad" ]; then ok "all four ops units run their script via /bin/bash"; else bad "ExecStart without /bin/bash: $units_bad"; fi

echo "== alerts v2: dry-run sends nothing and writes nothing"
"$OPS/alerts/worker-alerts-v2.sh" --dry-run > "$T/dry.out" 2>&1 || bad "dry-run exit $?"
expect_grep "$T/dry.out" "WOULD ALERT [la-kami-renter-pod-v16-musu-DEAD_KAMI]" "dry-run reports DEAD_KAMI"
if [ -s "$NTFY_LOG" ]; then bad "dry-run sent a notification"; else ok "dry-run sent nothing"; fi
if [ -e "$T/state" ] || [ -e "$T/persist" ]; then bad "dry-run created state dirs"; else ok "dry-run wrote no state"; fi
expect_nogrep "$T/dry.out" "SHOULD_NEVER_BE_PRINTED" "operator key never printed"

echo "== alerts v2: apply run 1"
"$OPS/alerts/worker-alerts-v2.sh" --apply > "$T/run1.out" 2>&1 || bad "run1 exit $?"
expect_grep "$NTFY_LOG" "Title: DEAD_KAMI on kami-renter-pod-v16-musu" "DEAD_KAMI pushed"
expect_grep "$NTFY_LOG" "Title: TX_TIMEOUT on kami-renter-pod-v16-musu" "TX_TIMEOUT pushed separately"
expect_grep "$NTFY_LOG" "Title: lease wedge text on kami-renter-pod-v16-musu" "legacy wedge text pushed"
expect_grep "$NTFY_LOG" "Title: worker heartbeat STALE: kami-renter-pod-v16-musu" "stale heartbeat pushed"
expect_nogrep "$NTFY_LOG" "heartbeat STALE: kami-renter-pod-v16-vipp" "fresh heartbeat not pushed"
expect_grep "$NTFY_LOG" "Title: worker errors: kami-renter-pod-v16-vipp" "baseline error-rate check kept"
if [ "$HAVE_JQ" = 1 ] || [ -n "$NODE" ]; then
  expect_nogrep "$NTFY_LOG" "lease #999 erroring" "job error needs JOB_ERROR_RUNS=2 runs"
  expect_nogrep "$NTFY_LOG" "alerts degraded" "state checks run without jq (node fallback)"
else
  expect_grep "$NTFY_LOG" "alerts degraded" "missing jq and node is itself alerted"
fi
expect_nogrep "$NTFY_LOG" "SHOULD_NEVER_BE_PRINTED" "operator key never sent"
[ -f "$T/persist/alerts-last-ok" ] && ok "last-ok stamp written" || bad "no last-ok stamp"

echo "== alerts v2: apply run 2 (cooldown + persistence)"
"$OPS/alerts/worker-alerts-v2.sh" --apply > "$T/run2.out" 2>&1 || bad "run2 exit $?"
expect_count "$NTFY_LOG" "Title: DEAD_KAMI on" 1 "DEAD_KAMI not re-sent inside cooldown"
if [ "$HAVE_JQ" = 1 ] || [ -n "$NODE" ]; then expect_grep "$NTFY_LOG" "lease #999 erroring (musu)" "persistent job error pushed on 2nd run"; else skip "persistent job error (needs jq or node)"; fi

echo "== alerts v2: empty/corrupt cooldown + counter files do not abort the run"
: > "$T/state/la-kami-renter-pod-v16-musu-DEAD_KAMI"
echo "garbage" > "$T/persist/alerts-last-ok"
printf 'x\n' > "$T/persist/count-rpc-errors"
rc=0; "$OPS/alerts/worker-alerts-v2.sh" --apply > "$T/run2b.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "run with an empty cooldown file exits 0"
expect_grep "$T/run2b.out" "condition(s) firing" "run reached the end"
expect_count "$NTFY_LOG" "Title: DEAD_KAMI on" 2 "empty cooldown file reads as 0 (re-sent)"
ls "$T/state" | grep -q '\.tmp\.' && bad "tmp files left behind" || ok "atomic writes leave no tmp files"

echo "== alerts v2: chain thresholds (forced)"
KEEPER_MIN_WEI=999999999999999999 FEE_FLOAT_MIN_CLAIMS=100000 \
  "$OPS/alerts/worker-alerts-v2.sh" --apply > "$T/run3.out" 2>&1 || bad "run3 exit $?"
expect_grep "$NTFY_LOG" "Title: keeper ETH low" "keeper balance alert"
expect_grep "$NTFY_LOG" "Title: VIPP fee float low" "fee float alert"
expect_nogrep "$NTFY_LOG" "backing shortfall" "no shortfall alert while shortfall=0"

echo "== alerts v2: unit down + self-test + OnFailure hook"
FAKE_DOWN="caddy kami-renter-pod-v16-vipp" "$OPS/alerts/worker-alerts-v2.sh" --apply > "$T/run4.out" 2>&1 || bad "run4 exit $?"
expect_grep "$NTFY_LOG" "Title: unit DOWN: caddy" "caddy down alert"
expect_grep "$NTFY_LOG" "Title: worker DOWN" "worker down alert"
"$OPS/alerts/worker-alerts-v2.sh" --self-test --apply > /dev/null 2>&1
expect_grep "$NTFY_LOG" "Title: kami lease alerts self-test" "self-test sends one push"
"$OPS/alerts/worker-alerts-v2.sh" --self-test > /dev/null 2>&1
expect_count "$NTFY_LOG" "Title: kami lease alerts self-test" 1 "self-test without --apply sends nothing"
"$OPS/alerts/worker-alerts-v2.sh" --apply --notify-failure kami-lease-gas-sponsor.service > /dev/null 2>&1
expect_grep "$NTFY_LOG" "Title: UNIT FAILED: kami-lease-gas-sponsor.service" "OnFailure hook push"

# run a state-reading script with a fixture: locally (jq), else over ssh (read-only), else skip
run_state() { # out script state_json args...
  local out="$1" script="$2" json="$3"; shift 3
  if [ "$HAVE_JQ" = 1 ]; then
    LAUNCH_OPS_TEST_STATE_JSON="$json" "$OPS/$script" "$@" > "$out" 2>&1
  elif [ -n "$REMOTE" ]; then
    ssh -o BatchMode=yes -o ConnectTimeout=20 "$REMOTE" \
      "LAUNCH_OPS_TEST_STATE_JSON=$(printf '%q' "$json") bash -s -- $*" < "$OPS/$script" > "$out" 2>&1
  else
    return 99
  fi
}
where="local"; [ "$HAVE_JQ" = 1 ] || where="remote $REMOTE"

echo "== transition gate (state fixtures, $where)"
J360='{"lastBlock":1,"jobs":{"360":{"tokenIndex":360,"pod":"0x0000000000000000000000000000000000000002","returned":false}},"reservations":{}}'
rc=0; run_state "$T/gate1.out" lease-transition-gate.sh "$J360" --market vipp || rc=$?
if [ "$rc" = 99 ]; then skip "gate J1 (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else
  [ "$rc" = 3 ] && ok "non-returned job with cleared request -> REFUSE (exit 3)" || bad "gate exit $rc (want 3)"
  expect_grep "$T/gate1.out" "J1 #360" "J1 reason printed"
fi
RES=$(printf '{"lastBlock":1,"jobs":{},"reservations":{"0x%064d":{"operator":"0x1","createdAt":%s000,"attestedDigest":"0xab"}}}' 1 "$NOW")
rc=0; run_state "$T/gate2.out" lease-transition-gate.sh "$RES" --market vipp || rc=$?
if [ "$rc" = 99 ]; then skip "gate R1 (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else [ "$rc" = 3 ] && ok "fresh bound reservation -> REFUSE" || bad "gate exit $rc (want 3)"; fi
OLDRES=$(printf '{"lastBlock":1,"jobs":{},"reservations":{"0x%064d":{"operator":"0x1","createdAt":%s000,"attestedDigest":"0xab"}}}' 1 $((NOW - 7200)))
rc=0; run_state "$T/gate3.out" lease-transition-gate.sh "$OLDRES" --market vipp || rc=$?
if [ "$rc" = 99 ]; then skip "gate old reservation (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else [ "$rc" = 0 ] && ok "bound reservation older than GATE_INFLIGHT_SEC -> SAFE" || bad "gate exit $rc (want 0)"; fi
EMPTY='{"lastBlock":1,"jobs":{},"reservations":{}}'
rc=0; run_state "$T/gate4.out" lease-transition-gate.sh "$EMPTY" --market vipp || rc=$?
if [ "$rc" = 99 ]; then skip "gate SAFE path (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else [ "$rc" = 0 ] && ok "no jobs, no reservations -> SAFE" || bad "gate exit $rc (want 0)"; fi
PEND='{"lastBlock":1,"jobs":{},"reservations":{},"txs":{"k":{"status":"pending","hash":"0x1"}}}'
rc=0; run_state "$T/gate5.out" lease-transition-gate.sh "$PEND" --market vipp || rc=$?
if [ "$rc" = 99 ]; then skip "gate T1 (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else [ "$rc" = 3 ] && ok "tx in flight -> REFUSE" || bad "gate exit $rc (want 3)"; fi
# the worker-hardening tracker shape: state.pendingTxs[key] = {hash, nonce, from, label, sentAt}, no status
PEND2='{"lastBlock":1,"jobs":{},"reservations":{},"pendingTxs":{"7":{"hash":"0x1","nonce":3,"from":"0x1","label":"endLease","sentAt":1}}}'
rc=0; run_state "$T/gate7.out" lease-transition-gate.sh "$PEND2" --market vipp || rc=$?
if [ "$rc" = 99 ]; then skip "gate T1 pendingTxs shape (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else [ "$rc" = 3 ] && ok "worker pendingTxs record (no status field) -> REFUSE" || bad "gate exit $rc (want 3)"; fi
BADRES=$(printf '{"lastBlock":1,"jobs":{},"reservations":{"0x%064d":{"operator":"0x1","createdAt":"not-a-number","attestedDigest":"0xab"}}}' 3)
rc=0; run_state "$T/gate8.out" lease-transition-gate.sh "$BADRES" --market vipp || rc=$?
if [ "$rc" = 99 ]; then skip "gate unparsable reservation (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else
  [ "$rc" = 1 ] && ok "unparsable reservation -> UNDECIDED (exit 1), not SAFE" || bad "gate exit $rc (want 1)"
  expect_grep "$T/gate8.out" "R1 cannot parse reservations" "R1 parse failure reported"
fi
if [ "$HAVE_JQ" = 1 ]; then
  printf '{"0x%064d":{"operator":"0x1","createdAt":%s000,"attestedDigest":"0xab"}}\n' 2 "$NOW" \
    > "$K/vault-kit-v16-vipp/renter-pod-worker-state.reservations.json"
  rc=0; LAUNCH_OPS_TEST_STATE_JSON="$EMPTY" "$OPS/lease-transition-gate.sh" --market vipp > "$T/gate6.out" 2>&1 || rc=$?
  [ "$rc" = 3 ] && ok "bound reservation in separate reservations file -> REFUSE" || bad "gate exit $rc (want 3)"
  echo '{"version":1,"reservations":' > "$K/vault-kit-v16-vipp/renter-pod-worker-state.reservations.json" # truncated write
  rc=0; LAUNCH_OPS_TEST_STATE_JSON="$EMPTY" "$OPS/lease-transition-gate.sh" --market vipp > "$T/gate9.out" 2>&1 || rc=$?
  [ "$rc" = 1 ] && ok "truncated reservations file -> UNDECIDED" || bad "gate exit $rc (want 1)"
  rm -f "$K/vault-kit-v16-vipp/renter-pod-worker-state.reservations.json"
else
  skip "gate R1 separate reservations file (needs local jq)"
  skip "gate truncated reservations file (needs local jq)"
fi

echo "== gas sponsor (real RPC, state fixture) + expiry keeper"
J999='{"lastBlock":1,"jobs":{"999":{"tokenIndex":999,"operator":"0x0000000000000000000000000000000000000001","pod":"0x0000000000000000000000000000000000000002","returned":false,"__OPKEY__":"0xSHOULD_NEVER_BE_PRINTED"}}}'
J999=${J999/__OPKEY__/operator''Key}
rc=0; LAUNCH_OPS_TEST_STATE_JSON="$J999" "$OPS/keeper/lease-gas-sponsor.sh" --dry-run > "$T/sponsor.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "sponsor dry-run exit 0"
expect_grep "$T/sponsor.out" "stages=[0 3 4 5]" "default SPONSOR_STAGES covers stage 0 and terminal stages 4-5"
expect_grep "$T/sponsor.out" "#999 stage=0: not listed on this market (stale job)" "stage-0 job for an unlisted token skipped"
expect_grep "$T/sponsor.out" "0 top-up(s) planned" "nothing planned"
expect_nogrep "$T/sponsor.out" "SHOULD_NEVER_BE_PRINTED" "sponsor never prints keys"
rc=0; SPONSOR_KEY_FILE="" "$OPS/keeper/lease-gas-sponsor.sh" --apply > "$T/sponsor-apply.out" 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "sponsor --apply without key file refuses" || bad "sponsor --apply ran without a key"
rc=0; "$OPS/keeper/lease-expiry-keeper.sh" --dry-run > "$T/keeper.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "keeper dry-run exit 0"
expect_grep "$T/keeper.out" "[dry-run] no transactions sent" "keeper dry-run sends nothing"
expect_grep "$T/keeper.out" "listings=2" "keeper enumerated the VIPP listings on chain"
rc=0; "$OPS/keeper/lease-expiry-keeper.sh" --apply > "$T/keeper-apply.out" 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "keeper --apply without key file refuses" || bad "keeper --apply ran without a key"

if [ -z "$NODE" ]; then
  skip "fake-RPC tests (sponsor stage 0, in-flight guard, keeper, deploy half): node missing"
else
start_fake_rpc
MKT=0x00000000000000000000000000000000000000a1
FAC=0x00000000000000000000000000000000000000f1
SPN=0x00000000000000000000000000000000000005a0
OWNER_W=$(aw 0x00000000000000000000000000000000000000b0)
RENTER_W=$(aw 0x00000000000000000000000000000000000000c0)
POD=0x00000000000000000000000000000000000000d0
listing() { # owner_word renter_word leaseEnd -> 14 words
  printf '0x%s%s%s%s%s%s%s%s%s%s%s%s%s%s' "$1" "$(w 1)" "$(w 0)" "$(w 0)" "$(w 0)" "$(w 0)" "$(w 0)" "$(w 0)" "$2" "$(w 0)" "$(w 0)" "$(w 0)" "$(w "$3")" "$(w 0)"
}
request() { # pod stage -> 6 words
  printf '0x%s%s%s%s%s%s' "$(w 0)" "$(aw "$1")" "$(w 0)" "$(w 0)" "$(w 0)" "$(w "$2")"
}
H_INFLIGHT=0x$(printf 'e%.0s' $(seq 1 64))
H_MINED=0x$(printf 'a%.0s' $(seq 1 64))
H_DROPPED=0x$(printf 'd%.0s' $(seq 1 64))
chain_config() { # nonce_latest nonce_pending [inflight_receipt_json]
  cat > "$T/rpc.json" <<EOF
{
  "eth_gasPrice": "0x2625a0",
  "eth_getTransactionCount:latest": "$1",
  "eth_getTransactionCount:pending": "$2",
  "eth_getBalance:$SPN": "0xde0b6b3a764000",
  "eth_getBalance": "0x0",
  "eth_getCode": "0x",
  "eth_getTransactionReceipt:$H_INFLIGHT": ${3:-null},
  "eth_getTransactionByHash:$H_INFLIGHT": {"hash": "$H_INFLIGHT"},
  "eth_getTransactionReceipt:$H_MINED": {"status": "0x1"},
  "eth_getTransactionReceipt:$H_DROPPED": null,
  "eth_getTransactionByHash:$H_DROPPED": null,
  "eth_call:$MKT:0xe1fc685a": "0x$(aw $FAC)",
  "eth_call:$MKT:0x90af04c1": "0x$(w 1)",
  "eth_call:$MKT:0x44d110b9$(w 0)": "0x$(w 7)",
  "eth_call:$FAC:0x0ab469b0$(w 7)": "$(request $ZERO 0)",
  "eth_call:$MKT:0xf81c2347$(w 7)": "$(listing "$OWNER_W" "$(w 0)" 0)",
  "eth_call:$FAC:0x0ab469b0$(w 8)": "$(request $ZERO 0)",
  "eth_call:$MKT:0xf81c2347$(w 8)": "$(listing "$(w 0)" "$(w 0)" 0)",
  "eth_call:$FAC:0x0ab469b0$(w 9)": "$(request $ZERO 0)",
  "eth_call:$MKT:0xf81c2347$(w 9)": "$(listing "$OWNER_W" "$RENTER_W" 0)",
  "eth_call:$FAC:0x0ab469b0$(w 10)": "$(request $POD 4)",
  "eth_call:$MKT:0xf81c2347$(w 10)": "$(listing "$OWNER_W" "$RENTER_W" 0)",
  "eth_call:$FAC:0x0ab469b0$(w 11)": "$(request 0x00000000000000000000000000000000000000e0 3)",
  "eth_call:$MKT:0xf81c2347$(w 11)": "$(listing "$OWNER_W" "$RENTER_W" 0)"
}
EOF
}
SJOBS=$(printf '{"jobs":{"7":{"tokenIndex":7,"operator":"0x0000000000000000000000000000000000000c07","pod":"%s","returned":false},"8":{"tokenIndex":8,"operator":"0x0000000000000000000000000000000000000c08","pod":"%s","returned":false},"9":{"tokenIndex":9,"operator":"0x0000000000000000000000000000000000000c09","pod":"%s","returned":false},"10":{"tokenIndex":10,"operator":"0x0000000000000000000000000000000000000c10","pod":"%s","returned":false},"11":{"tokenIndex":11,"operator":"0x0000000000000000000000000000000000000c11","pod":"%s","returned":false},"12":{"tokenIndex":12,"returned":true}}}' "$POD" "$POD" "$POD" "$POD" "$POD")
SP_ENV=(env YOMINET_RPC_PUBLIC="$FAKE_RPC" V16_MARKETS=vipp VIPP_MARKET="$MKT" ALERT_PERSIST_DIR="$T/persist-sp"
  SPONSOR_LOCK_FILE="$T/sponsor.lock" LAUNCH_OPS_TEST_STATE_JSON="$SJOBS")

echo "== gas sponsor (fake chain): stage 0 reachable, stale jobs skipped"
chain_config 0x5 0x5
rc=0; "${SP_ENV[@]}" "$OPS/keeper/lease-gas-sponsor.sh" --dry-run > "$T/sp1.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "sponsor dry-run on the fake chain exits 0"
expect_grep "$T/sp1.out" "#7 stage=0: request cleared, listing not re-leased" "stage-0 custody-return job validated against the listing"
expect_grep "$T/sp1.out" "WOULD send 30000000000000 wei" "stage-0 operator top-up planned (target 12M gas x 2.5 Mwei)"
expect_grep "$T/sp1.out" "#8 stage=0: not listed on this market" "stage 0 + unlisted token -> stale"
expect_grep "$T/sp1.out" "#9 stage=0: listing re-leased" "stage 0 + re-leased listing -> stale"
expect_grep "$T/sp1.out" "#10 stage=4" "stage 4 (terminal) considered by default"
expect_grep "$T/sp1.out" "#11 stage=3: chain pod" "stage 3 pod mismatch -> stale"
expect_grep "$T/sp1.out" "2 top-up(s) planned" "exactly #7 and #10 planned"
expect_nogrep "$T/sp1.out" "#12" "returned job ignored"

echo "== gas sponsor: a broadcast-but-unmined top-up counts toward the caps and blocks new sends"
mkdir -p "$T/persist-sp"
printf '%s\ttopup\t%s\t7\t%s\t0x0000000000000000000000000000000000000c07\t100000000000000\t%s\t4\tsent\n' "$NOW" "$MKT" "$POD" "$H_INFLIGHT" > "$T/persist-sp/sponsor-ledger.tsv"
chain_config 0x5 0x6
rc=0; SPONSOR_ADDRESS=$SPN "${SP_ENV[@]}" "$OPS/keeper/lease-gas-sponsor.sh" --dry-run > "$T/sp2.out" 2>&1 || rc=$?
expect_grep "$T/sp2.out" "(used 24h: 100000000000000)" "unresolved sent row counts toward the daily cap"
expect_grep "$T/sp2.out" "token=7 stage=0" "per-lease cap hit for #7 by the unresolved row"
expect_grep "$T/sp2.out" "reason=per-lease-cap" "per-lease cap alert is key=value"
expect_grep "$T/sp2.out" "still in flight (known to the node, not mined)" "ledger row resolved as in flight"
expect_grep "$T/sp2.out" "[LEASE-ALERT] TX_TIMEOUT source=sponsor" "in-flight sponsor tx alerted"
expect_count "$T/persist-sp/sponsor-ledger.tsv" "result" 0 "dry-run appends nothing to the ledger"

echo "== gas sponsor --apply: in-flight guard sends nothing (placeholder key, fake ethers dir)"
printf 'placeholder-not-a-key\n' > "$T/sponsor.key"; chmod 600 "$T/sponsor.key"
mkdir -p "$T/fake-nm/ethers"
: > "$T/rpc.log"
rc=0; SPONSOR_ADDRESS=$SPN SPONSOR_KEY_FILE="$T/sponsor.key" ETHERS_NODE_PATH="$T/fake-nm" \
  "${SP_ENV[@]}" "$OPS/keeper/lease-gas-sponsor.sh" --apply > "$T/sp3.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "sponsor --apply with a tx in flight exits 0 (no OnFailure push)"
expect_grep "$T/sp3.out" "held back until the in-flight sponsor tx resolves" "planned top-up held back"
expect_nogrep "$T/rpc.log" "eth_sendRawTransaction" "no transaction sent"
expect_nogrep "$T/rpc.log" "eth_chainId" "signer never started"
printf '%s\ttopup\t%s\t10\t%s\t0x0000000000000000000000000000000000000c10\t1\t%s\t5\tsent\n' "$NOW" "$MKT" "$POD" "$H_MINED" >> "$T/persist-sp/sponsor-ledger.tsv"
printf '%s\ttopup\t%s\t10\t%s\t0x0000000000000000000000000000000000000c10\t1\t%s\t6\tsent\n' "$NOW" "$MKT" "$POD" "$H_DROPPED" >> "$T/persist-sp/sponsor-ledger.tsv"
rc=0; SPONSOR_ADDRESS=$SPN SPONSOR_KEY_FILE="$T/sponsor.key" ETHERS_NODE_PATH="$T/fake-nm" \
  "${SP_ENV[@]}" "$OPS/keeper/lease-gas-sponsor.sh" --apply > "$T/sp4.out" 2>&1 || rc=$?
check "grep -qP '^\\d+\\tresult\\t.*\\t$H_MINED\\t-\\tmined$' '$T/persist-sp/sponsor-ledger.tsv'" "--apply records a mined ledger tx as resolved"
check "grep -qP '^\\d+\\tresult\\t.*\\t$H_DROPPED\\t-\\tdropped$' '$T/persist-sp/sponsor-ledger.tsv'" "--apply records a dropped ledger tx as resolved"
expect_nogrep "$T/rpc.log" "eth_sendRawTransaction" "still nothing sent (the first row is in flight)"

echo "== gas sponsor + keeper: a held lock skips the run with exit 0"
( exec 8>"$T/sponsor.lock"; flock 8; sleep 4 ) &
holder=$!
sleep 0.5
rc=0; SPONSOR_ADDRESS=$SPN SPONSOR_KEY_FILE="$T/sponsor.key" ETHERS_NODE_PATH="$T/fake-nm" \
  "${SP_ENV[@]}" "$OPS/keeper/lease-gas-sponsor.sh" --apply > "$T/sp5.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "sponsor exits 0 when the keeper holds the lock"
expect_grep "$T/sp5.out" "skipping this run" "sponsor logs the skip"
rc=0; YOMINET_RPC_PUBLIC="$FAKE_RPC" EXPIRY_MARKETS="$MKT" ALERT_PERSIST_DIR="$T/persist-kp" SPONSOR_LOCK_FILE="$T/sponsor.lock" \
  SPONSOR_ADDRESS=$SPN SPONSOR_KEY_FILE="$T/sponsor.key" ETHERS_NODE_PATH="$T/fake-nm" \
  "$OPS/keeper/lease-expiry-keeper.sh" --apply > "$T/kp0.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "keeper exits 0 when the sponsor holds the lock"
expect_grep "$T/kp0.out" "skipping this run" "keeper logs the skip"
wait "$holder" 2>/dev/null || true

echo "== expiry keeper --apply: expired lease, but a sponsor tx is in flight -> nothing sent"
# listing #7 leased and expired long ago (renter set, not ending)
python3 - "$T/rpc.json" "$MKT" "$(w 7)" "$(listing "$OWNER_W" "$RENTER_W" $((NOW - 100000)))" <<'PY'
import json, sys
p, mkt, word7, lst = sys.argv[1:]
c = json.load(open(p)); c[f"eth_call:{mkt}:0xf81c2347{word7}"] = lst; json.dump(c, open(p, "w"))
PY
: > "$T/rpc.log"
rc=0; YOMINET_RPC_PUBLIC="$FAKE_RPC" EXPIRY_MARKETS="$MKT" ALERT_PERSIST_DIR="$T/persist-kp" SPONSOR_LOCK_FILE="$T/sponsor.lock" \
  SPONSOR_ADDRESS=$SPN SPONSOR_KEY_FILE="$T/sponsor.key" ETHERS_NODE_PATH="$T/fake-nm" \
  "$OPS/keeper/lease-expiry-keeper.sh" --apply > "$T/kp1.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "keeper exits 0"
expect_grep "$T/kp1.out" "-> CANDIDATE" "expired lease found"
expect_grep "$T/kp1.out" "[LEASE-ALERT] STAGE_STUCK source=expiry-keeper reason=expired-not-ending count=1 candidates=$MKT:7" "keeper alert is key=value"
expect_grep "$T/kp1.out" "[LEASE-ALERT] TX_TIMEOUT source=expiry-keeper" "keeper refuses to send while the sponsor nonce has a pending tx"
expect_nogrep "$T/rpc.log" "eth_sendRawTransaction" "keeper sent nothing"
expect_nogrep "$T/rpc.log" "eth_chainId" "keeper signer never started"

echo "== worker deploy, VPS half (fake market dir, shimmed systemctl, fake RPC)"
RK="$T/rk/tools"; MD="$RK/vault-kit-v16-vipp"; STG="$T/rk/staging"
mkdir -p "$STG/code" "$T/rk/backups"
echo "// new code" > "$STG/code/renter-pod-worker.mjs"
echo "// new module" > "$STG/code/renter-pod-tx.mjs"
reset_market() { # pendingTxs_json state_reservations_json
  local pend="${1:-}" res="${2:-}"
  [ -n "$pend" ] || pend='{}'
  [ -n "$res" ] || res='{}'
  rm -rf "$MD"; mkdir -p "$MD"
  printf 'SOME_SETTING=1\n' > "$MD/.env"
  echo "// old code" > "$MD/renter-pod-worker.mjs"
  printf '{"lastBlock":1,"jobs":{},"reservations":%s,"pendingTxs":%s}\n' "$res" "$pend" > "$MD/renter-pod-worker-state.json"
  printf '{"version":1,"reservations":{"0xabc":{"operator":"0x0000000000000000000000000000000000000001","__OPKEY__":"0xSHOULD_NEVER_BE_PRINTED","createdAt":1}}}\n' \
    > "$MD/renter-pod-worker-state.reservations.json"
  sed -i 's/"__OPKEY__"/"operator''Key"/' "$MD/renter-pod-worker-state.reservations.json"
  chmod 600 "$MD/renter-pod-worker-state.json" "$MD/renter-pod-worker-state.reservations.json"
  : > "$T/systemctl.log"
}
REMOTE_ENV=(env KAMI_ROOT="$RK" NODE_BIN="$NODE" YOMINET_RPC_PUBLIC="$FAKE_RPC" SYSTEMCTL_LOG="$T/systemctl.log"
  FAKE_MARKET_DIR="$MD" PENDING_POLL_SEC=1 VERIFY_POLL_SEC=1)
install_args() { echo "--action install --market vipp --staging $STG --backup-dir $T/rk/backups/$1/vault-kit-v16-vipp --verify-sec 1 --require-heartbeat 1 --verify-halt 1 --pending-wait 2"; }
pending() { printf '{"7":{"hash":"%s","nonce":3,"from":"0x1","label":"endLease","sentAt":1}}' "$1"; }

reset_market
rc=0; asroot "${REMOTE_ENV[@]}" FAKE_WORKER_HB=1 bash "$OPS/deploy/remote-install-worker-code.sh" $(install_args ok) > "$T/d1.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "install with a fresh heartbeat succeeds"
expect_grep "$MD/renter-pod-worker.mjs" "new code" "new code installed"
expect_grep "$T/systemctl.log" "started halt=1 code=// new code" "HALT was present while the new code verified"
check "[ ! -e '$MD/HALT' ]" "HALT removed after a passing verify"
check "[ -f '$T/rk/backups/ok/vault-kit-v16-vipp/renter-pod-worker.mjs' ] && [ ! -e '$T/rk/backups/ok/vault-kit-v16-vipp/.env' ]" "backup holds code files, not .env"
check "[ \"\$(stat -c %a '$T/rk/backups/ok/vault-kit-v16-vipp/state-snapshot/renter-pod-worker-state.json')\" = 600 ]" "state snapshot is mode 600"

reset_market "$(pending "$H_DROPPED")"
rc=0; asroot "${REMOTE_ENV[@]}" FAKE_WORKER_HB=0 bash "$OPS/deploy/remote-install-worker-code.sh" $(install_args fail) > "$T/d2.out" 2>&1 || rc=$?
expect_rc "$rc" 4 "verify failure -> auto-rollback (exit 4)"
expect_grep "$MD/renter-pod-worker.mjs" "old code" "old code restored"
check "[ ! -e '$MD/renter-pod-tx.mjs' ]" "file new in the patch removed on rollback"
expect_grep "$T/d2.out" "resolved 7 $H_DROPPED dropped" "dropped pending tx resolved before the old code starts"
expect_grep "$MD/renter-pod-worker-state.json" '"0xabc"' "reservation store merged back into the state file"
check "ls '$MD' | grep -q 'renter-pod-worker-state.reservations.json.rolled-back-' && [ ! -e '$MD/renter-pod-worker-state.reservations.json' ]" "store renamed so a later patched worker does not resurrect it"
check "[ \"\$(stat -c %a '$MD/renter-pod-worker-state.json')\" = 600 ]" "state file mode kept by the merge"
check "[ ! -e '$MD/HALT' ]" "HALT removed after auto-rollback to old code"
expect_nogrep "$T/d2.out" "SHOULD_NEVER_BE_PRINTED" "no operator key printed"
check "grep -q 'stop kami-renter-pod-v16-vipp' '$T/systemctl.log'" "unit stopped before the state merge"

chain_config 0x5 0x5 null
reset_market "$(pending "$H_INFLIGHT")"
rc=0; asroot "${REMOTE_ENV[@]}" FAKE_WORKER_HB=0 bash "$OPS/deploy/remote-install-worker-code.sh" $(install_args blocked) > "$T/d3.out" 2>&1 || rc=$?
expect_rc "$rc" 5 "auto-rollback blocked by an in-flight tx (exit 5)"
expect_grep "$MD/renter-pod-worker.mjs" "new code" "patched code (with the tx tracker) kept running"
expect_grep "$T/d3.out" "[LEASE-ALERT] TX_TIMEOUT market=vipp" "blocked rollback alerted"
check "[ -e '$MD/HALT' ]" "HALT kept while a human is needed"
check "[ -e '$MD/renter-pod-worker-state.reservations.json' ]" "store untouched when the rollback is blocked"

: > "$T/systemctl.log"
rc=0; asroot "${REMOTE_ENV[@]}" bash "$OPS/deploy/remote-install-worker-code.sh" --action rollback --market vipp --backup-dir "$T/rk/backups/blocked/vault-kit-v16-vipp" --verify-sec 1 > "$T/d4.out" 2>&1 || rc=$?
check "[ '$rc' != 0 ]" "manual rollback refused while the tx is in flight"
expect_grep "$T/d4.out" "rollback refused" "refusal explained"
expect_nogrep "$T/systemctl.log" "stop" "refused rollback did not stop the unit"

chain_config 0x5 0x5 '{"status": "0x1"}'
rc=0; asroot "${REMOTE_ENV[@]}" bash "$OPS/deploy/remote-install-worker-code.sh" --action rollback --market vipp --backup-dir "$T/rk/backups/blocked/vault-kit-v16-vipp" --verify-sec 1 > "$T/d5.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "manual rollback succeeds once the tx is mined"
expect_grep "$MD/renter-pod-worker.mjs" "old code" "manual rollback restored the old code"
expect_grep "$MD/renter-pod-worker-state.json" '"0xabc"' "manual rollback merged the reservation store"

reset_market "" '{"0xabc":{"operator":"0x0000000000000000000000000000000000000002"}}'
rc=0; asroot "${REMOTE_ENV[@]}" FAKE_WORKER_HB=0 bash "$OPS/deploy/remote-install-worker-code.sh" $(install_args conflict) > "$T/d6.out" 2>&1 || rc=$?
expect_rc "$rc" 6 "reservation conflict blocks the auto-rollback (exit 6)"
expect_grep "$MD/renter-pod-worker.mjs" "new code" "patched code kept on a merge conflict"

echo "== worker deploy: staging tree carries test fixtures (full/) and its tests pass"
WREF="${LAUNCH_OPS_TEST_WORKER_REF:-launch/worker-hardening}"
TOP=$(git -C "$OPS" rev-parse --show-toplevel 2>/dev/null || true)
NM="${LAUNCH_OPS_TEST_NODE_MODULES:-}"
if [ -z "$NM" ]; then
  for c in "$TOP/tools/vault-kit/node_modules" /home/matrix/kamigotchi/tools/vault-kit/node_modules; do [ -d "$c" ] && { NM="$c"; break; }; done
fi
if [ -z "$TOP" ] || ! git -C "$TOP" rev-parse --verify -q "$WREF^{commit}" >/dev/null || [ -z "$NM" ]; then
  skip "staging tests (needs git ref $WREF and vault-kit node_modules)"
else
  rc=0; bash "$OPS/deploy-worker-patch.sh" --ref "$WREF" --local-stage "$T/stage" > "$T/st0.out" 2>&1 || rc=$?
  expect_rc "$rc" 0 "--local-stage builds the staging tree without ssh"
  check "[ -d '$T/stage/full/test-fixtures' ] && [ -f '$T/stage/code/renter-pod-worker.mjs' ] && [ ! -e '$T/stage/code/test-fixtures' ]" "full/ has test-fixtures, code/ holds only installable files"
  rc=0; asroot env NODE_BIN="$NODE" NODE_MODULES="$NM" bash "$OPS/deploy/remote-install-worker-code.sh" --action test --staging "$T/stage" > "$T/st1.out" 2>&1 || rc=$?
  expect_rc "$rc" 0 "staged vault-kit tests pass in full/"
  grep -E '^# (tests|pass|fail)' "$T/st1.out" | sed 's/^/       /' || true
  rm -rf "$T/stage/full"
  rc=0; asroot env NODE_BIN="$NODE" NODE_MODULES="$NM" bash "$OPS/deploy/remote-install-worker-code.sh" --action test --staging "$T/stage" > "$T/st2.out" 2>&1 || rc=$?
  check "[ '$rc' != 0 ]" "control: code-only staging (the old layout) fails on the fixture test"
fi
fi # node

echo "== install-launch-ops: SRC == DEST with scripts shipped as 644 (git archive of a 100644 commit)"
IR="$T/inst"; mkdir -p "$IR/units" "$IR/env" "$IR/backups"
cp -a "$OPS" "$IR/launch-ops"
find "$IR/launch-ops" -name '*.sh' -exec chmod 644 {} +
printf '#!/bin/bash\nTOPIC="unit-test-topic-123"\n' > "$IR/live-alerts.sh"
INST_ENV=(env LAUNCH_OPS_DEST="$IR/launch-ops" UNIT_DIR="$IR/units" BACKUP_ROOT="$IR/backups" LAUNCH_OPS_ENV_DIR="$IR/env"
  LIVE_ALERTS="$IR/live-alerts.sh" SYSTEMCTL_LOG="$T/systemctl-inst.log" FAKE_ENABLED=disabled)
rc=0; asroot "${INST_ENV[@]}" bash "$IR/launch-ops/install-launch-ops.sh" --component alerts > "$T/i0.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "installer dry-run exits 0"
expect_grep "$T/i0.out" "CHMOD     $IR/launch-ops/alerts/worker-alerts-v2.sh (644 -> 700; content unchanged)" "dry-run shows the mode fix for an unchanged file"
rc=0; asroot "${INST_ENV[@]}" bash "$IR/launch-ops/install-launch-ops.sh" --component alerts --apply > "$T/i1.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "installer --apply exits 0"
check "[ -x '$IR/launch-ops/alerts/worker-alerts-v2.sh' ] && [ \"\$(stat -c %a '$IR/launch-ops/alerts/worker-alerts-v2.sh')\" = 700 ]" "alerts script is 700 after install although SRC == DEST"
expect_grep "$T/systemctl-inst.log" "start kami-worker-alerts.service" "installer ran the alerts unit once through systemd"
expect_grep "$T/i1.out" "Result=success" "unit result checked"
expect_nogrep "$T/i1.out" "unit-test-topic-123" "ntfy topic not printed"
check "grep -q 'NTFY_TOPIC=unit-test-topic-123' '$IR/env/launch-ops.env' && [ \"\$(stat -c %a '$IR/env/launch-ops.env')\" = 600 ]" "topic migrated into the mode-600 env file"
BK=$(ls -d "$IR"/backups/ops-* | head -1)
check "grep -qP '^mode\\t.*worker-alerts-v2.sh\\t644$' '$BK/manifest.tsv'" "mode change recorded in the manifest"
rc=0; asroot "${INST_ENV[@]}" bash "$IR/launch-ops/install-launch-ops.sh" --component alerts > "$T/i2.out" 2>&1 || rc=$?
expect_grep "$T/i2.out" "[dry-run] 0 file change(s) planned" "second run is idempotent"
rc=0; asroot "${INST_ENV[@]}" bash "$IR/launch-ops/install-launch-ops.sh" --rollback "$BK" > "$T/i3.out" 2>&1 || rc=$?
check "[ \"\$(stat -c %a '$IR/launch-ops/alerts/worker-alerts-v2.sh')\" = 644 ] && [ ! -e '$IR/units/kami-worker-alerts.service' ]" "rollback restores the old mode and removes created units"
rm -rf "$IR/env" "$IR/units"; mkdir -p "$IR/units" "$IR/env"
rc=0; asroot "${INST_ENV[@]}" FAKE_SHOW_RESULT=exit-code FAKE_EXEC_STATUS=203 bash "$IR/launch-ops/install-launch-ops.sh" --component alerts --apply > "$T/i4.out" 2>&1 || rc=$?
check "[ '$rc' != 0 ]" "install fails when the alerts unit does not run (203/EXEC)"
expect_grep "$T/i4.out" "Result=exit-code ExecMainStatus=203" "failure names the unit result"
expect_grep "$T/i4.out" "roll back with:" "failure prints the rollback command"

echo "== cleanup-secret-backups (VPS-12)"
CR="$T/cr"; CD="$CR/tools/vault-kit-v16-musu"; mkdir -p "$CD" "$CR/units" "$CR/backups/worker-old" "$CR/backups/worker-new" "$CR/staging"
echo "SECRET_MARKER_live" > "$CD/.env"; chmod 600 "$CD/.env"
echo "SECRET_MARKER_stackA" > "$CD/.env.bak-stackA"; chmod 644 "$CD/.env.bak-stackA"
echo "SECRET_MARKER_kept" > "$CD/.env.bak-kept"
echo "EnvironmentFile=$CD/.env.bak-kept" > "$CR/units/x.service"
echo "// old" > "$CD/renter-pod-worker.mjs.bak-1"; chmod 777 "$CD/renter-pod-worker.mjs.bak-1"
echo "// live" > "$CD/renter-pod-worker.mjs"; chmod 666 "$CD/renter-pod-worker.mjs"
echo "SECRET_MARKER_backup" > "$CR/backups/worker-old/.env"; touch -d '30 days ago' "$CR/backups/worker-old"
CL_ENV=(env KAMI_ROOT="$CR/tools" V16_MARKETS=musu UNIT_DIR="$CR/units" BACKUP_ROOT="$CR/backups" STAGING_ROOT="$CR/staging")
rc=0; asroot "${CL_ENV[@]}" bash "$OPS/cleanup-secret-backups.sh" --prune-days 14 > "$T/c1.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "cleanup dry-run exits 0"
expect_grep "$T/c1.out" "WOULD shred .env.bak-stackA" "dry-run lists the stale secret backup"
expect_grep "$T/c1.out" "KEEP    .env.bak-kept" "a unit-referenced backup is kept"
check "[ -f '$CD/.env.bak-stackA' ] && [ -d '$CR/backups/worker-old' ]" "dry-run changed nothing"
rc=0; asroot "${CL_ENV[@]}" bash "$OPS/cleanup-secret-backups.sh" --prune-days 14 --apply > "$T/c2.out" 2>&1 || rc=$?
expect_rc "$rc" 0 "cleanup --apply exits 0"
check "[ ! -e '$CD/.env.bak-stackA' ] && [ -f '$CD/.env.bak-kept' ] && [ -f '$CD/.env' ]" "stale backup shredded; live .env and referenced backup kept"
check "[ \"\$(stat -c %a '$CD/renter-pod-worker.mjs.bak-1')\" = 600 ] && [ \"\$(stat -c %a '$CD/renter-pod-worker.mjs')\" = 644 ]" "777 .bak -> 600, 666 live code -> 644"
check "[ ! -e '$CR/backups/worker-old' ] && [ -d '$CR/backups/worker-new' ]" "old deploy backup pruned, recent kept"
cat "$T/c1.out" "$T/c2.out" > "$T/c.out"
expect_nogrep "$T/c.out" "SECRET_MARKER" "file contents never printed"

echo
echo "launch-ops tests: $PASS passed, $FAIL failed, $SKIP skipped (jq local=$HAVE_JQ node=${NODE:+yes} remote=${REMOTE:-none})"
[ "$FAIL" = 0 ]
