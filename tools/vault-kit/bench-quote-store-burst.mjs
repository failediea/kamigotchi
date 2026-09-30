#!/usr/bin/env node
/**
 * Quote-burst benchmark for the operator key store (NOT part of the test
 * suite; writes only to a fresh temp dir, never to a worker's files).
 *
 *   node bench-quote-store-burst.mjs [quotes=12000] [perSecond=10]
 *
 * Replays the web's worst case - 50 IPs at the per-IP quote limit (12/min),
 * i.e. 10 checkouts per second - through the REAL reservation handler and the
 * REAL quote store (append + fsync, compaction), on a simulated clock: each
 * checkout is reserve + attest with a 15-minute deadline, and a worker tick
 * every 30 s prunes keys whose deadline ingest has passed (20 s ingest lag).
 * 12,000 quotes = 20 simulated minutes, past the ~15.8-minute steady state.
 *
 * Prints CPU per checkout (the handler's own work: key generation, JSON,
 * writes; the web's RPC calls are stubbed), fsync'd append latency, peak live
 * keys, store bytes, compaction cost and memory, plus the projection at
 * `perSecond` on one vCPU. Run it on the target box to get its fsync numbers.
 */
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import { journalFileFor, openQuoteStore } from "./renter-pod-quote-store.mjs";
import { ATTEST_PATH, RESERVE_PATH, createReservationHandler } from "./renter-pod-reservation-server.mjs";
import { pruneReservations } from "./renter-pod-reservations.mjs";

const QUOTES = Number(process.argv[2] ?? 12_000);
const PER_SECOND = Number(process.argv[3] ?? 10);
const TOKEN = "b".repeat(40);
const MARKET = "0x00000000000000000000000000000000000000aa";
const FACTORY = "0x00000000000000000000000000000000000000bb";
const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const renter = (n) => `0x${n.toString(16).padStart(40, "0")}`;

async function invoke(handler, url, body) {
  const payload = Buffer.from(JSON.stringify({ market: MARKET, factory: FACTORY, ...body }));
  const response = {
    status: 0,
    body: null,
    headersSent: false,
    writeHead(status) {
      this.status = status;
      this.headersSent = true;
    },
    end(text) {
      this.body = JSON.parse(text);
    },
  };
  await handler(
    { method: "POST", url, headers: { authorization: `Bearer ${TOKEN}` }, async *[Symbol.asyncIterator]() { yield payload; } },
    response
  );
  return response;
}

const dir = mkdtempSync(join(tmpdir(), "quote-burst-bench-"));
const file = join(dir, "bench.reservations.json");
const state = { jobs: {}, reservations: {}, ingestRetry: {} };
const store = openQuoteStore({ file, getReservations: () => state.reservations });
state.reservations = store.load().reservations;
store.compact();
let clock = 1_790_000_000_000;
const syncMs = [];
const compactMs = [];
let appendedBytes = 0;
let snapshotBytesWritten = 0;
function compactIfDue() {
  const started = process.hrtime.bigint();
  const result = store.maybeCompact();
  if (!result) return;
  compactMs.push(Number(process.hrtime.bigint() - started) / 1e6);
  snapshotBytesWritten += result.snapshotBytes;
}
const handler = createReservationHandler({
  state,
  token: TOKEN,
  market: MARKET,
  factory: FACTORY,
  policy: hardeningConfigFromEnv({}),
  health: () => ({ ok: true }),
  quoteDigest: async () => `0x${"cd".repeat(32)}`,
  signDigest: () => "0xsig",
  persist: (nonces) => {
    const started = process.hrtime.bigint();
    const before = store.stats().journalBytes;
    store.sync(nonces);
    syncMs.push(Number(process.hrtime.bigint() - started) / 1e6);
    appendedBytes += store.stats().journalBytes - before;
    compactIfDue();
  },
  now: () => clock,
  log: () => {},
  renterBalance: async () => 10n ** 30n,
});

