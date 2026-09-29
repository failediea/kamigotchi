#!/usr/bin/env bash
# install-launch-ops.sh - install alerts v2 and (optionally) the H7 timers.
#
# Run ON THE VPS as root from a copy of tools/launch-ops (see README step 0).
#
#   --component alerts   worker-alerts-v2.sh + v2 kami-worker-alerts.service (the timer
#                        is kept), the OnFailure template, and 20-kami-onfailure.conf
#                        drop-ins for caddy + both v16 workers. Creates
#                        /etc/kami-lease-ops/launch-ops.env (mode 600) if absent and
#                        migrates NTFY_TOPIC from the live worker-alerts.sh without
#                        printing it. The live tools/alerts/worker-alerts.sh is NOT touched.
#   --component keeper   lease-expiry-keeper service + timer
#   --component sponsor  lease-gas-sponsor service + timer
#   (repeatable; keeper/sponsor refuse unless SPONSOR_KEY_FILE/SPONSOR_ADDRESS are set)
#   --no-enable          install keeper/sponsor units but do not enable their timers
#
#   (default) --dry-run  print every file it would write; change nothing
#   --apply              back up, write, daemon-reload, enable, run one read-only check
#   --rollback DIR       restore from the backup dir printed by --apply
#
# Idempotent: identical files are skipped. Backups: /root/launch-ops-backups/ops-<UTC ts>/.
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

MODE="dry-run"
COMPONENTS=""
ENABLE=1
ROLLBACK_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --component) COMPONENTS="$COMPONENTS ${2:?--component needs alerts|keeper|sponsor}"; shift ;;
    --no-enable) ENABLE=0 ;;
    --rollback) MODE="rollback"; ROLLBACK_DIR="${2:?--rollback needs the backup dir}"; shift ;;
    -h|--help) sed -n '2,24p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${LAUNCH_OPS_DEST:-/root/kamigotchi/tools/launch-ops}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
ENV_DIR="/etc/kami-lease-ops"
ENV_FILE="$ENV_DIR/launch-ops.env"
LIVE_ALERTS="/root/kamigotchi/tools/alerts/worker-alerts.sh"
BACKUP_ROOT="${BACKUP_ROOT:-/root/launch-ops-backups}"
ONFAIL_TARGETS="caddy.service kami-renter-pod-v16-musu.service kami-renter-pod-v16-vipp.service"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root on the VPS"
command -v jq >/dev/null || die "jq is required"

if [ "$MODE" = rollback ]; then
  [ -f "$ROLLBACK_DIR/manifest.tsv" ] || die "no manifest.tsv in $ROLLBACK_DIR"
  while IFS=$'\t' read -r action path saved; do
    case "$action" in
      created) log "rollback: removing $path"; rm -f "$path" ;;
      replaced) log "rollback: restoring $path"; cp -a "$ROLLBACK_DIR/files/$saved" "$path" ;;
      enabled) log "rollback: disabling $path"; systemctl disable --now "$path" || true ;;
    esac
  done < <(tac "$ROLLBACK_DIR/manifest.tsv")
  systemctl daemon-reload
  log "rollback done. kami-worker-alerts.service now: $(systemctl show kami-worker-alerts.service -p ExecStart --value | tr -s ' ' | cut -c1-160)"
  exit 0
fi

[ -n "$COMPONENTS" ] || die "pick at least one --component (alerts|keeper|sponsor)"

# plan: "src<TAB>dest<TAB>mode"
PLAN=()
add() { PLAN+=("$1"$'\t'"$2"$'\t'"$3"); }
for c in $COMPONENTS; do
  case "$c" in
    alerts)
      add "$SRC/alerts/worker-alerts-v2.sh" "$DEST/alerts/worker-alerts-v2.sh" 700
      add "$SRC/alerts/kami-worker-alerts.service" "$UNIT_DIR/kami-worker-alerts.service" 644
      add "$SRC/alerts/kami-worker-alerts.timer" "$UNIT_DIR/kami-worker-alerts.timer" 644
      add "$SRC/alerts/kami-lease-ops-onfailure@.service" "$UNIT_DIR/kami-lease-ops-onfailure@.service" 644
      for t in $ONFAIL_TARGETS; do
        add "GEN:onfailure" "$UNIT_DIR/$t.d/20-kami-onfailure.conf" 644
      done
      ;;
    keeper)
      add "$SRC/keeper/lease-expiry-keeper.sh" "$DEST/keeper/lease-expiry-keeper.sh" 700
      add "$SRC/keeper/kami-lease-expiry-keeper.service" "$UNIT_DIR/kami-lease-expiry-keeper.service" 644
      add "$SRC/keeper/kami-lease-expiry-keeper.timer" "$UNIT_DIR/kami-lease-expiry-keeper.timer" 644
      ;;
    sponsor)
      add "$SRC/keeper/lease-gas-sponsor.sh" "$DEST/keeper/lease-gas-sponsor.sh" 700
      add "$SRC/keeper/kami-lease-gas-sponsor.service" "$UNIT_DIR/kami-lease-gas-sponsor.service" 644
      add "$SRC/keeper/kami-lease-gas-sponsor.timer" "$UNIT_DIR/kami-lease-gas-sponsor.timer" 644
      ;;
    *) die "unknown component $c" ;;
  esac
done

gen_content() { # src -> content
  if [ "$1" = "GEN:onfailure" ]; then
    printf '# Installed by install-launch-ops.sh --component alerts\n[Unit]\nOnFailure=kami-lease-ops-onfailure@%%n.service\n'
  else
    cat "$1"
  fi
}

