#!/usr/bin/env bash
# harden-ssh.sh - H6 / VPS-5. FOR THE OWNER TO RUN on the VPS as root. Not run by the assistant.
#
#  !!!  KEEP YOUR CURRENT SSH SESSION OPEN UNTIL YOU HAVE LOGGED IN FROM A SECOND  !!!
#  !!!  TERMINAL WITH YOUR KEY. If anything goes wrong, the DigitalOcean web       !!!
#  !!!  console (Droplet > Access > Recovery console) still works.                 !!!
#
# What --apply does (dry-run by default prints the plan and current state only):
#   1. refuses unless /root/.ssh/authorized_keys holds >= 1 valid key AND this
#      session logged in with a public key (checked in the sshd journal against
#      $SSH_CONNECTION)
#   2. backs up /etc/ssh/sshd_config + sshd_config.d/ to /root/launch-ops-backups/ssh-<ts>/
#   3. writes /etc/ssh/sshd_config.d/01-kami-hardening.conf:
#        PasswordAuthentication no, KbdInteractiveAuthentication no,
#        PermitRootLogin prohibit-password
#      (named 01- so it wins over 50-cloud-init.conf, which sets PasswordAuthentication yes;
#      sshd keeps the FIRST value it reads)
#   4. sshd -t (config test; the drop-in is removed again if it fails), checks sshd -T,
#      then RELOADS (not restarts) ssh.service - existing sessions stay up
#   5. ufw allow 22/tcp, 80/tcp, 443/tcp, 443/udp; ufw --force enable
#      (refuses if other public listeners would be blocked, unless --allow-block-other-ports)
#   6. apt-get install fail2ban; sshd jail (systemd backend, your current IP in ignoreip)
#
# Options: --skip-ufw, --skip-fail2ban, --allow-console (run from the DO console,
#          no SSH_CONNECTION), --rollback DIR
# Idempotent: re-running changes nothing that is already in place.
{
set -euo pipefail

MODE="dry-run"
SKIP_UFW=0; SKIP_F2B=0; ALLOW_CONSOLE=0; ALLOW_BLOCK=0; ROLLBACK_DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --skip-ufw) SKIP_UFW=1 ;;
    --skip-fail2ban) SKIP_F2B=1 ;;
    --allow-console) ALLOW_CONSOLE=1 ;;
    --allow-block-other-ports) ALLOW_BLOCK=1 ;;
    --rollback) MODE="rollback"; ROLLBACK_DIR="${2:?}"; shift ;;
    -h|--help) sed -n '2,29p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

DROPIN=/etc/ssh/sshd_config.d/01-kami-hardening.conf
F2B_JAIL=/etc/fail2ban/jail.d/kami-sshd.local
BACKUP_ROOT="${BACKUP_ROOT:-/root/launch-ops-backups}"
HOSTIP=$(hostname -I 2>/dev/null | awk '{print $1}')
log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root"

cat <<'BANNER'
==========================================================================
  KEEP THIS SSH SESSION OPEN. Test a NEW key-based login in a second
  terminal before closing it. DigitalOcean recovery console = fallback.
==========================================================================
BANNER

if [ "$MODE" = rollback ]; then
  [ -d "$ROLLBACK_DIR" ] || die "no backup dir $ROLLBACK_DIR"
  rm -f "$DROPIN"
  cp -a "$ROLLBACK_DIR/sshd_config" /etc/ssh/sshd_config
  if [ -d "$ROLLBACK_DIR/sshd_config.d" ]; then cp -a "$ROLLBACK_DIR/sshd_config.d/." /etc/ssh/sshd_config.d/; fi
  sshd -t || die "restored config fails sshd -t; fix by hand before reloading"
  systemctl reload ssh.service
  if [ -f "$ROLLBACK_DIR/ufw-was-inactive" ]; then ufw --force disable || true; fi
  if [ -f "$ROLLBACK_DIR/f2b-jail-created" ]; then rm -f "$F2B_JAIL"; systemctl disable --now fail2ban || true; fi
  log "rollback done. Effective: $(sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication) ' | tr '\n' ' ')"
  exit 0
fi

# ---- current state ----
log "current effective sshd settings:"
sshd -T 2>/dev/null | grep -E '^(passwordauthentication|permitrootlogin|kbdinteractiveauthentication|pubkeyauthentication) ' | sed 's/^/    /'
log "sshd_config.d: $(ls /etc/ssh/sshd_config.d/ 2>/dev/null | tr '\n' ' ')"
log "ufw: $(ufw status 2>/dev/null | head -1)   fail2ban: $(systemctl is-active fail2ban 2>/dev/null || echo not-installed)"

# ---- 1. preconditions ----
AK=/root/.ssh/authorized_keys
nkeys=0
if [ -r "$AK" ]; then nkeys=$(ssh-keygen -lf "$AK" 2>/dev/null | wc -l); fi
log "authorized_keys: $nkeys valid key(s)"
[ "$nkeys" -ge 1 ] || die "no valid key in $AK; add yours first (ssh-copy-id) or you WILL be locked out"

CLIENT_IP=""; CLIENT_PORT=""
if [ -n "${SSH_CONNECTION:-}" ]; then
  read -r CLIENT_IP CLIENT_PORT _ _ <<<"$SSH_CONNECTION"
  how=$(journalctl -u ssh.service -u ssh.socket --since "-14d" --no-pager -o cat 2>/dev/null \
        | grep -E "Accepted [a-z-]+ for [^ ]+ from $CLIENT_IP port $CLIENT_PORT " | tail -1 | awk '{print $2}' || true)
  log "this session: from $CLIENT_IP:$CLIENT_PORT, auth method: ${how:-unknown}"
  if [ "$how" != publickey ]; then
    [ "$MODE" = apply ] && die "this session did not log in with a public key (method: ${how:-unknown}). Log in with your key and re-run."
    log "WARN: --apply would refuse from this session (not key-based)"
  fi
