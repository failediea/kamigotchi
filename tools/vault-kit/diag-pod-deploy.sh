#!/usr/bin/env bash
# Historical shared-pod deployment entry point. Kept only to fail safely.
set -euo pipefail
printf '%s\n' 'RETIRED: this helper targets the obsolete shared-pod architecture.' 'No environment was loaded, key generated, or transaction sent.' 'Use DEPLOY-V17-HANDOFF.md and a reviewed, simulated version-specific deployment.' >&2
exit 2
