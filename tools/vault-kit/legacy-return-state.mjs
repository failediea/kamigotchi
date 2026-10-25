/** Bounded retries for legacy returns; a dead Kami cannot be KamiSent. */
export function returnCheckDue(state, tokenIndex, nowMs) {
  return Number(state.blockedReturns?.[tokenIndex]?.nextCheckAt ?? 0) <= nowMs;
}

export function recordReturnState(state, tokenIndex, kamiState, nowMs) {
  state.blockedReturns ??= {};
  const prior = state.blockedReturns[tokenIndex];
  if (kamiState === "RESTING") {
    delete state.blockedReturns[tokenIndex];
    return { send: true, changed: !!prior, notify: false };
  }
  const reason = kamiState === "DEAD" ? "DEAD" : kamiState === "HARVESTING" ? "HARVESTING" : "STATE_UNAVAILABLE";
  const notify = !prior || prior.reason !== reason || nowMs - Number(prior.lastNotifiedAt) >= 3_600_000;
  state.blockedReturns[tokenIndex] = {
    reason,
    firstSeenAt: prior?.reason === reason ? prior.firstSeenAt : nowMs,
    lastCheckedAt: nowMs,
    nextCheckAt: nowMs + (reason === "DEAD" ? 900_000 : 60_000),
    lastNotifiedAt: notify ? nowMs : prior.lastNotifiedAt,
  };
  return { send: false, changed: true, notify, reason };
}
