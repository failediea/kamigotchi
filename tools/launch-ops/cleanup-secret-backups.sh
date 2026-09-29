#!/usr/bin/env bash
# cleanup-secret-backups.sh - VPS-12. OWNER runs it on the VPS as root.
#
# Dry-run by default (prints file names, modes and sizes; never file contents).
# With --apply, in every v16 market dir ($KAMI_ROOT/vault-kit-v16-<market>):
#   1. shreds stale secret backups: .env.*bak* / .env-*bak* files
#      (e.g. .env.bak-stackA, which holds KEEPER_PRIVATE_KEY) that no systemd unit
#      file under $UNIT_DIR references. The live .env is never touched. A file a
#      unit references is reported and kept.
#   2. removes group/world write from every regular file in the dir (the live
#      renter-pod-worker.mjs.bak-* files are 777) and makes *.bak* code backups
#      root-only (600).
# With --prune-days N (and --apply) it also deletes deploy backups and staging dirs
# older than N days: $BACKUP_ROOT/worker-* (code + state snapshots with operator
# keys; older ones also hold .env copies) and $STAGING_ROOT/worker-*. Files are
# shredded before the directory is removed.
#
# Nothing is restarted and no worker code or state is changed. There is no
# rollback for a shred: that is the point. Run the dry-run first and read it.
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

MODE="dry-run"
PRUNE_DAYS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --prune-days) PRUNE_DAYS="${2:?--prune-days needs a number of days}"; shift ;;
    -h|--help) sed -n '2,21p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$PRUNE_DAYS" ] || [[ "$PRUNE_DAYS" =~ ^[0-9]+$ ]] || { echo "--prune-days must be a number" >&2; exit 2; }

KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
V16_MARKETS="${V16_MARKETS:-musu vipp}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/launch-ops-backups}"
STAGING_ROOT="${STAGING_ROOT:-/root/launch-ops-staging}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root on the VPS"
describe() { stat -c '%a %s bytes' "$1"; }
wipe() { # file: shred (fallback rm) - contents are never printed
  if command -v shred >/dev/null 2>&1; then shred -u -z "$1"; else rm -f "$1"; fi
}

log "cleanup-secret-backups mode=$MODE markets=[$V16_MARKETS] prune-days=${PRUNE_DAYS:-off}"
ACTIONS=0
for m in $V16_MARKETS; do
  dir="$KAMI_ROOT/vault-kit-v16-$m"
  [ -d "$dir" ] || { log "== $m: $dir missing; skipped"; continue; }
  log "== $m ($dir)"
  # 1. stale .env backups
  for f in "$dir"/.env.*bak* "$dir"/.env-*bak*; do # .env.*bak* also covers .env.bak*
    [ -f "$f" ] || continue
    b=$(basename "$f")
    [ "$b" != .env ] || continue
    refs=$(grep -rlF -- "$b" "$UNIT_DIR" 2>/dev/null || true)
    if [ -n "$refs" ]; then
      log "  KEEP    $b ($(describe "$f")): referenced by $(tr '\n' ' ' <<<"$refs")"
      continue
    fi
    ACTIONS=$((ACTIONS + 1))
    if [ "$MODE" = apply ]; then wipe "$f"; log "  shredded $b"; else log "  WOULD shred $b ($(describe "$f")): no unit references it"; fi
  done
  # 2. write bits and code backups
  while IFS= read -r -d '' f; do
    b=$(basename "$f")
    case "$b" in .env|.env.*|.env-*) want="go-rwx" ;; *.bak*) want=600 ;; *) want="go-w" ;; esac
    ACTIONS=$((ACTIONS + 1))
    if [ "$MODE" = apply ]; then chmod "$want" "$f"; log "  chmod $want $b (now $(stat -c %a "$f"))"; else log "  WOULD chmod $want $b (mode $(stat -c %a "$f"))"; fi
  done < <(find "$dir" -maxdepth 1 -type f -perm /022 -print0)
  while IFS= read -r -d '' f; do
    b=$(basename "$f")
    ACTIONS=$((ACTIONS + 1))
    if [ "$MODE" = apply ]; then chmod 600 "$f"; log "  chmod 600 $b"; else log "  WOULD chmod 600 $b (mode $(stat -c %a "$f"))"; fi
  done < <(find "$dir" -maxdepth 1 -type f -name '*.bak*' ! -name '.env*' -perm /044 ! -perm /022 -print0)
done

# 3. old deploy backups and staging dirs
if [ -n "$PRUNE_DAYS" ]; then
  for root in "$BACKUP_ROOT" "$STAGING_ROOT"; do
    [ -d "$root" ] || continue
    while IFS= read -r -d '' d; do
      ACTIONS=$((ACTIONS + 1))
      if [ "$MODE" = apply ]; then
        find "$d" -type f -print0 | while IFS= read -r -d '' f; do wipe "$f"; done
        rm -rf "$d"
        log "  pruned $d"
      else
        log "  WOULD prune $d ($(find "$d" -type f | wc -l) files, older than $PRUNE_DAYS days)"
      fi
    done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name 'worker-*' -mtime "+$PRUNE_DAYS" -print0)
  done
fi

if [ "$MODE" = apply ]; then log "done: $ACTIONS action(s) applied"; else log "[dry-run] $ACTIONS action(s) planned; nothing changed"; fi
exit 0
}
