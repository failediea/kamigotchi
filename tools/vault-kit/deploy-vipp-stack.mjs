#!/usr/bin/env node
// Historical shared-pod deployment entry point. Kept only to fail safely.
console.error("RETIRED: this helper targets the obsolete shared-pod architecture.");
console.error("No environment was loaded, key generated, or transaction sent.");
console.error("Use DEPLOY-V17-HANDOFF.md and a reviewed, simulated version-specific deployment.");
process.exitCode = 2;
