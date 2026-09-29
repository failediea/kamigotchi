import assert from "node:assert/strict";
import test from "node:test";
import { createLeaseAlerter } from "./renter-pod-alerts.mjs";
import { ActiveAction, advanceActiveLease } from "./renter-pod-active.mjs";
import { observeKamiState } from "./renter-pod-safety.mjs";

const GAS_PRICE = 2_500_000n;
const ACTION_GAS = 1_700_000n;
const ACTION = GAS_PRICE * ACTION_GAS;
const NOW = 1_800_000_000;

/**
 * ensureGas(required:true) throws below one action, exactly like the live
 * ensureOperatorGas; the point of THR-03 is that the exit path never reaches it.
 */
function harness({ balance, escrow, kamiState = "HARVESTING", listing = {}, job = {} } = {}) {
  const calls = [];
  const lines = [];
  const alert = createLeaseAlerter({ log: (line) => lines.push(line), minIntervalMs: 0 });
  const theJob = { tokenIndex: 5846, pod: "0xpod", nonce: "0xn", strategyStarted: true, creds: {}, ...job };
  const args = {
    job: theJob,
    nowSec: NOW,
    listing: { ending: false, leaseEnd: NOW + 86_400, ...listing },
    market: "0xmarket",
    readGas: async () => ({ balance, escrow, gasPrice: GAS_PRICE }),
    actionGas: ACTION_GAS,
    exitReserveActions: 3,
    resumeHeadroomActions: 2,
    ensureGas: async ({ required }) => {
      calls.push(`ensureGas:${required}`);
      if (required && balance + escrow < ACTION) throw new Error("operator gas health failed");
    },
    strategy: {
      stopForOnChain: async (_job, { force } = {}) => calls.push(`stopStrategy:${Boolean(force)}`),
      reconcile: async (_job, { budget }) => calls.push(["reconcile", budget]),
    },
    readKamiState: async () => {
      calls.push("readState");
      return kamiState;
    },
    stopHarvest: async () => calls.push("stopHarvest"),
    endLease: async () => calls.push("endLease"),
    advanceEnding: async () => calls.push("advanceEnding"),
    observeKami: (state, action) =>
      observeKamiState(theJob, state, { stage: 3, action, market: "0xmarket", alert }),
    alert,
    log: () => {},
  };
  return { args, calls, lines, job: theJob };
}

test("healthy escrow: normal fail-closed gas check, then reconcile with the remaining budget", async () => {
  const h = harness({ balance: ACTION * 5n, escrow: ACTION * 50n });
  assert.equal(await advanceActiveLease(h.args), ActiveAction.RECONCILED);
  assert.deepEqual(h.calls.slice(0, 2), ["ensureGas:true", "readState"]);
  const [, budget] = h.calls[2];
  assert.equal(budget.availableWei, ACTION * 55n);
  assert.equal(budget.exitReserveWei, ACTION * 3n);
  assert.equal(budget.remainingSecs, 86_400);
  assert.deepEqual(h.lines, []);
});

test("escrow drained while HARVESTING: stop strategy + harvest on the reserve, never the throwing gas check", async () => {
  // 2.5 actions left: the old worker let Kamibots keep spending until
  // ensureOperatorGas threw ahead of endLease/stopHarvest. The exit fires first.
  const h = harness({ balance: ACTION * 2n + ACTION / 2n, escrow: 0n });
  assert.equal(await advanceActiveLease(h.args), ActiveAction.EXIT_STOP_HARVEST);
  assert.deepEqual(h.calls, ["stopStrategy:true", "ensureGas:false", "readState", "stopHarvest"]);
  assert.ok(h.job.exitReserve.since > 0);
  assert.match(h.lines[0], /^\[LEASE-ALERT\] EXIT_RESERVE_STOP token=5846 market=0xmarket stage=3 /);
  assert.match(h.lines[1], /^\[LEASE-ALERT\] ESCROW_LOW token=5846 market=0xmarket stage=3 .*reason=exit-reserve/);
});

test("below even one action the exit path still tries the stop instead of dead-ending", async () => {
  const h = harness({ balance: ACTION / 3n, escrow: 0n });
  h.args.ensureGas = async ({ required }) => {
    h.calls.push(`ensureGas:${required}`);
    throw new Error("insufficient funds for pullGas");
  };
  assert.equal(await advanceActiveLease(h.args), ActiveAction.EXIT_STOP_HARVEST);
  assert.ok(h.calls.includes("stopHarvest"));
  assert.ok(!h.calls.includes("ensureGas:true"));
});

