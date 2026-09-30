# Kami Lease Market v16: launch-ops runbook

Ops tooling for the open public launch of the v16 lease markets on Yominet
(MUSU `0x1FeF5Ce51f9d3BACD0C3f707eEeBbD7A44d69319`, VIPP `0x4A34d4847D8E2958E4017353e71fAB7afb85bD23`),
running on the VPS `root@68.183.190.126`. It follows the ordered checklist in
`LAUNCH-GO-NO-GO.md` section 4. **OWNER** marks steps only the owner can do
(signatures, funding, SSH access changes, approving a VPS change).

Nothing in this directory has been applied to the VPS. Every script:
- is bash with `set -euo pipefail`;
- does a **dry run by default** and changes nothing without `--apply`;
- prints what it will do, is idempotent (a second run changes nothing), makes
  timestamped backups under `/root/launch-ops-backups/`, and has a rollback (below);
- never prints private keys, `.env` values, tokens or the ntfy topic.

| File | Runs on | Purpose | Finding |
|---|---|---|---|
| `alerts/worker-alerts-v2.sh` | VPS (timer) | extended health alerts to ntfy | VPS-1/2/3/8, CHAIN-3/4, THR-06, H4 |
| `alerts/baseline/*` | reference | read-only copy of the live alert script + units (topic redacted to `NTFY_TOPIC`) | |
| `alerts/kami-worker-alerts.{service,timer}` | VPS | v2 unit (the timer is unchanged) | |
| `alerts/kami-lease-ops-onfailure@.service` | VPS | `OnFailure=` push for any watched unit | VPS-8 |
| `install-launch-ops.sh` | VPS | installs alerts v2, and optionally the keeper and sponsor timers | |
| `systemd/*.service.d/10-kami-launch.conf` + `install-dropins.sh` | VPS | Caddy restart, OOM protection, v16 unit descriptions | VPS-8, VPS-10, VPS-12 |
| `keeper/lease-expiry-keeper.sh` + unit/timer | VPS (timer) | permissionless `endLease` after `leaseEnd` | H7 / CON-01 |
| `keeper/lease-gas-sponsor.sh` + unit/timer | VPS (timer) | tops up ACTIVE lease operator EOAs below the exit reserve | H7 / CON-01 / H2 / MP-5 |
| `lease-transition-gate.sh` | VPS (read-only) | is any v16 lease mid-transition? | deploy safety |
| `cleanup-secret-backups.sh` | VPS, **OWNER** | shreds unused `.env.bak*` secret copies, removes world-write bits, prunes old deploy backups | VPS-12 |
| `deploy-worker-patch.sh` + `deploy/remote-install-worker-code.sh` | operator machine (WSL) + VPS | installs a worker sha into both v16 dirs, one market at a time, with auto-rollback | checklist step 5 |
| `harden-ssh.sh` | VPS, **OWNER only** | key-only SSH, ufw, fail2ban | H6 / VPS-5 |
| `launch-ops.env.example` | VPS | every knob, with its default | |
| `tests/run-tests.sh` + `tests/fake-rpc.mjs` | anywhere | shimmed tests for every script here (fake chain on 127.0.0.1) | |

## Step 0: put the tools on the VPS (OWNER approves)

`/root/kamigotchi` on the VPS is **not** a git checkout. Ship the committed tree from WSL
(never from a Windows checkout, which adds CRLF). Every script is committed as `100755`, so
`git archive` ships it executable; `install-launch-ops.sh` enforces the mode anyway, and the
ops units run their script as `/bin/bash <script>`, so a lost exec bit cannot stop them:

```bash
# from WSL, in the worktree or any clone that has this branch
git archive launch/ops-hardening tools/launch-ops \
  | ssh root@68.183.190.126 'tar -x -C /root/kamigotchi'   # -> /root/kamigotchi/tools/launch-ops
```

The scripts install from that directory. Nothing else is touched until you run one with `--apply`.

## Ordered runbook

Step numbers follow `LAUNCH-GO-NO-GO.md` section 4.

### 1. OWNER: write the launch policy into both worker `.env` files
The launch is **open**: any wallet can rent, with no allowlist. Rentals cannot be cheaply jammed,
because **quotes hold no capacity** (worker `2f3080d43`):
- **No quote-held locks.** A quote (reserve + keeper attest) reserves nothing a throwaway wallet
  could occupy. There are no reservation caps, per-listing locks, cooldowns or attempt counters.
  Two renters racing for one Kami are settled on chain: the second checkout reverts, and the web
  simulates it first and shows "this Kami was just rented".
- **Caps count on-chain leases only.** `MAX_ACTIVE_LEASES` (default 20) and
  `MAX_ACTIVE_LEASES_PER_RENTER` (default 2) count unreturned jobs plus pods parked in
  `ingestRetry`, distinct per Kami. At the cap, reserve and attest answer 429 (`LEASE_CAP` scope
  `market`, `RESERVATION_CAP` scope `renter`). Concurrent honest checkouts may overshoot the cap.
- **Filters, not capacity:** the web's renter signature, freshness and replay checks, pricing, the
  balance check and the per-IP and per-renter limiters, plus the worker's balance check
  (`REQUIRE_RENTER_BALANCE`, on by default).
- **Keys:** every quote still gets its own independently random operator key (V14-01). The key is
  fsync'd to the quote key store before the operator address or keeper signature is returned (see
  "Quote key store" below).
- **Allowlist:** `RENTER_ALLOWLIST` is an optional capability and is off by default. Leave it unset.

**Deploy guard.** `deploy-worker-patch.sh` refuses (dry run and `--apply`, exit 8 on the box) a
`.env` that has no `RENTER_ALLOWLIST` unless open rentals are acknowledged. Either
`ALLOW_OPEN_RENTALS=true` is already in that `.env`, or you run the deploy with
`ALLOW_OPEN_RENTALS=true`, and the install then appends that line itself. The worker reads the
same line and logs `open rentals: ALLOW_OPEN_RENTALS is set and RENTER_ALLOWLIST is empty (public
launch)`. Without it, the worker prints a loud "RENTER_ALLOWLIST is NOT SET" banner.

