# V17 lease-hardening handoff — prepared, not broadcast

Snapshot: 2026-08-01.

## Status

The post-V16 source hardening is committed at `failediea/kamigotchi`
`d4cd237e`. The matching developer-backup source and worker files are in
`failediea/kamigotchi-vault-backup` `c32c2fb`.

The V17 contracts are **not deployed**. V16 remains the production contract
stack. Its two workers do include the compatible terminal gas checks from
`d4cd237e`, running with `TERMINAL_GAS_PULL_MODE=check-only` because the
sealed V16 factories cannot pull escrow in terminal stages.

Finding 8 (cross-currency/common-dollar ranking) is intentionally excluded.

## Release evidence

- Forge vault suites: 104 passed, 0 failed, 0 skipped.
- Worker source suite: 43 passed; each installed V16 VPS directory: 36 passed.
- V17 runtime size:
  - `KamiLeaseMarket`: 24,552 bytes (24-byte EIP-170 margin).
  - `RenterRoomPodFactory`: 24,574 bytes (2-byte EIP-170 margin).
- The mandatory non-broadcast dry run completed with normal simulation,
  `FOUNDRY_PROFILE=v17`, and gas-estimate multiplier 500.
- Estimated gas: 153,518,505 at 0.0025 gwei.
- Estimated maximum requirement: 0.0003837962625 ETH.

## Current gates

1. The configured deployer
   `0x59fe48FF2549BfA806F452AA007DC2E1fe420bc6` held
   0.000281343357299326 ETH at the snapshot. Fund it with at least 0.00015 ETH
   before repeating the dry run; do not broadcast while Foundry's displayed
   requirement exceeds its balance.
2. VIPP lease #5846 is ACTIVE on V16 and ends at
   `2026-08-02T18:10:52Z`. Deploying V17 beside V16 is safe after funding,
   but do not repoint the frontend, reservation routes, Caddy, or owner pool
   version while that lease is active.
3. After #5846 finalizes and returns, verify its renter refund and owner
   custody before the coordinated V17 cutover. Keep both V16 workers online
   through that verification.

## Dry-run prediction

The 2026-08-01 simulation used fresh hub names `m17hub1` and
`vipphub171` and predicted:

| Contract | Address |
|---|---|
| MUSU market | `0xeFC4890491Eb0B1c6Fe6f6d565278AB300e6A404` |
| VIPP market | `0xd718f5c55C6f4B3096c31AeeBf32CfA772C9273a` |
| MUSU renter factory | `0xb378F2bC5A5360Cc3CFBaCa0F77853aad5e6Db1b` |
| VIPP renter factory | `0x8654F65F5d90bb60c36BC0Ba01D2eF68305e3cf6` |
| MUSU HubGuard | `0x40BA94A382A642D717B266EeF8D38D5E164cE2AE` |
| VIPP HubGuard | `0xD0278E5266d4e2e796d18516978C8E877Df5b29A` |
| Personal pool registry | `0x3B4C1Ee0F0FF65eD6e7ef2ec14F756AD3a060418` |
| Personal vault factory | `0x1051A331d9FdD7D2a1718b5736D928d2d484bcab` |

These are predictions, not deployed addresses. Re-run the exact simulation
from the clean release commit immediately before broadcast and trust the new
output if the deployer nonce changed.

## Cutover-specific worker setting

V17 factories allow the verified pod operator to pull its own request escrow
during terminal stages. New V17 worker directories must therefore set:

```dotenv
TERMINAL_GAS_RETURN_MODE=factory
TERMINAL_GAS_PULL_MODE=factory
```

Do not apply `TERMINAL_GAS_PULL_MODE=factory` to V16.

