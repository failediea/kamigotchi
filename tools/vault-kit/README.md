# KamiVault — go/no-go kit

Answers the one question the whole yield-vault design depends on:
**does Kamibots accept an operator key whose game account is owned by a contract?**

⚠️ Rules:
- Use a **throwaway** Kamibots registration wallet. **Never** touch the production
  80-slot registration or its operator key.
- Everything here costs pennies (Yominet gas is flat 0.0025 gwei) but the deployer,
  operator, and registration wallets each need a little bridged ETH — no faucet.

## What's where

- `packages/contracts/src/vault/KamiVault.sol` — the vault (custody + settle + withdraw)
- `packages/contracts/test/vault/KamiVault.t.sol` — 12 tests, all green vs the real World fixture
- `packages/contracts/script/DeployKamiVault.s.sol` — forge deploy script (Yominet or anvil)
- `tools/vault-kit/kamibots-onboard.mjs` — Kamibots register / key-upload / strategy driver

## Run order

```bash
# 0. one-time
cd tools/vault-kit && npm i

# 1. generate two fresh keys (operator + throwaway kamibots registration)
#    e.g. with foundry:  cast wallet new   (twice)

# 2. deploy the vault to Yominet (deployer key = vault admin; fund it a little)
cd ../../packages/contracts
WORLD_ADDR=0x2729174c265dbBd8416C6449E0E813E88f43D0E7 \
VAULT_OPERATOR=<operator-address> \
VAULT_NAME=<unused-name-max16> \
MGMT_BPS=1500 \
~/.foundry/bin/forge script script/DeployKamiVault.s.sol:DeployKamiVault \
  --rpc-url https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz \
  --broadcast --private-key $DEPLOYER_KEY

# 3. deposit ONE CHEAP kami (as any depositor EOA holding the 721):
#    kami721.approve(vault, tokenIndex) ; vault.deposit(tokenIndex)
#    then move the vault account to room 12 (operator tx) and vault.stakeDeposits([idx])

# 4. the actual test — register with Kamibots + upload the operator key
cd ../../tools/vault-kit
REG_PRIVATE_KEY=<throwaway-key> OPERATOR_PRIVATE_KEY=<operator-key> \
  node kamibots-onboard.mjs register

# 5. start a strategy on the deposited kami (fund the operator EOA with gas first)
node kamibots-onboard.mjs start <kamiId> <nodeIndex>
node kamibots-onboard.mjs status <kamiId>
```

## Reading the result

- `register` + `start` succeed and the kami harvests → **GO**: the full vault
  architecture works; scale it (factory, mgmt account, settle keeper).
- `operator key REJECTED` (403 ownership validation) → **NO-GO** for contract-owned
  accounts. Fallback: your EOA owns the account ("vault-lite": custody trust in you,
  splits still enforced off the same settle math run from your EOA), and/or ask the
  Kamibots team to whitelist contract owners.

## Also verify while it runs

- Decode one Kamibots `HarvestStart` tx (`cast tx <hash>` / explorer) and check the
  `taxerID/taxAmt` args → confirms their tax occupies the LibTax slot.
- `vault.settle()` after a few collects → confirms the in-world MUSU split end-to-end
  on mainnet, not just in tests.
