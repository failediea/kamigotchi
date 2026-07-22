#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const git = ["--git-dir", join(repo, ".git"), "--work-tree", repo];
const names = execFileSync("git", [...git, "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"], {
  encoding: "utf8",
}).split("\0").filter(Boolean);

const blockedName = /(?:^|\/)(?:pods\.json|[^/]*(?:credentials?|secrets?|worker-state)[^/]*\.json|[^/]*\.(?:pem|key))$/i;
const sensitiveAssignment = /"(?:privateKey|operatorKey|apiKey|mnemonic|seed|secret|reservationToken|accessToken|authToken)"\s*:\s*"[^"\s]+"/i;
const envAssignment = /^\s*(?:export\s+)?(?:[A-Z0-9_]*(?:PRIVATE_KEY|MNEMONIC|OPERATOR_SEED|RESERVATION_TOKEN|API_KEY)[A-Z0-9_]*)\s*=\s*(.+?)\s*$/gim;
const rawPrivateKey = /(?:private|operator|deployer|signer)[_-]?key[^\r\n]{0,40}0x[0-9a-f]{64}/i;

const violations = [];
for (const name of names) {
  if (blockedName.test(name) || (/deployment/i.test(name) && /\.json$/i.test(name) && !/\.public\.json$/i.test(name))) {
    violations.push(`${name}: secret-bearing filename`);
    continue;
  }
  let content;
  try {
    content = execFileSync("git", [...git, "show", `:${name}`], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    continue;
  }
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

console.log(`Secret scan passed (${names.length} staged files).`);
