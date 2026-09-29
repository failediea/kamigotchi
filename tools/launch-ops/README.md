# Kami Lease Market v16: launch-ops runbook

Ops tooling for the gated soft launch of the v16 lease markets on Yominet
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
| `deploy-worker-patch.sh` + `deploy/remote-install-worker-code.sh` | operator machine (WSL) + VPS | installs a worker sha into both v16 dirs, one market at a time, with auto-rollback | checklist step 5 |
| `harden-ssh.sh` | VPS, **OWNER only** | key-only SSH, ufw, fail2ban | H6 / VPS-5 |
| `launch-ops.env.example` | VPS | every knob, with its default | |
| `tests/run-tests.sh` | anywhere | shimmed tests for alerts, gate, sponsor, keeper | |

## Step 0: put the tools on the VPS (OWNER approves)

`/root/kamigotchi` on the VPS is **not** a git checkout. Ship the committed tree from WSL
(never from a Windows `git archive`, which loses the executable bits and adds CRLF):

```bash
# from WSL, in the worktree or any clone that has this branch
git archive launch/ops-hardening tools/launch-ops \
  | ssh root@68.183.190.126 'tar -x -C /root/kamigotchi'   # -> /root/kamigotchi/tools/launch-ops
```

The scripts install from that directory. Nothing else is touched until you run one with `--apply`.

## Ordered runbook

Step numbers follow `LAUNCH-GO-NO-GO.md` section 4.

### 1. OWNER: decide the policy
Set the renter allowlist, the lease caps and the other policy values in the worker `.env` knobs
(`RENTER_ALLOWLIST`, `MAX_ACTIVE_LEASES=20`, `MAX_RESERVATIONS_PER_RENTER=2`, and so on). They
are delivered with the worker patch. Also decide who pays for revives, and whether to accept
`TERMINAL_GAS_RETURN_MODE=skip`. Nothing in this directory changes these settings.

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
Run this from WSL. It reads the git repo, and the VPS side is piped over ssh.

```bash
cd /home/matrix/wt-launch-ops/tools/launch-ops
./deploy-worker-patch.sh --ref <worker sha>             # dry run: file plan per market, dependency drift, gate
./deploy-worker-patch.sh --ref <worker sha> --apply     # stage -> tests on the box -> musu -> vipp
```

With `--apply`, the script:
- **Stages and tests.** It runs `node --test *.test.mjs` on the box in `/root/launch-ops-staging/worker-<ts>`. If
  the tests fail, nothing live changes.
- **Deploys one market at a time.** The order is **musu first** (0 jobs), then vipp. For each market it:
  - re-runs the gate;
  - backs up the whole directory;
  - copies **code files only** (`renter-pod-*.mjs`, `kamibots-rental-config*.mjs`, `*.env.example`);
  - restarts the unit;
  - verifies for 120 s.
- **Verify criteria.** The unit must be active and port 8791/8792 bound. `heartbeat.json` must have
  `ts >= restart` and be at most 120 s old. There must be no `[LEASE-ALERT]` line and no automatic restart.
- **Auto-rollback.** On a verify failure, that market's code is restored and restarted, and the next market is not touched.
- **Files it never touches:** `.env*`, the worker state, `*.reservations.json`, `heartbeat.json`, `HALT`, `node_modules`.
- **Dependencies.** It refuses if `tools/vault-kit/package.json` dependencies differ from the VPS
  copy, because there is no `npm install` on the box.
- `TERMINAL_GAS_RETURN_MODE` / `TERMINAL_GAS_PULL_MODE` live in `.env`, so they are unchanged
  (currently return=skip, pull unset = check-only).

Rollback: `./deploy-worker-patch.sh --rollback <ts> [--markets "vipp"]`
- It restores the code files from `/root/launch-ops-backups/worker-<ts>/` and restarts. A heartbeat
  is not required, because older code does not write one.
- **It refuses while live reservations sit in `renter-pod-worker-state.reservations.json`,**
  because the pre-patch worker cannot read that file. Stop new quotes first with
  `touch <market dir>/HALT` (the patched worker then answers 503), wait `RESERVATION_TTL_SEC`
  (1200 s), then retry.

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
| C1 | Any listing on the market is in a transition stage on chain, or is leased and ending, even if the worker has not ingested it yet. |
| C2 | A leased listing has no live worker job. |
| R1 | A reservation bound to a signed quote (`attestedDigest`) is younger than `GATE_INFLIGHT_SEC` (1800 s): a renter may be submitting the create tx. The gate checks the state file and `*reservations*.json`. |
| T1 | The worker's `pendingTxs` holds a transaction still in flight. |

Steady ACTIVE leases are allowed: a restart pauses reconciliation for about 30 s while Kamibots keeps farming.
`GATE_ALLOW_ACTIVE=0` makes the gate refuse those too. If a chain or state read fails, the result
is **UNDECIDED** (exit 1), and the deploy treats that as a refusal.

### 6. Ops hardening: drop-ins, alerts v2, H7 timers  [the OWNER approves each VPS change]

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

The old script file stays in place. **Rollback:** `./install-launch-ops.sh --rollback /root/launch-ops-backups/ops-<ts>`.
It restores the baseline unit, which runs the old script again.

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
  (5) calls per run, each waited at most `TX_WAIT_TIMEOUT_MS`.

**Gas sponsor** (every 15 min):
- **Candidates:** only non-returned worker jobs that pass all of these:
  - the on-chain pod matches the job;
  - the stage is in `SPONSOR_STAGES` (default `3`, ACTIVE);
  - the operator is a plain EOA;
  - the operator's balance is below `EXIT_RESERVE_ACTIONS × OPERATOR_ACTION_GAS_FLOOR × gasPrice` (3 × 1.7M × 2.5 Mwei = 1.275e13 wei).
