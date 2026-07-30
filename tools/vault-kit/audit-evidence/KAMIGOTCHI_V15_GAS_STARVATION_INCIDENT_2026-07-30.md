# V15 renter-pod gas starvation incident — 2026-07-30

## User impact

Kami #6789 completed a one-day V15 MUSU lease without gaining XP or producing
owner/renter earnings. Its return then remained pending until the pod
operator received a manual 0.00005 Yominet ETH top-up.

The supplied incident transcript reports that the next 30-second worker retry
returned the Kami after that top-up. The raw transaction hashes were not
included in the transcript, so this repository records that timing as operator
evidence rather than independently reproduced chain evidence.

## Root cause

The renter paid three gas components at checkout:

1. setup gas sent directly to the fresh pod operator;
2. hub gas sent to the shared keeper;
3. operating gas retained as refundable factory escrow.

The old V15 worker attempted to maintain only
`1_000_000_000_000` wei in the pod operator. One measured Yominet bot action
costs approximately `4_030_000_000_000` wei. Once setup gas was consumed, a
single operating-gas pull could therefore leave the operator unable to submit
the transaction that starts/continues farming or returns the Kami.

This is a delivery-valve failure: the renter-funded operating budget can
remain in the factory while the operator that must spend it has less than one
transaction's gas.

## Immediate V15 remediation

Run `operations/apply-v15-gas-reserve-hotfix.sh --apply` on the VPS. It changes
the two live V15 worker reserves from 1e12 to 30e12 and changes their pull to
the exact `reserve - balance` deficit. It creates recoverable backups,
syntax-checks both workers, restarts the services, and fails unless both
return to `active`.

Do not replace V15 with the complete V16 worker. V16 returns leftover operator
ETH through a factory `returnGas()` path that was changed to support terminal
stages. V15's deployed factory is immutable and does not have that complete
behavior.

## V16 behavior

V16 addresses both sides of KV16-002:

- each top-up is `min(gasBudget, reserve - balance)`, so it funds the actual
  deficit instead of over-drawing the renter escrow;
- the reserve is priced from the live gas price times 12 million gas units,
  enough for approximately one day of measured actions and replenished on
  worker ticks;
- activation/reconciliation fails closed with the exact shortfall if operator
  balance plus escrow cannot afford even one measured action;
- before the ephemeral operator key is purged, remaining operator ETH is
  returned into factory accounting and included in the renter refund.

The V16 contracts are deployed, but the V16 workers must not be called live
until their shared keeper meets the documented gas threshold and the normal
launch/cutover checks pass.

## Required verification before V15 lease #10165 ends

1. Confirm the reserve hotfix is present in both V15 worker files.
2. Confirm both V15 services are active after restart.
3. Resolve #10165's exact pod and operator from the factory event/state.
4. Check the operator's current Yominet balance and remaining factory
   operating budget.
5. Confirm the worker can fund at least one measured return transaction.
6. Watch the return, market finalization, renter refund, and owner-pool
   restoration as separate states.

## Detection requirement

A lease must not be treated as healthy merely because it reached the ACTIVE
contract stage or because a strategy-start API call returned success. Worker
health must surface an explicit error when:

- operator balance plus remaining escrow cannot fund one action;
- an ACTIVE job has no confirmed strategy state;
- the same gas or strategy error repeats across polling cycles;
- XP remains unchanged beyond a defined post-activation grace period.

The first two checks can be enforced locally by the worker. XP-progress
monitoring requires a reliable on-chain/game activity read and should be
shipped with an alerting destination rather than silently inferred from the
local state file.
