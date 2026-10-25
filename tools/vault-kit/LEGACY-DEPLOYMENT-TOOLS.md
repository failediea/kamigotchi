# Retired shared-pod deployment helpers

The October 25, 2026 review retired these entry points:

- `add-pod.sh`
- `diag-pod-deploy.sh`
- `deploy-vipp-stack.mjs`
- `provision-pool.mjs`

They targeted the historical shared-pod architecture, broadcast by default,
disabled simulation, and passed private keys in command arguments. The diagnostic
script even generated an operator key without durably preserving it before its
deployment. These are not valid shortcuts for the current renter-funded release.

They now exit with code 2 before reading configuration or taking any action,
including when given `--apply`. There is deliberately no override. The old source
is preserved in Git history; do not restore it into a live operations directory.

Use `DEPLOY-V17-HANDOFF.md` with a reviewed source commit, exact compiler profile,
successful production-size checks, and a fresh chain simulation. That historical
handoff's addresses, sizes and funding numbers must be refreshed after source
changes. Do not broadcast while the current RPC/custody gates are unavailable.

Regression: `node --test legacy-deploy-disabled.test.mjs`.
