#!/usr/bin/env node
// Waits for the deployer to be funded, then executes the v12 conductor.
// Detached-safe: logs to migration-v12-autorun.log, writes a completion marker.
import { readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { JsonRpcProvider, Wallet } from "ethers";

const here = dirname(fileURLToPath(import.meta.url));
const LOG = join(here, "migration-v12-autorun.log");
const MARKER = join(here, "migration-v12-autorun.done");
const REQUIRED = 100_000_000_000_000n;
const POLL_MS = 20_000;
const MAX_POLLS = 720; // 4 hours

const env = {};
for (const raw of readFileSync(join(here, ".env"), "utf8").split(/\r?\n/)) {
  const at = raw.indexOf("=");
  if (at > 0) env[raw.slice(0, at).trim()] = raw.slice(at + 1).trim();
}
const provider = new JsonRpcProvider(env.YOMINET_RPC);
const deployer = new Wallet(env.DEPLOYER_KEY, provider);
const say = (m) => {
  const line = `${new Date().toISOString()} ${m}\n`;
  appendFileSync(LOG, line);
  console.log(line.trim());
};

say(`watching deployer ${deployer.address} for >= ${REQUIRED} wei…`);
let funded = false;
for (let i = 0; i < MAX_POLLS; i++) {
  try {
    const bal = await provider.getBalance(deployer.address);
    if (bal >= REQUIRED) {
      say(`funded: ${bal} wei — executing the v12 conductor`);
      funded = true;
      break;
    }
    if (i % 15 === 0) say(`still waiting (balance ${bal} wei)`);
  } catch (e) {
    say(`balance check failed: ${String(e).slice(0, 120)}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}

if (!funded) {
  say("timed out after 4h without funding — run conductor-v12.mjs --execute manually");
  writeFileSync(MARKER, JSON.stringify({ ok: false, reason: "funding timeout", at: new Date().toISOString() }));
  process.exit(1);
}

const result = spawnSync(process.execPath, [join(here, "conductor-v12.mjs"), "--execute"], {
  cwd: here,
  encoding: "utf8",
  env: process.env,
});
appendFileSync(LOG, result.stdout || "");
appendFileSync(LOG, result.stderr || "");
const ok = result.status === 0;
say(ok ? "✅ v12 conductor completed" : `❌ v12 conductor FAILED (${result.status}) — configs were rolled back to v11 by the conductor`);
writeFileSync(MARKER, JSON.stringify({ ok, status: result.status, at: new Date().toISOString() }));
process.exit(ok ? 0 : 2);