elif [ "$ALLOW_CONSOLE" = 1 ]; then
  log "no SSH_CONNECTION: running from the console (--allow-console)"
else
  [ "$MODE" = apply ] && die "cannot tell how you logged in (no SSH_CONNECTION). Run from a key-based SSH session, or pass --allow-console from the DO console."
fi

WANT_DROPIN='# Installed by tools/launch-ops/harden-ssh.sh (H6 / VPS-5). 01- sorts before
# 50-cloud-init.conf; sshd keeps the first value it reads for each keyword.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password'

OTHER_PORTS=$(ss -Hltnu 2>/dev/null | awk '{print $5}' | grep -vE '^(127\.|\[::1\]|\[?::ffff:127\.)' \
  | sed -E 's/.*:([0-9]+)$/\1/' | grep -vxE '22|80|443' | sort -un | tr '\n' ' ' || true)
[ -n "$OTHER_PORTS" ] && log "public listeners ufw would block: $OTHER_PORTS"

if [ "$MODE" != apply ]; then
  log "[dry-run] would write $DROPIN:"; sed 's/^/      | /' <<<"$WANT_DROPIN"
  [ "$SKIP_UFW" = 1 ] || log "[dry-run] would run: ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp; ufw --force enable"
  [ "$SKIP_F2B" = 1 ] || log "[dry-run] would apt-get install fail2ban and write $F2B_JAIL (ignoreip includes ${CLIENT_IP:-none})"
  log "[dry-run] nothing changed"
  exit 0
fi

# ---- 2. backup ----
TS=$(date -u +%Y%m%dT%H%M%SZ)
BK="$BACKUP_ROOT/ssh-$TS"
mkdir -p "$BK"; chmod 700 "$BACKUP_ROOT" "$BK"
cp -a /etc/ssh/sshd_config "$BK/sshd_config"
cp -a /etc/ssh/sshd_config.d "$BK/sshd_config.d"
log "backup: $BK"

# ---- 3/4. sshd drop-in ----
if [ -f "$DROPIN" ] && [ "$(cat "$DROPIN")" = "$WANT_DROPIN" ]; then
  log "$DROPIN already in place"
else
  printf '%s\n' "$WANT_DROPIN" > "$DROPIN.tmp"; chmod 644 "$DROPIN.tmp"; mv "$DROPIN.tmp" "$DROPIN"
  log "wrote $DROPIN"
fi
if ! sshd -t; then
  rm -f "$DROPIN"
  die "sshd -t failed; drop-in removed, sshd NOT reloaded"
fi
eff=$(sshd -T 2>/dev/null)
grep -qx 'passwordauthentication no' <<<"$eff" || die "sshd -T still shows password auth enabled; not reloading (check other sshd_config.d files)"
grep -qE '^permitrootlogin (without-password|prohibit-password)$' <<<"$eff" || die "sshd -T permitrootlogin is not prohibit-password; not reloading"
grep -qx 'kbdinteractiveauthentication no' <<<"$eff" || die "sshd -T kbdinteractiveauthentication is not no; not reloading"
systemctl reload ssh.service
log "ssh.service reloaded (existing sessions unaffected)"

# ---- 5. ufw ----
if [ "$SKIP_UFW" = 0 ]; then
  if [ -n "$OTHER_PORTS" ] && [ "$ALLOW_BLOCK" = 0 ]; then
    die "ufw would block public listeners on: $OTHER_PORTS. Review them; re-run with --allow-block-other-ports or --skip-ufw. (sshd hardening above is already applied.)"
  fi
  ufw status | grep -q 'Status: inactive' && touch "$BK/ufw-was-inactive"
  ufw allow 22/tcp; ufw allow 80/tcp; ufw allow 443/tcp; ufw allow 443/udp
  ufw --force enable
  ufw status verbose | sed 's/^/    /'
fi

# ---- 6. fail2ban ----
if [ "$SKIP_F2B" = 0 ]; then
  command -v fail2ban-client >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y fail2ban
  if [ ! -f "$F2B_JAIL" ]; then
    cat > "$F2B_JAIL" <<JAIL
# Installed by tools/launch-ops/harden-ssh.sh
[sshd]
enabled  = true
backend  = systemd
maxretry = 5
findtime = 10m
bantime  = 1h
ignoreip = 127.0.0.1/8 ::1 ${CLIENT_IP}
JAIL
    touch "$BK/f2b-jail-created"
  fi
  systemctl enable --now fail2ban
  systemctl reload fail2ban 2>/dev/null || systemctl restart fail2ban
  sleep 2
  fail2ban-client status sshd | sed 's/^/    /' || true
fi

cat <<VERIFY

==========================================================================
DONE. Now, from a SECOND terminal (keep this one open):
  1. ssh -i <your key> root@${HOSTIP}                         -> must log in
  2. ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@${HOSTIP}
                                                              -> must say "Permission denied (publickey)"
  3. on the box:  sshd -T | grep -E '^(passwordauth|permitrootlogin|kbdinteractive)'
                  ufw status verbose
                  fail2ban-client status sshd
                  curl -s -o /dev/null -w '%{http_code}\n' https://lease-musu.kamistats.com/   (expect 404)
Rollback (from this session or the DO console):
  $0 --rollback $BK
==========================================================================
VERIFY
exit 0
}