The worker patch does **not** carry these values; they live in `.env`. On the VPS, for `m` in `musu vipp`:
```bash
cd /root/kamigotchi/tools/vault-kit-v16-$m && cp -p .env .env.bak-$(date -u +%Y%m%dT%H%M%SZ)
cat >> .env <<'EOF'
ALLOW_OPEN_RENTALS=true
MAX_ACTIVE_LEASES=20
MAX_ACTIVE_LEASES_PER_RENTER=2
RESERVATION_TTL_SEC=1200
EOF
```
- Write the lines **unquoted**, with no spaces around `=`. The worker loader is last-line-wins, and so is the guard.
- **Retired knobs are ignored.** `MAX_LIVE_RESERVATIONS`, `MAX_RESERVATIONS_PER_RENTER`,
  `MAX_RESERVATIONS_PER_LISTING`, `LISTING_SINGLE_CHECKOUT`, `LISTING_RESERVE_COOLDOWN_SEC` and
  `MAX_RESERVATION_ATTEMPTS_PER_RENTER` do nothing. The guard and the worker log them as
  `ignored retired settings`; delete them when convenient.
- **Every set worker knob must parse exactly as the worker parses it.** The guard mirrors
  `hardeningConfigFromEnv`: strict integers, minimums and ranges, on/off switches, and
  `OPERATOR_TX_PRICING`. It also checks that `RESERVATION_TTL_SEC` is at least 900 (the quote
  deadline) and that `TICK_WATCHDOG_SEC` is above `TX_WAIT_TIMEOUT_MS`. The install then runs the
  **staged** worker's own parser over the `.env` and refuses on any `CONFIG_ERROR`, naming the key
  but never the value. A malformed knob therefore never reaches the restart, where it would hold
  the worker and roll the deploy back.
- `REQUIRE_RENTER_BALANCE=off` is allowed but warned about.
- **Other `.env` writes.** The install appends `MAX_ACTIVE_LEASES_PER_RENTER=2` when that line
  is absent. Together with `ALLOW_OPEN_RENTALS=true`, these are the only `.env` writes a deploy
  makes (atomic, mode and owner kept).
- Keep `TERMINAL_GAS_RETURN_MODE=skip`. Leave `OPERATOR_TX_PRICING` unset (eip1559): the ops
  sponsor and alerts price gas the same way (see "Gas pricing" below).
- The running pre-hardening worker ignores these keys; they take effect at the deploy restart.
- Also decide who pays for revives.
- **Optional allowlist.** If you set `RENTER_ALLOWLIST`, use the identical list for Vercel
  `LEASE_RENTER_ALLOWLIST`. It is comma separated, and every entry must be `0x` + 40 hex. With
  `ALLOW_OPEN_RENTALS=true` also set, the guard warns that the allowlist wins.

### 2. OWNER: harden SSH, then do a controlled reboot  [H6, VPS-5, VPS-7]
Do this while no v16 lease is active. First check with `lease-transition-gate.sh`, which must print `GATE: SAFE`.

```bash
# on the VPS, from a KEY-BASED session. Keep that session open the whole time.
cd /root/kamigotchi/tools/launch-ops
./harden-ssh.sh                  # dry run: current sshd -T values, key count, how you logged in, plan
./harden-ssh.sh --apply          # backup -> drop-in 01-kami-hardening.conf -> sshd -t -> reload -> ufw -> fail2ban
```

- **The drop-in must be named `01-kami-...`.** `50-cloud-init.conf` on this box sets
  `PasswordAuthentication yes`, and sshd keeps the first value it reads.
- **The script refuses to run** if `authorized_keys` has no valid key or your current session
  was not a public-key login.
- **ufw refuses** while other public listeners exist, unless you pass `--allow-block-other-ports`.
- **To stage the change,** pass `--skip-ufw` or `--skip-fail2ban`.

The script prints the exact verification commands. Then test from a **second** terminal:
- a key login must succeed;
- `ssh -o PreferredAuthentications=password -o PubkeyAuthentication=no root@68.183.190.126` must be denied.

Rollback (from the open session, or from the DigitalOcean recovery console):
`./harden-ssh.sh --rollback /root/launch-ops-backups/ssh-<ts>`

Controlled reboot (VPS-7): run `reboot`. Afterwards, run `./alerts/worker-alerts-v2.sh --dry-run`. It must print
`0 condition(s) firing`, both lease hosts `http=404`, and no unit DOWN.

### 3/5. Worker patch deploy  [B2, H1-H5; the OWNER approves the deploy]
**Before it:** step 1 (`.env` open-rental acknowledgement + knobs) and `./install-dropins.sh --apply`
from step 6 (OOMScoreAdjust=-500 for both workers and caddy), so an OOM during the deploy window
kills something other than a worker.

Run this from WSL. It reads the git repo, and the VPS side is piped over ssh.

```bash
cd /home/matrix/wt-launch-ops/tools/launch-ops
ALLOW_OPEN_RENTALS=true ./deploy-worker-patch.sh --ref <worker sha>           # dry run: file plan, dependency drift, launch guards, gate, test location
ALLOW_OPEN_RENTALS=true ./deploy-worker-patch.sh --ref <worker sha> --apply   # guards -> gate -> tests -> stage -> musu -> vipp
```

With `--apply`, the script:
- **Checks the launch guards** in each market `.env` (read-only; it prints counts, knob numbers
  and key names, never values). Open rentals must be acknowledged (step 1), every worker knob that
  is set must parse, and retired knobs are listed. It logs
  `launch guards [m]: rentals=open openAck=env|deploy knobs: ... perRenterCap=... retired=...`.
  The install re-checks everything, including the staged worker's own config parser, before
  touching anything (exit 8).
- **Tests the staged tree, never unguarded next to the live workers** (`--tests auto|box|local`,
  default `auto`). `code/` (the files that get installed) and `full/` (the whole `tools/vault-kit`
  tree of the ref, so tests that read `test-fixtures/` work) must agree byte for byte.
  - `box`: runs on the VPS as `nice -n 19 ionice -c 3 node --test --test-concurrency=1`, and
    refuses (exit 9) while `MemAvailable` < `TEST_MIN_MEM_MB` (300). The suite peaks at ~135 MB RSS.
  - `local`: runs off-box in WSL with the local vault-kit `node_modules`; the local `ethers`
    version must equal the VPS one (`--allow-dep-change` overrides).
  - `auto`: `box` when the VPS has 300 MB available, else `local` (the box had 153-197 MB on
    2026-09-29, so today this means `local`).
  If the tests fail, nothing live changes. Then `code/` + `full/` go to `/root/launch-ops-staging/worker-<ts>`.
