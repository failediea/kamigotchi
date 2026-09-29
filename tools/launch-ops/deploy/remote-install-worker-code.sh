#!/usr/bin/env bash
# remote-install-worker-code.sh - VPS half of deploy-worker-patch.sh. Do not run by hand
# unless you know why; deploy-worker-patch.sh pipes it over ssh with explicit args.
#
#   --action install   copy code files from STAGING into the market dir (backup first),
#                      restart the unit, verify, auto-rollback on failure
#   --action rollback  restore code files from BACKUP_DIR, restart, verify (no heartbeat needed)
#   --action test      run the vault-kit tests inside STAGING (nothing live is touched)
#
# Only code files are ever written: names must match renter-pod-*.mjs,
# kamibots-rental-config*.mjs or *.env.example. .env*, *.json (worker state,
# reservations, heartbeat), HALT, node_modules and anything else are never touched.
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

ACTION="" MARKET="" STAGING="" BACKUP_DIR="" VERIFY_SEC=120 REQUIRE_HEARTBEAT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --action) ACTION="$2"; shift ;;
    --market) MARKET="$2"; shift ;;
    --staging) STAGING="$2"; shift ;;
    --backup-dir) BACKUP_DIR="$2"; shift ;;
    --verify-sec) VERIFY_SEC="$2"; shift ;;
    --require-heartbeat) REQUIRE_HEARTBEAT="$2"; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v20.20.0/bin/node}"
NODE_MODULES="${NODE_MODULES:-$KAMI_ROOT/vault-kit/node_modules}"
log() { printf '%s [remote %s] %s\n' "$(date -u +%FT%TZ)" "${MARKET:-test}" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "must run as root"

is_code() { case "$1" in renter-pod-*.mjs|kamibots-rental-config*.mjs|*.env.example) return 0 ;; *) return 1 ;; esac; }

if [ "$ACTION" = test ]; then
  [ -d "$STAGING/code" ] || die "no staging code at $STAGING/code"
  ln -sfn "$NODE_MODULES" "$STAGING/code/node_modules"
  cd "$STAGING/code"
  log "running: node --test *.test.mjs (in staging)"
  if timeout 300 "$NODE_BIN" --test ./*.test.mjs > "$STAGING/test.log" 2>&1; then
    grep -E '^# (tests|pass|fail|skipped|todo|cancelled)' "$STAGING/test.log" || true
    log "tests PASSED"
    exit 0
  fi
  tail -40 "$STAGING/test.log"
  grep -E '^# (tests|pass|fail|skipped)' "$STAGING/test.log" || true
  die "tests FAILED (full log: $STAGING/test.log); nothing live was changed"
fi

case "$MARKET" in musu) PORT=8791 ;; vipp) PORT=8792 ;; *) die "--market musu|vipp" ;; esac
DIR="$KAMI_ROOT/vault-kit-v16-$MARKET"
UNIT="kami-renter-pod-v16-$MARKET"
[ -d "$DIR" ] || die "$DIR missing"

state_file() {
  local v=""
  v=$(grep -E '^WORKER_STATE_FILE=' "$DIR/.env" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^ +| +$//g' || true)
  [ -n "$v" ] || v="$DIR/renter-pod-worker-state.json"
  case "$v" in /*) ;; *) v="$DIR/$v" ;; esac
  printf '%s' "$v"
}
SF=$(state_file)
HB="$(dirname "$SF")/heartbeat.json"

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
    chown root:root "$DIR/.$base.new"
    mv -f "$DIR/.$base.new" "$DIR/$base"
    echo "$base"
  done
}

verify() { # start_ts require_hb -> 0 ok
  local start="$1" need_hb="$2" end=$(( $1 + VERIFY_SEC )) ok_hb=0 now ts la
  while :; do
    now=$(date +%s)
    if [ "$need_hb" = 1 ]; then
      if [ -r "$HB" ]; then
        ts=$(jq -r '.ts // 0' "$HB" 2>/dev/null || echo 0); ts=${ts%.*}
        [[ "$ts" =~ ^[0-9]+$ ]] || ts=0
        if [ "$ts" -ge "$start" ] && [ $((now - ts)) -le 120 ]; then ok_hb=1; fi
      fi
    else
      if [ -e "$SF" ] && [ "$(stat -c %Y "$SF")" -ge "$start" ]; then ok_hb=1; fi
    fi
    [ "$now" -ge "$end" ] && break
    sleep 5
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

if [ "$ACTION" = rollback ]; then
  [ -d "$BACKUP_DIR" ] || die "backup dir $BACKUP_DIR missing"
  # A newer worker may have moved reservations out of the state file. The old
  # code would not see them and a renter's create tx would wedge ingest. Refuse
  # while any live reservation sits in a separate file.
  for rf in "$(dirname "$SF")"/*reservations*.json; do
    [ -r "$rf" ] || continue
    n=$(jq '(if has("reservations") then .reservations else . end) | if type=="object" then length else 0 end' "$rf" 2>/dev/null || echo 1)
    if [ "$n" -gt 0 ]; then
      die "rollback refused: $n live reservation(s) in $(basename "$rf") that old code cannot read. Stop new quotes first (touch $(dirname "$SF")/HALT; the patched worker then answers 503), wait RESERVATION_TTL_SEC, retry."
    fi
  done
  before=$(protected_sums)
  restore_from "$BACKUP_DIR"
  [ "$before" = "$(protected_sums)" ] || die ".env files changed during rollback (should be impossible)"
  start=$(date +%s)
  systemctl restart "$UNIT"
  NRESTARTS_BEFORE=$(systemctl show "$UNIT" -p NRestarts --value)
  if verify "$start" 0; then log "rollback OK"; exit 0; fi
  die "rollback verification failed; inspect: journalctl -u $UNIT -n 100"
fi

[ "$ACTION" = install ] || die "--action install|rollback|test"
[ -d "$STAGING/code" ] || die "no staging code at $STAGING/code"
[ -n "$BACKUP_DIR" ] || die "--backup-dir required"

log "backup $DIR -> $BACKUP_DIR (full copy incl. .env/state, mode 700)"
mkdir -p "$BACKUP_DIR"
chmod 700 "$(dirname "$BACKUP_DIR")" "$BACKUP_DIR"
cp -a "$DIR/." "$BACKUP_DIR/"
before=$(protected_sums)
state_md5=$(md5sum < "$SF" | cut -c1-32)

log "copying code files:"
copy_code_from "$STAGING/code" | sed 's/^/    /'
[ "$before" = "$(protected_sums)" ] || { restore_from "$BACKUP_DIR"; die ".env files changed during copy; restored code"; }
log "protected .env files unchanged; state md5 before restart ${state_md5:0:8}"

start=$(date +%s)
systemctl restart "$UNIT"
NRESTARTS_BEFORE=$(systemctl show "$UNIT" -p NRestarts --value)
log "restarted $UNIT at $start; verifying for ${VERIFY_SEC}s"
if verify "$start" "$REQUIRE_HEARTBEAT"; then
  log "install OK"
  exit 0
fi

log "VERIFY FAILED - auto-rollback to $BACKUP_DIR code"
restore_from "$BACKUP_DIR"
start=$(date +%s)
systemctl restart "$UNIT"
NRESTARTS_BEFORE=$(systemctl show "$UNIT" -p NRestarts --value)
if verify "$start" 0; then
  log "auto-rollback OK (old code running)"
else
  log "auto-rollback verification ALSO failed; human needed: journalctl -u $UNIT -n 100"
fi
exit 4
}
