#!/usr/bin/env bash
# Move BOTH market keepers (MUSU + VIPP) from WSL to the indexer VPS as systemd
# services. WSL keepers are killed ONLY after both VPS services log "online".
set -euo pipefail
VPS="root@68.183.190.126"
SSHOPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10 -o BatchMode=yes)
run() { ssh "${SSHOPTS[@]}" "$VPS" "$1"; }

echo "=== 1. preflight ==="
run 'echo "vps: $(hostname)"; free -m | sed -n 2p'

echo "=== 2. sync code + secrets (over SSH) ==="
rsync -az -e "ssh ${SSHOPTS[*]}" \
  --exclude node_modules --exclude "*.log" --exclude migration-backups \
  --exclude migration-snapshots --exclude audit-evidence --exclude __pycache__ \
  "$HOME/kamigotchi/tools/vault-kit/" "$VPS:/root/kamigotchi/tools/vault-kit/"
rsync -az -e "ssh ${SSHOPTS[*]}" \
  --exclude node_modules --exclude "*.log" \
  "$HOME/kamigotchi/tools/vault-kit-vipp/" "$VPS:/root/kamigotchi/tools/vault-kit-vipp/"
echo "synced"

echo "=== 3. secrets modes + deps ==="
run 'chmod 600 /root/kamigotchi/tools/vault-kit/.env /root/kamigotchi/tools/vault-kit/pods.json /root/kamigotchi/tools/vault-kit/kamibots-credentials*.json /root/kamigotchi/tools/vault-kit-vipp/.env /root/kamigotchi/tools/vault-kit-vipp/pods.json /root/kamigotchi/tools/vault-kit-vipp/kamibots-credentials*.json 2>/dev/null || true; export PATH=/root/.nvm/versions/node/v20.20.0/bin:$PATH; cd /root/kamigotchi/tools/vault-kit && (node -e "require.resolve(\"ethers\")" >/dev/null 2>&1 || npm install --no-fund --no-audit ethers@6 >/dev/null) && rm -rf /root/kamigotchi/tools/vault-kit-vipp/node_modules && ln -sfn /root/kamigotchi/tools/vault-kit/node_modules /root/kamigotchi/tools/vault-kit-vipp/node_modules && echo "deps ok"'

echo "=== 4. install + start services ==="
run 'cp /root/kamigotchi/tools/vault-kit/deploy/kami-lease-bot.service /root/kamigotchi/tools/vault-kit/deploy/kami-lease-bot-vipp.service /etc/systemd/system/ && systemctl daemon-reload && systemctl enable --now kami-lease-bot kami-lease-bot-vipp && sleep 15 && systemctl is-active kami-lease-bot kami-lease-bot-vipp'

echo "=== 5. verify both keepers online ==="
run 'journalctl -u kami-lease-bot -n 30 --no-pager | grep -m1 "online"'
run 'journalctl -u kami-lease-bot-vipp -n 30 --no-pager | grep -m1 "online"'
echo "BOTH VPS KEEPERS ONLINE"

echo "=== 6. retire the WSL keepers ==="
pkill -xf "node ops-bot.mjs" || true
sleep 2
if pgrep -xf "node ops-bot.mjs" >/dev/null; then
  echo "WARN: local keepers still running — kill manually"
else
  echo "local keepers retired — the market now runs on the VPS"
fi
echo "MIGRATION COMPLETE"
