# V15 security migration

V14 is sealed and cannot be upgraded in place. The safe change is a coordinated replacement deployment; do not point the public quote API at partially configured contracts.

## User-visible behavior

- Owners still create one Personal Rental Vault and any number of terms pools.
- Idle Kamis remain in their registered owner pool.
- A renter chooses a Kami, Kamibots strategy, tile and term, then confirms one checkout transaction.
- Checkout pays RoomPod setup, constrained keeper routing and the refundable farming budget.
- The paid lease clock starts only after the Kami reaches its exact RoomPod and Kamibots is ready.
- Normal returns remain automatic. After a provable timeout, anyone can irreversibly disable that pod's Kamibots EOA and advance a return only to the recorded pool. If the Kami is dead, recovery can use exactly 33 Onyx from that pod to revive it before returning it; it cannot redirect the Kami or spend arbitrary inventory.

## Contract graph

`PersonalRentalVaultFactory` creates `PersonalRentalVault` and `PersonalRentalPool` contracts. It is the only writer to `PersonalRentalPoolRegistry`. Both `KamiLeaseMarket` contracts accept listings only from that registry and cache the registered human beneficiary. Each market has its own `RenterRoomPodFactory` and no-admin `HubGuard`. Every accepted rental gets a new bound `RoomPod` with a random Kamibots EOA.

The quote service signs economics/terms. The separately hosted worker reserves the random operator and signs the same quote. The factory requires both signatures. The keeper can advance setup but is not a game-account operator. `HubGuard` is the hub operator and has no arbitrary destination function.

## Cutover order

1. Rotate or retire every credential found in historical pod/deployment JSON before reusing infrastructure.
2. Put `QUOTE_SIGNER_PRIVATE_KEY` only on the Kamistats quote host. Put `KEEPER_PRIVATE_KEY`, Kamibots credentials and random per-pod keys only on the worker host. Do not co-host them.
3. Stop new v14 checkout quotes, but leave v14 workers running until every REQUESTED/PREPARING/ACTIVE/ENDING lease has returned to its recorded pool and every user claim is accounted.
4. Simulate `DeployDualKamiLeaseMarket.s.sol` and record the predicted addresses and gas. Do not fund or broadcast from the web server.
5. Run the coordinated staged broadcaster. It creates both markets, both renter factories, both HubGuards, one registry and one shared Personal Rental Vault factory in consecutive transactions, then burns all temporary admin/installer authority. The script must not publish or wire any partial address set; if it stops, discard that partial deployment and rerun from a fresh deployer nonce/state.
6. Run `tools/vault-kit/verify-v15-security-deployment.mjs`. A failed invariant blocks cutover.
7. Confirm the game world still permits contract account creation. If `WORLD_PRIVATE` is enabled, the game operator must whitelist the exact vault factory and renter-pod creation path before launch; there is no safe protocol-side bypass for the game's whitelist.
8. Start one worker per market with separate state paths, reservation URLs/tokens and ports. Confirm each worker's on-chain `keeper()` check before opening quotes.
9. Set Kamistats' address-keyed `OPERATOR_RESERVATION_URLS` and `OPERATOR_RESERVATION_TOKENS`, then update both market/factory addresses together in one release.
10. Run a canary end to end with a non-critical Kami: owner pool → hub → RoomPod → farm → settle → pool, plus a separate timed recovery rehearsal on a test deployment.
11. Only after the canary passes, expose the direct marketplace URL. Keep v14 read/claim/return support until its backing and participation counters reach zero.

## Hard launch blockers

- Either market reports a nonzero `admin()`.
- Registry `installer()` is nonzero or `factory()` is not the shared vault factory.
- Market operator is not its exact HubGuard.
- Quote signer equals keeper, or either secret is installed on the other host.
- The worker cannot attest a fresh random operator quote.
- The game world is private and the contract account-creation path has not been explicitly whitelisted by the game operator.
- Any active v14 lease, pending return, backing shortfall or unclaimed migration obligation is ignored.
- Full Foundry tests and a fork canary have not passed.
