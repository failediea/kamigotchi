#!/usr/bin/env bash
# Direct, unwrapped pod deploy for node 29 — surfaces the real forge error.
set -uo pipefail
cd "$(dirname "$0")"
set -a; source ./.env; set +a
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"

KEYJSON=$(~/.foundry/bin/cast wallet new --json)
OP_ADDR=$(echo "$KEYJSON" | python3 -c "import json,sys; d=json.load(sys.stdin); d=d[0] if isinstance(d,list) else d; print(d['address'])")
echo "fresh operator: $OP_ADDR"

cd ../../packages/contracts
WORLD_ADDR=0x2729174c265dbBd8416C6449E0E813E88f43D0E7 \
HUB_ADDR="$MARKET_ADDRESS" \
REGISTRY_ADDR="$REGISTRY_ADDRESS" \
POD_COUNT=1 \
POD1_NODE=29 \
POD1_LABEL="Misty Forest Path (INSECT)" \
POD1_OPERATOR="$OP_ADDR" \
POD1_NAME=leasepod2912 \
~/.foundry/bin/forge script script/DeployLeasePods.s.sol:DeployLeasePods \
  --rpc-url "$YOMINET_RPC" --broadcast --private-key "$DEPLOYER_KEY" \
  --legacy --optimizer-runs 1 --slow --skip-simulation
echo "FORGE EXIT: $?"
