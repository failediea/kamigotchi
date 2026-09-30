#!/usr/bin/env node
/**
 * Durable store for quote operator keys (the reservation store).
 *
 * Every quote gets a fresh, independently random RoomPod operator key
 * (renter-pod-keys.mjs, V14-01). The key must be on disk BEFORE the worker
 * returns the operator address or the keeper signature, and must stay there
 * until no pod can ever use it. Rewriting the whole store for every quote
 * (the previous design) costs O(live quotes) per request, so a burst of
 * quotes made each request slower. The store is now:
 *
 *   <store>.json     snapshot  { version: 1, generation: G, reservations }
 *                    (same shape the ops gate R1 and the rollback merge read)
 *   <store>.journal  append-only JSON lines, fsync'd on every append:
 *                      {"journal":1,"generation":G}      header, first line
 *                      {"put":"0x<nonce>","r":{...}}     full entry (last wins)
 *                      {"del":"0x<nonce>"}
 *
 * Both files are mode 0600 (they hold private keys). Nothing here COUNTS
 * entries or refuses a write because of how many there are: the store has no
 * capacity, cap or eviction. Its size is bounded only by the quote rate the
 * web allows and by how long an entry must live (see pruneReservations).
 *
 * Crash safety:
 *  - append: one write of whole lines, then fsync. A crash mid-append can only
 *    leave an unterminated LAST line; load ignores it (its request was never
 *    answered, because the answer is sent only after the fsync returns).
 *  - compaction: the snapshot is written atomically with generation G+1
 *    (tmp + fsync + rename + dir fsync), then a fresh journal with header G+1
 *    replaces the old one the same way. A crash between the two leaves a
 *    generation-G journal next to a G+1 snapshot: load ignores that stale
 *    journal, whose records the snapshot already contains.
 *  - the journal is opened for appending only by a compaction (the worker
 *    compacts right after load), so a torn tail is never appended to.
 *  - a failed append (e.g. ENOSPC) marks the journal suspect; the next write
 *    compacts first (full rewrite), and throws while that is impossible.
 *
 * CLI (worker STOPPED only, e.g. before a rollback merge or a backup):
 *   node renter-pod-quote-store.mjs compact <store>.json
 * folds the journal into the snapshot and prints entry counts (never keys).
 */
import * as NODE_FS from "node:fs";
import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonAtomic } from "./renter-pod-liveness.mjs";

export const QUOTE_STORE_SNAPSHOT_VERSION = 1;
export const QUOTE_JOURNAL_VERSION = 1;
/** Compact when the journal exceeds max(this, COMPACT_RATIO x snapshot bytes). */
export const COMPACT_MIN_BYTES = 1 << 20;
export const COMPACT_RATIO = 2;

export class QuoteStoreCorruptError extends Error {
  constructor(message) {
    super(message);
    this.name = "QuoteStoreCorruptError";
  }
}

/** <dir>/<name>.reservations.json -> <dir>/<name>.reservations.journal */
export function journalFileFor(storeFile) {
  return join(dirname(storeFile), `${basename(storeFile).replace(/\.json$/i, "")}.journal`);
}

function fsyncDir(fs, path) {
  let dirFd = null;
  try {
    dirFd = fs.openSync(dirname(path), "r");
    fs.fsyncSync(dirFd);
  } catch {
    // best effort, as in writeJsonAtomic
  } finally {
    if (dirFd !== null) fs.closeSync(dirFd);
  }
}

function writeAll(fs, fd, buffer) {
  let offset = 0;
  while (offset < buffer.length) offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
}

/**
 * Combine two versions of one nonce's entry without ever losing what makes a
 * key necessary. An entry only ever moves forward (reserved -> attested ->
 * released), so the merge is monotone: a keeper binding (attestedDigest +
 * quoteDeadline) or a release seen in either version survives, and the later
 * deadline wins. Two different operators for one nonce cannot both be right:
 * that is a hand-reconcile error, never a silent pick.
 */
export function mergeReservationEntry(existing, incoming, nonce = "?") {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (String(existing.operator).toLowerCase() !== String(incoming.operator).toLowerCase()) {
    throw new QuoteStoreCorruptError(`reservation ${nonce} has two different operators; reconcile by hand`);
  }
  const merged = { ...existing, ...incoming };
  if (existing.attestedDigest && !incoming.attestedDigest) merged.attestedDigest = existing.attestedDigest;
  const deadlines = [existing.quoteDeadline, incoming.quoteDeadline].map(Number).filter((value) => value > 0);
  if (deadlines.length) merged.quoteDeadline = Math.max(...deadlines);
  if (Number(existing.releasedAt) > 0 && !(Number(incoming.releasedAt) > 0)) {
    merged.releasedAt = existing.releasedAt;
    if (existing.releaseReason !== undefined) merged.releaseReason = existing.releaseReason;
  }
  return merged;
}