- **Top-up amount:** up to `SPONSOR_TARGET_GAS_UNITS × gasPrice` (3e13 wei).
- **Caps:**
  - `SPONSOR_MAX_PER_LEASE_WEI` 1e14, cumulative per market, token and pod;
  - `SPONSOR_MAX_PER_DAY_WEI` 3e14, over a rolling 24 h;
  - `SPONSOR_WALLET_FLOOR_WEI` 2e14, a hard floor;
  - `SPONSOR_MAX_TX_PER_RUN` 3.
- **Ledger:** every transfer is recorded in `/var/lib/kami-lease-ops/sponsor-ledger.tsv`.

**Both timers:**
- They share one `flock`, so they never race on the sponsor nonce.
- Any condition that needs a human is logged as a `[LEASE-ALERT]` line, which alerts v2 picks up from their journals.

**Rollback** (on-chain there is nothing to undo): run `systemctl disable --now kami-lease-expiry-keeper.timer kami-lease-gas-sponsor.timer`,
or run `./install-launch-ops.sh --rollback <dir>`.

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

Each condition gets one ntfy push per `COOLDOWN_SECS` (3600, same as the baseline). The state dir
is the same as before (`/run/kami-worker-alerts`); run counters and the last-run stamp are in `/var/lib/kami-lease-ops`.

| Check | Fires when | Code in the push |
|---|---|---|
| Units | caddy, `kami-worker-alerts.timer`, the v15 and v16 workers are not `active` | UNIT_DOWN |
| OnFailure hook | alerts, keeper, sponsor, caddy or a v16 worker enters `failed` | UNIT_FAILED |
| Worker `[LEASE-ALERT]` lines | any line since the last run (journald cursor), one push per code | the worker's code (WORKER_STALL … STAGE_STUCK) |
| Ops-timer `[LEASE-ALERT]` lines | same, for the expiry keeper and sponsor journals | STAGE_STUCK / ESCROW_LOW / TX_TIMEOUT |
| Error rate (baseline) | at least `ERR_THRESHOLD` (20) error-keyword lines since the last run | text |
| Legacy wedge text | `lease ending paused`, `walk expected room`, `pod stopped in room`, `no longer farmable`, operator key missing/mismatch, `operator gas health failed`, `second active RoomPod event`, `DEAD` | text |
| Heartbeat | `heartbeat.json` `ts` older than `HEARTBEAT_STALE_SEC` (180). If the file is absent, the state-file mtime is used instead. | WORKER_STALL |
| Tick failures | `lastTickOk=false` on `TICK_FAIL_RUNS` (2) consecutive checks | WORKER_STALL |
| Job error | a non-returned job keeps `error` set on `JOB_ERROR_RUNS` (2) consecutive checks | STAGE_STUCK |
| Stage age | PREPARING for more than 6 h; ACTIVE more than 1 h past `leaseEnd` and not ending; ending past the 2-day grace (`recoveryReady`) | STAGE_STUCK |
| Operator gas | a job's operator balance plus pullable escrow is below the exit reserve (stages 3-5) | ESCROW_LOW |
| Keeper | balance below `KEEPER_MIN_WEI` | KEEPER_LOW |
| VIPP float | `feeFloatClaimsLeft()` below `FEE_FLOAT_MIN_CLAIMS` | FEE_FLOAT_LOW |
| Backing | `backingShortfall()` above 0 on either v16 market | BACKING_SHORTFALL |
| RPC | chain reads fail on 2 consecutive checks | RPC_UNREACHABLE |
| Ingress | a lease host answers something other than 404 | INGRESS_DOWN |
| TLS | the certificate expires in less than `TLS_MIN_DAYS` (14) | TLS_EXPIRY |
| Host | `/` more than 85 % used; `MemAvailable` below 100 MB | HOST_DISK / HOST_MEMORY |
| Self | the previous successful run is more than 30 min old | ALERTS_GAP |
| jq missing | worker-state checks cannot run | ALERTS_DEGRADED |

Every push body starts with `[LEASE-ALERT] <CODE>`. The codes beyond the shared worker contract
are ops-side only. Anything that greps for the prefix sees them all.

## Tests

```bash
bash tools/launch-ops/tests/run-tests.sh                                        # local; jq-dependent state tests SKIP without jq
LAUNCH_OPS_TEST_REMOTE=root@68.183.190.126 bash tools/launch-ops/tests/run-tests.sh   # state tests over ssh, read-only
```
- **What is shimmed:** `systemctl`, `journalctl` and ntfy.
- **What is real:** chain reads use the public RPC, with read-only calls only.
- **The remote mode** pipes each script to `bash -s` and passes the fixture in the
  `LAUNCH_OPS_TEST_STATE_JSON` env var. It writes no file on the VPS and signs nothing.
  That variable is a test hook only; never set it in production.

## Known limits
- **Big numbers are capped.** On-chain values above about 1.15e18 read as 1.15e18. Scripts
  only compare them against thresholds, so a sponsor wallet above about 1.15 ETH still passes the floor check.
- **The gas sponsor only sees jobs the worker has ingested.** An ACTIVE lease the worker has not
  ingested yet is covered by gate rule C2 and by the `STAGE_STUCK` alerts instead.
- **Terminal-stage wedges are opt-in.** Set `SPONSOR_STAGES="3 4 5"` if you want the sponsor to
  also fund stages 4-5 (terminal wedges, MP-5).
- **No off-box probe.** An external uptime probe and DigitalOcean backups are OWNER actions (VPS-3, VPS-4).
- **Backups hold secrets.** The worker backup dirs contain copies of `.env` and the state files.
  They are mode 700 under `/root/launch-ops-backups`. Prune them once a deploy is stable (VPS-12).