- **Skips markets that already run the ref.** A market whose file plan has no NEW/CHANGED runtime
  file (test files and `*.env.example` alone do not count) is not restarted, so a re-run is a no-op.
- **Deploys one market at a time.** The order is **musu first** (0 jobs), then vipp. For each market it:
  - re-runs the gate;
  - backs up the **code files** plus `state-snapshot/`: the state file and the quote key store's
    snapshot **and journal**, all mode 600 because they hold operator keys. `.env` is not copied;
  - copies **code files only** (`renter-pod-*.mjs`, `kamibots-rental-config*.mjs`, `*.env.example`);
  - creates `HALT` (only if absent; `VERIFY_HALT=0` disables): the patched worker answers 503 to
    new quotes, so no quote is signed while the install can still roll back;
  - restarts the unit and verifies for 120 s, then removes the `HALT` it created.
- **Verify criteria.** The unit must be active and port 8791/8792 bound. `heartbeat.json` must have
  `ts >= restart` and be at most 120 s old. There must be no `[LEASE-ALERT]` line and no automatic restart.
- **Auto-rollback** (exit 4). On a verify failure it does these steps in order:
  1. Stops the unit. On `SIGTERM` the patched worker compacts its quote key store.
  2. Waits up to `ROLLBACK_PENDING_WAIT_SEC` (300) until every `state.pendingTxs` entry is mined
     or dropped. The old worker has no tx tracker and would re-send it.
  3. Prunes those resolved entries and `txNonceHints` from the state file. The old worker saves
     them verbatim, and gate T1 would otherwise refuse every later deploy.
  4. Compacts the quote key store with the worker's own CLI
     (`node renter-pod-quote-store.mjs compact`, worker stopped). This covers a worker that was
     killed before it could compact.
  5. Applies the **drain rule** (see "Quote key store and rollbacks"). The patched code is
     started again under `HALT` (exit 10) if a quote it signed can still become a pod.
  6. Merges every store entry back into the state file's `reservations`, which is all the old
     worker reads, and renames **both** store files to `*.rolled-back-<ts>`.
  7. Restores the code and starts the unit.

  If a tx is still in flight (exit 5), or the store cannot be read or the merge conflicts
  (exit 6), the **patched** code is started again with `HALT` kept and a human decides. The next
  market is never touched.
- **Files it never touches:** `.env.*` backups, `heartbeat.json`, `node_modules`. `.env` only gets
  the `MAX_ACTIVE_LEASES_PER_RENTER=2` and `ALLOW_OPEN_RENTALS=true` lines, each only when absent.
  The state file is only rewritten by a rollback (pendingTxs prune and reservation merge; atomic,
  same mode). The store is only rewritten by the worker's own compaction during a rollback.
  `HALT` is only touched when the deploy created it.
- **RPC.** The pendingTxs checks (mined / dropped) go through the market `.env` `YOMINET_RPC`,
  the node the worker itself sends through (the URL is never printed), else the public RPC. A tx
  that only a private node has seen is therefore not mistaken for dropped.
- **Dependencies.** It refuses if `tools/vault-kit/package.json` dependencies differ from the VPS
  copy, because there is no `npm install` on the box.
- `TERMINAL_GAS_RETURN_MODE` / `TERMINAL_GAS_PULL_MODE` live in `.env`, so they are unchanged
  (currently return=skip, pull unset = check-only).
- **Deploy the web right after the workers.** The patched worker rejects the current production
  web's reserve call (it sends no `renter`), so between the worker deploy and the Vercel deploy
  every quote returns 503. That fails closed; keep the window short, or `touch <market dir>/HALT`
  until the web is live.
- **A pre-existing `[LEASE-ALERT]`** (for example a transient `INGEST_ERROR`) inside the 120 s
  verify makes it roll back (exit 4). That is fail-safe; if the tail shows only a transient
  INGEST_ERROR, re-run `--apply`.

Rollback: `./deploy-worker-patch.sh --rollback <ts> --drain [--markets "vipp"] [--force]`
- **`--drain` (HALT + drain), for a pre-change target.** A pre-change target is one whose backup
  has no `renter-pod-quote-store.mjs`, such as the pre-hardening worker that runs today. The
  script creates `HALT` (marked `.HALT.launch-ops`), so the patched worker answers 503 to reserve
  and attest and signs nothing new. It keeps ingesting and pruning. The script then waits, up to
  `ROLLBACK_DRAIN_WAIT_SEC` (1500) and polling every 30 s, until no signed quote in the store can
  still become a pod: every `quoteDeadline` plus `ROLLBACK_DRAIN_MARGIN_SEC` (120) is past. That
  takes at most `RESERVATION_TTL_SEC` + 60 s + margin. If the wait runs out, re-run the same command.
- **It runs the transition gate** with `--for-rollback` for each market, and refuses unless the gate
  prints SAFE. R1-store refuses while signed quotes are live, unless the target reads the store.
- **It refuses while the patched worker has a tx in flight** (`state.pendingTxs`), without stopping anything.
- **It refuses (exit 10) without stopping anything** while a quote the current worker signed can
  still become a pod and the target does not read the store. The message says to use `--drain`.
- Otherwise it does what the auto-rollback does: stop, wait for pendingTxs, compact the store,
  re-check the drain rule, merge the store into the state file and move both store files aside,
  restore the code files from `/root/launch-ops-backups/worker-<ts>/`, and start. A heartbeat is
  not required, because older code does not write one. Once the rollback verifies, it removes a
  `HALT` that the drain created. A `HALT` that you created yourself is never removed.
- `--force` skips the gate verdict and the pendingTxs wait; the store merge still runs. Use it only
  when you accept a possible duplicate tx. **`--force` never skips the drain rule.** Waiting at
  most about 23 minutes always works, even when the patched worker is crash-looping, because
  quote deadlines pass on their own.