/**
 * Read snapshot + journal. Returns { reservations, generation, replayed,
 * tornTail, staleJournal, journalAhead, droppedCooldowns }.
 *
 * Journal generation vs snapshot generation:
 *   equal   -> replay (the normal case);
 *   older   -> ignore: a compaction already folded it into the snapshot
 *              (crash between the snapshot and the journal swap);
 *   newer, or no snapshot at all (e.g. a rollback moved the snapshot away)
 *           -> replay with mergeReservationEntry, so no key or keeper binding
 *              is ever dropped, and report journalAhead.
 * Throws QuoteStoreCorruptError only for damage no crash can cause: a snapshot
 * that is not JSON, a journal header or COMPLETE line that does not parse.
 */
export function readQuoteStore(file, { journalFile = journalFileFor(file), fs = NODE_FS } = {}) {
  let reservations = {};
  let generation = 0;
  let droppedCooldowns = 0;
  if (fs.existsSync(file)) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      throw new QuoteStoreCorruptError(`reservation store ${basename(file)} is not valid JSON: ${error.message}`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new QuoteStoreCorruptError(`reservation store ${basename(file)} is not an object`);
    }
    const stored = parsed.reservations ?? {};
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) {
      throw new QuoteStoreCorruptError(`reservation store ${basename(file)} has no reservations map`);
    }
    for (const [nonce, entry] of Object.entries(stored)) reservations[nonce.toLowerCase()] = entry;
    generation = Number.isSafeInteger(parsed.generation) && parsed.generation >= 0 ? parsed.generation : 0;
    // The retired reservation-capacity design kept per-listing cooldowns here.
    droppedCooldowns = Object.keys(parsed.listingCooldowns ?? {}).length;
  }

  let replayed = 0;
  let tornTail = false;
  let staleJournal = false;
  let journalAhead = false;
  const hasSnapshot = fs.existsSync(file);
  if (fs.existsSync(journalFile)) {
    const text = fs.readFileSync(journalFile, "utf8");
    const lines = text.split("\n");
    // Everything after the last "\n" is an unacknowledged torn append.
    const tail = lines.pop();
    if (tail) tornTail = true;
    if (lines.length) {
      let header;
      try {
        header = JSON.parse(lines[0]);
      } catch {
        throw new QuoteStoreCorruptError(`reservation journal ${basename(journalFile)} has an unreadable header`);
      }
      const journalGeneration = Number(header?.generation);
      if (header?.journal !== QUOTE_JOURNAL_VERSION || !Number.isSafeInteger(journalGeneration)) {
        throw new QuoteStoreCorruptError(`reservation journal ${basename(journalFile)} has an unknown header`);
      }
      if (hasSnapshot && journalGeneration < generation) {
        staleJournal = true;
      } else {
        // Same generation: plain last-put-wins replay is exact. A journal that
        // is ahead of (or has no) snapshot is merged monotonically instead.
        journalAhead = !hasSnapshot ? lines.length > 1 : journalGeneration > generation;
        const exact = !journalAhead;
        for (let index = 1; index < lines.length; index++) {
          const line = lines[index];
          if (!line) continue;
          let record;
          try {
            record = JSON.parse(line);
          } catch {
            throw new QuoteStoreCorruptError(`reservation journal line ${index + 1} is not valid JSON`);
          }
          if (typeof record?.put === "string" && record.r && typeof record.r === "object") {
            const nonce = record.put.toLowerCase();
            reservations[nonce] = exact ? record.r : mergeReservationEntry(reservations[nonce], record.r, nonce);
          } else if (typeof record?.del === "string") {
            delete reservations[record.del.toLowerCase()];
          } else {
            throw new QuoteStoreCorruptError(`reservation journal line ${index + 1} is not a put or del record`);
          }
          replayed++;
        }
        generation = Math.max(generation, journalGeneration);
      }
    }
  }
  return { reservations, generation, replayed, tornTail, staleJournal, journalAhead, droppedCooldowns };
}

/**
 * Open the store for one worker process. `getReservations()` returns the live
 * in-memory map (state.reservations): sync() journals the CURRENT entry of each
 * nonce (put when present, del when absent) and compact() snapshots the map.
 */
