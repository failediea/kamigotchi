#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const repo = process.env.SECRET_SCAN_REPO || dirname(dirname(fileURLToPath(import.meta.url)));
// A linked worktree has a .git FILE. Let Git resolve its own index/object store.
const git = ["-C", repo];
let base;
if (args.length) {
  if (args.length !== 2 || args[0] !== "--base" || args[1].startsWith("-")) {
    throw new Error("Usage: check-staged-secrets.mjs [--base <revision>]");
  }
  base = execFileSync("git", [...git, "rev-parse", "--verify", `${args[1]}^{commit}`], {
    encoding: "utf8",
  }).trim();
}
const range = base ? [`${base}...HEAD`] : ["--cached"];
const names = execFileSync("git", [...git, "diff", ...range, "--name-only", "--diff-filter=ACMR", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

// Includes the renter-pod worker's operator key store: the snapshot
// (<state>.reservations.json) and its append-only journal
// (<state>.reservations.journal, plus .tmp leftovers of either).
const blockedName = /(?:^|\/)(?:pods\.json|[^/]*(?:credentials?|secrets?|worker-state)[^/]*\.json|[^/]*\.(?:pem|key)|[^/]*\.reservations\.(?:json|journal)(?:\.tmp)?|[^/]*\.journal(?:\.tmp)?)$/i;
const sensitiveAssignment = /"(?:privateKey|operatorKey|apiKey|mnemonic|seed|secret|reservationToken|accessToken|authToken)"\s*:\s*"[^"\s]+"/i;
const envAssignment = /^\s*(?:export\s+)?(?:[A-Z0-9_]*(?:PRIVATE_KEY|MNEMONIC|OPERATOR_SEED|RESERVATION_TOKEN|API_KEY)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/gim;
const rawPrivateKey = /(?:private|operator|deployer|signer)[_-]?key[^\r\n]{0,40}0x[0-9a-f]{64}/i;

const violations = [];
for (const name of names) {
  if (blockedName.test(name) || (/deployment/i.test(name) && /\.json$/i.test(name) && !/\.public\.json$/i.test(name))) {
    violations.push(`${name}: secret-bearing filename`);
    continue;
  }
  // Fail closed on unreadable/oversized content; silently skipping it would
  // let a failed scan masquerade as a clean release.
  const content = execFileSync("git", [...git, "show", base ? `HEAD:${name}` : `:${name}`], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  let liveEnvValue = false;
  for (const match of content.matchAll(envAssignment)) {
    const value = match[1].replace(/^['"]|['"]$/g, "").trim();
    if (value && !/^(?:<[^>]+>|replace|change-?me|example|\$\{)/i.test(value)) {
      liveEnvValue = true;
      break;
    }
  }
  if (sensitiveAssignment.test(content) || rawPrivateKey.test(content) || liveEnvValue) {
    violations.push(`${name}: credential-like value`);
  }
}

if (violations.length) {
  console.error("Commit blocked: possible custody credentials are staged.");
  for (const violation of violations) console.error(`- ${violation}`);
  console.error("Move secrets out of the repository; do not bypass this check.");
  process.exit(1);
}

console.log(`Secret scan passed (${names.length} ${base ? "release" : "staged"} files).`);
