import { createHmac, randomBytes } from "node:crypto";
import { Wallet } from "ethers";

const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;

function requireNonce(nonce) {
  if (!NONCE_RE.test(String(nonce))) throw new Error("invalid operator reservation nonce");
  return String(nonce).toLowerCase();
}

/**
 * A RenterPodCreated event whose operator does not match the key stored for
 * its nonce (or no key is stored for it). The worker cannot operate that pod;
 * ingest parks the event and raises OPERATOR_MISMATCH (renter-pod-ingest.mjs).
 */
export class OperatorMismatchError extends Error {
  constructor(message, { reason }) {
    super(message);
    this.name = "OperatorMismatchError";
    this.reason = reason;
  }
}

/**
 * A fresh RoomPod operator key: 32 bytes straight from the OS CSPRNG
 * (node:crypto randomBytes), independent of every other key, of any seed and
 * of every public input (V14-01). The rare out-of-range scalar is redrawn.
 * About 0.2 ms, against about 4 ms for ethers' Wallet.createRandom (a BIP-39
 * mnemonic + PBKDF2 + five HD derivations nothing here uses).
 */
export function randomOperatorWallet() {
  for (;;) {
    try {
      return new Wallet(`0x${randomBytes(32).toString("hex")}`);
    } catch {
      // zero or >= the curve order: draw again
    }
  }
}

function walletFromPrivateKey(privateKey, provider) {
  try {
    return new Wallet(privateKey, provider);
  } catch {
    throw new Error("invalid stored RoomPod operator key");
  }
}

export function initializeOperatorKeyState(state) {
  state.reservations ??= {};
  state.jobs ??= {};
  return state;
}

export function reserveRandomOperator(
  state,
  nonce,
  { now = Date.now(), walletFactory = randomOperatorWallet, renter } = {}
) {
  initializeOperatorKeyState(state);
  const key = requireNonce(nonce);
  const existing = state.reservations[key];
  if (existing) {
    const wallet = walletFromPrivateKey(existing.operatorKey);
    if (wallet.address.toLowerCase() !== String(existing.operator).toLowerCase()) {
      throw new Error("stored RoomPod reservation is inconsistent");
    }
    return { operator: wallet.address, createdAt: Number(existing.createdAt) };
  }

  const wallet = walletFactory();
  state.reservations[key] = {
    operator: wallet.address,
    operatorKey: wallet.privateKey,
    createdAt: now,
    // Optional: recorded so per-renter caps and the attestation renter check
    // can be enforced. Legacy reservations simply lack it.
    ...(renter ? { renter: String(renter).toLowerCase() } : {}),
  };
  return { operator: wallet.address, createdAt: now };
}

/**
 * Resolve the operator key for an on-chain pod. With `remove: false` the
 * reservation is left in place so the caller can delete it only after the job
 * holding the key has been durably saved (crash between the two writes then
 * leaves the key in both files, never in neither).
 */
export function claimOperatorReservation(state, nonce, expectedOperator, { remove = true } = {}) {
  initializeOperatorKeyState(state);
  const key = requireNonce(nonce);
  const reservation = state.reservations[key];
  if (!reservation) {
    throw new OperatorMismatchError("RoomPod operator reservation is missing", { reason: "missing" });
  }
  const wallet = walletFromPrivateKey(reservation.operatorKey);
  if (wallet.address.toLowerCase() !== String(expectedOperator).toLowerCase()) {
    throw new OperatorMismatchError("RoomPod operator reservation does not match the on-chain event", { reason: "mismatch" });
  }
  if (remove) delete state.reservations[key];
  return wallet.privateKey;
}

export function bindOperatorReservationQuote(state, nonce, expectedOperator, digest) {
  initializeOperatorKeyState(state);
  const key = requireNonce(nonce);
  const reservation = state.reservations[key];
  if (!reservation) throw new Error("RoomPod operator reservation is missing");
  if (String(reservation.operator).toLowerCase() !== String(expectedOperator).toLowerCase()) {
    throw new Error("operator attestation does not match the reservation");
  }
  const normalizedDigest = String(digest).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(normalizedDigest)) throw new Error("invalid quote digest");
  if (reservation.attestedDigest && reservation.attestedDigest !== normalizedDigest) {
    throw new Error("reservation nonce is already bound to a different quote");
  }
  reservation.attestedDigest = normalizedDigest;
  return normalizedDigest;
}

// (removeExpiredUnclaimedReservations is gone: it dropped keys by local age
// alone, even a signed quote's. Pruning is renter-pod-reservations.mjs
// prunableReservations, which needs on-chain proof for signed quotes.)

function deriveLegacyOperator(nonce, seed) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const key = createHmac("sha256", seed).update(`${nonce}:${attempt}`).digest("hex");
    try {
      return new Wallet(`0x${key}`);
    } catch {}
  }
  throw new Error("could not migrate legacy RoomPod operator key");
}

export function migrateLegacyJobKeys(state, legacySeed) {
  initializeOperatorKeyState(state);
  let migrated = 0;
  for (const job of Object.values(state.jobs)) {
    if (job.returned || job.operatorKey) continue;
    if (!legacySeed) throw new Error("LEGACY_PROVISIONING_OPERATOR_SEED is required to migrate active legacy jobs");
    const wallet = deriveLegacyOperator(job.nonce, legacySeed);
    if (wallet.address.toLowerCase() !== String(job.operator).toLowerCase()) {
      throw new Error(`legacy RoomPod operator mismatch for Kami #${job.tokenIndex}`);
    }
    job.operatorKey = wallet.privateKey;
    migrated++;
  }
  return migrated;
}

export function operatorWalletForJob(job, provider) {
  if (!job.operatorKey) throw new Error(`RoomPod operator key missing for Kami #${job.tokenIndex}`);
  const wallet = walletFromPrivateKey(job.operatorKey, provider);
  if (wallet.address.toLowerCase() !== String(job.operator).toLowerCase()) {
    throw new Error(`RoomPod operator key mismatch for Kami #${job.tokenIndex}`);
  }
  return wallet;
}

export function purgeReturnedJobSecrets(job) {
  delete job.operatorKey;
  delete job.creds;
  delete job.strategySignature;
}
