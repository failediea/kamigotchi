# v16 deploy runbook — LAUNCHED 2026-07-31

> **Status: V16 infrastructure is the production stack as of 2026-07-31.**
> Workers staged from `c8346aae`; both V16 services are active/enabled with
> `terminalGasReturn=factory` on ports 8791/8792; Caddy and Vercel point at V16.
> Both V15 services remain active with `terminalGasReturn=skip` for legacy
> recovery only, and V15 rejects new leases.
>
> **Verification boundary:** the recorded 409 responses prove routing reached
> the listing check; they are not successful signed quotes and do not prove the
> money path. VIPP personal-pool creation was enabled in production by Kamistats
> commit `9395f40`; that UI gate is closed. The MUSU and VIPP burn-in loops in
> section 7 remain required.
> The V16 pool registry is new — owners must re-declare kamis into V16 pools.

Written 2026-07-27 and corrected after the release audit. This is the
coordinated deploy that has been pending since the audit: 13 audit fixes, the
pod-recovery machinery, the VIPP fee-float system, and the terminal float
return + seed 150→45.
The contracts were deployed on 2026-07-29 from source commit
`f781b2d7e0b122d20750621323fc75f9da4defef`. The public address and receipt
records live under `deployments/`. V16 infrastructure is now the production
stack. Lease #10165 is finalized; V15 remains online only for legacy recovery.
End-to-end feature burn-in is still pending as described in section 7.

## What changes vs the deployed v15

| Area | Change | Why |
|---|---|---|
| `RenterRoomPodFactory` | `enterPodRecovery(uint32, bytes32 salt)` — NEW SIGNATURE | audit #1: squat-proof recovery rotation |
| `RoomPod` | constructor takes `recoveryOpImpl`; recovery clones it via CREATE2 | recovery machinery |
| `RoomPod.sweepMusu` | market/factory terminal sweeps also return unused MUSU float to the hub (`FeeFloatReturned`) | stops seed stranding + churn-drain; makes VIPP viable |
| `POD_FEE_FLOAT_SEED` | 150 → 45 (`RenterRoomPodFactory.sol:79`) | worker sweeps ONCE (measured); 150 stranded ~135/pod |
| `KamiLeaseMarket` | `seedPodFeeFloat`, `musuFeeFloat`, `feeFloatClaimsLeft`, `forfeitDust`, pro-rata `claimOwed`, `_creditPending` in cancel paths | audit fixes + VIPP fee plumbing |
| `RenterRoomPodFactory` | native `createPodsAndRequestLeases` batch entrypoint | replaces the BatchLease periphery (DEPLOYMENTS.md redeploy rule 3) |
| `HarvestGuard.ship` | lease-state check | audit: keeper could evict mid-term |
| `PersonalRentalPool.declareKami` | accepts already-arrived kami | audit |
| `PersonalRentalVaultFactory` | `cloneDeterministic` salted by (sender, accountName) | audit |

Open by design: #5 (KamiVault dead code — do NOT deploy it, see DEPLOYMENTS.md
"Dead contracts"), #7 (XP metering).

## 0. Preconditions and the deploy/cutover boundary

1. **Commit.** Use an audited release commit with a clean tracked worktree.
   The deployed contract bytecode is pinned to `f781b2d7e`; later documentation
   commits do not change that bytecode.
2. **Tests green.** Run the vault files one at a time and one thread at a time;
   a single full-glob via-IR build can exhaust this WSL VM before Forge prints a
   result:

   ```bash
   cd packages/contracts
   for TEST in test/vault/*.t.sol; do
     FOUNDRY_PROFILE=v16 forge test --match-path "$TEST" --threads 1 || exit 1
   done
   ```

   Every executable suite must exit zero and the aggregate skip count must be
   zero. Record exact per-file counts from the release commit rather than
   copying a historical number into the deploy record.
