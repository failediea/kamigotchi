#!/usr/bin/env bash
# One-off verified walk for a pods.json pod: ./fix-walk-node.sh <node> <room> [room...]
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
export YOMINET_RPC="$(grep '^YOMINET_RPC' .env | cut -d= -f2-)"
NODE_IDX="$1"; shift

NODE_IDX="$NODE_IDX" PATH_ROOMS="$*" python3 - <<'PYEOF'
import json, os
node = int(os.environ["NODE_IDX"])
path = [int(x) for x in os.environ["PATH_ROOMS"].split()]
pods = json.load(open("pods.json"))
entry = next(p for p in pods["pods"] if int(p["node"]) == node)
import subprocess
acc_out = subprocess.run(
    [os.path.expanduser("~/.foundry/bin/cast"), "call", entry["address"], "accID()(uint256)", "--rpc-url", os.environ["YOMINET_RPC"]],
    capture_output=True, text=True)
acc = acc_out.stdout.split()[0].strip()
job = [{"name": f"POD{node}", "acc": acc, "key": entry["operatorKey"], "path": path}]
with open("walk-oneoff.json", "w") as f:
    json.dump(job, f)
os.chmod("walk-oneoff.json", 0o600)
print(f"job: pod node {node} acc {acc} path {path}")
PYEOF

python3 walk-accounts.py walk-oneoff.json
rm -f walk-oneoff.json
