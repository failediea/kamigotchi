/** Infrastructure limits refuse NEW keys only; they never evict a signed key. */
export const ALLOCATION_LIMITS = Object.freeze({ maxKeys: 20000, maxConcurrent: 16, perMinute: 1200 });

export function allocationLimit(value, fallback, name) {
  if (value === undefined || String(value).trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > 1_000_000) {
    throw new Error(`${name} must be an integer between 1 and 1000000`);
  }
  return number;
}

export function createAllocationLimiter({ maxKeys = ALLOCATION_LIMITS.maxKeys, perMinute = ALLOCATION_LIMITS.perMinute, now = Date.now } = {}) {
  let windowStart = now();
  let allocations = 0;
  return function admit(reservations) {
    const at = now();
    if (at - windowStart >= 60_000 || at < windowStart) { windowStart = at; allocations = 0; }
    // Records are fixed-size addresses, scalar keys, digest and numeric metadata.
    // A count ceiling therefore bounds memory independently of API rate limits.
    if (Object.keys(reservations ?? {}).length >= maxKeys) return "KEY_STORE_CAPACITY";
    if (allocations >= perMinute) return "KEY_ALLOCATION_RATE";
    allocations++;
    return null;
  };
}
