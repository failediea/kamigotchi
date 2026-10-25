# Reviewed worker rollout and rollback

Source preparation is **not deployment**. On 2026-10-25 04:01-04:04 UTC,
read-only SSH confirmed six v13/v15/v16 processes running as root on Node
20.20.0. Their units point to 22.23.4, but `/proc/<pid>/exe` proves they have
not restarted. Both v16 workers report RPC 503 `no healthy upstream`.
The official Initia registry still names that endpoint. A clean on-chain
migration gate cannot currently be completed. **Do not cut over during that
outage or infer safety from empty local jobs.**

## Source changes and limits

- Operator quote keys use the reviewed append-and-fsync journal and 20-minute
  lifetime. New infrastructure limits reject new allocation above 20,000 stored
  keys, 1,200 allocations/minute or 16 concurrent requests. No signed/live key is
  evicted, no listing is locked, and quotes do not hold lease slots. This is a
  bounded worker endpoint, not a separately isolated quote process.
- The exact deployed legacy bot was preserved before editing (source commit
  `d4342f76c`; baseline SHA256
  `5bf7cfb9ff124875fe27dd3b7129415e9131a1e9e61fe92de4c469fe8ea5ce11`).
  Legacy returns now read fresh game state; DEAD returns persist an alertable
  block and recheck every 15 minutes instead of sending every tick. No Kami ID
  is hardcoded. This does not revive or recover an already-dead Kami.
- Settlement uses the worker's durable transaction tracker, at most one batch
  per minute/tick, ten listings/batch, and a six-million-gas ceiling. Old markets
  without positive batch-selector identification are capped at 25 listings.
  A failed batch is never reinterpreted as missing capability.
- For **daily** settlement, `SETTLER_PRIVATE_KEY` must match `market.settler()`.
  The old snapshot's settler differs from the keeper. Without the dedicated
  key the keeper waits for the contract's three-day permissionless fallback;
  `estimateGas` must prove the exact deployed permission/cooldown before a send.
  Therefore installing this code alone does not establish daily settlement.
- Semantic monitoring now includes both v13 services. Alert, gas-sponsor and
  transition-gate readers prefer `/etc/kami-lease/<stack>.env`, so a migrated
  worker's new state and heartbeat are monitored instead of stale old files.

## Build, without touching services or secrets

1. Finish the complete source tests, dependency audit and review. Export only
   the reviewed commit to a separate root-owned staging checkout. Never copy
   a dirty live worker tree over a reviewed tree.
2. Independently verify the official Node 22.23.4 download/checksum. The existing
   versioned binary may be reused only if verified; shell `node --version` is
   not proof of the actual workers' runtime.
3. Run `stage-worker-release.mjs --source=<reviewed vault-kit directory>
   --id=<reviewed commit ID> --node-source=<verified v22.23.4/bin/node>`.
   Default is dry-run. Add `--apply` only for the reviewed build. It stages
   `/opt/kami-lease/runtime/node-v22.23.4/bin/node` and an immutable
   `/opt/kami-lease/releases/<ID>`; installs locked production dependencies
   with lifecycle scripts disabled; audits them; and writes a hash manifest.
   It never copies `.env`, state or keys, installs units, or starts services.
4. Inspect `RELEASE-MANIFEST.json` against the reviewed source. The worker and
   all imported modules must be present. Do not change global Node symlinks.

## Controlled installation, one stack at a time

1. Restore RPC availability first. Obtain fresh chain head, factory/market
   wiring, requests, custody and zero-active-lease evidence. Re-read every
   state file and both quote snapshot/journal. Stop if any check is unresolved.
2. Put that stack's quote endpoint in maintenance/HALT, allow existing quotes
   and checkout transactions to drain, and stop its service explicitly. A
   failed/restarting service is **not stopped**. Do not stop other stacks.
3. Dry-run `install-isolated-worker.mjs --stack=v16-musu
   --release=/opt/kami-lease/releases/<ID>` (then separately v16-vipp).
   Defaults preserve the original `/root/kamigotchi/tools/vault-kit-<stack>`.
   `--source=` is available for a reviewed alternative. The installer never
   starts/stops services and refuses existing destination files/directories.
