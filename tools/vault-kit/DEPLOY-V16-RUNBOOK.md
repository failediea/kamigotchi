# v16 deploy runbook — kami-vault branch

Written 2026-07-27. This is the coordinated deploy that has been pending since
the audit: 13 audit fixes, the pod-recovery machinery, the VIPP fee-float
system, and the two changes added today (terminal float return, seed 150→45).
Everything here assumes the `kami-vault` branch of `~/kamigotchi`, vault test
suite green (83 passed / 0 failed, run `packages/contracts/run-vault-tests.sh`).

## What changes vs the deployed v15

| Area | Change | Why |
|---|---|---|
| `RenterRoomPodFactory` | `enterPodRecovery(uint32, bytes32)` — NEW SIGNATURE | audit: stuck-pod recovery |
| `RoomPod` | constructor takes `recoveryOpImpl` — NEW ABI | recovery clones |
| `RoomPod.sweepMusu` | factory's terminal sweep also returns unused MUSU float to the hub | stops seed stranding + churn-drain; makes VIPP viable |
| `POD_FEE_FLOAT_SEED` | 150 → 45 | worker sweeps ONCE (measured); 150 stranded ~135/pod |
| `KamiLeaseMarket` | `seedPodFeeFloat`, `musuFeeFloat`, `feeFloatClaimsLeft`, `forfeitDust`, pro-rata `claimOwed`, `_creditPending` in cancel paths | audit fixes + VIPP fee plumbing |
| `HarvestGuard.ship` | lease-state check | audit: keeper could evict mid-term |
| `PersonalRentalPool.declareKami` | accepts already-arrived kami | audit |
| `PersonalRentalVaultFactory` | `cloneDeterministic` salted by (sender, accountName) | audit |

