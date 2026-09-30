import { existsSync, readFileSync } from "node:fs";
import { initializeIngestState } from "./renter-pod-ingest.mjs";
import { initializeOperatorKeyState, migrateLegacyJobKeys } from "./renter-pod-keys.mjs";
import { writeJsonAtomic } from "./renter-pod-liveness.mjs";
import { journalFileFor, openQuoteStore } from "./renter-pod-quote-store.mjs";
import { mergeStoredReservations, stateForDisk } from "./renter-pod-reservations.mjs";

/**
 * Load (or create) the worker's durable state exactly as the live v16 workers
 * left it. Pre-hardening state files load unchanged; legacy embedded
 * reservations move to the quote store (store made durable first, then the
 * state file drops them).
 *
 * Returns { state, save, persistReservations, quoteStore, ... }:
 *   save()                      atomic job-state write (no operator keys of
 *                               quotes in flight: see stateForDisk)
 *   persistReservations(nonces) journal the current entry of each nonce
 *                               (append + fsync; throws when not durable)
 *   quoteStore                  maybeCompact() / compact() / close() / stats()
 */
export function loadWorkerState({
  stateFile,
  reservationFile,
  journalFile = journalFileFor(reservationFile),
  startBlock = 0,
  legacySeed = "",
  quoteStoreOptions = {},
}) {
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { lastBlock: Number(startBlock || 0), jobs: {} };
  initializeOperatorKeyState(state);
  initializeIngestState(state);
  const embeddedCount = Object.keys(state.reservations).length;

  const quoteStore = openQuoteStore({
    file: reservationFile,
    journalFile,
    getReservations: () => state.reservations,
    ...quoteStoreOptions,
  });
  const loaded = quoteStore.load();
  const { migrated: migratedReservations } = mergeStoredReservations(state, loaded.reservations);
  // Always start from a fresh snapshot + empty journal: folds the journal in,
  // makes migrated legacy entries durable BEFORE the state file drops them,
  // and never appends after a torn journal tail.
  quoteStore.compact();

  const save = () => writeJsonAtomic(stateFile, stateForDisk(state));
  const persistReservations = (nonces) => quoteStore.sync(nonces);
  const migratedLegacyJobs = migrateLegacyJobKeys(state, legacySeed);
  if (migratedLegacyJobs || embeddedCount) save();
  return {
    state,
    save,
    persistReservations,
    quoteStore,
    migratedReservations,
    migratedLegacyJobs,
    storeLoad: {
      replayed: loaded.replayed,
      tornTail: loaded.tornTail,
      staleJournal: loaded.staleJournal,
      journalAhead: loaded.journalAhead,
      droppedCooldowns: loaded.droppedCooldowns,
    },
  };
}
