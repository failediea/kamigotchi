import { existsSync, readFileSync } from "node:fs";
import { initializeIngestState } from "./renter-pod-ingest.mjs";
import { initializeOperatorKeyState, migrateLegacyJobKeys } from "./renter-pod-keys.mjs";
import { writeJsonAtomic } from "./renter-pod-liveness.mjs";
import { loadReservationStore, saveReservationStore, stateForDisk } from "./renter-pod-reservations.mjs";

/**
 * Load (or create) the worker's durable state exactly as the live v16 workers
 * left it. Pre-hardening state files load unchanged; legacy embedded
 * reservations move to the reservation store (store written first).
 */
export function loadWorkerState({ stateFile, reservationFile, startBlock = 0, legacySeed = "" }) {
  const state = existsSync(stateFile)
    ? JSON.parse(readFileSync(stateFile, "utf8"))
    : { lastBlock: Number(startBlock || 0), jobs: {} };
  initializeOperatorKeyState(state);
  initializeIngestState(state);

  const { migrated: migratedReservations } = loadReservationStore(state, reservationFile);
  const save = () => writeJsonAtomic(stateFile, stateForDisk(state));
  const saveReservations = () => saveReservationStore(state, reservationFile);
  if (migratedReservations || !existsSync(reservationFile)) saveReservations();
  const migratedLegacyJobs = migrateLegacyJobKeys(state, legacySeed);
  if (migratedLegacyJobs || migratedReservations) save();
  return { state, save, saveReservations, migratedReservations, migratedLegacyJobs };
}