Open by design: #5 (KamiVault dead code — do NOT deploy it), #7 (XP metering).
Assess before deploy: the ItemBurn grief (renter's operator can burn pod
inventory; with the float return + small seed the blast radius is ≤45 MUSU and
self-harming, but decide explicitly whether to accept it — see task #8).

## Gates — do not start until all true

1. **Lease #10165 on v15 MUSU is finished or ended.** Ends 2026-08-02 19:07 UTC
   unless the renter ends early. Never cut a stack over mid-lease.
2. Vault tests green on the branch (they are: 83/0, 5 pre-existing skips).
3. VIPP hub float budget ready: each VIPP checkout draws seed 45 + fee 15 = 60
   from the hub's MUSU, each claim payout another 15. Seed the hub with ~600
   MUSU for ten checkouts of headroom. (Terminal returns now flow back, so the
   float mostly recycles.)
4. Quote signer `0xf1B03dC0…5BAc` and keeper `0x0d0294C5…bcDc` are REUSED
   (DEPLOYMENTS.md rule — fresh keys force a Vercel + VPS key rotation).
   The keeper wallet still holds ~0.00009 ETH; top up to ≥0.0005 for deploy-day
   provisioning at the measured 1.4M gas/tx.

## Deploy order

Use the existing scripts as the source of truth for constructor args — they
deployed v15 and only addresses change: `deploy-vipp-stack.mjs` (whole-stack
pattern), `deploy-directory.mjs`, `expand-tiles.mjs`, `add-pod.sh`,
`activate-v13-accounts.mjs` (account-activation pattern). Deployer key is in
`tools/vault-kit/.env` (never on the VPS).

1. `forge build` with the production profile (`FOUNDRY_PROFILE=v14` — the name
   is historical; it is the sized/via-IR profile).
2. Deploy shared `PodRecoveryOperator` implementation.
3. MUSU v16: market → initialize (game account name) → factory(world, market,
   quoteSigner, keeper, recoveryOpImpl) → wire factory into market → registry.
4. VIPP v16: same, `payItem = 2`.
5. Register tiles/pods for both markets (11 MUSU tiles, 5 VIPP — reuse the v15
   tile set from `expand-tiles.mjs`).
6. In-game: activate both hub accounts, walk them to room 1 if the scripts
   don't. **Send ~600 MUSU to the VIPP hub's game account** (gate 3).
7. Record every address in `migration-v16-deployment.json` + DEPLOYMENTS.md
   BEFORE touching any env — the stack-A incident happened because prod env
   pointed at an abandoned deploy.

## VPS (root@68.183.190.126)

8. Copy `vault-kit-v15-musu` → `vault-kit-v16-musu` (and vipp). In each `.env`:
   `MARKET_ADDRESS`, `RENTER_POD_FACTORY` = v16 addresses,
   `START_BLOCK` = deploy block, ports 8791/8792 (v15 keeps 8789/8790 until
   its last lease settles).
9. **While in the worker, fix `ensureOperatorGas` (task #1):** `reserve` is
   `1_000_000_000_000n` (0.000001 ETH) but one bot action costs ~4.03e12 wei at
   2.5 Mwei — the top-up buys a quarter of a transaction and then never fires
   again, stranding the whole escrow. Set `reserve = 45_000_000_000_000n`
   (~11 actions) and pull `min(gasBudget, reserve)` as now. Apply to BOTH new
   worker copies (and optionally backport to v15 for its remaining lease).
10. New systemd units `kami-renter-pod-v16-{musu,vipp}`, Caddy: keep
    `lease-musu.kamistats.com` / `lease-vipp` domains, repoint to 8791/8792
    ONLY at cutover (step 12) — the domain is referenced by market address in
    the Vercel maps, so flip both together.

## kamistats cutover

11. `lib/vault-versions.ts`: append v15 MUSU + VIPP to `historicalMarkets`
    (append-only, never delete), bump `NEXT_PUBLIC_MARKET_VERSION` to 16.
12. Vercel env (all Sensitive): `NEXT_PUBLIC_MARKET_ADDRESS`,
    `NEXT_PUBLIC_VIPP_MARKET_ADDRESS`, `NEXT_PUBLIC_REGISTRY_ADDRESS`,
    `NEXT_PUBLIC_VIPP_REGISTRY_ADDRESS`,
    `NEXT_PUBLIC_PERSONAL_VAULT_FACTORY_ADDRESS` if redeployed, and — the one
    that bit us last time — **`OPERATOR_RESERVATION_URLS` / `_TOKENS` are JSON
    maps KEYED BY MARKET ADDRESS.** Add the v16 addresses as new keys; keep the
    v15 keys until its last lease settles. `QUOTE_SIGNER_PRIVATE_KEY` is
    unchanged (same signer). Redeploy, then verify:
    `lease-quote` returns 200+signatures on BOTH markets (the smoke test that
    caught the stale map last time).
13. UI follow-ups now unblocked: `feeFloatClaimsLeft()` monitor with low-float
    warning on the vault page; "early claim" helper on VIPP lease cards
    (send ≥15 MUSU to the pod → permissionless `sweepMusu()` → claim).

## Post-deploy proof (the money path, once each)

14. MUSU: list one kami, self-lease 1 day from the second wallet, watch
    provisioning → HARVESTING → collect → settle → gas refund. (This worked on
    v15 on 2026-07-26; it must still work on v16.)
15. VIPP: same, and additionally verify at finalization: hub received the
    swept VIPP, hub MUSU float went UP by the returned seed remainder
    (FeeFloatReturned event), renter can claim VIPP.
16. Withdraw the listed kami from v15, re-list on v16. Decommission v15
    workers only after `numListings == 0` and all claims are zero.

## Honest caveat on #16218 (the dead kami)

Recovering #16218 was a motivation for this deploy, but the kami sits in a
v13-era pod (`0xF3ce…f9Fa`) whose bytecode predates ALL recovery machinery —
`enterPodRecovery` only exists on the NEW factory for NEW pods and cannot
reach an old pod. Deployed bytecode is immutable. Recovery of #16218 needs a
separate investigation of what that old pod's code can actually still do
(its operator paths, if any); do not assume this deploy rescues it.
