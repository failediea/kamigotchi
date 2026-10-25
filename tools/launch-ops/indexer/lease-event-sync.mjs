#!/usr/bin/env node
import { constants, closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const EVENT_SYNC_URL = "https://kamistats.com/api/cron/sync-lease-events";

export function readToken(path) {
  if (!path) throw new Error("TOKEN_FILE_REQUIRED");
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || (stat.mode & 0o077)) throw new Error("TOKEN_FILE_UNSAFE");
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error("TOKEN_FILE_OWNER");
    const token = readFileSync(fd, "utf8").trim();
    if (!/^[A-Za-z0-9._~+\/-]{24,4096}={0,2}$/.test(token)) throw new Error("TOKEN_FORMAT");
    return token;
  } finally {
    closeSync(fd);
  }
}

export async function syncEvents({ token, fetchRequest = fetch }) {
  // Fixed HTTPS origin, no redirects, and credentials only in a header. Never
  // accept a caller-controlled URL or put the token in argv/process listings.
  const response = await fetchRequest(EVENT_SYNC_URL, {
    method: "GET", redirect: "error", cache: "no-store",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(280_000),
  });
  if (!response.ok) throw new Error(`HTTP_${response.status}`);
  const reader = response.body?.getReader();
  if (!reader) throw new Error("EMPTY_RESPONSE");
  let body = "";
  let bytes = 0;
  const decoder = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65_536) throw new Error("RESPONSE_TOO_LARGE");
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  let result;
  try { result = JSON.parse(body); } catch { throw new Error("INVALID_RESPONSE"); }
  if (result?.ok !== true || typeof result.caughtUp !== "boolean" ||
      ![result.hubs, result.scannedBlocks, result.inserted].every((v) => Number.isSafeInteger(v) && v >= 0)) {
    throw new Error("INVALID_RESPONSE");
  }
  // Whitelist output: API error bodies can contain database/RPC details.
  return { hubs: result.hubs, scannedBlocks: result.scannedBlocks, inserted: result.inserted, caughtUp: result.caughtUp };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length === 0 || (args.length === 1 && args[0] === "--dry-run")) {
    console.log(`DRY RUN: authenticated GET ${EVENT_SYNC_URL}; no request sent.`);
  } else if (args.length === 1 && args[0] === "--apply") {
    try {
      const tokenFile = process.env.CREDENTIALS_DIRECTORY
        ? join(process.env.CREDENTIALS_DIRECTORY, "event-sync-token")
        : process.env.EVENT_SYNC_TOKEN_FILE;
      const result = await syncEvents({ token: readToken(tokenFile) });
      console.log(JSON.stringify({ event: "LEASE_EVENT_SYNC", ...result }));
    } catch {
      console.error("[LEASE-ALERT] EVENT_SYNC_FAILED; check endpoint health, credential configuration, and indexer logs.");
      process.exitCode = 1;
    }
  } else {
    console.error("Usage: lease-event-sync.mjs [--dry-run|--apply]");
    process.exitCode = 2;
  }
}