3. **Lease #10165 is a CUTOVER gate, not a broadcast gate.** It ends
   2026-08-02 19:07 UTC unless the renter ends early. Steps 1–2, read-only
   wiring verification, and staging V16 workers on their separate ports can
   happen while V15 continues serving it. Do not perform the production
   env/frontend/Caddy cutover in steps 3–5, remove V15 map entries, or stop the
   V15 units until the lease has finalized and its claims/refund are drained.
4. **ItemBurn grief posture — ships as a KNOWN ACCEPTED RISK.** The branch
   does NOT close the vector: the renter's in-game operator can call the
   game's `ItemBurnSystem` against the pod's inventory, including the VIPP
   pod's seeded MUSU fee float. What the branch DOES do is bound it:
   - blast radius per pod is capped at `POD_FEE_FLOAT_SEED = 45` MUSU
     (`RenterRoomPodFactory.sol:79`);
   - the market/factory terminal sweep returns any unburned float to the hub
     (`RoomPod.sweepMusu` float-return branch, commit `a3b40df`), so churned
     leases no longer strand seed;
   - burning the float is self-harming — the renter's own earnings sweep
     then can't pay its fee and their payItem strands in the pod until the
     manual re-fund path runs: send ≥15 MUSU to the pod's game account, then
     anyone calls the permissionless `sweepMusu()`;
   - `feeFloatClaimsLeft()` on the hub is the monitor (0 = claims about to
     revert).
   Decision recorded here: accept and ship. No contract change required.
5. **Reuse signer/keeper** (DEPLOYMENTS.md redeploy rule 1): quote signer
   `0xf1B03dC03b310726e04d524aE1498ccf4FC65BAc` and keeper
   `0x0d0294C57B01ED7189b8A9ba354cf77b935abcDc`, keys in
   `tools/vault-kit/.env.v15` (`V15_QUOTE_SIGNER_KEY`,
   `V15_MARKET_KEEPER_KEY`). Fresh keys force a Vercel + VPS rollout for no
   benefit. Settler stays `0xD8A64a5cf338480B2EAf77955979cF163716957c`, mgmt
   account `756360582917686076792667387455343056142985847610`.
6. **Keeper gas.** Top the keeper wallet up to ≥0.0005 ETH for deploy-day
   provisioning (measured ~1.4M gas per keeper tx).
7. **VIPP float budget ready.** Each VIPP checkout draws seed 45 + its own
   transfer fee 15 = 60 MUSU from the hub; each claim payout costs another
   15. Have ~600 MUSU ready for the hub (step 2 below).

## 1. Deploy the contracts

v15 was deployed by ONE forge script that does both markets, both renter
factories, both hub guards, the shared pool registry, the personal-vault
factory + pool implementation, and seals everything before printing
addresses: `script/DeployDualKamiLeaseMarket.s.sol`. The
`PodRecoveryOperator` implementation is NOT a separate deploy — the
`RenterRoomPodFactory` constructor `new`s it itself
(`RenterRoomPodFactory.sol:189`); the factory constructor is
`(world, market, quoteSigner, keeper)`.

**Registry naming:** the newly deployed `PersonalRentalPoolRegistry` approves
owner-created pools for these markets. It is NOT either `LeasePodRegistry`
used by the frontend tile picker. The current tile registries remain
`0xE205C6A75cB54309874cDF2B2B506E48C72C2871` (MUSU) and
`0xFea42ab917706F3ADfdA803970a41649C84eF7Cf` (VIPP).

