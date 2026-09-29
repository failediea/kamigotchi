#!/usr/bin/env bash
# deploy-worker-patch.sh - install a worker branch/sha into both v16 VPS dirs.
#
# Runs on the OPERATOR MACHINE (WSL, where the kamigotchi git repo lives), not on
# the VPS: /root/kamigotchi on the VPS is not a git checkout.
#
#   deploy-worker-patch.sh --ref <sha|branch>                 dry-run (read-only)
#   deploy-worker-patch.sh --ref <sha|branch> --apply         install
#   deploy-worker-patch.sh --rollback <TS> [--markets "vipp"] [--force]
#                                                             restore code from a backup
#   deploy-worker-patch.sh --ref <sha|branch> --local-stage DIR
#                             build the staging tree (code/ + full/) locally and stop
#                             (no ssh; used by tests/run-tests.sh)
#
# What --apply does, in order (stops at the first failure):
#   1. git archive <ref>:tools/vault-kit locally; keep only code files
#      (renter-pod-*.mjs, kamibots-rental-config*.mjs, *.env.example)
#   2. refuse if tools/vault-kit/package.json dependencies differ from the VPS copy
#      (no npm install on the box) unless --allow-dep-change
#   2b. launch guards per market .env (read-only, counts only): refuse unless
#      RENTER_ALLOWLIST is non-empty and valid (soft launch fails CLOSED), or the
#      deploy runs with ALLOW_OPEN_RENTALS=true (or --allow-open-rentals); numeric
#      worker knobs must parse. The install appends MAX_ACTIVE_LEASES_PER_RENTER=2
#      to .env when absent (the only .env write a deploy makes)
#   3. mid-transition gate (lease-transition-gate.sh, read-only) for all markets
#   4. test the staged tree: code/ (what gets installed) and full/ (the whole
#      tools/vault-kit tree of the ref, so tests that read test-fixtures/ work).
#      --tests box    on the VPS, niced (nice 19, ionice idle, --test-concurrency=1),
#                     refused while MemAvailable < TEST_MIN_MEM_MB (300)
#      --tests local  off-box, here, with the local vault-kit node_modules (ethers
#                     version must equal the VPS one unless --allow-dep-change)
#      --tests auto   (default) box when the VPS has TEST_MIN_MEM_MB available, else local
#      Then upload code/ + full/ to /root/launch-ops-staging/worker-<TS>/. Nothing live
#      changes if the tests fail
#   5. per market, ONE AT A TIME (default order: musu, the market with 0 jobs, then vipp),
#      skipping a market whose file plan has no NEW/CHANGED runtime file (*.test.mjs and
#      *.env.example alone do not count; idempotent re-run):
#      re-run the gate for that market; back up the code files + a state snapshot to
#      /root/launch-ops-backups/worker-<TS>/vault-kit-v16-<m>/ (.env is not copied);
#      copy code files only (.env*, state, reservations, heartbeat, keys, node_modules
#      untouched); create HALT for the verify window (VERIFY_HALT=1, only if absent; the
#      patched worker answers 503 to new quotes, so nothing is signed while the install
#      can still roll back); restart the unit; verify for VERIFY_SEC (120): unit active,
#      port 8791/8792 bound, heartbeat.json fresh (ts >= restart and <= 120 s old), no
#      [LEASE-ALERT] line, no auto-restart; then remove HALT. On failure: auto-rollback
#      (waits for pendingTxs, merges the reservation store back into the state file,
#      restores the code; see deploy/remote-install-worker-code.sh), exit non-zero
#      (the next market is not touched)
#
# Dry-run does steps 1-3 (with the launch guards) plus a per-file diff against the
# live copies, and says where the tests would run. It writes nothing locally except
# a temp dir, and nothing on the VPS.
# Rollback: --rollback <TS> first runs the transition gate per market (refuses unless
# --force), then restores code files from the backup of that run (heartbeat not
# required, since older code does not write one), with the same pendingTxs wait and
# reservation merge as the auto-rollback.
{
set -euo pipefail

MODE="dry-run"
REF=""
ROLLBACK_TS=""
HOST="${VPS_HOST:-root@68.183.190.126}"
MARKETS="${DEPLOY_MARKETS:-musu vipp}"
ALLOW_DEP_CHANGE=0
REQUIRE_HEARTBEAT="${REQUIRE_HEARTBEAT:-1}"
VERIFY_SEC="${VERIFY_SEC:-120}"
VERIFY_HALT="${VERIFY_HALT:-1}"
ROLLBACK_PENDING_WAIT_SEC="${ROLLBACK_PENDING_WAIT_SEC:-300}"
FORCE=0
LOCAL_STAGE=""
TEST_WHERE="${DEPLOY_TESTS:-auto}"
TEST_MIN_MEM_MB="${TEST_MIN_MEM_MB:-300}"
ALLOW_OPEN_RENTALS="${ALLOW_OPEN_RENTALS:-false}"
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?}"; shift ;;
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    --rollback) MODE="rollback"; ROLLBACK_TS="${2:?}"; shift ;;
    --host) HOST="${2:?}"; shift ;;
    --markets) MARKETS="${2:?}"; shift ;;
    --allow-dep-change) ALLOW_DEP_CHANGE=1 ;;
    --allow-open-rentals) ALLOW_OPEN_RENTALS=true ;;
    --tests) TEST_WHERE="${2:?}"; shift ;;
    --no-require-heartbeat) REQUIRE_HEARTBEAT=0 ;;
    --force) FORCE=1 ;;
    --local-stage) LOCAL_STAGE="${2:?}"; shift ;;
    -h|--help) sed -n '2,58p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
