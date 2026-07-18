#!/usr/bin/env bash
# FULL STACK REDEPLOY -> hub v9 (one-tx NFT listing) + pods + guard + registries.
# Run AFTER funding the deployer (needs ~0.0001 ETH; check with cast balance).
#
# Preserves every Kamibots registration: each new account re-uses the SAME
# operator key (old accounts get parked operators first). Walks the hub to the
# bridge room and pods 2/3 to their tiles. Rewrites pods.json + env files.
# The dApp needs NEXT_PUBLIC_* updates printed at the end + a server restart.
set -e
cd "$(dirname "$0")"
set -a; source ./.env; set +a
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
CAST=~/.foundry/bin/cast
FORGE=~/.foundry/bin/forge
WORLD=0x2729174c265dbBd8416C6449E0E813E88f43D0E7
OLD_HUB="$MARKET_ADDRESS"
OP=0x282FB7D36B3Aa3507a6d760a0a7d8B83Cc4382A8
NAME_SUFFIX="${NAME_SUFFIX:-9}"

BAL=$($CAST balance $($CAST wallet address --private-key "$DEPLOYER_KEY") --rpc-url "$YOMINET_RPC")
echo "deployer balance: $BAL wei"
[ "$BAL" -lt 60000000000000 ] && { echo "ABORT: fund the deployer first (~0.0001 ETH)"; exit 1; }

park() { # park an account's operator so its key can be reused on the new account
  $CAST send "$1" 'rotateOperator(address)' \
    "$($CAST wallet new --json | grep -o '"address": *"[^"]*"' | head -1 | cut -d'"' -f4)" \
    --rpc-url "$YOMINET_RPC" --private-key "$DEPLOYER_KEY" --legacy >/dev/null
}

echo "=== park old operators (hub + bot pods) ==="
park "$OLD_HUB"
for P in $(node -e 'console.log(JSON.parse(require("fs").readFileSync("pods.json")).pods.map(p=>p.address).join(" "))'); do
  park "$P"
done

echo "=== deploy hub v9 (leasetest${NAME_SUFFIX}) ==="
cd ~/kamigotchi/packages/contracts
WORLD_ADDR=$WORLD MARKET_OPERATOR=$OP MARKET_NAME=leasetest${NAME_SUFFIX} MGMT_BPS=1000 \
  $FORGE script script/DeployKamiLeaseMarket.s.sol:DeployKamiLeaseMarket \
  --rpc-url "$YOMINET_RPC" --broadcast --private-key "$DEPLOYER_KEY" --legacy --optimizer-runs 200 2>&1 \
  | grep -E 'KamiLeaseMarket:|game accID:|Error' | tee /tmp/hub9.out
HUB=$(grep 'KamiLeaseMarket:' /tmp/hub9.out | awk '{print $2}')
[ -n "$HUB" ] || { echo "hub deploy failed"; exit 1; }

echo "=== deploy bot pods + registry (same operators -> kamibots regs stay valid) ==="
cd ~/kamigotchi/tools/vault-kit
P1OP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("pods.json")).pods.find(p=>p.node==1).operator)')
P2OP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("pods.json")).pods.find(p=>p.node==2).operator)')
P3OP=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("pods.json")).pods.find(p=>p.node==3).operator)')
cd ~/kamigotchi/packages/contracts
WORLD_ADDR=$WORLD HUB_ADDR=$HUB POD_COUNT=3 \
POD1_NODE=1 POD1_LABEL='Misty Riverside (EERIE)' POD1_OPERATOR=$P1OP POD1_NAME=leasepod1${NAME_SUFFIX} \
POD2_NODE=2 POD2_LABEL='Tunnel of Trees (NORMAL)' POD2_OPERATOR=$P2OP POD2_NAME=leasepod2${NAME_SUFFIX} \
POD3_NODE=3 POD3_LABEL='Torii Gate (NORMAL)' POD3_OPERATOR=$P3OP POD3_NAME=leasepod3${NAME_SUFFIX} \
  $FORGE script script/DeployLeasePods.s.sol:DeployLeasePods \
  --rpc-url "$YOMINET_RPC" --broadcast --private-key "$DEPLOYER_KEY" --legacy --optimizer-runs 200 2>&1 \
  | grep -E 'LeasePodRegistry:|RoomPod:|accID:|Error' | tee /tmp/pods9.out
REG=$(grep 'LeasePodRegistry:' /tmp/pods9.out | awk '{print $2}')
PODS=($(grep 'RoomPod:' /tmp/pods9.out | awk '{print $2}'))
for P in "${PODS[@]}"; do # addPod broadcast race guard
  $CAST send "$REG" 'addPod(address)' "$P" --rpc-url "$YOMINET_RPC" --private-key "$DEPLOYER_KEY" --legacy >/dev/null 2>&1 || true
done

