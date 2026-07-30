function normalizedHash(value, label) {
  const hash = String(value ?? "").toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error(`invalid ${label}`);
  return hash;
}

export function eventIdentity(event) {
  const index = Number(event?.index ?? event?.logIndex);
  if (!Number.isSafeInteger(index) || index < 0) throw new Error("invalid event log index");
  const blockHash = normalizedHash(event?.blockHash, "event block hash");
  const transactionHash = normalizedHash(event?.transactionHash, "event transaction hash");
  return {
    blockHash,
    transactionHash,
    index,
    id: `${transactionHash}:${index}`,
  };
}

export function checkpointForBlock(block) {
  const blockNumber = Number(block?.number ?? block?.blockNumber);
  if (!Number.isSafeInteger(blockNumber) || blockNumber < 0) {
    throw new Error("invalid event cursor block number");
  }
  return {
    blockNumber,
    blockHash: normalizedHash(block?.hash ?? block?.blockHash, "event cursor block hash"),
  };
}

/** A stored cursor is a security boundary: silently continuing from a
 * different block at the same height can skip the canonical replacement log
 * and permanently lose the operator reservation associated with it. */
export function assertCanonicalCheckpoint(stored, canonicalBlock) {
  if (!stored) return;
  const expected = checkpointForBlock(stored);
  let canonical;
  try {
    canonical = checkpointForBlock(canonicalBlock);
  } catch {
    throw new Error(
      `event cursor block ${expected.blockNumber} is unavailable; stop and reconcile worker state before restarting`
    );
  }
  if (
    canonical.blockNumber !== expected.blockNumber ||
    canonical.blockHash !== expected.blockHash
  ) {
    throw new Error(
      `event cursor reorg at block ${expected.blockNumber}: expected ${expected.blockHash}, canonical ${canonical.blockHash}; stop and reconcile reservations/jobs before resetting the cursor`
    );
  }
}

export function assertCursorSequence(lastBlock, checkpoint) {
  if (!checkpoint || !lastBlock) return;
  if (Number(lastBlock) !== Number(checkpoint.blockNumber) + 1) {
    throw new Error("worker event cursor is inconsistent; stop and reconcile state before restarting");
  }
}