case "$TEST_WHERE" in auto|box|local) ;; *) echo "--tests auto|box|local" >&2; exit 2 ;; esac
[[ "$TEST_MIN_MEM_MB" =~ ^[0-9]+$ ]] || { echo "TEST_MIN_MEM_MB must be a number" >&2; exit 2; }
case "$ALLOW_OPEN_RENTALS" in true|1) AOR=1 ;; *) AOR=0 ;; esac

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${REPO:-$(git -C "$HERE" rev-parse --show-toplevel)}"
REMOTE_ROOT="/root/kamigotchi/tools"
SSH=(ssh -o BatchMode=yes -o ConnectTimeout=20 "$HOST")
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
for m in $MARKETS; do case "$m" in musu|vipp) ;; *) die "bad market $m" ;; esac; done

remote() { "${SSH[@]}" "bash -s -- $*"; } # stdin = script
gate() { # markets...
  local args="" m rc=0
  for m in "$@"; do args="$args --market $m"; done
  remote "$args" < "$HERE/lease-transition-gate.sh" || rc=$?
  return "$rc"
}

if [ "$MODE" = rollback ]; then
  log "ROLLBACK code from backup worker-$ROLLBACK_TS for [$MARKETS] on $HOST"
  force_arg=""; [ "$FORCE" = 1 ] && force_arg="--force"
  for m in $MARKETS; do
    # The pre-hardening worker has no tx tracker and re-derives every action; the
    # gate (J1-J3, C1-C2, R1, T1) refuses while a lease is mid-transition.
    rc=0; gate "$m" || rc=$?
    if [ "$rc" != 0 ]; then
      [ "$FORCE" = 1 ] || die "gate refused rollback of $m (exit $rc). Wait until it prints SAFE, or pass --force."
      log "WARN: gate refused (exit $rc) but --force given; rolling back $m anyway"
    fi
    remote "--action rollback --market $m --backup-dir /root/launch-ops-backups/worker-$ROLLBACK_TS/vault-kit-v16-$m --verify-sec $VERIFY_SEC --pending-wait $ROLLBACK_PENDING_WAIT_SEC $force_arg" \
      < "$HERE/deploy/remote-install-worker-code.sh" || die "rollback of $m failed; see output above"
  done
  log "rollback complete"
  exit 0
