#!/usr/bin/env bash
# Register each RoomPod on Kamibots — RUN THIS YOURSELF (creates third-party accounts).
# One registration per pod: fresh throwaway REG wallet + the pod's operator key
# (from pods.json), creds saved per-pod so ops-bot picks them up automatically.
#
#   ./register-pods.sh          # registers every pod missing creds
#   ./register-pods.sh 2        # just pod node 2
set -e
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
command -v node >/dev/null || { echo "node not found"; exit 1; }
[ -f pods.json ] || { echo "pods.json missing"; exit 1; }

ONLY="${1:-}"
for NODE in $(node -e 'console.log(JSON.parse(require("fs").readFileSync("pods.json")).pods.map(p=>p.node).join(" "))'); do
  [ -n "$ONLY" ] && [ "$ONLY" != "$NODE" ] && continue
  CREDS="./kamibots-credentials-pod${NODE}.json"
  if [ -f "$CREDS" ]; then echo "pod $NODE: already registered ($CREDS)"; continue; fi
  OP_KEY=$(NODE_IDX=$NODE node -e 'const p=JSON.parse(require("fs").readFileSync("pods.json")).pods.find(x=>x.node==process.env.NODE_IDX);console.log(p.operatorKey)')
  REG_KEY=$(node -e 'const{Wallet}=require("ethers");console.log(Wallet.createRandom().privateKey)')
  echo "=== registering pod $NODE (fresh REG wallet, operator from pods.json) ==="
  REG_PRIVATE_KEY="$REG_KEY" OPERATOR_PRIVATE_KEY="$OP_KEY" CREDS_FILE="$CREDS" \
    node kamibots-onboard.mjs register
  chmod 600 "$CREDS" 2>/dev/null || true
  echo "pod $NODE done -> $CREDS"
done
echo "all done. restart ops-bot to pick up new creds."
