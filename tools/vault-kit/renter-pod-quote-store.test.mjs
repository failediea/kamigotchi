import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { reserveRandomOperator } from "./renter-pod-keys.mjs";
import {
  QuoteStoreCorruptError,
  journalFileFor,
  mergeReservationEntry,
  openQuoteStore,
  readQuoteStore,
} from "./renter-pod-quote-store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const nonce = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const DIGEST = `0x${"ab".repeat(32)}`;

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "rp-qstore-"));
  const file = join(dir, "musu-renter-pod-worker-state.reservations.json");
  return { dir, file, journal: journalFileFor(file), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function open(file, holder, options = {}) {
  const store = openQuoteStore({ file, getReservations: () => holder.reservations, ...options });
  holder.reservations = store.load().reservations;
  return store;
}

test("journal path sits next to the snapshot and is not matched by the ops *reservations*.json glob", () => {
  assert.equal(journalFileFor("/d/x-state.reservations.json"), "/d/x-state.reservations.journal");
  assert.doesNotMatch("x-state.reservations.journal", /reservations.*\.json$/);
});

test("sync appends one fsync'd line per nonce; reload replays it exactly; both files are 0600", () => {
  const { file, journal, cleanup } = scratch();
  try {
    const holder = { reservations: {} };
    const store = open(file, holder);
    store.compact();
    reserveRandomOperator(holder, nonce(1), { now: 5, renter: `0x${"c1".repeat(20)}` });
    reserveRandomOperator(holder, nonce(2), { now: 6 });
    store.sync([nonce(1), nonce(2)]);
    Object.assign(holder.reservations[nonce(1)], { attestedDigest: DIGEST, quoteDeadline: 900, tokenIndex: 4 });
    store.sync([nonce(1)]);
    delete holder.reservations[nonce(2)];
    store.sync([nonce(2)]);
    assert.deepEqual(store.stats().fsyncs, 3, "one fsync per sync() call");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(journal).mode & 0o777, 0o600);
    const lines = readFileSync(journal, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 5, "header + 2 puts + 1 put + 1 del");
    assert.deepEqual(Object.keys(lines[0]), ["journal", "generation"]);
    assert.deepEqual(lines.at(-1), { del: nonce(2) });
    store.close();

    const loaded = readQuoteStore(file);
    assert.deepEqual(loaded.reservations, holder.reservations);
    assert.equal(loaded.replayed, 4);
    assert.equal(loaded.reservations[nonce(1)].attestedDigest, DIGEST);
  } finally {
    cleanup();
  }
});

test("CRASH mid-append: a torn last line is ignored, earlier keys survive, and nothing is ever appended after it", () => {
  const { file, journal, cleanup } = scratch();
  try {
    const holder = { reservations: {} };
    const store = open(file, holder);
    store.compact();
    reserveRandomOperator(holder, nonce(1), { now: 1 });
    store.sync([nonce(1)]);
    store.close();
    // The process died inside writeSync for nonce 2: half a line, no newline,
    // and its request was never answered (the answer follows the fsync).
    appendFileSync(journal, '{"put":"0x00000000000000000000000000000000000000000000000000000000000000');
    const restarted = { reservations: {} };
    const again = openQuoteStore({ file, getReservations: () => restarted.reservations });
    const loaded = again.load();
    restarted.reservations = loaded.reservations;
    assert.equal(loaded.tornTail, true);
    assert.deepEqual(Object.keys(restarted.reservations), [nonce(1)]);
    // The first write after a load compacts (fresh journal), so the torn bytes are gone.
    reserveRandomOperator(restarted, nonce(3), { now: 2 });
    again.sync([nonce(3)]);
    again.close();
    const text = readFileSync(journal, "utf8");
    assert.ok(text.endsWith("\n"));
    for (const line of text.trim().split("\n")) JSON.parse(line);
    const final = readQuoteStore(file);
    assert.equal(final.tornTail, false);
    assert.deepEqual(Object.keys(final.reservations).sort(), [nonce(1), nonce(3)]);
  } finally {
    cleanup();
  }
});

