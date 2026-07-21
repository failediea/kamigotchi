import { createHmac } from "node:crypto";
import { Wallet } from "ethers";

const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;

function requireNonce(nonce) {
  if (!NONCE_RE.test(String(nonce))) throw new Error("invalid operator reservation nonce");
  return String(nonce).toLowerCase();
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

export function reserveRandomOperator(state, nonce, { now = Date.now(), walletFactory = Wallet.createRandom } = {}) {
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
  };
  return { operator: wallet.address, createdAt: now };
}

export function claimOperatorReservation(state, nonce, expectedOperator) {
  initializeOperatorKeyState(state);
  const key = requireNonce(nonce);
  const reservation = state.reservations[key];
  if (!reservation) throw new Error("RoomPod operator reservation is missing");
  const wallet = walletFromPrivateKey(reservation.operatorKey);
  if (wallet.address.toLowerCase() !== String(expectedOperator).toLowerCase()) {
    throw new Error("RoomPod operator reservation does not match the on-chain event");
  }
  delete state.reservations[key];
  return wallet.privateKey;
}

export function removeExpiredUnclaimedReservations(state, now = Date.now(), maxAgeMs = 24 * 60 * 60_000) {
  initializeOperatorKeyState(state);
  let removed = 0;
  for (const [nonce, reservation] of Object.entries(state.reservations)) {
    if (now - Number(reservation.createdAt || 0) <= maxAgeMs) continue;
    delete state.reservations[nonce];
    removed++;
  }
  return removed;
}

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