#### Quote key store and rollbacks
From worker `2f3080d43`, every quote's random operator key is appended to
`<state>.reservations.journal` (JSON lines) and fsync'd **before** the operator address or keeper
signature is returned. The journal is compacted into `<state>.reservations.json`
(`{version:1, generation, reservations}`) in three cases: when it outgrows the snapshot, at
startup, and on `SIGTERM`. Both files are mode 600. Keys are pruned only after the quote deadline
has passed in chain time, and never while the nonce is parked in `ingestRetry`. Nothing counts,
caps or evicts the store (see `tools/vault-kit/OPERATOR-KEY-CUSTODY.md`).

- **Forward restarts are safe with quotes in flight.** This covers the same or newer code, whose
  dir has `renter-pod-quote-store.mjs`: the restarted worker reloads every key. Gate R1-store
  therefore *reports* in-flight quotes and does not refuse. On an open market some quotes are
  always in flight.
- **Rolling back to a pre-change worker is not safe while quotes are live.** That worker reads keys
  only from the state file and never reads the journal. A renter who submits a quote signed by the
  patched worker would get a pod whose operator key the old worker does not have: the event parks,
  and the Kami is stuck until recovery.

  The rule is **HALT + drain, then roll back** (`--drain`). While a signed quote that is **not**
  in the backup's pre-install state snapshot still has `quoteDeadline` + margin ahead, both the
  manual and the automatic rollback refuse with exit 10. Quotes the old worker signed itself
  before the install do not block. The install's verify-window `HALT` means the patched worker
  signs nothing during the auto-rollback window, so the auto-rollback completes. With
  `VERIFY_HALT=0` it can be blocked (exit 10, `HALT` created).

  After the drain, the remaining entries are merged into the state file anyway: unsigned keys and
  expired quotes, which are harmless. Both store files are then renamed `*.rolled-back-<ts>`. They
  still hold keys (mode 600), so delete them once every lease they cover has returned.
- **Rolling back to a target that has `renter-pod-quote-store.mjs`** does not need a drain. The
  compacted store is left in place and the target reloads it.
- **Crash between persist and sign.** A key journaled whose answer never went out is simply
  pruned later, and nothing in ops depends on it. Gate R1-store and the rollback read the store
  exactly as the worker does (`readQuoteStore`): a torn last line is ignored, a journal older than
  its snapshot is ignored, and a journal ahead of or without its snapshot is merged, so no key or
  keeper binding is lost. The tests compare the gate's jq replay with the worker's own
  `readQuoteStore` on the same fixtures.

Note: the live `renter-pod-recovery.mjs` and `renter-pod-worker.env.example` differ from git only
in line endings (the live copies are CRLF). The dry run labels them `eol-only`.

#### Mid-transition rule (enforced by `lease-transition-gate.sh`)
A market may be restarted only when every lease it knows about is fully returned, or in steady
ACTIVE farming far from expiry. The gate **refuses** (exit 3) if any of these holds:

| Rule | Condition |
|---|---|
| J1 | A non-returned worker job has factory stage 1 REQUESTED, 2 PREPARING, 4 CANCEL_REQUESTED, 5 FINALIZED or 6/7 RECOVERY_*. Stage 0 also counts: the request is cleared, but the worker has not finished the custody return. |
| J2 | A non-returned job is ACTIVE, but its listing is `ending`, or `leaseEnd` is less than `GATE_EXPIRY_MARGIN_SEC` (1800 s) away or already past. |
| J3 | A job's on-chain pod differs from the worker's pod. |
| J4 | `state.retiredJobs` holds a superseded pod whose kami is not returned yet. The pre-hardening worker never reads `retiredJobs`, so a rollback would orphan that kami. |
| J5 | `state.ingestRetry` holds a parked `RenterPodCreated` event. The cursor is already past it and the pre-hardening worker never replays it. |
| C1 | Any listing on the market is in a transition stage on chain, or is leased and ending, even if the worker has not ingested it yet. |
| C2 | A leased listing has no live worker job. |
| R1-legacy | A reservation in the **state file** is bound to a signed quote (`attestedDigest`) and can still become a create tx. That means its `quoteDeadline` is in the future, or (with no deadline) it is younger than `GATE_INFLIGHT_SEC` (default `RESERVATION_TTL_SEC` + 900 = 2100 s). This is the pre-hardening worker, which may not have made the key durable. |
| R1-store | The same test over the **quote key store**: `*reservations*.json` plus `*reservations*.journal` (and `RESERVATION_STATE_FILE`), replayed like `readQuoteStore`. It **refuses** with `--for-rollback` (unless `--target-reads-store`) and when the running code has no `renter-pod-quote-store.mjs`. For a forward restart of store-aware code it only **reports** the count, because the keys are durable and reload. A store it cannot parse is UNDECIDED. |
| T1 | The worker's `pendingTxs` holds a transaction still in flight. Each hash is resolved over the worker's RPC first: mined or unknown to the node (dropped) does not count; unreadable does. |

Steady ACTIVE leases are allowed: a restart pauses reconciliation for about 30 s while Kamibots keeps farming.
`GATE_ALLOW_ACTIVE=0` makes the gate refuse those too. If a chain or state read fails, the result
is **UNDECIDED** (exit 1), and the deploy treats that as a refusal. The gate reads the chain
through the market `.env` `YOMINET_RPC` when present (never printed), else the public RPC.

### 6. Ops hardening: drop-ins, alerts v2, H7 timers  [the OWNER approves each VPS change]

Run `install-dropins.sh` **before** the worker deploy (3/5): it gives the workers OOM protection
for the deploy window. The rest of this step comes after the deploy.

```bash
cd /root/kamigotchi/tools/launch-ops
./install-dropins.sh             # dry run: current Restart/RestartUSec/OOMScoreAdjust/Description + planned files
./install-dropins.sh --apply     # backup -> write -> daemon-reload -> live oom_score_adj -> verify. NO restarts.
```

- **Caddy** gets `Restart=on-failure`, `RestartSec=5` and `OOMScoreAdjust=-500`. It currently has `Restart=no`.
- **Both v16 workers** get `OOMScoreAdjust=-500`, and their `Description` changes from v15 to v16.
  They already have `Restart=always RestartSec=10`, which the installer re-checks and only adds if missing.
- **Applying OOMScoreAdjust.** It takes effect at the next process start, so `--apply` also sets
  `/proc/<MainPID>/oom_score_adj` live. `--no-live-oom` skips that.
- **Rollback:** `./install-dropins.sh --rollback /root/launch-ops-backups/dropins-<ts>`

