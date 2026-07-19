# Running the lease-market keeper on the indexer VPS

The bot joins the same VPS that already runs the kamistats loop services —
same systemd pattern (`Restart=always`, journald logs, boot-start).

## One-time install

From your PC (WSL), copy the code and the secrets. The secrets NEVER go
through git — `scp` them straight over:

```bash
# 1) code (from WSL)
rsync -av --exclude node_modules ~/kamigotchi/tools/vault-kit/ root@YOUR_VPS:/root/kamigotchi/tools/vault-kit/

# 2) secrets are included by the rsync above (.env, pods.json,
#    kamibots-credentials*.json) — verify their modes on the VPS:
ssh root@YOUR_VPS 'chmod 600 /root/kamigotchi/tools/vault-kit/.env /root/kamigotchi/tools/vault-kit/pods.json /root/kamigotchi/tools/vault-kit/kamibots-credentials*.json'

# 3) deps + service
ssh root@YOUR_VPS
cd /root/kamigotchi/tools/vault-kit
npm install ethers
# add the production status push to .env (URL of the Vercel site + a long random secret):
#   VAULT_STATUS_PUSH_URL=https://YOUR-SITE/api/vault/live-status
#   VAULT_STATUS_SECRET=<same value you set in Vercel env>
cp deploy/kami-lease-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now kami-lease-bot
```

## Day-to-day

```bash
systemctl status kami-lease-bot          # is it up
journalctl -u kami-lease-bot -f          # live logs
systemctl restart kami-lease-bot         # after a code update
```

## What must NOT be on this box

- The ADMIN / deployer private key. The bot runs without it by design
  ("emergency admin not loaded"). Rotation on theft is a manual one-transaction
  action from your offline key.

## After install, retire the WSL copy

Stop the bot on your PC so two keepers never race:

```bash
pkill -xf "node ops-bot.mjs"   # in WSL
```
