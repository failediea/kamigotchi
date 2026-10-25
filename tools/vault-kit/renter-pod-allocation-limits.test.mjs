import test from "node:test";
import assert from "node:assert/strict";
import { createAllocationLimiter, allocationLimit } from "./renter-pod-allocation-limits.mjs";

test("infrastructure ceiling refuses allocation without deleting signed keys", () => {
  const reservations = { a: { attestedDigest: "signed", operatorKey: "keep" } };
  const admit = createAllocationLimiter({ maxKeys: 1 });
  assert.equal(admit(reservations), "KEY_STORE_CAPACITY");
  assert.deepEqual(reservations, { a: { attestedDigest: "signed", operatorKey: "keep" } });
  delete reservations.a; // only proven-expired/claimed cleanup removes entries
  assert.equal(admit(reservations), null);
});

test("allocation rate resets after a minute and cannot change lease capacity", () => {
  let clock = 0;
  const admit = createAllocationLimiter({ perMinute: 2, now: () => clock });
  assert.equal(admit({}), null);
  assert.equal(admit({}), null);
  assert.equal(admit({}), "KEY_ALLOCATION_RATE");
  clock = 60_000;
  assert.equal(admit({}), null);
});

test("invalid allocation configuration cannot disable bounds", () => {
  assert.equal(allocationLimit(undefined, 16, "MAX"), 16);
  for (const value of [0, -1, 1.5, Infinity, "no", 1_000_001]) assert.throws(() => allocationLimit(value, 16, "MAX"));
});
