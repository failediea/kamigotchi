# RoomPod operator key custody (renter-pod worker)

Every RoomPod has its own game operator EOA. The worker holds that key for the
whole lease: it walks the pod, registers it with Kamibots, and returns the Kami.
This page describes how those keys are made, stored, backed up and destroyed,
and what a leak of any worker file gives an attacker.

## 1. One independent random key per quote (V14-01)

- The quote API asks the worker for an operator (`POST /v1/operator-reservations`).
  The worker draws **32 bytes from the OS CSPRNG** (`node:crypto randomBytes`,
  `randomOperatorWallet()` in `renter-pod-keys.mjs`). The rare out-of-range
  value is drawn again.
- There is **no master seed and no derivation**. The key does not depend on the
  quote nonce, the renter, the chain, the market, or any other key. Knowing any
  number of keys, or every public `RenterPodCreated` event, says nothing about
  any other key. This is the V14-01 fix
  (`CODEX_V14_SECURITY_AUDIT_2026-07-21.md`, V14-01;
  `docs/V14_RANDOM_OPERATOR_MIGRATION.md`). A seed-derivation design was built
  and rejected for that reason. Do not reintroduce one.
- Only the **address** leaves the worker. The key never reaches the web, the
  browser, the quote or the chain. It is uploaded to Kamibots only after the
  pod exists on-chain, for that pod alone.

## 2. Durable before it is used

A key must never be needed by a pod the worker cannot operate. So:

| Step | What is written | Before which answer |
|---|---|---|
| reserve | the new key, its operator, renter, tokenIndex | the operator address (201) |
| attest | the quote binding (digest, deadline) | the keeper signature (200) |

Each write is one JSON line appended to the journal, then `fsync`. The answer is
sent only after `fsync` returns. If the write fails, the worker answers `503
KEY_STORE_UNAVAILABLE` and returns nothing: no address, no signature. A crash
between the fsync and the answer is harmless, because a stored key that is never
used is simply pruned later. A signed quote whose key is not on disk cannot
exist. The regression tests `CRASH ...` in `renter-pod-reservation-server.test.mjs`
and `renter-pod-quote-store.test.mjs` check this ordering.

## 3. Where keys live

| File (mode 0600) | Holds | Lifetime |
|---|---|---|
| `<state>.reservations.json` (snapshot) | keys of quotes in flight: `{ version: 1, generation, reservations }` | rewritten atomically on compaction |
| `<state>.reservations.journal` | the same keys as append-only JSON lines (`put` / `del`) since the last compaction | replaced on compaction |
| `<state>.json` (job state) | the key of every **active** lease (`jobs[token].operatorKey`) and its Kamibots credentials | the key is deleted when the Kami is back home (`purgeReturnedJobSecrets`) |
| Kamibots | the key of each active lease, so its strategy can act | outside our control. See section 6 |

The journal is folded into the snapshot when it grows past twice the snapshot
(and past 1 MiB), at every start, and on `SIGTERM`/`SIGINT`. `node
renter-pod-quote-store.mjs compact <snapshot>` does the same for a worker that
was killed. Run it only while the worker is stopped.

### When a key is deleted

- **Unattested** (never signed): after `RESERVATION_TTL_SEC`, or right away when
  the web releases the checkout or the attest finds the wallet unfunded. The
  factory rejects any quote without the keeper signature, so no pod can ever
  use such a key.
- **Attested** (signed): only once ingest has covered a confirmed block whose
  **timestamp** is past the quote deadline. That is chain time, never the local
  clock. The keeper signs deadlines at most `RESERVATION_TTL_SEC` + 60 s ahead,
  which bounds how long a key waits.
- **Never** while a `RenterPodCreated` event for that nonce is parked for ingest
  retry.
- **Claimed**: when its pod is ingested, the key moves into the job. The job
  state file is saved first, and only then is the key deleted from the store. A
  crash in between leaves the key in both places, never in neither.
- **Never for space.** Nothing counts, caps or evicts the store. Its size is the
  web's quote rate times the key lifetime (section 7).

At ingest, the event's operator must equal the key stored for its nonce.
Otherwise the event is parked and `[LEASE-ALERT] OPERATOR_MISMATCH
reason=missing|mismatch` is raised on every retry. Restoring the right store
file and restarting adopts it.

## 4. What a leak exposes

Keys are independent, so a leak exposes exactly the keys in the leaked file and
nothing else.

