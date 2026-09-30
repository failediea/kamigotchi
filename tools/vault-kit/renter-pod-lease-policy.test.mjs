import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, toBeHex } from "ethers";
import {
  LEASE_PREFS_FLOOR,
  applyLeasePrefsFloor,
  buildKamibotsStartBody,
  normalizeKamibotsPrefs,
  startBodyFloorViolations,
} from "./kamibots-rental-config.mjs";
import { HARDENING_DEFAULTS, hardeningConfigFromEnv } from "./renter-pod-config.mjs";
import {
  EXIT_RESERVE,
  OPERATOR_GAS_DEFAULTS,
  billedActionWei,
  billedFeePerGas,
  flooredLeasePrefs,
  leaseOperatingActions,
  leaseOperatingGasWei,
  leasePolicySnapshot,
} from "./renter-pod-lease-policy.mjs";
import { billedActionGas, exitReservePlan, operatorFeePerGas } from "./renter-pod-safety.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const JSON_FILE = join(here, "renter-pod-lease-policy.json");

/** Minimal JSON-RPC node for ethers' getFeeData(): gas price, priority fee, latest block. */
async function feeNode({ gasPrice, baseFeePerGas, priorityFee }) {
  const server = createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    const one = ({ id, method }) => {
      const reply = (result) => ({ id, jsonrpc: "2.0", result });
      switch (method) {
        case "eth_chainId":
          return reply("0x1");
        case "eth_gasPrice":
          return reply(toBeHex(gasPrice));
        case "eth_maxPriorityFeePerGas":
          return priorityFee == null
            ? { id, jsonrpc: "2.0", error: { code: -32601, message: "the method eth_maxPriorityFeePerGas does not exist" } }
            : reply(toBeHex(priorityFee));
        case "eth_getBlockByNumber":
          return reply({
            number: "0x10",
            hash: `0x${"11".repeat(32)}`,
            parentHash: `0x${"22".repeat(32)}`,
            timestamp: "0x66000000",
            nonce: "0x0000000000000000",
            difficulty: "0x0",
            gasLimit: "0x1c9c380",
            gasUsed: "0x0",
            miner: "0x0000000000000000000000000000000000000000",
            extraData: "0x",
            ...(baseFeePerGas == null ? {} : { baseFeePerGas: toBeHex(baseFeePerGas) }),
            transactions: [],
          });
        default:
          return { id, jsonrpc: "2.0", error: { code: -32601, message: `unsupported ${method}` } };
      }
    };
    const parsed = JSON.parse(body);
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(Array.isArray(parsed) ? parsed.map(one) : one(parsed)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const provider = new JsonRpcProvider(`http://127.0.0.1:${server.address().port}`, 1, { staticNetwork: true });
  return {
    provider,
    close: async () => {
      provider.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("billedFeePerGas (raw RPC values) equals what the worker prices from ethers getFeeData()", async () => {
  const cases = [
    { gasPrice: 2_500_000n, baseFeePerGas: 2_500_000n, priorityFee: 0n }, // live Yominet, 2026-09
    { gasPrice: 2_500_000n, baseFeePerGas: 2_500_000n, priorityFee: null }, // RPC without the priority method
    { gasPrice: 9_000_000n, baseFeePerGas: 1_000_000n, priorityFee: 0n }, // gasPrice above maxFee
    { gasPrice: 2_500_000n, baseFeePerGas: null, priorityFee: 0n }, // no base fee
  ];
  for (const c of cases) {
    const node = await feeNode(c);
    try {
      const feeData = await node.provider.getFeeData();
      for (const pricing of ["eip1559", "legacy"]) {
        const expected = operatorFeePerGas(feeData, pricing);
        const actual = billedFeePerGas({
          gasPrice: c.gasPrice,
          baseFeePerGas: c.baseFeePerGas,
          maxPriorityFeePerGas: c.priorityFee,
          pricing,
        });
        assert.equal(actual, expected, `${JSON.stringify(c, (_k, v) => (typeof v === "bigint" ? String(v) : v))} ${pricing}`);
      }
    } finally {
      await node.close();
    }
  }
  assert.equal(billedFeePerGas({ gasPrice: 2_500_000n, baseFeePerGas: 2_500_000n, maxPriorityFeePerGas: 0n }), 5_000_000n);
});

test("final-verify numbers: 5 Mwei billed, 9.35e12 per action, 3.74e13 stop trigger, 6e13 pullGas target", () => {
  const fee = billedFeePerGas({ gasPrice: 2_500_000n, baseFeePerGas: 2_500_000n, maxPriorityFeePerGas: 0n });
  assert.equal(billedActionGas(OPERATOR_GAS_DEFAULTS.actionGasFloor), 1_870_000n);
  assert.equal(billedActionWei(fee), 9_350_000_000_000n);
  assert.equal(EXIT_RESERVE.actions, 3);
  assert.equal(EXIT_RESERVE.stopTriggerActions, 4);
  assert.equal(EXIT_RESERVE.resumeActions, 6);
  // Same numbers as the worker's own exit-reserve plan.
  const plan = exitReservePlan({
    balance: 0n,
    escrow: 0n,
    gasPrice: fee,
    actionGas: billedActionGas(OPERATOR_GAS_DEFAULTS.actionGasFloor),
    exitReserveActions: HARDENING_DEFAULTS.EXIT_RESERVE_ACTIONS,
    resumeHeadroomActions: HARDENING_DEFAULTS.EXIT_RESUME_HEADROOM_ACTIONS,
  });
  assert.equal(plan.triggerWei, 37_400_000_000_000n);
  assert.equal(plan.triggerWei, billedActionWei(fee) * BigInt(EXIT_RESERVE.stopTriggerActions));
  assert.equal(plan.resumeWei, billedActionWei(fee) * BigInt(EXIT_RESERVE.resumeActions));
  assert.equal(fee * OPERATOR_GAS_DEFAULTS.reserveGasUnits, 60_000_000_000_000n);
  const hardening = hardeningConfigFromEnv({});
  assert.equal(hardening.exitReserveActions, EXIT_RESERVE.actions);
});

test("final-verify repro: the operating budget uses the FLOORED timers (1200/15-min H&F is priced as 300/153)", () => {
  const raw = { strategy: "harvestAndFeed", farmInterval: 1200 * 60, restInterval: 15 * 60, enableFeedInterval: false };
  const unfloored = normalizeKamibotsPrefs(raw, { defaultNode: 1, botNodes: new Set([1]) });
  const floored = flooredLeasePrefs(raw, { node: 1 });
  assert.equal(floored.farmInterval, LEASE_PREFS_FLOOR.farmIntervalMaxSec);
  assert.equal(floored.restInterval, Math.ceil(18_000 * 0.51));
  // The worker runs exactly these prefs (and the body passes its own floor check).
  const body = buildKamibotsStartBody({ node: 1, creds: { privyId: "p" } }, 1, floored);
  assert.deepEqual(startBodyFloorViolations(body), []);
  const day = 86_400;
  const naive = leaseOperatingActions(unfloored, day);
  const real = leaseOperatingActions(floored, day);
  // 1215-min cycle: 2 cycles/day budgeted -> 8 actions; the worker runs 300+153
  // min: 4 cycles/day -> 12 actions (2 per cycle + 4 headroom).
  assert.equal(naive, 8);
  assert.equal(real, 12);
  const fee = 5_000_000n;
  const budget = leaseOperatingGasWei({ prefs: floored, termSecs: day, feePerGas: fee });
  assert.equal(budget, BigInt(real + EXIT_RESERVE.stopTriggerActions) * billedActionWei(fee));
  // A budget of exactly this size keeps the lease above the stop trigger until the last action.
  const afterTerm = budget - BigInt(real) * billedActionWei(fee);
  const plan = exitReservePlan({
    balance: 0n,
    escrow: afterTerm,
    gasPrice: fee,
    actionGas: billedActionGas(OPERATOR_GAS_DEFAULTS.actionGasFloor),
    exitReserveActions: EXIT_RESERVE.actions,
  });
  assert.equal(plan.mode, "ok");
  assert.equal(applyLeasePrefsFloor(unfloored).prefs.restInterval, floored.restInterval);
});

test("the committed renter-pod-lease-policy.json is exactly the module's snapshot", { skip: !existsSync(JSON_FILE) && "json not shipped" }, () => {
  const committed = JSON.parse(readFileSync(JSON_FILE, "utf8"));
  assert.deepEqual(committed, JSON.parse(JSON.stringify(leasePolicySnapshot())), "regenerate: node renter-pod-lease-policy.mjs > renter-pod-lease-policy.json");
  const printed = execFileSync(process.execPath, [join(here, "renter-pod-lease-policy.mjs")], { encoding: "utf8" });
  assert.deepEqual(JSON.parse(printed), committed);
});

test("the snapshot carries every number web and ops must mirror", () => {
  const snap = leasePolicySnapshot();
  assert.equal(snap.prefsFloor.farmIntervalSec.max, 18_000);
  assert.equal(snap.prefsFloor.restPctOfFarmMin, 51);
  assert.equal(snap.prefsFloor.failsafeRestMinSec, 3_600);
  assert.equal(snap.kamibotsPrefLimits.farmIntervalSec.min, 1_200);
  assert.equal(snap.kamibotsPrefLimits.restIntervalSec.max, 30_000);
  assert.equal(snap.gas.defaultPricing, "eip1559");
  assert.equal(snap.gas.billedActionGas, "1870000");
  assert.equal(snap.gas.exitReserveActions, 3);
  assert.equal(snap.gas.operatingBudgetExtraActions, 4);
  assert.equal(snap.gas.examples[0].feePerGasWei, "5000000");
  assert.equal(snap.gas.examples[0].exitStopTriggerWei, "37400000000000");
  assert.equal(snap.gas.examples[2].feePerGasWei, "2500000", "legacy example");
  assert.equal(snap.version, 2);
  assert.equal(snap.reservations.maxActiveLeases, 20);
  assert.equal(snap.reservations.maxActiveLeasesPerRenter, 2);
  assert.equal(snap.reservations.reservationTtlSec, 1_200);
  // Quotes hold no capacity: only the two on-chain scopes remain.
  assert.equal(snap.reservations.quotesHoldCapacity, false);
  assert.deepEqual(Object.keys(snap.reservations.refusalScopes).sort(), ["market", "renter"]);
  assert.doesNotMatch(snap.reservations.refusal429Body, /LISTING_COOLDOWN/);
  for (const retired of ["maxLiveReservations", "maxReservationsPerRenter", "maxReservationsPerListing", "listingSingleCheckout", "listingReserveCooldownSec", "maxReservationAttemptsPerRenter"]) {
    assert.equal(snap.reservations[retired], undefined, retired);
  }
  assert.ok(snap.reservations.retiredSettings.includes("LISTING_SINGLE_CHECKOUT"));
  assert.match(snap.reservations.retryAfterRule, /Retry-After: 60/);
  assert.match(snap.reservations.reserveBody, /tokenIndex/);
  assert.match(snap.reservations.reserveBody, /fundingWei/);
  assert.match(snap.operatorKeys.generation, /CSPRNG/);
  assert.match(snap.operatorKeys.durability, /fsync/);
  assert.match(snap.operatorKeys.ingestRule, /OPERATOR_MISMATCH/);
  assert.doesNotMatch(JSON.stringify(snap), /soft.launch|private.beta/i);
  assert.ok(snap.renterAllowlist.vectors.length >= 10);
});
