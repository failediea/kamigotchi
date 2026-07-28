#!/usr/bin/env bash
# Assemble the exact env block to bulk-paste into Vercel (Settings → Environment
# Variables → paste .env). Values come from the WORKING local .env.local, so
# what ships is what was verified. Output is gitignored (.env*.local).
set -euo pipefail
SRC=/home/matrix/kamistats/.env.local
OUT=/home/matrix/kamistats/.env.vercel.local

{
  echo "# Paste this whole block into Vercel (Production) — assembled $(date -u +%F)"
  echo "# After saving: redeploy. Addresses must match DEPLOYMENTS.md."
  grep -E "^(NEXT_PUBLIC_WORLD_ADDRESS|NEXT_PUBLIC_MARKET_ADDRESS|NEXT_PUBLIC_MARKET_ACCOUNT_NAME|NEXT_PUBLIC_MARKET_VERSION|NEXT_PUBLIC_VIPP_MARKET_ADDRESS|NEXT_PUBLIC_VIPP_MARKET_VERSION|NEXT_PUBLIC_REGISTRY_ADDRESS|NEXT_PUBLIC_VIPP_REGISTRY_ADDRESS|NEXT_PUBLIC_SELF_REGISTRY_ADDRESS|NEXT_PUBLIC_HUB_HAS_721|NEXT_PUBLIC_PERSONAL_VAULT_FACTORY_ADDRESS|NEXT_PUBLIC_PERSONAL_VAULT_VERSION|NEXT_PUBLIC_LEGACY_PERSONAL_VAULT_FACTORY_ADDRESS|QUOTE_SIGNER_PRIVATE_KEY|OPERATOR_RESERVATION_URLS|OPERATOR_RESERVATION_TOKENS)=" "$SRC"
} > "$OUT"
chmod 600 "$OUT"
COUNT=$(grep -c "=" "$OUT")
echo "wrote $OUT ($COUNT vars)"