```bash
cd /home/matrix/kamigotchi/packages/contracts
# values: DEPLOYER_* / WORLD_ADDR / YOMINET_RPC / MGMT_ACC_ID from
# tools/vault-kit/.env; QUOTE_SIGNER / MARKET_KEEPER addresses from .env.v15
WORLD_ADDR=0x2729174c265dbBd8416C6449E0E813E88f43D0E7 \
KAMI721_ADDR=0x5d4376b62fa8AC16dFabe6a9861E11c33A48C677 \
DEPLOYER_ADDRESS=<DEPLOYER_ADDRESS> \
QUOTE_SIGNER=0xf1B03dC03b310726e04d524aE1498ccf4FC65BAc \
MARKET_KEEPER=0x0d0294C57B01ED7189b8A9ba354cf77b935abcDc \
MARKET_SETTLER=0xD8A64a5cf338480B2EAf77955979cF163716957c \
MGMT_ACC_ID=756360582917686076792667387455343056142985847610 \
MUSU_MARKET_NAME=<FRESH_MUSU_NAME> \
VIPP_MARKET_NAME=<FRESH_VIPP_NAME> \
FOUNDRY_PROFILE=v16 \
forge script script/DeployDualKamiLeaseMarket.s.sol:DeployDualKamiLeaseMarket \
  --rpc-url "$YOMINET_RPC" --private-key "$DEPLOYER_KEY" \
  --legacy --slow --gas-estimate-multiplier 500
```

Notes:
- The command above is the mandatory dry run. Save and review its predicted
  addresses, constructor arguments, and transaction sequence. Only then rerun
  the exact command with `--broadcast`; do not use `--skip-simulation`.
- `FOUNDRY_PROFILE=v16` is mandatory: via-IR, optimizer runs=1, and metadata
  removed. The deployed `KamiLeaseMarket` runtime is 24,541 bytes, only 35
  bytes below EIP-170. Do not build or broadcast this source under v14.
- Yominet performs fee-precompile work before the EVM call. Foundry's default
  130% gas estimate, and even 300% for `sealAdmin`, can leave too little EVM
  gas. Use the 500% multiplier above, preserve normal simulation, and fund the
  deployer for the displayed maximum requirement.
- Hub account names must be fresh because in-game names are unique. The live
  V16 deployment uses `m16hub2` / `vipphub162`.
- The reviewed v16 script intentionally does not deploy the obsolete
  `BatchLease` periphery. The factory's native
  `createPodsAndRequestLeases` entrypoint is the only batch path. Do not edit
  the script between the dry run and broadcast.
- Record the deploy block number — it becomes `START_BLOCK` in step 5.

Then verify the wiring read-only (the checker is env-driven and
version-agnostic despite its name):

```bash
cd /home/matrix/kamigotchi/tools/vault-kit
YOMINET_RPC=<rpc> \
MUSU_MARKET=<V16_MUSU_MARKET> VIPP_MARKET=<V16_VIPP_MARKET> \
MUSU_RENTER_FACTORY=<V16_MUSU_FACTORY> VIPP_RENTER_FACTORY=<V16_VIPP_FACTORY> \
MUSU_HUB_GUARD=<V16_MUSU_GUARD> VIPP_HUB_GUARD=<V16_VIPP_GUARD> \
PERSONAL_POOL_REGISTRY=<V16_PERSONAL_POOL_REGISTRY> \
PERSONAL_VAULT_FACTORY=<V16_PERSONAL_FACTORY> \
QUOTE_SIGNER=0xf1B03dC03b310726e04d524aE1498ccf4FC65BAc \
MARKET_KEEPER=0x0d0294C57B01ED7189b8A9ba354cf77b935abcDc \
MGMT_ACC_ID=756360582917686076792667387455343056142985847610 \
node verify-v15-security-deployment.mjs
```

No separate hub-account activation or walk is required. `initialize()` calls
`AccountRegisterSystem`, whose `LibAccount.create` path places every new
account in room 1. Verify the recorded `accID` values instead.

**Record every address in `tools/vault-kit/migration-v16-deployment.json`
and `~/kamistats/DEPLOYMENTS.md` BEFORE touching any env** — the stack-A
incident happened because prod env pointed at an abandoned deploy.

## 2. Seed the VIPP hub MUSU float

`seedPodFeeFloat` is factory-gated and fires automatically at each VIPP
checkout — but it draws from the hub's own MUSU balance, and per
`KamiLeaseMarket.feeFloatClaimsLeft()` docs the top-up mechanism is simply an
in-game MUSU transfer to the hub's game account. So: **send 600 MUSU to the
v16 VIPP hub's game account (`vipphub162`)** from any funded game account —
in-client trade/send, or the operator-scripted equivalent
(`ItemTransferSystem.executeTyped([1], [600], <vippHubAccID>)`; item index 1
= MUSU; the sender pays the 15-MUSU transfer fee on top).

