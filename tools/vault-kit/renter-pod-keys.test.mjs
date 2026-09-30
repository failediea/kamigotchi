import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import { Wallet } from "ethers";
import {
  bindOperatorReservationQuote,
  claimOperatorReservation,
  migrateLegacyJobKeys,
  operatorWalletForJob,
  OperatorMismatchError,
  purgeReturnedJobSecrets,
  randomOperatorWallet,
  reserveRandomOperator,
} from "./renter-pod-keys.mjs";

const nonce = (value) => `0x${value.toString(16).padStart(64, "0")}`;

test("each nonce receives an independently random operator key", () => {
  const state = {};
  const first = reserveRandomOperator(state, nonce(1));
  const second = reserveRandomOperator(state, nonce(2));
  assert.notEqual(first.operator, second.operator);
  assert.notEqual(state.reservations[nonce(1)].operatorKey, state.reservations[nonce(2)].operatorKey);
});

test("reserving the same nonce is idempotent", () => {
  const state = {};
  const wallet = Wallet.createRandom();
  const first = reserveRandomOperator(state, nonce(3), { now: 10, walletFactory: () => wallet });
  const second = reserveRandomOperator(state, nonce(3), { now: 20 });
  assert.deepEqual(second, first);
});

test("claim checks the event operator and moves the private key out of reservations", () => {
  const state = {};
  const reserved = reserveRandomOperator(state, nonce(4));
  const privateKey = claimOperatorReservation(state, nonce(4), reserved.operator);
  assert.equal(new Wallet(privateKey).address, reserved.operator);
  assert.equal(state.reservations[nonce(4)], undefined);
});

test("a mismatched on-chain operator cannot consume a reservation", () => {
  const state = {};
  reserveRandomOperator(state, nonce(5));
  assert.throws(() => claimOperatorReservation(state, nonce(5), Wallet.createRandom().address), /does not match/);
  assert.ok(state.reservations[nonce(5)]);
});

test("a reservation nonce binds to exactly one quote digest", () => {
  const state = {};
  const reserved = reserveRandomOperator(state, nonce(8));
  const firstDigest = `0x${"11".repeat(32)}`;
  assert.equal(
    bindOperatorReservationQuote(state, nonce(8), reserved.operator, firstDigest),
    firstDigest
  );
  assert.equal(
    bindOperatorReservationQuote(state, nonce(8), reserved.operator, firstDigest),
    firstDigest
  );
  assert.throws(
    () => bindOperatorReservationQuote(state, nonce(8), reserved.operator, `0x${"22".repeat(32)}`),
    /already bound/
  );
  assert.throws(
    () => bindOperatorReservationQuote(state, nonce(8), Wallet.createRandom().address, firstDigest),
    /does not match/
  );
});

test("V14-01: keys are independently random - the same nonce in two workers gets unrelated keys; no seed is involved", () => {
  const a = {};
  const b = {};
  const first = reserveRandomOperator(a, nonce(6));
  const second = reserveRandomOperator(b, nonce(6));
  assert.notEqual(first.operator, second.operator, "not derived from the (public) nonce");
  const keys = new Set(Array.from({ length: 200 }, () => randomOperatorWallet().privateKey));
  assert.equal(keys.size, 200);
  for (const key of keys) assert.match(key, /^0x[0-9a-f]{64}$/);
  assert.equal(new Wallet(a.reservations[nonce(6)].operatorKey).address, first.operator);
});

test("claim errors are typed OPERATOR_MISMATCH causes: missing vs mismatch", () => {
  const state = {};
  const reserved = reserveRandomOperator(state, nonce(9));
  assert.throws(
    () => claimOperatorReservation(state, nonce(10), reserved.operator),
    (error) => error instanceof OperatorMismatchError && error.reason === "missing"
  );
  assert.throws(
    () => claimOperatorReservation(state, nonce(9), Wallet.createRandom().address),
    (error) => error instanceof OperatorMismatchError && error.reason === "mismatch"
  );
});

test("legacy active jobs migrate once and returned jobs do not retain secrets", () => {
  const seed = "legacy-seed-that-is-long-enough-for-migration-only";
  const oldNonce = nonce(7);
  const key = `0x${createHmac("sha256", seed).update(`${oldNonce}:0`).digest("hex")}`;
  const oldState = {
    jobs: { 7: { tokenIndex: 7, nonce: oldNonce, operator: new Wallet(key).address } },
    reservations: {},
  };
  assert.equal(migrateLegacyJobKeys(oldState, seed), 1);
  const wallet = operatorWalletForJob(oldState.jobs[7]);
  assert.equal(wallet.address, oldState.jobs[7].operator);
  oldState.jobs[7].creds = { apiKey: "secret" };
  purgeReturnedJobSecrets(oldState.jobs[7]);
  assert.equal(oldState.jobs[7].operatorKey, undefined);
  assert.equal(oldState.jobs[7].creds, undefined);
});