```bash
./install-launch-ops.sh --component alerts            # dry run
./install-launch-ops.sh --component alerts --apply
./alerts/worker-alerts-v2.sh --self-test --apply      # exactly one test push to the phone
```

What `--component alerts` installs:
- `worker-alerts-v2.sh`, the v2 `kami-worker-alerts.service` and the OnFailure template;
- `20-kami-onfailure.conf` drop-ins for caddy and both v16 workers;
- `/etc/kami-lease-ops/launch-ops.env` (mode 600). The `NTFY_TOPIC` value is migrated from the
  live `tools/alerts/worker-alerts.sh` and is not printed.

**Checks after `--apply`** (any failure exits non-zero and prints the rollback command):
- every installed script is executable. A file whose content is unchanged but whose mode is wrong
  is chmod-ed (`CHMOD` in the plan) and recorded in the manifest, so SRC == DEST installs work;
- each installed script's `--dry-run` exits 0;
- **alerts:** `kami-worker-alerts.service` is started once through systemd and must end with
  `Result=success`. This is exactly the timer's run, so it may push conditions that are firing now.
  The keeper and sponsor services are never started by the installer (their `--apply` sends txs).

The old script file stays in place. **Rollback:** `./install-launch-ops.sh --rollback /root/launch-ops-backups/ops-<ts>`.
It restores the baseline unit, which runs the old script again (and restores any file mode it changed).

Fire-test the alerts once (checklist step 10). This sends a real WORKER_STALL push without
touching the production cooldown state:
```bash
HEARTBEAT_STALE_SEC=1 COOLDOWN_SECS=0 ALERT_STATE_DIR=/tmp/kla-test ALERT_PERSIST_DIR=/tmp/kla-test \
  ./alerts/worker-alerts-v2.sh --apply; rm -rf /tmp/kla-test
```
Once both v16 workers run the patched code, set `HEARTBEAT_MISSING_MODE=alert` in the env file.
Until then, a missing `heartbeat.json` falls back to the state-file mtime, which the current
worker rewrites every tick.

**OWNER: create the sponsor wallet**, then install the H7 timers.
- **Use a NEW dedicated EOA.** Never reuse the keeper `0x0d02…bcDc`: the keeper's nonce is
  already shared by four workers (THR-08).
- **Fund it:** at least `SPONSOR_WALLET_FLOOR_WEI` (2e14) plus the planned budget, for example 0.001 ETH.
- **Write the key file** as one line, `0x…`, owned by root, mode 600.
- **Set these in `/etc/kami-lease-ops/launch-ops.env`:**
  - `SPONSOR_KEY_FILE=/root/.kami-lease-sponsor.key`
  - `SPONSOR_ADDRESS=0x…` (the address of that key; the signer refuses a key that does not match)

```bash
./keeper/lease-expiry-keeper.sh      # dry run: leased listings, overdue seconds, endLease candidates
./keeper/lease-gas-sponsor.sh        # dry run: per-lease operator balance vs exit reserve, planned top-ups
./install-launch-ops.sh --component keeper --component sponsor --apply   # add --no-enable to stage only
```

**Expiry keeper** (every 10 min):
- **Candidates:** leases with `renter != 0`, not ending, and `now > leaseEnd + EXPIRY_GRACE_SEC` (600 s).
  The grace lets the worker's own `endLease` go first.
- **Sending:** each call is simulated with `eth_call` before it is sent. At most `EXPIRY_MAX_TX_PER_RUN`
  (5) calls per run, each waited at most `TX_WAIT_TIMEOUT_MS`. A broadcast that is not confirmed in
  time stops the run; the next run resolves it first.

**Gas sponsor** (every 15 min):
- **Candidates:** only non-returned worker jobs that pass all of these:
  - the stage is in `SPONSOR_STAGES` (default `0 3 4 5`: ACTIVE, the terminal stages 4-5 where
    v16 `pullGas` reverts, and stage 0 where the custody return is operator-signed with `allowPull=false`);
  - stages 3-5: the on-chain request pod matches the job. Stage 0 (request cleared): the token is
    listed on this market and the listing is not re-leased (`renter == 0`); otherwise the job is stale;
  - the operator is a plain EOA;
  - the operator's balance (plus escrow at stage 3, the only stage where the worker can pull it)
    is below the worker's exit-reserve **stop trigger** (see "Gas pricing": 3.74e13 wei today).
- **Top-up amount:** up to `max(SPONSOR_TARGET_GAS_UNITS × feePerGas, resume level)` (6e13 wei
  today), so a sponsor-funded lease clears the worker's resume level (5.61e13) and farms again.
- **Caps:**
  - `SPONSOR_MAX_PER_LEASE_WEI` 1e14, cumulative per market, token and pod;
  - `SPONSOR_MAX_PER_DAY_WEI` 3e14, over a rolling 24 h;
  - `SPONSOR_WALLET_FLOOR_WEI` 2e14, a hard floor;
  - `SPONSOR_MAX_TX_PER_RUN` 3.