That is ten checkouts of headroom (10 × 60); terminal sweeps now return
unused seed, so the float mostly recycles. Verify:
`feeFloatClaimsLeft()` on the VIPP market returns ≥ 40 (600 / 15).

## 3. kamistats env re-key — OPERATOR RUNS THESE

**Do not change `NEXT_PUBLIC_REGISTRY_ADDRESS` or
`NEXT_PUBLIC_VIPP_REGISTRY_ADDRESS` here.** Those variables are the two
`LeasePodRegistry` tile directories above, not the new
`PersonalRentalPoolRegistry`. Pointing either variable at the personal
registry makes the UI's `allPods()` call fail and empties the tile picker.

`OPERATOR_RESERVATION_URLS` / `OPERATOR_RESERVATION_TOKENS` are JSON maps
**keyed by lowercase market address** (shape set by
`fix-reservation-maps.sh`). Add the v16 keys and KEEP the v15 keys until the
last v15 lease settles. The tokens live in the VPS worker `.env`s
(`OPERATOR_RESERVATION_TOKEN`) — copying the v15 worker dirs (step 5) also
reuses the tokens, so `<MUSU_TOKEN>` / `<VIPP_TOKEN>` below are the SAME
values already in the current Vercel map.

```bash
cd /home/matrix/kamistats
TOKEN="$(tr -d '\r\n' < ~/.vercel-token)"

# reservation URL map (v15 keys kept, v16 keys added; same two domains)
npx vercel@latest env rm OPERATOR_RESERVATION_URLS production --yes --token "$TOKEN"
printf '%s' '{"0x94546710ab310fa0beaa92b4b0701d801d8ae800":"https://lease-musu.kamistats.com","0x3e83748a2053aa745ba6125b696072e277fffa2b":"https://lease-vipp.kamistats.com","<V16_MUSU_MARKET_LOWERCASE>":"https://lease-musu.kamistats.com","<V16_VIPP_MARKET_LOWERCASE>":"https://lease-vipp.kamistats.com"}' | npx vercel@latest env add OPERATOR_RESERVATION_URLS production --sensitive --token "$TOKEN"

# reservation token map (values from the VPS worker .envs — never commit)
npx vercel@latest env rm OPERATOR_RESERVATION_TOKENS production --yes --token "$TOKEN"
printf '%s' '{"0x94546710ab310fa0beaa92b4b0701d801d8ae800":"<MUSU_TOKEN>","0x3e83748a2053aa745ba6125b696072e277fffa2b":"<VIPP_TOKEN>","<V16_MUSU_MARKET_LOWERCASE>":"<MUSU_TOKEN>","<V16_VIPP_MARKET_LOWERCASE>":"<VIPP_TOKEN>"}' | npx vercel@latest env add OPERATOR_RESERVATION_TOKENS production --sensitive --token "$TOKEN"

# current-market pointers (checksummed addresses)
for PAIR in \
  "NEXT_PUBLIC_MARKET_ADDRESS <V16_MUSU_MARKET>" \
  "NEXT_PUBLIC_VIPP_MARKET_ADDRESS <V16_VIPP_MARKET>" \
  "NEXT_PUBLIC_PERSONAL_VAULT_FACTORY_ADDRESS <V16_PERSONAL_FACTORY>" \
  "NEXT_PUBLIC_MARKET_ACCOUNT_NAME m16hub" \
  "NEXT_PUBLIC_MARKET_VERSION 16" \
  "NEXT_PUBLIC_VIPP_MARKET_VERSION 16" \
  "NEXT_PUBLIC_PERSONAL_VAULT_VERSION 16"; do
  set -- $PAIR
  npx vercel@latest env rm "$1" production --yes --token "$TOKEN"
  printf '%s' "$2" | npx vercel@latest env add "$1" production --token "$TOKEN"
done
```

