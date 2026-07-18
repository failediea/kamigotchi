#!/usr/bin/env bash
# ONE COMMAND = ONE NEW RENTABLE TILE.
#   ./add-pod.sh <nodeIndex> "<Tile Name (AFFINITY)>" <accountName>
#   e.g. ./add-pod.sh 5 "Scrap Yard (SCRAP)" leasepod5
#
# Does everything a new tile needs:
#   1. fresh operator keypair
#   2. deploy RoomPod + register its game account (on-chain, DEPLOYER_KEY)
#   3. registry.addPod  -> tile appears in the dApp automatically
#   4. fund the operator with gas
#   5. Kamibots registration (fresh throwaway REG wallet, key upload)
#   6. append pods.json -> ops-bot picks it up on restart
#
# The Kamibots leg (5) is a Web2 API call — it can never live in a contract;
# this script is the bridge. Run it yourself: it creates a third-party account.
set -e
cd "$(dirname "$0")"
NODE_IDX="${1:?usage: add-pod.sh <nodeIndex> <label> <name>}"
LABEL="${2:?label required, e.g. 'Scrap Yard (SCRAP)'}"
NAME="${3:?account name required, e.g. leasepod5}"

set -a; source ./.env; set +a
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
CAST=~/.foundry/bin/cast
REG="${REGISTRY_ADDRESS:?REGISTRY_ADDRESS missing in .env}"
HUB="${MARKET_ADDRESS:?MARKET_ADDRESS missing in .env}"

if [ "$($CAST call "$REG" 'podForNode(uint32)(address)' "$NODE_IDX" --rpc-url "$YOMINET_RPC")" != "0x0000000000000000000000000000000000000000" ]; then
  echo "node $NODE_IDX already has a pod"; exit 1
fi

echo "=== 1. operator keypair ==="
J=$($CAST wallet new --json)
OP_ADDR=$(echo "$J" | grep -o '"address": *"[^"]*"' | head -1 | cut -d'"' -f4)
OP_KEY=$(echo "$J" | grep -o '"private_key": *"[^"]*"' | head -1 | cut -d'"' -f4)
echo "operator: $OP_ADDR"

echo "=== 2+3. deploy pod + addPod ==="
cd ~/kamigotchi/packages/contracts
OUT=$(WORLD_ADDR=0x2729174c265dbBd8416C6449E0E813E88f43D0E7 HUB_ADDR="$HUB" REGISTRY_ADDR="$REG" \
  POD_COUNT=1 POD1_NODE="$NODE_IDX" POD1_LABEL="$LABEL" POD1_OPERATOR="$OP_ADDR" POD1_NAME="$NAME" \
  ~/.foundry/bin/forge script script/DeployLeasePods.s.sol:DeployLeasePods \
  --rpc-url "$YOMINET_RPC" --broadcast --private-key "$DEPLOYER_KEY" --legacy --optimizer-runs 200 2>&1)
echo "$OUT" | grep -E 'RoomPod:|accID:|Error' || true
POD_ADDR=$(echo "$OUT" | grep 'RoomPod:' | head -1 | awk '{print $2}')
[ -n "$POD_ADDR" ] || { echo "deploy failed"; echo "$OUT" | tail -20; exit 1; }
cd ~/kamigotchi/tools/vault-kit

# addPod can race the pod's initialize in the same broadcast — verify, retry once
if [ "$($CAST call "$REG" 'podForNode(uint32)(address)' "$NODE_IDX" --rpc-url "$YOMINET_RPC")" = "0x0000000000000000000000000000000000000000" ]; then
  echo "addPod race — retrying"
  $CAST send "$REG" 'addPod(address)' "$POD_ADDR" --rpc-url "$YOMINET_RPC" --private-key "$DEPLOYER_KEY" --legacy >/dev/null
fi
echo "registered in directory: $POD_ADDR"

echo "=== 4. fund operator ==="
$CAST send "$OP_ADDR" --value 15000000000000 --rpc-url "$YOMINET_RPC" --private-key "$DEPLOYER_KEY" --legacy >/dev/null
echo "funded 15e12 wei"

echo "=== 6. pods.json ==="
NODE_IDX="$NODE_IDX" LABEL="$LABEL" NAME="$NAME" POD_ADDR="$POD_ADDR" OP_ADDR="$OP_ADDR" OP_KEY="$OP_KEY" \
node -e '
const fs = require("fs");
const f = JSON.parse(fs.readFileSync("pods.json"));
f.pods.push({ node: Number(process.env.NODE_IDX), name: process.env.NAME, label: process.env.LABEL,
  address: process.env.POD_ADDR, operator: process.env.OP_ADDR, operatorKey: process.env.OP_KEY });
fs.writeFileSync("pods.json", JSON.stringify(f, null, 2));
'
chmod 600 pods.json

echo "=== 5. Kamibots registration ==="
bash ./register-pods.sh "$NODE_IDX"

echo ""
echo "✅ tile live: node $NODE_IDX — $LABEL ($NAME @ $POD_ADDR)"
echo "   restart ops-bot to route leases here. dApp shows it automatically."