export function openQuoteStore({
  file,
  journalFile = journalFileFor(file),
  getReservations,
  fs = NODE_FS,
  mode = 0o600,
  compactMinBytes = COMPACT_MIN_BYTES,
  compactRatio = COMPACT_RATIO,
}) {
  if (typeof getReservations !== "function") throw new Error("openQuoteStore needs getReservations()");
  let fd = null;
  let generation = 0;
  let journalBytes = 0;
  let snapshotBytes = 0;
  let suspect = false;
  const stats = { appends: 0, fsyncs: 0, compactions: 0 };

  function closeJournal() {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {}
      fd = null;
    }
  }

  function compact() {
    const next = generation + 1;
    const reservations = getReservations() ?? {};
    const snapshot = { version: QUOTE_STORE_SNAPSHOT_VERSION, generation: next, reservations };
    writeJsonAtomic(file, snapshot, { mode, pretty: false, fs });
    snapshotBytes = fs.statSync(file).size;
    const header = Buffer.from(`${JSON.stringify({ journal: QUOTE_JOURNAL_VERSION, generation: next })}\n`);
    const temp = `${journalFile}.tmp`;
    const tempFd = fs.openSync(temp, "w", mode);
    try {
      writeAll(fs, tempFd, header);
      fs.fsyncSync(tempFd);
    } finally {
      fs.closeSync(tempFd);
    }
    fs.chmodSync(temp, mode);
    closeJournal();
    fs.renameSync(temp, journalFile);
    fsyncDir(fs, journalFile);
    fd = fs.openSync(journalFile, "a", mode);
    generation = next;
    journalBytes = header.length;
    suspect = false;
    stats.compactions++;
    return { generation, snapshotBytes, entries: Object.keys(reservations).length };
  }

  /** Append records and fsync once. Throws when they are not durable. */
  function append(records) {
    if (!records.length) return;
    if (suspect || fd === null) compact();
    const buffer = Buffer.from(records.map((record) => `${JSON.stringify(record)}\n`).join(""));
    try {
      writeAll(fs, fd, buffer);
      fs.fsyncSync(fd);
    } catch (error) {
      // A partial line may now sit in the journal: never append after it.
      suspect = true;
      throw error;
    }
    journalBytes += buffer.length;
    stats.appends += records.length;
    stats.fsyncs++;
  }

  return {
    file,
    journalFile,
    /**
     * Read snapshot + journal (see readQuoteStore). The journal is not opened
     * for appending here: the first sync() (or an explicit compact(), which
     * the worker runs right after merging legacy entries) compacts first, so
     * nothing is ever appended after a torn tail.
     */
    load() {
      const loaded = readQuoteStore(file, { journalFile, fs });
      generation = loaded.generation;
      return loaded;
    },
    compact,
    /**
     * Make the current in-memory entry of each nonce durable (put when it is
     * in getReservations(), del when it is not), with ONE fsync. Returns only
     * after the fsync; throws otherwise.
     */
    sync(nonces) {
      const reservations = getReservations() ?? {};
      const records = [];
      for (const raw of nonces) {
        const nonce = String(raw).toLowerCase();
        const entry = reservations[nonce];
        records.push(entry ? { put: nonce, r: entry } : { del: nonce });
      }
      append(records);
    },
    /** Compact when the journal has outgrown the snapshot (amortized O(1) per append). */
    maybeCompact() {
      if (suspect || (journalBytes > compactMinBytes && journalBytes > compactRatio * snapshotBytes)) return compact();
      return null;
    },
    close: closeJournal,
    stats: () => ({ ...stats, generation, journalBytes, snapshotBytes }),
  };
}

const invokedDirectly = (() => {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  const [command, file] = process.argv.slice(2);
  if (command !== "compact" || !file) {
    console.error("usage: node renter-pod-quote-store.mjs compact <store>.reservations.json   (worker stopped)");
    process.exit(2);
  }
  const holder = { reservations: {} };
  const store = openQuoteStore({ file, getReservations: () => holder.reservations });
  const loaded = store.load();
  holder.reservations = loaded.reservations;
  const result = store.compact();
  store.close();
  console.log(
    `compacted ${basename(file)}: entries=${result.entries} generation=${result.generation} `
      + `journalRecordsReplayed=${loaded.replayed} tornTail=${loaded.tornTail} staleJournal=${loaded.staleJournal}`
  );
}
