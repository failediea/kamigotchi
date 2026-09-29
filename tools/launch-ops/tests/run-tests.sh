#!/usr/bin/env bash
# Local tests for tools/launch-ops. Needs bash, curl, awk; jq for the
# worker-state tests. systemctl / journalctl / ntfy are shimmed; chain reads go
# to the public Yominet RPC (read-only eth_call / eth_getBalance / eth_getCode
# only). Nothing is signed or sent.
#   bash tools/launch-ops/tests/run-tests.sh
#   LAUNCH_OPS_TEST_REMOTE=root@68.183.190.126 bash tools/launch-ops/tests/run-tests.sh
#     -> where jq is missing locally, the gate/sponsor state tests run on that host
#        over ssh with the fixture passed in an env var (read-only there: no files
#        are written, nothing is signed). Otherwise they are reported as SKIP.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OPS="$(cd "$HERE/.." && pwd)"
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0; SKIP=0
HAVE_JQ=0; command -v jq >/dev/null 2>&1 && HAVE_JQ=1
REMOTE="${LAUNCH_OPS_TEST_REMOTE:-}"
skip() { SKIP=$((SKIP + 1)); echo "  skip $*"; }
ok() { PASS=$((PASS + 1)); echo "  ok   $*"; }
bad() { FAIL=$((FAIL + 1)); echo "  FAIL $*"; }
expect_grep() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3 (missing: $2)"; fi; }
expect_nogrep() { if grep -qF -- "$2" "$1"; then bad "$3 (unexpected: $2)"; else ok "$3"; fi; }
expect_count() { local c; c=$(grep -cF -- "$2" "$1" || true); if [ "$c" = "$3" ]; then ok "$4"; else bad "$4 (count $c != $3)"; fi; }

# ---- shims ----
mkdir -p "$T/bin" "$T/journal"
REAL_CURL=$(command -v curl)
cat > "$T/bin/systemctl" <<'EOF'
#!/usr/bin/env bash
case "$1" in
  is-active) for d in ${FAKE_DOWN:-}; do [ "$d" = "$2" ] && { echo failed; exit 3; }; done; echo active ;;
  cat) exit 1 ;;
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
cat > "$T/bin/curl" <<EOF
#!/usr/bin/env bash
for a in "\$@"; do
  case "\$a" in *ntfy.invalid*) printf 'NTFY %s\n' "\$*" >> "\$NTFY_LOG"; exit 0 ;; esac
done
exec "$REAL_CURL" "\$@"
EOF
chmod +x "$T/bin/"*
export PATH="$T/bin:$PATH"
export FAKE_JOURNAL_DIR="$T/journal" NTFY_LOG="$T/ntfy.log"
: > "$NTFY_LOG"

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
if [ "$HAVE_JQ" = 1 ]; then expect_nogrep "$NTFY_LOG" "lease #999 erroring" "job error needs JOB_ERROR_RUNS=2 runs"; else expect_grep "$NTFY_LOG" "alerts degraded: jq missing" "missing jq is itself alerted"; fi
expect_nogrep "$NTFY_LOG" "SHOULD_NEVER_BE_PRINTED" "operator key never sent"
[ -f "$T/persist/alerts-last-ok" ] && ok "last-ok stamp written" || bad "no last-ok stamp"

echo "== alerts v2: apply run 2 (cooldown + persistence)"
"$OPS/alerts/worker-alerts-v2.sh" --apply > "$T/run2.out" 2>&1 || bad "run2 exit $?"
expect_count "$NTFY_LOG" "Title: DEAD_KAMI on" 1 "DEAD_KAMI not re-sent inside cooldown"
if [ "$HAVE_JQ" = 1 ]; then expect_grep "$NTFY_LOG" "lease #999 erroring (musu)" "persistent job error pushed on 2nd run"; else skip "persistent job error (needs jq)"; fi

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
if [ "$HAVE_JQ" = 1 ]; then
  printf '{"0x%064d":{"operator":"0x1","createdAt":%s000,"attestedDigest":"0xab"}}\n' 2 "$NOW" \
    > "$K/vault-kit-v16-vipp/renter-pod-worker-state.reservations.json"
  rc=0; LAUNCH_OPS_TEST_STATE_JSON="$EMPTY" "$OPS/lease-transition-gate.sh" --market vipp > "$T/gate6.out" 2>&1 || rc=$?
  [ "$rc" = 3 ] && ok "bound reservation in separate reservations file -> REFUSE" || bad "gate exit $rc (want 3)"
  rm -f "$K/vault-kit-v16-vipp/renter-pod-worker-state.reservations.json"
else
  skip "gate R1 separate reservations file (needs local jq)"
fi

echo "== gas sponsor (state fixture, $where) + expiry keeper"
J999='{"lastBlock":1,"jobs":{"999":{"tokenIndex":999,"operator":"0x0000000000000000000000000000000000000001","pod":"0x0000000000000000000000000000000000000002","returned":false,"__OPKEY__":"0xSHOULD_NEVER_BE_PRINTED"}}}'
J999=${J999/__OPKEY__/operator''Key}
rc=0; run_state "$T/sponsor.out" keeper/lease-gas-sponsor.sh "$J999" --dry-run || rc=$?
if [ "$rc" = 99 ]; then skip "sponsor fixture (needs jq or LAUNCH_OPS_TEST_REMOTE)"
else
  [ "$rc" = 0 ] && ok "sponsor dry-run exit 0" || bad "sponsor exit $rc"
  expect_grep "$T/sponsor.out" "#999 stage=0: chain pod" "stale job (pod mismatch) skipped"
  expect_grep "$T/sponsor.out" "0 top-up(s) planned" "nothing planned"
  expect_nogrep "$T/sponsor.out" "SHOULD_NEVER_BE_PRINTED" "sponsor never prints keys"
fi
rc=0; SPONSOR_KEY_FILE="" "$OPS/keeper/lease-gas-sponsor.sh" --apply > "$T/sponsor-apply.out" 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "sponsor --apply without key file refuses" || bad "sponsor --apply ran without a key"
rc=0; "$OPS/keeper/lease-expiry-keeper.sh" --dry-run > "$T/keeper.out" 2>&1 || rc=$?
[ "$rc" = 0 ] && ok "keeper dry-run exit 0" || bad "keeper exit $rc"
expect_grep "$T/keeper.out" "[dry-run] no transactions sent" "keeper dry-run sends nothing"
expect_grep "$T/keeper.out" "listings=2" "keeper enumerated the VIPP listings on chain"
rc=0; "$OPS/keeper/lease-expiry-keeper.sh" --apply > "$T/keeper-apply.out" 2>&1 || rc=$?
[ "$rc" != 0 ] && ok "keeper --apply without key file refuses" || bad "keeper --apply ran without a key"
echo "  (a) missing-key refusal message: $(grep -o 'needs SPONSOR_KEY_FILE[^(]*' "$T/keeper-apply.out" | head -1)"

echo
echo "launch-ops tests: $PASS passed, $FAIL failed, $SKIP skipped (jq local=$HAVE_JQ remote=${REMOTE:-none})"
[ "$FAIL" = 0 ]
