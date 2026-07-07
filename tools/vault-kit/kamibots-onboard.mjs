#!/usr/bin/env node
/**
 * Kamibots onboarding for a KamiVault — THE GO/NO-GO TEST.
 *
 * Answers empirically: does Kamibots accept an operator key whose game account is
 * OWNED BY A CONTRACT (the vault)? Registration is an EIP-191 wallet signature; a
 * 403 "ownership validation failed" path exists in their API — this script tells us
 * whether it bites.
 *
 * ⚠️  Use a THROWAWAY registration wallet. NEVER run this against the production
 *     80-slot Kamibots registration or its operator key.
 *
 * Env (put in tools/vault-kit/.env or export):
 *   REG_PRIVATE_KEY       throwaway wallet that registers with Kamibots
 *   OPERATOR_PRIVATE_KEY  the vault's operator EOA key (as passed to DeployKamiVault)
 *   KAMIBOTS_API          default https://api.kamibots.xyz
 *
 * Usage:
 *   node kamibots-onboard.mjs register           # register + upload operator key + tier
 *   node kamibots-onboard.mjs tier               # check tier/slots
 *   node kamibots-onboard.mjs start <kamiId> <nodeId>   # start harvestAndRest
 *   node kamibots-onboard.mjs status <kamiId>    # strategy status
 *   node kamibots-onboard.mjs stop <kamiId>      # stop strategy
 *
 * Credentials (apiKey shown ONCE by their API) are persisted to ./kamibots-credentials.json.
 */
import { Wallet } from "ethers";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = process.env.KAMIBOTS_API || "https://api.kamibots.xyz";
const CREDS_FILE = new URL("./kamibots-credentials.json", import.meta.url).pathname;

function loadCreds() {
  if (!existsSync(CREDS_FILE)) return null;
  return JSON.parse(readFileSync(CREDS_FILE, "utf8"));
}

async function api(path, { method = "GET", body, apiKey } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { "X-Agent-Key": apiKey } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  if (!res.ok) {
    // the interesting failure mode: 403 ownership validation on contract-owned accounts
    throw new Error(`${method} ${path} -> ${res.status}: ${text}`);
  }
  return json;
}

async function register() {
  const regKey = process.env.REG_PRIVATE_KEY;
  const opKey = process.env.OPERATOR_PRIVATE_KEY;
  if (!regKey || !opKey) throw new Error("set REG_PRIVATE_KEY and OPERATOR_PRIVATE_KEY");

  const regWallet = new Wallet(regKey);
  const opWallet = new Wallet(opKey);
  console.log(`registration wallet: ${regWallet.address}`);
  console.log(`operator wallet:     ${opWallet.address}`);

  // Step 1: EIP-191 signed registration (timestamp must be within ±5min of server)
  const timestamp = Math.floor(Date.now() / 1000);
  const message = `Register for Kamibots: ${timestamp}`;
  const signature = await regWallet.signMessage(message);

  const reg = await api("/api/agent/register", {
    method: "POST",
    body: {
      walletAddress: regWallet.address,
      signature,
      message,
      label: "vault-go-no-go",
    },
  });
  console.log("registered:", { privyId: reg.privyId, isNewUser: reg.isNewUser });

  const creds = {
    apiKey: reg.apiKey,
    privyId: reg.privyId,
    regAddress: regWallet.address,
    operatorAddress: opWallet.address,
  };
  writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
  console.log(`credentials saved -> ${CREDS_FILE} (apiKey is shown ONCE by their API)`);

  // Step 2: upload the operator key — THE moment of truth for contract-owned accounts
  try {
    await api("/api/agent/operator-key", {
      method: "POST",
      apiKey: creds.apiKey,
      body: { operatorKey: opKey },
    });
    console.log("✅ operator key accepted");
  } catch (e) {
    console.error("❌ operator key REJECTED — likely the ownership-validation path:");
    console.error(e.message);
    console.error("=> GO/NO-GO RESULT: NO-GO for contract-owned accounts (see fallback in design doc)");
    process.exit(1);
  }

  // Step 3: tier check
  const tier = await api("/api/agent/tier", { apiKey: creds.apiKey });
  console.log("tier:", tier);
  console.log("\n=> next: node kamibots-onboard.mjs start <kamiId> <nodeId>");
}

async function tier() {
  const creds = loadCreds();
  console.log(await api("/api/agent/tier", { apiKey: creds.apiKey }));
}

async function start(kamiId, nodeId) {
  const creds = loadCreds();
  // harvestAndRest: simplest strategy; available on FREE tier
  const res = await api("/api/strategies/start", {
    method: "POST",
    apiKey: creds.apiKey,
    body: {
      strategyType: "harvestAndRest",
      kamiId: Number(kamiId),
      nodeId: Number(nodeId),
      config: {
        farmInterval: 1800,
        restInterval: 1800,
        initialCooldown: 60,
        useHpBasedRest: true,
        hpThresholdLow: 30,
        hpThresholdHigh: 80,
      },
      keyData: { privy_id: creds.privyId },
    },
  });
  console.log("✅ strategy started:", res);
  console.log("=> GO/NO-GO RESULT: GO — Kamibots drives a contract-owned account");
}

async function status(kamiId) {
  const creds = loadCreds();
  console.log(await api(`/api/strategies/status/${kamiId}`, { apiKey: creds.apiKey }));
}

async function stop(kamiId) {
  const creds = loadCreds();
  console.log(
    await api(`/api/strategies/kami/${kamiId}`, {
      method: "DELETE",
      apiKey: creds.apiKey,
      body: { keyData: { privy_id: creds.privyId } },
    })
  );
}

const [cmd, a, b] = process.argv.slice(2);
const commands = { register, tier, start, status, stop };
if (!commands[cmd]) {
  console.log("usage: node kamibots-onboard.mjs <register|tier|start|status|stop> [args]");
  process.exit(1);
}
commands[cmd](a, b).catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