test("CRASH during compaction: a snapshot newer than the journal ignores the (already folded) stale journal", () => {
  const { file, journal, cleanup } = scratch();
  try {
    const holder = { reservations: {} };
    const store = open(file, holder);
    store.compact();
    reserveRandomOperator(holder, nonce(1), { now: 1 });
    store.sync([nonce(1)]);
    Object.assign(holder.reservations[nonce(1)], { attestedDigest: DIGEST, quoteDeadline: 900 });
    store.sync([nonce(1)]);
    const staleJournal = readFileSync(journal, "utf8");
    store.compact();
    store.close();
    // Simulate the crash between the snapshot rename and the journal swap.
    writeFileSync(journal, staleJournal, { mode: 0o600 });
    const loaded = readQuoteStore(file);
    assert.equal(loaded.staleJournal, true);
    assert.equal(loaded.replayed, 0);
    assert.equal(loaded.reservations[nonce(1)].attestedDigest, DIGEST, "the stale unattested put never regresses the binding");
  } finally {
    cleanup();
  }
});

test("snapshot moved away (launch-ops rollback) or replaced by an older one: the journal is merged, never regressing a binding", () => {
  const { file, journal, cleanup } = scratch();
  try {
    const holder = { reservations: {} };
    const store = open(file, holder);
    store.compact();
    const olderSnapshot = readFileSync(file, "utf8");
    reserveRandomOperator(holder, nonce(1), { now: 1 });
    store.sync([nonce(1)]);
    Object.assign(holder.reservations[nonce(1)], { attestedDigest: DIGEST, quoteDeadline: 900 });
    store.compact();
    reserveRandomOperator(holder, nonce(2), { now: 2 });
    store.sync([nonce(2)]);
    store.close();

    rmSync(file);
    const orphan = readQuoteStore(file);
    assert.equal(orphan.journalAhead, true);
    assert.deepEqual(Object.keys(orphan.reservations), [nonce(2)], "only what the journal holds; the moved snapshot went to the state file");

    writeFileSync(file, olderSnapshot, { mode: 0o600 });
    const ahead = readQuoteStore(file);
    assert.equal(ahead.journalAhead, true);
    assert.ok(ahead.generation >= 2, "the next compaction supersedes both files");
    assert.deepEqual(Object.keys(ahead.reservations), [nonce(2)]);

    // Monotone merge: an older unattested copy never drops a binding.
    const signed = { operator: "0xA", operatorKey: "k", createdAt: 1, attestedDigest: DIGEST, quoteDeadline: 900, releasedAt: 3 };
    const merged = mergeReservationEntry(signed, { operator: "0xa", operatorKey: "k", createdAt: 1 });
    assert.deepEqual([merged.attestedDigest, merged.quoteDeadline, merged.releasedAt], [DIGEST, 900, 3]);
    assert.equal(mergeReservationEntry({ ...signed, quoteDeadline: 1000 }, signed).quoteDeadline, 1000);
    assert.throws(() => mergeReservationEntry(signed, { operator: "0xb" }, "n"), QuoteStoreCorruptError);
    assert.ok(existsSync(journal));
  } finally {
    cleanup();
  }
});

test("damage no crash can cause is refused loudly: garbage snapshot, unreadable header, garbage complete line", () => {
  const { file, journal, cleanup } = scratch();
  try {
    writeFileSync(file, "{not json");
    assert.throws(() => readQuoteStore(file), QuoteStoreCorruptError);
    writeFileSync(file, JSON.stringify({ version: 1, generation: 1, reservations: {} }));
    writeFileSync(journal, "nope\n");
    assert.throws(() => readQuoteStore(file), /header/);
    writeFileSync(journal, `${JSON.stringify({ journal: 1, generation: 1 })}\n{"put":1}\n`);
    assert.throws(() => readQuoteStore(file), /put or del/);
    writeFileSync(journal, `${JSON.stringify({ journal: 1, generation: 1 })}\n{broken\n{"del":"0x1"}\n`);
    assert.throws(() => readQuoteStore(file), /line 2/);
    rmSync(journal);
    assert.deepEqual(readQuoteStore(file).reservations, {}, "a missing journal is fine");
    rmSync(file);
    assert.deepEqual(readQuoteStore(file).reservations, {}, "a missing store is a fresh store");
  } finally {
    cleanup();
  }
});