needs_sponsor=0
case " $COMPONENTS " in *" keeper "*|*" sponsor "*) needs_sponsor=1 ;; esac
if [ "$needs_sponsor" = 1 ]; then
  # shellcheck disable=SC1090
  if [ -r "$ENV_FILE" ]; then set -a; . "$ENV_FILE"; set +a; fi
  if [ -z "${SPONSOR_KEY_FILE:-}" ] || [ -z "${SPONSOR_ADDRESS:-}" ]; then
    msg="keeper/sponsor need SPONSOR_KEY_FILE and SPONSOR_ADDRESS in $ENV_FILE (OWNER: create + fund the sponsor wallet first)"
    if [ "$MODE" = apply ]; then die "$msg"; else log "WARN: $msg"; fi
  elif [ ! -f "$SPONSOR_KEY_FILE" ]; then
    if [ "$MODE" = apply ]; then die "SPONSOR_KEY_FILE does not exist"; else log "WARN: SPONSOR_KEY_FILE does not exist"; fi
  fi
fi

log "install-launch-ops mode=$MODE components=[$COMPONENTS] src=$SRC dest=$DEST"
CHANGES=0
for p in "${PLAN[@]}"; do
  IFS=$'\t' read -r s d m <<<"$p"
  if [ -f "$d" ] && [ "$(gen_content "$s")" = "$(cat "$d")" ]; then
    log "  unchanged $d"
  elif [ -f "$d" ]; then
    log "  REPLACE   $d (mode $m)"; CHANGES=$((CHANGES + 1))
  else
    log "  CREATE    $d (mode $m)"; CHANGES=$((CHANGES + 1))
  fi
done
case " $COMPONENTS " in *" alerts "*)
  if [ -f "$ENV_FILE" ]; then
    log "  env file $ENV_FILE exists (kept as is)"
  else
    log "  CREATE    $ENV_FILE (mode 600) from launch-ops.env.example; NTFY_TOPIC migrated from $LIVE_ALERTS (value not shown)"
  fi
;; esac

if [ "$MODE" != apply ]; then
  log "[dry-run] $CHANGES file change(s) planned; nothing written"
  exit 0
fi

TS=$(date -u +%Y%m%dT%H%M%SZ)
BK="$BACKUP_ROOT/ops-$TS"
mkdir -p "$BK/files"; chmod 700 "$BACKUP_ROOT" "$BK"
: > "$BK/manifest.tsv"
n=0
for p in "${PLAN[@]}"; do
  IFS=$'\t' read -r s d m <<<"$p"
  want=$(gen_content "$s")
  if [ -f "$d" ] && [ "$want" = "$(cat "$d")" ]; then continue; fi
  if [ -f "$d" ]; then
    n=$((n + 1)); cp -a "$d" "$BK/files/$n"
    printf 'replaced\t%s\t%s\n' "$d" "$n" >> "$BK/manifest.tsv"
  else
    printf 'created\t%s\t-\n' "$d" >> "$BK/manifest.tsv"
  fi
  mkdir -p "$(dirname "$d")"
  printf '%s\n' "$want" > "$d.tmp"; chmod "$m" "$d.tmp"; mv "$d.tmp" "$d"
  log "wrote $d"
done

case " $COMPONENTS " in *" alerts "*)
  if [ ! -f "$ENV_FILE" ]; then
    mkdir -p "$ENV_DIR"; chmod 700 "$ENV_DIR"
    umask 077
    topic=""
    if [ -r "$LIVE_ALERTS" ]; then topic=$(sed -nE 's/^TOPIC="([A-Za-z0-9_-]+)".*/\1/p' "$LIVE_ALERTS" | head -1); fi
    sed -E "s/^NTFY_TOPIC=.*/NTFY_TOPIC=${topic}/" "$SRC/launch-ops.env.example" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    printf 'created\t%s\t-\n' "$ENV_FILE" >> "$BK/manifest.tsv"
    if [ -n "$topic" ]; then log "created $ENV_FILE; NTFY_TOPIC migrated (value not shown)"; else log "WARN: created $ENV_FILE but no topic found; set NTFY_TOPIC by hand"; fi
  fi
;; esac

systemctl daemon-reload
for c in $COMPONENTS; do
  case "$c" in
    alerts) t=kami-worker-alerts.timer ;;
    keeper) t=kami-lease-expiry-keeper.timer ;;
    sponsor) t=kami-lease-gas-sponsor.timer ;;
  esac
  if [ "$c" = alerts ] || [ "$ENABLE" = 1 ]; then
    if [ "$(systemctl is-enabled "$t" 2>/dev/null || true)" != enabled ] || [ "$(systemctl is-active "$t" 2>/dev/null || true)" != active ]; then
      systemctl enable --now "$t"
      printf 'enabled\t%s\t-\n' "$t" >> "$BK/manifest.tsv"
      log "enabled $t"
    else
      log "$t already enabled and active"
    fi
  fi
done

# one read-only pass of each installed script (never --apply here)
for c in $COMPONENTS; do
  case "$c" in
    alerts) LAUNCH_OPS_ENV="$ENV_FILE" "$DEST/alerts/worker-alerts-v2.sh" --dry-run | tail -25 || true ;;
    keeper) LAUNCH_OPS_ENV="$ENV_FILE" "$DEST/keeper/lease-expiry-keeper.sh" --dry-run | tail -15 || true ;;
    sponsor) LAUNCH_OPS_ENV="$ENV_FILE" "$DEST/keeper/lease-gas-sponsor.sh" --dry-run | tail -15 || true ;;
  esac
done
log "backup + manifest: $BK   (rollback: $0 --rollback $BK)"
exit 0
}
