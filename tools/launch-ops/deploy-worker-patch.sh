#!/usr/bin/env bash
# deploy-worker-patch.sh - install a worker branch/sha into both v16 VPS dirs.
#
# Runs on the OPERATOR MACHINE (WSL, where the kamigotchi git repo lives), not on
# the VPS: /root/kamigotchi on the VPS is not a git checkout.
#
#   deploy-worker-patch.sh --ref <sha|branch>                 dry-run (read-only)
#   deploy-worker-patch.sh --ref <sha|branch> --apply         install
#   deploy-worker-patch.sh --rollback <TS> [--markets "vipp"] restore code from a backup
#
# What --apply does, in order (stops at the first failure):
#   1. git archive <ref>:tools/vault-kit locally; keep only code files
#      (renter-pod-*.mjs, kamibots-rental-config*.mjs, *.env.example)
#   2. refuse if tools/vault-kit/package.json dependencies differ from the VPS copy
#      (no npm install on the box) unless --allow-dep-change
#   3. mid-transition gate (lease-transition-gate.sh, read-only) for all markets
#   4. upload to /root/launch-ops-staging/worker-<TS>/ and run the vault-kit tests
#      there (node --test *.test.mjs); nothing live changes if they fail
#   5. per market, ONE AT A TIME (default order: musu, the market with 0 jobs, then vipp):
#      re-run the gate for that market; back up the whole dir to
#      /root/launch-ops-backups/worker-<TS>/vault-kit-v16-<m>/; copy code files only
#      (.env*, state, reservations, heartbeat, keys, node_modules untouched); restart
#      the unit; verify for VERIFY_SEC (120): unit active, port 8791/8792 bound,
#      heartbeat.json fresh (ts >= restart and <= 120 s old), no [LEASE-ALERT] line,
#      no auto-restart; on failure restore that market's code, restart, exit non-zero
#      (the next market is not touched)
#
# Dry-run does steps 1-3 plus a per-file diff against the live copies. It writes
# nothing locally except a temp dir, and nothing on the VPS.
# Rollback: --rollback <TS> restores code files from the backup of that run
# (heartbeat not required, since older code does not write one).
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
while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="${2:?}"; shift ;;
    --apply) MODE="apply" ;;
    --dry-run) MODE="dry-run" ;;
    --rollback) MODE="rollback"; ROLLBACK_TS="${2:?}"; shift ;;
    --host) HOST="${2:?}"; shift ;;
    --markets) MARKETS="${2:?}"; shift ;;
    --allow-dep-change) ALLOW_DEP_CHANGE=1 ;;
    --no-require-heartbeat) REQUIRE_HEARTBEAT=0 ;;
    -h|--help) sed -n '2,33p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

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
  for m in $MARKETS; do
    remote "--action rollback --market $m --backup-dir /root/launch-ops-backups/worker-$ROLLBACK_TS/vault-kit-v16-$m --verify-sec $VERIFY_SEC" \
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

# 1. code files from the ref
git -C "$REPO" archive "$SHA" tools/vault-kit | tar -x -C "$WORK"
mkdir -p "$WORK/code"
for f in "$WORK"/tools/vault-kit/*; do
  b=$(basename "$f")
  case "$b" in renter-pod-*.mjs|kamibots-rental-config*.mjs|*.env.example) cp "$f" "$WORK/code/$b" ;; esac
done
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
for m in $MARKETS; do
  "${SSH[@]}" "cd $REMOTE_ROOT/vault-kit-v16-$m && for f in renter-pod-*.mjs kamibots-rental-config*.mjs *.env.example; do [ -f \"\$f\" ] && printf '%s %s %s\n' \"\$(md5sum < \"\$f\" | cut -c1-32)\" \"\$(tr -d '\\r' < \"\$f\" | md5sum | cut -c1-32)\" \"\$f\"; done" > "$WORK/remote-$m.md5" || true
  log "== $m: file plan"
  while read -r sum norm name; do
    r=$(awk -v n="$name" '$3==n{print $1}' "$WORK/remote-$m.md5")
    rn=$(awk -v n="$name" '$3==n{print $2}' "$WORK/remote-$m.md5")
    if [ -z "$r" ]; then echo "    NEW      $name"
    elif [ "$r" = "$sum" ]; then echo "    same     $name"
    elif [ "$rn" = "$norm" ]; then echo "    eol-only $name (identical except CRLF/LF; will be rewritten as LF)"
    else echo "    CHANGED  $name"; fi
  done < "$WORK/local.md5"
  while read -r _ _ name; do
    grep -q " $name\$" "$WORK/local.md5" || echo "    extra    $name (on VPS only; left in place)"
  done < "$WORK/remote-$m.md5"
done

# 3. gate
log "mid-transition gate (read-only):"
rc=0; gate $MARKETS || rc=$?
[ "$rc" = 0 ] || die "gate refused (exit $rc): a v16 lease is mid-transition or state is unreadable. Nothing was changed."

if [ "$MODE" != apply ]; then
  log "[dry-run] would stage to /root/launch-ops-staging/worker-$TS, run tests, then install [$MARKETS] one at a time"
  exit 0
fi

# 4. stage + test on the box
STAGE="/root/launch-ops-staging/worker-$TS"
tar -C "$WORK/code" -czf "$WORK/code.tgz" .
"${SSH[@]}" "mkdir -p $STAGE/code && chmod 700 /root/launch-ops-staging $STAGE && tar -xzf - -C $STAGE/code" < "$WORK/code.tgz"
printf '%s\n' "$SHA" | "${SSH[@]}" "cat > $STAGE/SHA"
remote "--action test --staging $STAGE" < "$HERE/deploy/remote-install-worker-code.sh" || die "tests failed on the VPS; nothing live changed (staging kept at $STAGE)"

# 5. one market at a time
for m in $MARKETS; do
  log "== $m: re-checking gate"
  rc=0; gate "$m" || rc=$?
  [ "$rc" = 0 ] || die "gate refused for $m (exit $rc); stopping. Markets already done stay on $SHA."
  rc=0
  remote "--action install --market $m --staging $STAGE --backup-dir /root/launch-ops-backups/worker-$TS/vault-kit-v16-$m --verify-sec $VERIFY_SEC --require-heartbeat $REQUIRE_HEARTBEAT" \
    < "$HERE/deploy/remote-install-worker-code.sh" || rc=$?
  [ "$rc" = 0 ] || die "$m install failed (exit $rc; 4 = verify failed and auto-rolled back). Not continuing."
  log "== $m now runs $SHA"
done
log "deployed $SHA to [$MARKETS]. Rollback: $0 --rollback $TS --markets \"$MARKETS\""
log "backups under /root/launch-ops-backups/worker-$TS contain .env and state copies (secrets): prune once stable."
exit 0
}
