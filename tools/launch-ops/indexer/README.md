# Optional five-minute lease-history refresh

Prepared source, not an installed service. This does not run game transactions.
It calls the authenticated web event-indexing endpoint. Public history GETs no
longer run backfills; owner custody polling and indexed historical data have
separate refresh schedules.

Vercel Hobby allows only daily cron scheduling. The optional systemd timer runs
five minutes after the last sync exits, with at most 30 seconds of jitter. The
web database transaction/advisory lock prevents concurrent sync writers. A
backlog can require multiple runs; `caughtUp: false` does not mean corruption.

## Prerequisites

- Deploy the reviewed web version, including the cron-auth and transactional
  event-index changes, before enabling this timer.
- Restore healthy Yominet RPC access and verify an authenticated manual run.
- Install the verified, root-owned Node 22.23.4 runtime at
  `/opt/kami-lease/runtime/node-v22.23.4/bin/node` (the isolated-worker installer
  uses the same runtime path).
- Put `lease-event-sync.mjs` in `/opt/kami-lease-ops/indexer/`, owned by root and
  not group/world writable. Put these unit files in `/etc/systemd/system/`.
- Provision `/etc/kami-lease-ops/event-sync-token` as a root-owned mode-0600
  file containing the web deployment's `CRON_SECRET` or `KAMISTATS_API_KEY`.
  Do not put its value in shell arguments, commit it, or log it. The service
  receives a read-only copy through systemd `LoadCredential`.
- Install the existing `kami-lease-ops-onfailure@.service` alert integration.

The caller accepts only the fixed HTTPS endpoint on `kamistats.com`, never
follows redirects, times out after 280 seconds, and logs only whitelisted
numeric counters. It does not print the token or remote error bodies.

## Verify and enable

Run `node lease-event-sync.mjs` first: the default is a dry run with no network
request. For a manual authenticated run, set `EVENT_SYNC_TOKEN_FILE` to a private
file owned by the invoking user and pass `--apply`. Do not set
`CREDENTIALS_DIRECTORY` manually; systemd owns that service variable.

After installation, validate the units with `systemd-analyze verify`, reload
systemd, and run `systemctl start kami-lease-event-sync.service`. Check its exit
status and whitelisted journal counters. Enable the timer only after this run
succeeds. This rollout is blocked while the chain RPC is unhealthy.

Rollback is `systemctl disable --now kami-lease-event-sync.timer`; let any active
oneshot finish. The normal Vercel daily cron remains configured. No key store,
worker state, market pointer, or chain state is changed by this timer.

## Tests

`node --test tools/launch-ops/tests/lease-event-sync.test.mjs`

The tests inject a fake fetch, verify fixed-origin/redirect protection, reject
malformed or oversized responses, check private-file and symlink protections,
and prove the default CLI does not send a request. No live credentials or
production database are used.
