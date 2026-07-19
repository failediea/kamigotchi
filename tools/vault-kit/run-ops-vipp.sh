#!/usr/bin/env bash
# VIPP-market keeper: the same ops-bot binary pointed at the VIPP config dir.
set -euo pipefail
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/v22.22.1/bin:$PATH"
export OPS_DIR="$(cd ../vault-kit-vipp && pwd)"
exec node ops-bot.mjs >> "$OPS_DIR/ops-bot-vipp.log" 2>&1
