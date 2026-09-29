#!/usr/bin/env bash
# install-dropins.sh - systemd drop-ins for launch (VPS-8, VPS-10, VPS-12).
#
# Run ON THE VPS as root from a copy of tools/launch-ops.
#   caddy.service                    Restart=on-failure, RestartSec=5, OOMScoreAdjust=-500
#   kami-renter-pod-v16-musu/-vipp   OOMScoreAdjust=-500, Description "v16" (was "v15");
#                                    Restart=always / RestartSec=10 appended ONLY if the
#                                    live unit lacks them (it has both as of 2026-09-29)
#
# Nothing is restarted. `systemctl daemon-reload` makes Restart=/Description
# effective; OOMScoreAdjust only applies at the next process start, so --apply
# also sets /proc/<MainPID>/oom_score_adj on the running processes (skip with
# --no-live-oom).
#
# Usage:
#   install-dropins.sh                 dry-run: show current values and the planned files
#   install-dropins.sh --apply         back up, write drop-ins, daemon-reload, verify
#   install-dropins.sh --rollback DIR  restore from a backup dir printed by --apply
#
# Idempotent: identical files are left alone. Backups: /root/launch-ops-backups/dropins-<UTC ts>/.
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

MODE="dry-run"
LIVE_OOM=1
ROLLBACK_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --no-live-oom) LIVE_OOM=0 ;;
    --rollback) MODE="rollback"; ROLLBACK_DIR="${2:?--rollback needs the backup dir}"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/systemd"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/launch-ops-backups}"
DROPIN_NAME="10-kami-launch.conf"
WORKERS="kami-renter-pod-v16-musu.service kami-renter-pod-v16-vipp.service"
UNITS="caddy.service $WORKERS"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root on the VPS"

show() { systemctl show "$1" -p Description -p Restart -p RestartUSec -p OOMScoreAdjust -p MainPID -p DropInPaths --no-pager | sed 's/^/    /'; }

desired_content() { # unit -> content on stdout
  local unit="$1" src="$SRC_DIR/$1.d/$DROPIN_NAME" restart rsec
  [ -r "$src" ] || die "missing $src"
  cat "$src"
  case " $WORKERS " in
    *" $unit "*)
      restart=$(systemctl show "$unit" -p Restart --value)
      rsec=$(systemctl show "$unit" -p RestartUSec --value)
      # Only what is missing (Restart=always / RestartSec=10 already live on 2026-09-29).
      if [ "$restart" != always ] || [ "$rsec" != 10s ]; then
        printf '\n# appended by install-dropins.sh: live unit had Restart=%s RestartUSec=%s\n' "$restart" "$rsec"
        [ "$restart" = always ] || echo "Restart=always"
        [ "$rsec" = 10s ] || echo "RestartSec=10"
      fi
      ;;
  esac
}

if [ "$MODE" = rollback ]; then
  [ -f "$ROLLBACK_DIR/manifest.tsv" ] || die "no manifest.tsv in $ROLLBACK_DIR"
  while IFS=$'\t' read -r action path; do
    case "$action" in
      created) log "rollback: removing $path"; rm -f "$path"; rmdir --ignore-fail-on-non-empty "$(dirname "$path")" 2>/dev/null || true ;;
      replaced) log "rollback: restoring $path"; install -m 644 "$ROLLBACK_DIR/files/$(basename "$(dirname "$path")")/$(basename "$path")" "$path" ;;
    esac
  done < "$ROLLBACK_DIR/manifest.tsv"
  systemctl daemon-reload
  for u in $UNITS; do
    pid=$(systemctl show "$u" -p MainPID --value)
    want=$(systemctl show "$u" -p OOMScoreAdjust --value)
    if [ "${pid:-0}" != 0 ] && [ -w "/proc/$pid/oom_score_adj" ]; then echo "$want" > "/proc/$pid/oom_score_adj"; fi
    log "after rollback: $u"; show "$u"
  done
  exit 0
fi

log "install-dropins mode=$MODE"
CHANGES=0
for u in $UNITS; do
  systemctl cat "$u" >/dev/null 2>&1 || die "unit $u not found"
  log "current $u:"; show "$u"
  target="$UNIT_DIR/$u.d/$DROPIN_NAME"
  want=$(desired_content "$u")
  if [ -f "$target" ] && [ "$(cat "$target")" = "$want" ]; then
    log "  $target unchanged"
    continue
  fi
  CHANGES=$((CHANGES + 1))
  log "  will write $target:"
  sed 's/^/      | /' <<<"$want"
done

if [ "$MODE" != apply ]; then
  log "[dry-run] $CHANGES file(s) would change; nothing written, nothing reloaded"
  exit 0
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
BK="$BACKUP_ROOT/dropins-$TS"
mkdir -p "$BK/files"
chmod 700 "$BACKUP_ROOT" "$BK"
: > "$BK/manifest.tsv"
for u in $UNITS; do
  target="$UNIT_DIR/$u.d/$DROPIN_NAME"
  want=$(desired_content "$u")
  if [ -f "$target" ] && [ "$(cat "$target")" = "$want" ]; then continue; fi
  if [ -f "$target" ]; then
    mkdir -p "$BK/files/$u.d"
    cp -a "$target" "$BK/files/$u.d/"
    printf 'replaced\t%s\n' "$target" >> "$BK/manifest.tsv"
  else
    printf 'created\t%s\n' "$target" >> "$BK/manifest.tsv"
  fi
  mkdir -p "$UNIT_DIR/$u.d"
  printf '%s\n' "$want" > "$target.tmp"
  chmod 644 "$target.tmp"
  mv "$target.tmp" "$target"
  log "wrote $target"
done
systemd-analyze verify $UNITS >/dev/null 2>&1 || log "WARN: systemd-analyze verify reported issues (often pre-existing; review with: systemd-analyze verify $UNITS)"
systemctl daemon-reload

FAIL=0
for u in $UNITS; do
  if [ "$LIVE_OOM" = 1 ]; then
    pid=$(systemctl show "$u" -p MainPID --value)
    if [ "${pid:-0}" != 0 ] && [ -w "/proc/$pid/oom_score_adj" ]; then
      echo -500 > "/proc/$pid/oom_score_adj"
      log "live oom_score_adj for $u (pid $pid) = $(cat "/proc/$pid/oom_score_adj")"
    fi
  fi
  log "verify $u:"; show "$u"
  [ "$(systemctl show "$u" -p OOMScoreAdjust --value)" = -500 ] || { log "FAIL: $u OOMScoreAdjust"; FAIL=1; }
  [ "$(systemctl is-active "$u")" = active ] || { log "FAIL: $u not active"; FAIL=1; }
done
[ "$(systemctl show caddy.service -p Restart --value)" = on-failure ] || { log "FAIL: caddy Restart"; FAIL=1; }
for w in $WORKERS; do
  [ "$(systemctl show "$w" -p Restart --value)" = always ] || { log "FAIL: $w Restart"; FAIL=1; }
  systemctl show "$w" -p Description --value | grep -q v16 || { log "FAIL: $w Description"; FAIL=1; }
done
log "backup + manifest: $BK   (rollback: $0 --rollback $BK)"
[ "$FAIL" = 0 ] || die "verification failed; consider: $0 --rollback $BK"
log "done"
exit 0
}