echo "=== deploy self-farm stack ==="
WORLD_ADDR=$WORLD HUB_ADDR=$HUB KEEPER_ADDR=$OP POD_NODE=1 \
POD_LABEL='Misty Riverside (EERIE)' POD_NAME=selfpod1${NAME_SUFFIX} \
  $FORGE script script/DeploySelfFarm.s.sol:DeploySelfFarm \
  --rpc-url "$YOMINET_RPC" --broadcast --private-key "$DEPLOYER_KEY" --legacy --optimizer-runs 200 2>&1 \
  | grep -E 'SelfFarmRegistry:|HarvestGuard:|RoomPod:|Error' | tee /tmp/self9.out
SREG=$(grep 'SelfFarmRegistry:' /tmp/self9.out | awk '{print $2}')
GUARD=$(grep 'HarvestGuard:' /tmp/self9.out | awk '{print $2}')
SPOD=$(grep 'RoomPod:' /tmp/self9.out | awk '{print $2}')
$CAST send "$GUARD" 'setPod(address)' "$SPOD" --rpc-url "$YOMINET_RPC" --private-key "$DEPLOYER_KEY" --legacy >/dev/null 2>&1 || true
$CAST send "$SREG" 'addPod(address)' "$SPOD" --rpc-url "$YOMINET_RPC" --private-key "$DEPLOYER_KEY" --legacy >/dev/null 2>&1 || true

echo "=== rewrite pods.json ==="
cd ~/kamigotchi/tools/vault-kit
HUB=$HUB REG=$REG SREG=$SREG GUARD=$GUARD SPOD=$SPOD NS=$NAME_SUFFIX \
P0=${PODS[0]} P1=${PODS[1]} P2=${PODS[2]} node -e '
const fs = require("fs");
const f = JSON.parse(fs.readFileSync("pods.json"));
const e = process.env;
f.hub = e.HUB; f.registry = e.REG; f.selfRegistry = e.SREG;
const addrs = [e.P0, e.P1, e.P2];
f.pods.forEach((p, i) => { p.address = addrs[i]; p.name = `leasepod${p.node}${e.NS}`; });
f.selfPods = [{ node: 1, name: `selfpod1${e.NS}`, label: "Misty Riverside (EERIE)",
  address: e.SPOD, guard: e.GUARD }];
fs.writeFileSync("pods.json", JSON.stringify(f, null, 2));
console.log("pods.json rewritten");
'
sed -i "s/^MARKET_ADDRESS=.*/MARKET_ADDRESS=$HUB/" .env
sed -i "s/^REGISTRY_ADDRESS=.*/REGISTRY_ADDRESS=$REG/" .env

echo "=== walk accounts into position ==="
HUBACC=$($CAST call "$HUB" 'accID()(uint256)' --rpc-url "$YOMINET_RPC" | awk '{print $1}')
P2ACC=$($CAST call "${PODS[1]}" 'accID()(uint256)' --rpc-url "$YOMINET_RPC" | awk '{print $1}')
P3ACC=$($CAST call "${PODS[2]}" 'accID()(uint256)' --rpc-url "$YOMINET_RPC" | awk '{print $1}')
P2KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("pods.json")).pods.find(p=>p.node==2).operatorKey)')
P3KEY=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("pods.json")).pods.find(p=>p.node==3).operatorKey)')
cat > /tmp/walk9.json <<WJSON
[
 {"name":"HUB","acc":"$HUBACC","key":"$OPERATOR_PRIVATE_KEY","path":[29,2,3,30,4,34,12]},
 {"name":"POD2","acc":"$P2ACC","key":"$P2KEY","path":[29,2]},
 {"name":"POD3","acc":"$P3ACC","key":"$P3KEY","path":[29,2,3]}
]
WJSON
python3 walk-accounts.py /tmp/walk9.json

echo "=== restart ops-bot ==="
pkill -f 'node.*ops-bot.mjs' 2>/dev/null || true
sleep 1
setsid nohup node ops-bot.mjs >> ops-bot.log 2>&1 < /dev/null &
sleep 8; tail -6 ops-bot.log

echo ""
echo "✅ STACK LIVE ON v9"
echo "   hub:           $HUB  (leasetest${NAME_SUFFIX}, in room 12 -> one-tx NFT listing ACTIVE)"
echo "   bot registry:  $REG"
echo "   self registry: $SREG   guard: $GUARD"
echo ""
echo "NOW update ~/kamistats/.env.local:"
echo "   NEXT_PUBLIC_MARKET_ADDRESS=$HUB"
echo "   NEXT_PUBLIC_MARKET_ACCOUNT_NAME=leasetest${NAME_SUFFIX}"
echo "   NEXT_PUBLIC_REGISTRY_ADDRESS=$REG"
echo "   NEXT_PUBLIC_SELF_REGISTRY_ADDRESS=$SREG"
echo "   NEXT_PUBLIC_HUB_HAS_721=1"
echo "…and restart the dev server."
