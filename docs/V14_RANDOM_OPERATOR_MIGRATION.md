# V14 independent RoomPod operator migration

This change removes `PROVISIONING_OPERATOR_SEED` from new rental quotes. The
worker now creates a cryptographically random key for each accepted RoomPod,
stores it in its mode-0600 state file while the rental is active, uploads that
one key to Kamibots, and deletes the local key after the Kami is returned.

## Required rollout order

1. Back up `WORKER_STATE_FILE` to encrypted, access-controlled storage. The
   state file contains active RoomPod operator keys and Kamibots credentials.
2. Generate a fresh 32-byte-or-longer `OPERATOR_RESERVATION_TOKEN`. Configure
   the same value on the worker and Kamistats without committing it.
3. Configure the worker's `OPERATOR_RESERVATION_HOST` and
   `OPERATOR_RESERVATION_PORT` (defaults: `127.0.0.1:8789`). Publish only
   `/v1/operator-reservations` through the existing authenticated HTTPS reverse
   proxy; do not expose the raw worker port publicly.
4. For the first upgraded worker start only, set
   `LEGACY_PROVISIONING_OPERATOR_SEED` to the former
   `PROVISIONING_OPERATOR_SEED`. The worker converts each active legacy job to
   an explicit per-job key in its protected state file.
5. Start the worker first. Verify that an authenticated reservation request is
   accepted and an unauthenticated request returns 401.
6. Configure Kamistats with the HTTPS `OPERATOR_RESERVATION_URL` and the shared
   `OPERATOR_RESERVATION_TOKEN`, then deploy the web application. Remove
   `PROVISIONING_OPERATOR_SEED` from the web environment.
7. After all migrated legacy jobs have returned, remove
   `LEGACY_PROVISIONING_OPERATOR_SEED` from the worker environment.

The quote API receives only the public operator address. The raw private key
never enters the browser, the Kamistats process, the quote, or the chain. A
missing reservation fails closed and prevents an unsafe or unrecoverable lease
quote from being issued.