4. Add `--apply` only after reviewing the plan. It requires the source unit
   inactive, no unfinished/retired job, no pending transaction or parked event,
   an immutable root-owned release/runtime, a fresh Yominet head and zero
   active on-chain requests/renters. A bad RPC fails the gate. It resolves
   relative state paths against the source directory, not the caller's cwd.
5. It copies the complete custody state, quote snapshot, journal and HALT
   byte-for-byte, verifies hashes before/after copying, and records counts and
   hashes without keys. Old files are retained. It creates separate
   `kami-v16-musu` / `kami-v16-vipp` users, mode-0700 state directories under
   `/var/lib/kami-lease/<stack>`, root-mode-0600 env files under `/etc/kami-lease`,
   and a restrictive systemd drop-in. V15 migration is permitted only with its
   required `TERMINAL_GAS_RETURN_MODE=skip`; do not give v15 v16-only gas calls.
6. Inspect `systemctl cat/show` and `systemd-analyze security`. Start **one**
   service. Verify actual process UID and `/proc/<pid>/exe`, all imports, two
   successful heartbeats, matching canonical cursor, key counts, localhost-only
   reservation binding, semantic alerts and public status freshness. Keep HALT
   until healthy. Then repeat for the other stack and restore quotes.

No new contract, frontend environment, listing or token move is part of this
installer. Starting a worker may execute its normal on-chain jobs/accounting;
the operator must verify that behavior before starting it.

V13 uses a different bot and is not migrated by this installer. Review and
stage its legacy-return patch independently, preserve its exact environment and
state, and apply equivalent isolation in a separate change. V14 was observed
crash-looping from RPC 503; do not retire it until its holdings/requests are
verified through a healthy RPC. Those operational items remain open.

## Rollback: state must move forward, never back

- Before the migrated worker has run or answered any quote, keep it stopped
  and keep quotes halted. Securely archive both the new
  `90-isolated-worker.conf` and `/etc/kami-lease/<stack>.env` outside their
  active paths. Preserve root ownership and mode 0600 on the archived env;
  it contains credentials. Do not print it or discard the isolated state,
  migration receipt, or original files.
- The env file is also a migration marker: alerts, gas sponsorship and the
  transition gate prefer it whenever it is readable, independently of the
  service drop-in. Removing only the drop-in would leave those readers on a
  stale state copy. Run `systemctl daemon-reload`, inspect the restored unit,
  and verify every reader resolves the original environment, state and
  heartbeat paths before starting the old service or lifting HALT. Do not
  run a gas sponsor in apply mode just to verify its configuration.
- **After it has run or answered any quote, the old state snapshot is stale.**
  Do not simply remove the drop-in and start the old service. Keep HALT, stop
  the new worker, resolve pending transactions, and drain signed quotes through
  their on-chain deadline plus confirmations. Reconcile the *latest* state,
  quote snapshot and journal using the reviewed key-store reader. Preserve all
  live/attested keys and every unresolved custody job; no overwrite from backups.
- Prefer rolling code back to a previously reviewed compatible immutable
  release while keeping the same isolated user and current state paths.
  A pre-journal worker cannot be pointed at the new format without the existing
  guarded store-to-state merge and drain checks. The old in-place deploy helper
  now refuses immutable isolated releases.
- If a source/configuration or custody conflict remains, leave quotes halted
  and request review. Do not interpret a missing receipt, zero local jobs, or
  an unavailable RPC as proof that funds/custody are clear.

## Verification commands

`node --test tools/vault-kit/*.test.mjs tools/launch-ops/*.test.mjs`

`bash tools/launch-ops/tests/run-tests.sh` uses deterministic loopback RPC
fixtures. Run it with Node 22.23.4 and jq. It sends no real transactions.
`npm audit` and `npm audit --omit=dev` belong in `tools/vault-kit` using its
committed lockfile. Live verification is separately captured by
`tests/capture-worker-baseline.mjs` and `tests/capture-market-baseline.mjs`;
fixture success is not deployment evidence.