test("exit reserve holds a RESTING Kami, does not restart, and re-alerts only ESCROW_LOW", async () => {
  const h = harness({ balance: ACTION * 3n, escrow: 0n, kamiState: "RESTING", job: { exitReserve: { since: 1 } } });
  assert.equal(await advanceActiveLease(h.args), ActiveAction.EXIT_HOLD);
  assert.ok(!h.calls.some((call) => Array.isArray(call)), "no reconcile");
  assert.equal(h.lines.length, 1);
  assert.match(h.lines[0], /ESCROW_LOW/);
});

test("exit reserve still ends an expired lease and drives the ending on the reserve", async () => {
  const expired = harness({ balance: ACTION * 3n, escrow: 0n, listing: { leaseEnd: NOW - 1 } });
  assert.equal(await advanceActiveLease(expired.args), ActiveAction.END_LEASE);
  assert.ok(!expired.calls.includes("ensureGas:true"));
  const ending = harness({ balance: ACTION * 3n, escrow: 0n, listing: { ending: true } });
  assert.equal(await advanceActiveLease(ending.args), ActiveAction.ENDING);
  assert.deepEqual(ending.calls, ["stopStrategy:true", "ensureGas:false", "advanceEnding"]);
});

test("a renter top-up past the resume threshold restarts the normal flow", async () => {
  const h = harness({ balance: ACTION * 3n, escrow: ACTION * 4n, kamiState: "RESTING", job: { exitReserve: { since: 1 } } });
  assert.equal(await advanceActiveLease(h.args), ActiveAction.RECONCILED);
  assert.equal(h.job.exitReserve, undefined);
  assert.equal(h.calls[0], "ensureGas:true");
});

test("a DEAD Kami in an active lease is alerted, its strategy stopped, and nothing reconciled", async () => {
  const h = harness({ balance: ACTION * 10n, escrow: ACTION * 10n, kamiState: "DEAD" });
  assert.equal(await advanceActiveLease(h.args), ActiveAction.DEAD);
  assert.deepEqual(h.calls, ["ensureGas:true", "readState", "stopStrategy:true"]);
  assert.match(h.lines[0], /^\[LEASE-ALERT\] DEAD_KAMI token=5846 market=0xmarket stage=3 action=active/);
  assert.ok(h.job.dead);
});

test("stop only BYPASSED (Kamibots may still run): no bulk pull, one action just in time per exit tx", async () => {
  const pulls = [];
  const setup = (opts) => {
    const h = harness(opts);
    h.args.strategy.stopForOnChain = async () => "bypassed";
    h.args.ensureGas = async (options) => {
      pulls.push(options);
      h.calls.push(`ensureGas:${options.required}:${options.targetActions ?? "all"}`);
    };
    return h;
  };
  const harvesting = setup({ balance: ACTION * 2n, escrow: ACTION * 1n });
  assert.equal(await advanceActiveLease(harvesting.args), ActiveAction.EXIT_STOP_HARVEST);
  assert.deepEqual(harvesting.calls, ["readState", "ensureGas:false:1", "stopHarvest"]);

  const expired = setup({ balance: ACTION * 2n, escrow: ACTION * 1n, listing: { leaseEnd: NOW - 1 } });
  assert.equal(await advanceActiveLease(expired.args), ActiveAction.END_LEASE);
  assert.deepEqual(expired.calls, ["ensureGas:false:1", "endLease"]);

  const ending = setup({ balance: ACTION * 2n, escrow: ACTION * 1n, listing: { ending: true } });
  assert.equal(await advanceActiveLease(ending.args), ActiveAction.ENDING);
  assert.deepEqual(ending.calls, ["ensureGas:false:2", "advanceEnding"], "finalize + the KamiSend home");

  const resting = setup({ balance: ACTION * 2n, escrow: ACTION * 1n, kamiState: "RESTING" });
  assert.equal(await advanceActiveLease(resting.args), ActiveAction.EXIT_HOLD);
  assert.deepEqual(resting.calls, ["readState"], "nothing to send: nothing pulled onto the shared EOA");
  assert.ok(pulls.every((options) => options.required === false && options.targetActions));
});

test("stop confirmed: the remaining escrow is pulled in full, as before", async () => {
  for (const outcome of ["stopped", "none"]) {
    const h = harness({ balance: ACTION * 2n, escrow: ACTION * 1n });
    h.args.strategy.stopForOnChain = async () => outcome;
    const seen = [];
    h.args.ensureGas = async (options) => seen.push(options);
    await advanceActiveLease(h.args);
    assert.deepEqual(seen, [{ required: false }], outcome);
  }
});