- **Ledger, reserve-then-confirm:** `/var/lib/kami-lease-ops/sponsor-ledger.tsv`. The signer signs
  the tx locally, appends the `sent` row (hash of the signed tx, nonce) and only **then**
  broadcasts; if the append fails it does not broadcast at all. A broadcast whose RPC reply is lost
  (the signer's RPC calls time out after 20 s), a receipt timeout, or a run killed by systemd
  therefore still counts toward both caps; a row whose tx never reached the node resolves as
  `dropped` and stays counted (conservative). Any failed send stops the run.

**Gas pricing (sponsor, alerts; same as the worker).** Yominet bills an EIP-1559 tx at its
`maxFeePerGas`, not at the gas price, and the worker default is `OPERATOR_TX_PRICING=eip1559`.
Everything that budgets operator gas therefore prices exactly like the worker's
`renter-pod-safety.mjs` (the test suite checks the numbers against the worker's own `exitReservePlan`):

| Quantity | Formula | Live (gasPrice 2.5 Mwei, baseFee 2.5 Mwei, priority 0) |
|---|---|---|
| feePerGas | `max(2 × baseFee + eth_maxPriorityFeePerGas, gasPrice)` (`legacy`: gasPrice) | 5 Mwei |
| action | feePerGas × (`OPERATOR_ACTION_GAS_FLOOR` 1.7M + 10 % unused-gas charge) | 9.35e12 wei |
| reserve | `EXIT_RESERVE_ACTIONS` (3) × action (alerts ESCROW_LOW threshold) | 2.805e13 wei |
| trigger | reserve + 1 action (worker stops the strategy below it; sponsor tops up below it) | 3.74e13 wei |
| resume | trigger + `EXIT_RESUME_HEADROOM_ACTIONS` (2) × action | 5.61e13 wei |

If the worker `.env` ever sets `OPERATOR_TX_PRICING=legacy`, set the same value in
`/etc/kami-lease-ops/launch-ops.env`. The earlier stopgap (`OPERATOR_ACTION_GAS_FLOOR=3740000`,
`SPONSOR_TARGET_GAS_UNITS=24000000`) is **not** needed and must not be set: it would now double-count.

**Both timers:**
- They share one `flock`, so they never race on the sponsor nonce. A run that finds the lock
  taken logs the skip and exits 0 (no OnFailure push); the next timer run retries.
- **In-flight guard.** Before sending, `--apply` resolves every ledger row that has no result yet
  (receipt: mined/reverted; unknown to the node: dropped) and compares the sponsor's `pending` and
  `latest` nonce. While any sponsor tx is still in flight it sends nothing and logs
  `[LEASE-ALERT] TX_TIMEOUT source=sponsor|expiry-keeper inflight=N`.
- Any condition that needs a human is logged as a `[LEASE-ALERT]` line, which alerts v2 picks up from their journals.

**Rollback** (on-chain there is nothing to undo): run `systemctl disable --now kami-lease-expiry-keeper.timer kami-lease-gas-sponsor.timer`,
or run `./install-launch-ops.sh --rollback <dir>`.

**OWNER: clean up secret copies (VPS-12).** Read the dry run first; a shred cannot be undone.
```bash
./cleanup-secret-backups.sh                       # dry run: names, modes, sizes and derived ADDRESSES only
./cleanup-secret-backups.sh --apply               # shred PROVEN-redundant .env.*bak* files, drop group/world write, *.bak* -> 600
./cleanup-secret-backups.sh --prune-days 14 --apply   # also delete worker deploy backups/staging older than 14 days
```
- **Nothing unproven is shredded.** A `.env` backup is shredded only when no unit file references
  it **and** every `*PRIVATE_KEY*` in it (compared by derived address, node + ethers) and every
  `*SEED*` / `*MNEMONIC*` value is also in a live `.env` on the box (`tools/*/.env`). Otherwise it is
  **report-only**: kept, with its derived addresses printed. Copy it off-box, then re-run with
  `--confirm-offbox-copy`. The same rule protects `.env` copies inside old deploy backups on
  `--prune-days`. Without node/ethers nothing can be proven, so nothing is shredded.
- The live `.env` is never touched. Only addresses are ever printed, never keys or file contents.
- Today (read-only dry run, 2026-09-29): vipp's `.env.bak-stackA` holds one key, address
  `0x5f6F…dFc1`, which is the `OPERATOR_PRIVATE_KEY` of the live `tools/vault-kit/.env`. It is
  therefore proven redundant and would be shredded; it is **not** the v16 keeper `0x0d02…bcDc`.
  The dry run also fixes the mode of the 777 `renter-pod-worker.mjs*` files.

### 7. OWNER: fund and set up
- **Keeper** `0x0d0294C57B01ED7189b8A9ba354cf77b935abcDc`: top up to about 0.002 ETH. The alert fires below `KEEPER_MIN_WEI` (4e14).
- **VIPP hub float:** top up to at least 1,000-3,000 MUSU. The alert fires when `feeFloatClaimsLeft() < 20`; it is 38 today.
- **Sponsor wallet:** see step 6.
- **Off-box monitoring:** set up an uptime probe for `https://lease-musu.kamistats.com/` and `https://lease-vipp.kamistats.com/`
  (expect 404 JSON), and turn on DigitalOcean backups. Alerts v2 runs on the box it watches, so it
  cannot report the box itself being down. The `ALERTS_GAP` check only catches a gap after the fact.

### 8-10. Smoke loops and the go/no-go re-check
The OWNER runs the MUSU and VIPP smoke loops (B1). While a loop runs, the assistant runs, read-only:
```bash
ssh root@68.183.190.126 'bash -s -- --dry-run' < alerts/worker-alerts-v2.sh
ssh root@68.183.190.126 'bash -s -- --dry-run' < keeper/lease-gas-sponsor.sh
ssh root@68.183.190.126 'bash -s -- --dry-run' < keeper/lease-expiry-keeper.sh
ssh root@68.183.190.126 'bash -s --'            < lease-transition-gate.sh
```
The go/no-go re-check requires all of these:
- `backingShortfall=0` on both markets (printed by the alerts dry run);
- the alerts have been fire-tested once (step 6);
- the sponsor and keeper dry runs are clean after each loop.

## What alerts v2 checks

Each condition gets one ntfy push per `COOLDOWN_SECS` (3600, same as the baseline). For the
per-lease codes (DEAD_KAMI, ESCROW_LOW, EXIT_RESERVE_STOP, STAGE_STUCK, TX_TIMEOUT, OPERATOR_MISMATCH) the condition
is keyed per (unit, code, `token=`), so a second lease's DEAD_KAMI inside the first one's cooldown
is pushed too. The state dir is the same as before (`/run/kami-worker-alerts`); run counters and
the last-run stamp are in `/var/lib/kami-lease-ops`. A malformed numeric knob in the env file
(for example a quoted number) stops the run with a message naming the knob.

| Check | Fires when | Code in the push |
|---|---|---|
| Units | caddy, `kami-worker-alerts.timer`, the v15 and v16 workers are not `active` | UNIT_DOWN |
| OnFailure hook | alerts, keeper, sponsor, caddy or a v16 worker enters `failed` | UNIT_FAILED |
| Worker `[LEASE-ALERT]` lines | any line since the last run (journald cursor), one push per code (per token for per-lease codes) | the worker's code (WORKER_STALL … STAGE_STUCK, CONFIG_ERROR, OPERATOR_MISMATCH) |
| Quote key store write | the worker logged `operator key store write failed`: that quote was answered 503 and nothing was signed | KEY_STORE_UNAVAILABLE |
| Quote key store maintenance | `quote key store compaction failed` / `delete failed` (the journal still holds every key, but it grows) | QUOTE_STORE_COMPACT |
| Quote key store size | snapshot + journal above `QUOTE_STORE_MAX_MB` (32), or heartbeat `liveReservations` above `QUOTE_STORE_MAX_LIVE` (15000) | QUOTE_STORE_SIZE |
| Quote key store disk | free space where the store lives below `QUOTE_STORE_MIN_FREE_MB` (256): a failed fsync'd append makes every quote 503 | QUOTE_STORE_DISK |
| Key-file mode | the store snapshot, journal or state file is readable by group or others (they hold operator keys) | QUOTE_STORE_MODE |
| Ops-timer `[LEASE-ALERT]` lines | same, for the expiry keeper and sponsor journals | STAGE_STUCK / ESCROW_LOW / TX_TIMEOUT |
| Error rate (baseline) | at least `ERR_THRESHOLD` (20) error-keyword lines since the last run | text |
| Legacy wedge text | `lease ending paused`, `walk expected room`, `pod stopped in room`, `no longer farmable`, operator key missing/mismatch, `operator gas health failed`, `second active RoomPod event`, `DEAD` | text |
| Heartbeat | `heartbeat.json` `ts` older than `HEARTBEAT_STALE_SEC` (180). If the file is absent, the state-file mtime is used instead. | WORKER_STALL |
| Tick failures | `lastTickOk=false` on `TICK_FAIL_RUNS` (2) consecutive checks | WORKER_STALL |
| Job error | a non-returned job keeps `error` set on `JOB_ERROR_RUNS` (2) consecutive checks | STAGE_STUCK |
| Stage age | PREPARING for more than 6 h; ACTIVE more than 1 h past `leaseEnd` and not ending; ending past the 2-day grace (`recoveryReady`) | STAGE_STUCK |
| Operator gas | a job's operator balance plus pullable escrow is below the worker's exit reserve, priced at the billed fee (see "Gas pricing"; 2.805e13 wei today) (stages 3-5, and stage 0 while the token is listed and not re-leased; only stage 3 counts escrow as pullable) | ESCROW_LOW |
| Keeper | balance below `KEEPER_MIN_WEI` | KEEPER_LOW |
| VIPP float | `feeFloatClaimsLeft()` below `FEE_FLOAT_MIN_CLAIMS` | FEE_FLOAT_LOW |
| Backing | `backingShortfall()` above 0 on either v16 market | BACKING_SHORTFALL |
| RPC | chain reads fail on 2 consecutive checks | RPC_UNREACHABLE |
| Ingress | a lease host answers something other than 404 | INGRESS_DOWN |
| TLS | the certificate expires in less than `TLS_MIN_DAYS` (14) | TLS_EXPIRY |
| Host | `/` more than 85 % used; `MemAvailable` below 100 MB | HOST_DISK / HOST_MEMORY |
| Self | the previous successful run is more than 30 min old | ALERTS_GAP |
| jq and node missing | worker-state checks cannot run (node is the fallback when jq is absent) | ALERTS_DEGRADED |

### Alert codes
Every push body, and every ops-script line that needs a human, starts with `[LEASE-ALERT] <CODE>`
followed by `key=value` details (`source=` names the ops script). Anything that greps for the prefix sees them all.
- **Shared worker contract:** WORKER_STALL, INGEST_ERROR, DEAD_KAMI, ESCROW_LOW, EXIT_RESERVE_STOP,
  RESERVATION_CAP, LEASE_CAP, STRATEGY_RESTART_STORM, TX_TIMEOUT, STAGE_STUCK, CONFIG_ERROR and
  OPERATOR_MISMATCH.
  - **OPERATOR_MISMATCH** (`token= nonce= reason=missing|mismatch`): ingest found an on-chain
    pod whose operator is not the key stored for its quote nonce. The event is parked and retried
    every tick. To fix it, restore the right store files (from `state-snapshot/`, or a
    `*.rolled-back-*` pair after a rollback) and restart; the worker adopts the pod.
  - The ops scripts reuse ESCROW_LOW (sponsor caps, low sponsor or operator balance), TX_TIMEOUT
    (keeper or sponsor tx in flight or unconfirmed, blocked deploy rollback) and STAGE_STUCK
    (expired leases, stage age, rollback blocked by the store or the drain rule).
- **Ops-only codes** (host, chain and key-store health, not emitted by the worker): UNIT_DOWN,
  UNIT_FAILED, KEEPER_LOW, FEE_FLOAT_LOW, BACKING_SHORTFALL, RPC_UNREACHABLE, INGRESS_DOWN,
  TLS_EXPIRY, HOST_DISK, HOST_MEMORY, ALERTS_GAP, ALERTS_DEGRADED, KEY_STORE_UNAVAILABLE,
  QUOTE_STORE_COMPACT, QUOTE_STORE_SIZE, QUOTE_STORE_DISK, QUOTE_STORE_MODE.

### Quote key store sizing (1 vCPU / 1 GB VPS)
Worst case: the web's per-IP limit (12 quotes/min) allows 50 IPs × 12/min for 1 h, which is
36,000 quotes. The worker lane measured this burst (`OPERATOR-KEY-CUSTODY.md` section 7). The
first two columns are measured in WSL2, **not on the VPS**. The on-box command is
`node bench-quote-store-burst.mjs`, which writes only to a temp dir.

| | measured | VPS estimate | alert at |
|---|---|---|---|
| live keys at the peak | 9,200 (worker bound < 13,000) | same | `QUOTE_STORE_MAX_LIVE` 15,000 |
| snapshot + journal | 3.9 MB + 7.7 MB | < 15 MB on disk at any moment; ~39 MB written per hour | `QUOTE_STORE_MAX_MB` 32 |
| CPU | 0.80 ms per checkout (0.8% of a core at 10/s) | a few % of the one core | |
| fsync per append | p50 4.7 ms, p99 33 ms | disk-bound; it delays other requests by ms and never refuses them | KEY_STORE_UNAVAILABLE on failure |
| memory | heap 46 MB / RSS 127 MB (bench process) | about +50 MB over the idle worker | HOST_MEMORY (100 MB available) |
| drain after the burst | ~16 min to 0 | same | |

The box had ~14.8 GB free on `/` (read-only check, 2026-09-29), so disk use is negligible.
Memory is the tight resource: the box had 153-197 MB available. That is why the vault-kit test
suite runs off-box (`--tests auto` → `local`).

## Tests

```bash
bash tools/launch-ops/tests/run-tests.sh                                        # local; jq-dependent state tests SKIP without jq
LAUNCH_OPS_TEST_REMOTE=root@68.183.190.126 bash tools/launch-ops/tests/run-tests.sh   # state tests over ssh, read-only
```
- **What is shimmed:** `systemctl`, `journalctl`, `ss`, `id` (root only for the installer, the
  deploy VPS half and the cleanup) and ntfy.
- **What is real:** chain reads use the public RPC (read-only calls) or `tests/fake-rpc.mjs` on
  127.0.0.1 (a fake chain for stage-0, cap, pricing, in-flight and rollback cases). The in-flight
  keeper/sponsor `--apply` tests use a placeholder key file and a fake `ethers` dir, and assert
  that `eth_sendRawTransaction` / `eth_chainId` were never called.
- **Reserve-then-confirm tests** run the real signer (ethers) with the well-known test key 1
  against the fake chain (chain id 31337, never a real network). The fake answers every
  broadcast with an error, like a lost reply; the tests assert the ledger row exists, carries the
  hash of exactly the raw tx that was broadcast, counts toward the caps and blocks the next run,
  and that an unwritable ledger means no broadcast at all.
- **Pricing parity:** the sponsor's printed action/reserve/trigger/resume are compared with the
  worker ref's own `exitReservePlan` (from the staged tree).
- **Gate tests** (remote mode) cover J4/J5, the R1 quote lifetime and T1 hash resolution with a
  real mined Yominet tx hash read from the public RPC. They also cover R1-store for the forward,
  rollback and store-reading-target cases, plus these journal cases: no snapshot, put+del, torn
  tail, stale journal, journal ahead, and a broken line (UNDECIDED). The store fixtures travel in
  the `LAUNCH_OPS_TEST_STORE_JSON` / `LAUNCH_OPS_TEST_JOURNAL_TEXT` hooks, so they also run
  read-only over ssh.
- **Replay parity.** The gate's jq replay is compared with the worker's own `readQuoteStore`
  (from `LAUNCH_OPS_TEST_WORKER_REF`) on the same seven fixtures.
- **Launch guard parity.** The guard's verdict is compared with the worker's own
  `hardeningConfigFromEnv` on 26 `.env` vectors: TTL floor, watchdog vs tx wait, ranges, switches,
  pricing, retired knobs, allowlist edge cases. The install is also shown refusing on the staged
  parser's `CONFIG_ERROR` with the key named and the value never printed.
- **Quote key store rollback tests** use the worker's real `renter-pod-quote-store.mjs`. They cover:
  - refusal before anything stops while a new quote is live, and that `--force` does not bypass it;
  - drain timeout (`HALT` kept), drain success, and the drain margin;
  - a baseline quote (signed by the old worker) that does not block;
  - a killed worker whose keys are only in the journal: compacted by the CLI and merged into the
    state file with every key;
  - both store files moved aside with mode 600, and the drain `HALT` removed after the rollback;
  - a target that reads the store: left in place, no merge;
  - auto-rollback blocked (exit 10) when `VERIFY_HALT=0` and the patched worker signed a quote,
    and completing under the verify `HALT`.
- **Alerts tests** cover KEY_STORE_UNAVAILABLE, QUOTE_STORE_COMPACT/SIZE/DISK/MODE and
  per-token OPERATOR_MISMATCH.
- **Wording.** No script or doc here, and no script output, describes the launch as gated or as a beta (the test greps for those phrases).
- **The deploy staging test** builds the staging tree of `LAUNCH_OPS_TEST_WORKER_REF` (default
  `launch/worker-hardening`) with `deploy-worker-patch.sh --local-stage`. It runs that tree's
  vault-kit suite through the VPS half (`--action test`), plus a control run on the old code-only
  layout, which must fail.
- **The remote mode** pipes each script to `bash -s` and passes the fixture in the
  `LAUNCH_OPS_TEST_STATE_JSON` env var. It writes no file on the VPS and signs nothing.
  That variable is a test hook only; never set it in production.

## Known limits
- **Big numbers are capped.** On-chain values above about 1.15e18 read as 1.15e18. Scripts
  only compare them against thresholds, so a sponsor wallet above about 1.15 ETH still passes the floor check.
- **The gas sponsor only sees jobs the worker has ingested.** An ACTIVE lease the worker has not
  ingested yet is covered by gate rule C2 and by the `STAGE_STUCK` alerts instead.
- **Stage-0 sponsoring cannot see custody.** The sponsor cannot read where the kami sits (that
  needs world reads), so a stage-0 job whose worker action is WAIT/COMPLETE may still be funded
  once, bounded by the per-lease cap.
- **No off-box probe.** An external uptime probe and DigitalOcean backups are OWNER actions (VPS-3, VPS-4).
- **Backups hold secrets.** Worker deploy backups hold state snapshots and the quote key store
  (operator keys), mode 600 under a mode-700 `/root/launch-ops-backups`. `.env` is no longer
  copied. Prune them with `cleanup-secret-backups.sh --prune-days N --apply` once a deploy is
  stable (VPS-12). The `*.reservations.{json,journal}.rolled-back-<ts>` files that a rollback
  leaves in the market dir also hold keys. Delete them by hand once every lease they cover has
  returned; the cleanup script does not touch them.
- **The launch guard reads `.env` only.** A knob set in the unit's `Environment=` wins over
  `.env` in the worker, and the guard does not see it. A read-only check on 2026-09-29 found that
  the v16 units set only `NODE_ENV` and `PATH`. The same check found that they stop with
  `SIGTERM` and a 90 s timeout, which leaves ample time for the compaction on stop (under 100 ms
  in the worker lane's bench). If the compaction does not run, the rollback compacts the store
  itself.
- **Memory is the tight resource under a quote burst.** A full 50-IP burst adds about 50 MB per
  worker. The box had 153-197 MB available, and both workers can be hit at once. `HOST_MEMORY`
  alerts below 100 MB, and `OOMScoreAdjust=-500` (step 6) makes the kernel pick something other
  than a worker.