fi

[ -n "$REF" ] || die "--ref <sha|branch> is required"
SHA=$(git -C "$REPO" rev-parse --verify "$REF^{commit}") || die "cannot resolve $REF in $REPO"
TS=$(date -u +%Y%m%dT%H%M%SZ)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
log "deploy-worker-patch mode=$MODE ref=$REF sha=$SHA host=$HOST markets=[$MARKETS]"

# 1. code files from the ref (code/ is installed; full/ is the tested tree)
git -C "$REPO" archive "$SHA" tools/vault-kit | tar -x -C "$WORK"
mkdir -p "$WORK/stage/code"
for f in "$WORK"/tools/vault-kit/*; do
  b=$(basename "$f")
  [ -f "$f" ] || continue
  case "$b" in renter-pod-*.mjs|kamibots-rental-config*.mjs|*.env.example) cp "$f" "$WORK/stage/code/$b" ;; esac
done
cp -a "$WORK/tools/vault-kit" "$WORK/stage/full"
rm -rf "$WORK/stage/full/node_modules"
ln -s stage/code "$WORK/code"
if [ -n "$LOCAL_STAGE" ]; then
  mkdir -p "$LOCAL_STAGE"
  cp -a "$WORK/stage/." "$LOCAL_STAGE/"
  printf '%s\n' "$SHA" > "$LOCAL_STAGE/SHA"
  log "local staging tree for $SHA written to $LOCAL_STAGE (code/ + full/); nothing else done"
  exit 0
fi
FILES=$(cd "$WORK/code" && ls -1)
[ -n "$FILES" ] || die "no code files found in $SHA:tools/vault-kit"
grep -q '^renter-pod-worker.mjs$' <<<"$FILES" || die "renter-pod-worker.mjs missing from $SHA"
# "<md5> <md5 with CR stripped> <name>": the live VPS copies are CRLF, the repo is LF
sums() { local f; for f in "$@"; do printf '%s %s %s\n' "$(md5sum < "$f" | cut -c1-32)" "$(tr -d '\r' < "$f" | md5sum | cut -c1-32)" "$(basename "$f")"; done; }
(cd "$WORK/code" && sums ./*) > "$WORK/local.md5"
log "$(wc -l < "$WORK/local.md5") code file(s) at $SHA"

# 2. dependency drift
# python3, not jq: the operator machine may not have jq (the VPS does)
deps() { python3 -c 'import json,sys; print(json.dumps(json.load(sys.stdin).get("dependencies", {}), sort_keys=True, indent=1))'; }
local_deps=$(deps < "$WORK/tools/vault-kit/package.json")
remote_deps=$("${SSH[@]}" "cat $REMOTE_ROOT/vault-kit/package.json" | deps) || die "cannot read VPS package.json"
if [ "$local_deps" != "$remote_deps" ]; then
  log "dependency drift between $SHA and the VPS vault-kit/package.json:"
  diff <(echo "$remote_deps") <(echo "$local_deps") || true
  [ "$ALLOW_DEP_CHANGE" = 1 ] || die "refusing: the VPS node_modules would not match (pass --allow-dep-change only if you installed them yourself)"
fi

# diff against live copies (read-only)
declare -A NEED=()
for m in $MARKETS; do
  NEED[$m]=0
  "${SSH[@]}" "cd $REMOTE_ROOT/vault-kit-v16-$m && for f in renter-pod-*.mjs kamibots-rental-config*.mjs *.env.example; do [ -f \"\$f\" ] && printf '%s %s %s\n' \"\$(md5sum < \"\$f\" | cut -c1-32)\" \"\$(tr -d '\\r' < \"\$f\" | md5sum | cut -c1-32)\" \"\$f\"; done" > "$WORK/remote-$m.md5" || true
  log "== $m: file plan"
  while read -r sum norm name; do
    r=$(awk -v n="$name" '$3==n{print $1}' "$WORK/remote-$m.md5")
    rn=$(awk -v n="$name" '$3==n{print $2}' "$WORK/remote-$m.md5")
    # *.test.mjs and *.env.example never change what the running worker does, so on
    # their own they do not justify a restart (they are still copied when the market
    # is deployed for another reason)
    runtime=1; case "$name" in *.test.mjs|*.env.example) runtime=0 ;; esac
    if [ -z "$r" ]; then echo "    NEW      $name"; [ "$runtime" = 0 ] || NEED[$m]=$(( NEED[$m] + 1 ))
    elif [ "$r" = "$sum" ]; then echo "    same     $name"
    elif [ "$rn" = "$norm" ]; then echo "    eol-only $name (identical except CRLF/LF; rewritten as LF only if the market is deployed)"
    else echo "    CHANGED  $name"; [ "$runtime" = 0 ] || NEED[$m]=$(( NEED[$m] + 1 )); fi
  done < "$WORK/local.md5"
  while read -r _ _ name; do
    grep -q " $name\$" "$WORK/local.md5" || echo "    extra    $name (on VPS only; left in place)"
  done < "$WORK/remote-$m.md5"
  if [ ! -s "$WORK/remote-$m.md5" ]; then NEED[$m]=1; log "    (could not list the live files of $m; it will be deployed)"; fi
  if [ "${NEED[$m]}" = 0 ]; then log "== $m already runs the code of $SHA (no NEW/CHANGED runtime file): skipped, no restart"; fi
done
TODO=""
for m in $MARKETS; do [ "${NEED[$m]}" = 0 ] || TODO="$TODO $m"; done
TODO="${TODO# }"
if [ -z "$TODO" ]; then
  log "nothing to deploy: every market in [$MARKETS] already has the code files of $SHA"
  exit 0
fi

# 2b. launch guards (read-only; counts only, never values)
log "launch guards (read-only; ALLOW_OPEN_RENTALS=$([ "$AOR" = 1 ] && echo true || echo false)):"
for m in $TODO; do
  rc=0; remote "--action guards --market $m --allow-open-rentals $AOR" < "$HERE/deploy/remote-install-worker-code.sh" || rc=$?
  [ "$rc" = 0 ] || die "launch guards refused $m (exit $rc): fix the market .env (see above) or, to open rentals on purpose, re-run with ALLOW_OPEN_RENTALS=true. Nothing was changed."
done

# 3. gate
log "mid-transition gate (read-only):"
rc=0; gate $TODO || rc=$?
[ "$rc" = 0 ] || die "gate refused (exit $rc): a v16 lease is mid-transition or state is unreadable. Nothing was changed."

# where the staged tests run (never unguarded next to the live workers)
if [ "$TEST_WHERE" = auto ]; then
  mem=$("${SSH[@]}" "awk '/^MemAvailable:/{print int(\$2/1024)}' /proc/meminfo" 2>/dev/null || echo 0)
  [[ "$mem" =~ ^[0-9]+$ ]] || mem=0
  if [ "$mem" -ge "$TEST_MIN_MEM_MB" ]; then TEST_WHERE=box; else TEST_WHERE=local; fi
  log "tests: auto -> $TEST_WHERE (VPS MemAvailable ${mem} MB, box needs >= ${TEST_MIN_MEM_MB} MB)"
fi

if [ "$MODE" != apply ]; then
  log "[dry-run] would run the vault-kit tests ($TEST_WHERE), stage to /root/launch-ops-staging/worker-$TS, then install [$TODO] one at a time"
  exit 0
fi

# 4. test (off-box or guarded on the box) + stage
local_tests() {
  local node nm c lv rv
  node=$(command -v node) || die "--tests local needs node on this machine"
  nm="${LOCAL_NODE_MODULES:-}"
  for c in "$REPO/tools/vault-kit/node_modules" /home/matrix/kamigotchi/tools/vault-kit/node_modules; do
    [ -n "$nm" ] || { [ -d "$c" ] && nm="$c"; } || true
  done
  [ -n "$nm" ] && [ -d "$nm/ethers" ] || die "--tests local: no vault-kit node_modules with ethers here (set LOCAL_NODE_MODULES)"
  ver() { python3 -c 'import json,sys; print(json.load(sys.stdin)["version"])'; }
  lv=$(ver < "$nm/ethers/package.json")
  rv=$("${SSH[@]}" "cat $REMOTE_ROOT/vault-kit/node_modules/ethers/package.json" | ver) || rv="unknown"
  log "off-box tests: node $("$node" -v) here (the VPS runs v20.20.0), ethers $lv here / $rv on the VPS"
  [ "$lv" = "$rv" ] || [ "$ALLOW_DEP_CHANGE" = 1 ] || die "ethers differs (here $lv, VPS $rv): off-box tests would not prove the box. Use --tests box, or --allow-dep-change"
  NODE_BIN="$node" NODE_MODULES="$nm" bash "$HERE/deploy/remote-install-worker-code.sh" --action test --staging "$WORK/stage" --min-mem-mb 0 \
    || die "tests failed off-box; nothing live changed"
  rm -f "$WORK/stage/full/node_modules" "$WORK/stage/code/node_modules" "$WORK/stage/test.log"
}
[ "$TEST_WHERE" != local ] || local_tests
STAGE="/root/launch-ops-staging/worker-$TS"
tar -C "$WORK/stage" -czf "$WORK/stage.tgz" code full
"${SSH[@]}" "mkdir -p $STAGE && chmod 700 /root/launch-ops-staging $STAGE && tar -xzf - -C $STAGE" < "$WORK/stage.tgz"
printf '%s\n' "$SHA" | "${SSH[@]}" "cat > $STAGE/SHA"
if [ "$TEST_WHERE" = box ]; then
  rc=0; remote "--action test --staging $STAGE --min-mem-mb $TEST_MIN_MEM_MB" < "$HERE/deploy/remote-install-worker-code.sh" || rc=$?
  [ "$rc" != 9 ] || die "VPS memory guard refused the on-box test run; re-run with --tests local. Nothing live changed (staging kept at $STAGE)"
  [ "$rc" = 0 ] || die "tests failed on the VPS; nothing live changed (staging kept at $STAGE)"
fi

# 5. one market at a time (markets with nothing NEW/CHANGED were dropped above)
for m in $TODO; do
  log "== $m: re-checking gate"
  rc=0; gate "$m" || rc=$?
  [ "$rc" = 0 ] || die "gate refused for $m (exit $rc); stopping. Markets already done stay on $SHA."
  rc=0
  remote "--action install --market $m --staging $STAGE --backup-dir /root/launch-ops-backups/worker-$TS/vault-kit-v16-$m --verify-sec $VERIFY_SEC --require-heartbeat $REQUIRE_HEARTBEAT --verify-halt $VERIFY_HALT --pending-wait $ROLLBACK_PENDING_WAIT_SEC --allow-open-rentals $AOR" \
    < "$HERE/deploy/remote-install-worker-code.sh" || rc=$?
  [ "$rc" = 0 ] || die "$m install failed (exit $rc; 4 = verify failed and auto-rolled back, 5/6 = auto-rollback blocked: the patched code runs again with HALT kept, 8 = launch guards refused, nothing changed). Not continuing."
  log "== $m now runs $SHA"
done
log "deployed $SHA to [$TODO]. Rollback: $0 --rollback $TS --markets \"$TODO\""
log "backups under /root/launch-ops-backups/worker-$TS hold code files + state snapshots (operator keys, mode 600). Once stable, prune:"
log "  ssh $HOST 'bash -s -- --prune-days 14 --apply' < $HERE/cleanup-secret-backups.sh"
exit 0
}
