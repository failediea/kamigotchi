#!/usr/bin/env bash
# Poll until the SSH key lands on the VPS, then run the bot migration.
cd "$(dirname "$0")"
for i in $(seq 1 240); do
  if ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 root@68.183.190.126 true 2>/dev/null; then
    break
  fi
  sleep 15
done
bash migrate-bots-to-vps.sh > vps-migration.log 2>&1
echo "EXIT:$?" >> vps-migration.log
touch vps-migration.done