`QUOTE_SIGNER_PRIVATE_KEY` is unchanged (same signer — precondition 5).
Mirror the same values into `~/kamistats/.env.local`, then regenerate the
paste-block with `tools/vault-kit/make-vercel-env.sh` as the cross-check.

## 4. kamistats vault-versions change + ship

File: **`~/kamistats/lib/vault-versions.ts`**. The current entries are built
from env (step 3 flips them to v16 automatically). The V15 market entries and
V15 personal factory are pre-staged on the release branch so they dedupe while
V15 is current and become legacy sources immediately after the env flips.
Verify these immutable facts before shipping; never delete an older entry:

```ts
{
  id: "v15-musu",
  version: 15,
  currency: "MUSU",
  label: "MUSU v15",
  market: "0x94546710aB310FA0BEAa92B4B0701d801d8AE800",
  registry: "0xE205C6A75cB54309874cDF2B2B506E48C72C2871",
  selfRegistry: "",   // carry over the live NEXT_PUBLIC_SELF_REGISTRY_ADDRESS value if set
  lifecycle: "legacy",
  acceptsNewLeases: false,
  has721: false,      // mirror the live NEXT_PUBLIC_HUB_HAS_721 value
},
{
  id: "v15-vipp",
  version: 15,
  currency: "VIPP",
  label: "VIPP v15",
  market: "0x3E83748a2053Aa745ba6125b696072E277ffFa2b",
  registry: "0xFea42ab917706F3ADfdA803970a41649C84eF7Cf",
  selfRegistry: "",
  lifecycle: "legacy",
  acceptsNewLeases: false,
  has721: false,
},
```

And in `historicalPersonalFactories`:

```ts
{
  id: "v15-personal",
  version: 15,
  label: "Personal Rental Vault v15",
  address: "0x3F04d39508d20580A994cf78Badaf73813C3981f",
  lifecycle: "legacy",
}
```

V15 owner pools cannot be registered into V16: the V15 personal registry is
sealed to its one immutable factory, and every pool is bound to its V15 market.
The owner UI therefore keeps V15 visible and walks each Kami through the safe
multi-step migration (finish/cancel → withdraw → create/select V16 pool →
declare/send/publish). This migration is expected and is not automatic.

(While v15 still has a live lease, `uniqueByAddress` dedupes: the env-driven
"current" v15 entry wins until step 3 flips the env — safe to land early.)
Also update `~/kamistats/DEPLOYMENTS.md`: v16 table becomes current, v15
moves under services/legacy notes. Then the standard kamistats ship pattern:

```bash
cd /home/matrix/kamistats
git status --short
git add -- lib/vault-versions.ts DEPLOYMENTS.md
git diff --cached --check
git diff --cached --stat
git diff --cached
git commit -m "v16 cutover: v15 -> historical, env-driven current to v16"
git push origin HEAD
npx vercel@latest --prod --yes --token "$(tr -d '\r\n' < ~/.vercel-token)"
```

Stop if the staged diff contains anything except the two files above. Audit
and commit application-code changes separately; never use `git add -A` in the
cutover workflow.

Smoke the quote path immediately: `/api/vault/lease-quote` must return 200 +
signatures on BOTH v16 markets — this is the check that caught the stale
reservation map last time.

## 5. VPS cutover (root@68.183.190.126)