| Leaked | Exposes | Does not expose |
|---|---|---|
| snapshot and/or journal | the operator keys of quotes that were in flight (quoted in the last ~15-20 min and not yet claimed or pruned); older lines of the same journal generation may include keys already claimed into jobs | keys of other quotes and pods; the keeper key; the reservation token |
| job state file | the operator key and Kamibots credentials of every **active** lease | returned leases (their secrets are purged) |
| a Kamibots account | that pod's operator key | every other pod |
| `.env` | `KEEPER_PRIVATE_KEY`, `OPERATOR_RESERVATION_TOKEN` | operator keys (none live in `.env`) |

An operator key is an ordinary game operator, not a harvest-only capability
(V14-01). Whoever holds it can act on that pod's Kami and pull that pod's
remaining renter-funded gas budget, for as long as the pod holds the Kami. The
key of a quote that was never submitted controls an empty pod address, so
leaking it is harmless. The dangerous files are the job state file and the
store entries of quotes that became pods and are not yet claimed. Treat all
three files like the keeper key.

## 5. Backup expectations

- **What:** the job state file **and** both store files, taken together. The
  snapshot alone misses keys journaled since the last compaction. Stop the
  worker first (`SIGTERM` compacts), or run `renter-pod-quote-store.mjs
  compact` on a stopped worker, or copy all three files.
- **How:** encrypted (e.g. `age` / `gpg` to an offline recipient), off the VPS,
  and access-controlled like the keeper key. Never commit them: the
  pre-commit secret scan blocks `*.reservations.json`, `*.reservations.journal`
  and `*worker-state*.json`.
- **How often:** a backup is useful only for keys that are still alive: active
  leases (state file) and in-flight quotes (store, minutes). Back up the state
  file whenever a lease starts. A daily backup of the store is not useful.
  Losing the store loses only quotes submitted in the last few minutes, and
  their events then park with `OPERATOR_MISMATCH`.
- **Restoring an old store** is safe. The loader merges and never drops a key
  or a keeper binding. A journal newer than its snapshot is merged monotonically,
  and a journal older than its snapshot is ignored because it is already folded
  in. Garbage (a snapshot that is not JSON, a broken complete journal line)
  stops the worker loudly. Nothing is silently discarded.
- **Destroy** old backups once every lease they cover has returned. They hold
  live keys only until then.

## 6. Kamibots

Kamibots receives each active pod's key (`/api/agent/operator-key`) so that the
strategy can harvest and feed. Its custody is outside this worker. A Kamibots
compromise exposes the pods registered there, one key per pod, and nothing
else, because the keys are independent.

## 7. Store size under a quote burst

The web's per-IP limit (12 quotes/min) bounds the worst case: 50 IPs at the
limit for an hour means 600 checkouts/min (36,000 quotes). Each quote's key
lives about 15 minutes (the web's quote deadline) plus the ingest lag and the
30 s tick. That gives about 9,200-9,500 live keys at the peak, and the count
drains to 0 about 16 minutes after the burst.

Measured on 2026-09-29 in WSL2 (ext4 on a virtual disk, Node 20). These are
not VPS numbers. Run `node bench-quote-store-burst.mjs` on the box to get
its own fsync figures. The bench writes only to a fresh temp dir.

| | full 1 h burst (test `BURST`, fsync stubbed) | 20 min at 10/s, real fsync (bench) |
|---|---|---|
| peak live keys | 9,200 | 9,200 |
| snapshot / journal peak | 3.9 MB / 7.7 MB | 2.5 MB / 4.3 MB (compaction timing) |
| compactions | 6 | 3, slowest 99 ms |
| worker CPU per checkout (reserve + attest) | | 0.80 ms, so 0.8% of one core at 10/s |
| fsync'd append | | p50 4.7 ms, p99 33 ms, max 165 ms |
| event loop busy at 10/s (CPU + synchronous fsync) | | 15.5% |
| heap / RSS peak (bench process incl. ethers) | | 46 MB / 127 MB |
| disk written | | ~39 MB per hour (journal + compactions) |

On the 1 vCPU / 1 GB VPS, allow about 2-3x the CPU time: a few percent of the
core. Memory stays around +50 MB over the idle worker. Disk use is under
15 MB at any moment. The synchronous fsyncs are the main cost. Each one blocks
the event loop for one disk flush, which delays other quote requests and
ticks by milliseconds but never refuses them. Nothing here grows with the
length of the burst, only with its rate. Even at the worker's own bound
(deadline <= `RESERVATION_TTL_SEC` + 60 s = 21 min) the peak stays below
13,000 keys (~5.5 MB snapshot).