test("pre-journal (v1) store files load unchanged; their listing cooldowns are dropped", () => {
  const { file, cleanup } = scratch();
  try {
    const entry = { operator: "0x1", operatorKey: "k", createdAt: 1, attestPendingUntil: 5 };
    writeFileSync(file, JSON.stringify({ version: 1, reservations: { [nonce(1).toUpperCase().replace("0X", "0x")]: entry }, listingCooldowns: { a: 1, b: 2 } }));
    const loaded = readQuoteStore(file);
    assert.deepEqual(loaded.reservations, { [nonce(1)]: entry });
    assert.equal(loaded.generation, 0);
    assert.equal(loaded.droppedCooldowns, 2);
    const holder = { reservations: loaded.reservations };
    const store = openQuoteStore({ file, getReservations: () => holder.reservations });
    store.compact();
    store.close();
    const rewritten = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(Object.keys(rewritten), ["version", "generation", "reservations"], "shape the ops tools read (.reservations)");
    assert.equal(rewritten.version, 1);
  } finally {
    cleanup();
  }
});

test("a failed append is never acknowledged, and the next write rewrites the store before appending again", () => {
  const { file, cleanup } = scratch();
  try {
    let failNext = false;
    const flaky = {
      ...fs,
      fsyncSync(fd) {
        if (failNext) {
          failNext = false;
          throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        }
        return fs.fsyncSync(fd);
      },
    };
    const holder = { reservations: {} };
    const store = open(file, holder, { fs: flaky });
    store.compact();
    reserveRandomOperator(holder, nonce(1), { now: 1 });
    failNext = true;
    assert.throws(() => store.sync([nonce(1)]), /ENOSPC/);
    const before = store.stats().compactions;
    reserveRandomOperator(holder, nonce(2), { now: 2 });
    store.sync([nonce(2)]);
    assert.equal(store.stats().compactions, before + 1, "compacted before appending after a failure");
    store.close();
    assert.deepEqual(Object.keys(readQuoteStore(file).reservations).sort(), [nonce(1), nonce(2)]);
  } finally {
    cleanup();
  }
});

test("maybeCompact folds the journal once it outgrows the snapshot (amortized O(1) per quote)", () => {
  const { file, journal, cleanup } = scratch();
  try {
    const holder = { reservations: {} };
    const store = open(file, holder, { compactMinBytes: 4_096, compactRatio: 2 });
    store.compact();
    let compactions = 0;
    for (let i = 1; i <= 400; i++) {
      reserveRandomOperator(holder, nonce(i), { now: i });
      store.sync([nonce(i)]);
      if (i > 20) {
        delete holder.reservations[nonce(i - 20)];
        store.sync([nonce(i - 20)]);
      }
      if (store.maybeCompact()) compactions++;
    }
    assert.ok(compactions >= 5 && compactions <= 60, `compactions=${compactions}`);
    assert.ok(statSync(journal).size <= Math.max(4_096, 2 * statSync(file).size) + 1_000);
    store.close();
    assert.equal(Object.keys(readQuoteStore(file).reservations).length, 20);
  } finally {
    cleanup();
  }
});

test("CLI: `compact` folds the journal for a stopped worker and prints counts, never keys", () => {
  const { file, journal, cleanup } = scratch();
  try {
    const holder = { reservations: {} };
    const store = open(file, holder);
    store.compact();
    reserveRandomOperator(holder, nonce(1), { now: 1 });
    store.sync([nonce(1)]);
    store.close();
    const out = execFileSync(process.execPath, [join(here, "renter-pod-quote-store.mjs"), "compact", file], { encoding: "utf8" });
    assert.match(out, /entries=1 .*journalRecordsReplayed=1/);
    assert.doesNotMatch(out, new RegExp(holder.reservations[nonce(1)].operatorKey.slice(2)));
    assert.equal(JSON.parse(readFileSync(file, "utf8")).reservations[nonce(1)].operator, holder.reservations[nonce(1)].operator);
    assert.equal(readFileSync(journal, "utf8").trim().split("\n").length, 1, "journal is back to its header");
  } finally {
    cleanup();
  }
});
