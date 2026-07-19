#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
export YOMINET_RPC="$(grep '^YOMINET_RPC' .env | cut -d= -f2-)"

python3 - <<'PYEOF'
import json, os
secrets = json.load(open("migration-v12-secrets.json"))
pod2 = next(p for p in secrets["pods"] if p["node"] == 2)
job = [{"name": "POD2-FIX", "acc": "1133263392091945455459855966357629447517558612540", "key": pod2["privateKey"], "path": [2]}]
with open("walk-fix-pod2.json", "w") as f:
    json.dump(job, f)
os.chmod("walk-fix-pod2.json", 0o600)
print("job written: pod2 -> room 2 via", os.environ.get("YOMINET_RPC", "MISSING")[:40])
PYEOF

python3 walk-accounts.py walk-fix-pod2.json
rm -f walk-fix-pod2.json
