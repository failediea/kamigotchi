// Watch the market's game account for an incoming kami (via KamiSend).
// Uses the Kamibots indexer (by-owner = the market CONTRACT address) because on-chain
// reverse lookup of IDOwnsKami reverts on live Yominet. Prints arrivals, then keeps going.
import { readFileSync, existsSync } from "node:fs";

const envPath = new URL("./.env", import.meta.url).pathname;
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  }
}
const MARKET = process.env.MARKET_ADDRESS;
const KAMIBOTS = process.env.KAMIBOTS_API || "https://api.kamibots.xyz";
const creds = JSON.parse(
  readFileSync(new URL("./kamibots-credentials.json", import.meta.url).pathname, "utf8")
);

console.log(`watching market ${MARKET} for incoming kamis (kamibots by-owner)…`);
const seen = new Set();
for (;;) {
  try {
    const res = await fetch(`${KAMIBOTS}/api/accounts/by-owner/${MARKET}/kamis`, {
      headers: { "X-Agent-Key": creds.apiKey },
    });
    if (res.ok) {
      const { kamis = [] } = await res.json();
      for (const k of kamis) {
        if (!seen.has(k.index)) {
          seen.add(k.index);
          console.log(`KAMI ARRIVED: tokenIndex=${k.index} state=${k.state} name=${k.name}`);
        }
      }
    }
  } catch {
    // transient — keep watching
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