v15 units keep running (they still own lease #10165). v16 gets NEW dirs,
ports, and units — pattern per `repoint-v15-workers.sh` and
`deploy/README-vps.md`:

The new directories, unit files and services on ports 8791/8792 may be staged
before the cutover gate. The Caddy repoint at the end of this section must wait
and move in the same sitting as steps 3–4.

```bash
ssh root@68.183.190.126
cp -a /root/kamigotchi/tools/vault-kit-v15-musu /root/kamigotchi/tools/vault-kit-v16-musu
cp -a /root/kamigotchi/tools/vault-kit-v15-vipp /root/kamigotchi/tools/vault-kit-v16-vipp
```

In each new dir's `.env` (chmod 600):
- `MARKET_ADDRESS` / `RENTER_POD_FACTORY` = the v16 addresses
- `START_BLOCK` = the deploy block from step 1
- `OPERATOR_RESERVATION_PORT` = **8791** (musu) / **8792** (vipp) — v15
  keeps 8789/8790
- `KEEPER_PRIVATE_KEY` / `OPERATOR_RESERVATION_TOKEN` / `YOMINET_RPC` /
  `WORLD_ADDR` carry over unchanged
- point `WORKER_STATE_FILE` at a fresh file (or delete the copied v15 state
  json) so the worker actually starts from `START_BLOCK`

Ship the fixed worker code (the repo copy now carries the
`ensureOperatorGas` reserve fix) into both v16 dirs from WSL:

```bash
rsync -av /home/matrix/kamigotchi/tools/vault-kit/{renter-pod-worker.mjs,renter-pod-events.mjs,renter-pod-keys.mjs,renter-pod-recovery.mjs,kamibots-rental-config.mjs} \
  root@68.183.190.126:/root/kamigotchi/tools/vault-kit-v16-musu/
rsync -av /home/matrix/kamigotchi/tools/vault-kit/{renter-pod-worker.mjs,renter-pod-events.mjs,renter-pod-keys.mjs,renter-pod-recovery.mjs,kamibots-rental-config.mjs} \
  root@68.183.190.126:/root/kamigotchi/tools/vault-kit-v16-vipp/
```

**Apply the compatibility-safe reserve hotfix to the still-running v15
units.** Their copies predate the fix; without it any remaining v15
provisioning can strand its gas escrow because one bot action costs ~4.03e12
wei while the old reserve tops up only 1e12. Do not replace the entire V15
worker with the V16 worker: V15 does not support V16's terminal
`returnUnusedOperatorGas()` sequence.

The hotfix also changes V15's pull from `min(budget, reserve)` to
`min(budget, reserve - balance)`. That exact-deficit calculation is essential:
V15 cannot return terminal operator dust, so knowingly overfunding the
ephemeral operator would trade a liveness fix for avoidable renter loss.

```bash
scp tools/vault-kit/apply-v15-gas-reserve-hotfix.sh \
  root@68.183.190.126:/root/kamigotchi/tools/
ssh root@68.183.190.126 \
  'bash /root/kamigotchi/tools/apply-v15-gas-reserve-hotfix.sh --apply'
```

The script is idempotent, creates timestamped backups, refuses unexpected
worker layouts, runs `node --check`, restarts both V15 services, and requires
both services to return to `active`. A later read-only verification is:

```bash
ssh root@68.183.190.126 \
  'bash /root/kamigotchi/tools/apply-v15-gas-reserve-hotfix.sh --check'
```

Units — copy the v15 unit files, fix `WorkingDirectory`/`ExecStart` to the
v16 dirs:

```bash
ssh root@68.183.190.126
sed 's/v15-musu/v16-musu/g' /etc/systemd/system/kami-renter-pod-v15-musu.service > /etc/systemd/system/kami-renter-pod-v16-musu.service
sed 's/v15-vipp/v16-vipp/g' /etc/systemd/system/kami-renter-pod-v15-vipp.service > /etc/systemd/system/kami-renter-pod-v16-vipp.service
systemctl daemon-reload
systemctl enable --now kami-renter-pod-v16-musu kami-renter-pod-v16-vipp
journalctl -u kami-renter-pod-v16-musu -n 20 --no-pager   # expect: "operator reservations listening on http://127.0.0.1:8791"
journalctl -u kami-renter-pod-v16-vipp -n 20 --no-pager   # and "renter-funded worker ready: market 0x<v16>… keeper 0x0d0294…"
```

The worker refuses to start if `KEEPER_PRIVATE_KEY` doesn't match the v16
factory's on-chain keeper — that error in the journal means the factory
address or key is wrong; fix before proceeding.

Caddy: the domains stay `lease-musu.kamistats.com` / `lease-vipp.kamistats.com`.
Repoint them 8789→8791 and 8790→8792 in `/etc/caddy/Caddyfile` and
`systemctl reload caddy` **in the same sitting as step 3's map update** —
the domain flip and the Vercel map flip belong together. (v15's reservation
endpoints going dark is harmless: reservations are only consulted for NEW
quotes, and v15 accepts none.)

## 6. v15 wind-down + the #16218 recovery item

Wind-down: lease #10165 rides out on v15 (ends 2026-08-02 19:07 UTC).
Keep the v15 units and the v15 keys in the Vercel maps until the v15 markets
show `numListings == 0` and all `owedMusu` claims are drained, then:

```bash
ssh root@68.183.190.126 'systemctl disable --now kami-renter-pod-v15-musu kami-renter-pod-v15-vipp'
```

then remove the v15 map keys at the next env touch.

**#16218 (dead kami) — separate v13-side item, NOT fixed by this deploy.**
Verified on-chain 2026-07-27: pod `0xF3ce071af425E9bD5AdaA5373e4a408BE93bf9Fa`
is v13 MUSU pod `m13p2` (node 2, Tunnel of Trees — see
`migration-v13-musu-deployment.json`), runtime 3738 bytes, and its bytecode
predates ALL recovery machinery: `enterPodRecovery`/`enterRecoveryMode` do
not exist for it and never can (deployed bytecode is immutable). The v16
recovery path only reaches pods created by the v16 factory. What the v13 pod
DOES have (per `git show 3c96c5f78:.../RoomPod.sol` and the on-chain probe):

- `admin()` = the deployer EOA (`DEPLOYER_ADDRESS` in `tools/vault-kit/.env`)
  — still ours;
- `rotateOperator(address)` (onlyAdmin) — can point the pod's game account
  at any fresh operator EOA we control;
- the pod's CURRENT operator key is already local:
  `tools/vault-kit-v13-musu/pods.json` (operator
  `0x2e58DD16a48bA9B4ffDebE8De1D07025B96BbCf2`).

So the recovery is an in-game operation, not a contract one: acting as the
pod's operator EOA, revive #16218 (dead kamis can't move), then send it home
via `KamiSendSystem.executeTyped(16218, <owner address>)`; sweep any MUSU
with the pod's permissionless `sweepMusu()` first. Diagnostics from the
earlier incident: `diag-16218.mjs`, `poll-16218.mjs`, `rearm-16218.mjs`.
Do this any time — it does not gate the v16 deploy.