const cpuStart = process.cpuUsage();
const wallStart = process.hrtime.bigint();
let peakKeys = 0;
let peakSnapshot = 0;
let peakJournal = 0;
let peakRss = 0;
let peakHeap = 0;
const tickEvery = 30 * PER_SECOND;
for (let n = 1; n <= QUOTES; n++) {
  const who = renter(10_000 + (n % 2_000));
  const reserved = await invoke(handler, RESERVE_PATH, { nonce: nonce(n), renter: who, tokenIndex: n % 5_000, fundingWei: "6000" });
  if (reserved.status !== 201) throw new Error(`reserve ${n}: ${reserved.status} ${JSON.stringify(reserved.body)}`);
  const attested = await invoke(handler, ATTEST_PATH, {
    quote: {
      nonce: nonce(n),
      renter: who,
      operator: reserved.body.operator,
      tokenIndex: n % 5_000,
      deadline: String(Math.floor(clock / 1000) + 900),
      setupGasWei: "1000",
      hubGasWei: "2000",
      operatingGasWei: "3000",
    },
  });
  if (attested.status !== 200) throw new Error(`attest ${n}: ${attested.status} ${JSON.stringify(attested.body)}`);
  clock += 1000 / PER_SECOND;
  if (n % tickEvery === 0) {
    const removed = pruneReservations(state, { nowMs: clock, ttlMs: 20 * 60_000, ingestedThroughSec: Math.floor(clock / 1000) - 20 });
    if (removed.length) {
      const before = store.stats().journalBytes;
      store.sync(removed);
      appendedBytes += store.stats().journalBytes - before;
    }
    compactIfDue();
    peakKeys = Math.max(peakKeys, Object.keys(state.reservations).length);
    peakSnapshot = Math.max(peakSnapshot, statSync(file).size);
    peakJournal = Math.max(peakJournal, statSync(journalFileFor(file)).size);
    const memory = process.memoryUsage();
    peakRss = Math.max(peakRss, memory.rss);
    peakHeap = Math.max(peakHeap, memory.heapUsed);
  }
}
const wallMs = Number(process.hrtime.bigint() - wallStart) / 1e6;
const cpu = process.cpuUsage(cpuStart);
const cpuMs = (cpu.user + cpu.system) / 1000;
store.close();
rmSync(dir, { recursive: true, force: true });

syncMs.sort((a, b) => a - b);
const pct = (list, p) => (list.length ? list[Math.min(list.length - 1, Math.floor((p / 100) * list.length))] : 0);
const cpuPerCheckout = cpuMs / QUOTES;
const wallPerCheckout = wallMs / QUOTES;
const mb = (bytes) => (bytes / 1_048_576).toFixed(1);
console.log(JSON.stringify({
  quotes: QUOTES,
  simulatedMinutes: +(QUOTES / PER_SECOND / 60).toFixed(1),
  cpuMsPerCheckout: +cpuPerCheckout.toFixed(3),
  wallMsPerCheckout: +wallPerCheckout.toFixed(3),
  fsyncdAppendMs: { p50: +pct(syncMs, 50).toFixed(2), p99: +pct(syncMs, 99).toFixed(2), max: +pct(syncMs, 100).toFixed(2) },
  compactions: compactMs.length,
  compactionMsMax: +Math.max(0, ...compactMs).toFixed(1),
  peakLiveKeys: peakKeys,
  peakSnapshotMB: +mb(peakSnapshot),
  peakJournalMB: +mb(peakJournal),
  peakHeapMB: +mb(peakHeap),
  peakRssMB: +mb(peakRss),
  projectionAtPerSecond: {
    perSecond: PER_SECOND,
    cpuShareOfOneCore: `${(cpuPerCheckout * PER_SECOND / 10).toFixed(1)}%`,
    eventLoopBusyShare: `${(wallPerCheckout * PER_SECOND / 10).toFixed(1)}% (CPU + fsync waits)`,
    diskWrittenPerHourMB: +mb(((appendedBytes + snapshotBytesWritten) / (QUOTES / PER_SECOND)) * 3600),
  },
}, null, 2));