## 7. Post-deploy smoke test (the money path, once each)

> **OPEN RELEASE GATE:** neither currency has a recorded successful signed quote
> (HTTP 200) plus complete lifecycle. The existing 409 checks are wiring evidence
> only. Record transaction hashes and refund/claim evidence before marking MUSU
> or VIPP end-to-end verified.

1. **MUSU:** list one kami on v16 via the kamistats UI, self-lease it for
   1 day from the second wallet, and watch the v16 musu journal walk the
   stages: `markLeasePreparing` → walk → `routePreparedKami` →
   Kamibots armed → on-chain `HARVESTING` → `activateProvisionedLease`. Verify the operator wallet pulls
   ~3e13 wei once (the new reserve) rather than 1e12.
2. Verify the kamistats **`/api/vault/live-lease`** panel shows the lease
   with the v16 market address, and the vault page reads green.
3. Collect → settle → end lease → `finalizeMarketLease` → gas refund lands
   back at the renter wallet. (This exact loop worked on v15 on 2026-07-26;
   it must still work on v16.)
4. **VIPP:** same loop, plus at finalization: hub received the swept VIPP,
   hub MUSU float went UP by the returned seed remainder (`FeeFloatReturned`
   event), `feeFloatClaimsLeft()` dropped by exactly the fees spent, and the
   renter can claim VIPP.
5. Withdraw the smoke-test kami from v15 if it was listed there, re-list on
   v16. Real listings migrate the same way: v15 out, v16 in.
