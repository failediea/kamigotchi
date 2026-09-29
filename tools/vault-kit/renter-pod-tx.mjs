import { LeaseAlertCode } from "./renter-pod-alerts.mjs";

/**
 * Bounded transaction waits with duplicate-send protection.
 *
 * Every worker action is re-derived from chain state on each tick. Before this
 * module, `await (await tx).wait()` blocked forever on a dropped tx; simply
 * adding a timeout would make the NEXT tick re-derive the same action and send
 * it again while the first tx may still be in the mempool - a second tx that
 * at best reverts and burns renter-escrowed gas.
 *
 * So a tx that times out is remembered (durably, in state.pendingTxs, keyed by
 * job) and that job sends nothing else until the tx is resolved:
 *   - mined (receipt exists)                    -> clear, job continues
 *   - still known to the node (in the mempool)   -> job stays paused
 *   - unknown and its nonce not yet consumed     -> dropped; clear, so the next
 *     send reuses the same nonce (ethers takes the "pending" nonce count)
 *   - unknown and its nonce consumed             -> replaced/mined elsewhere;
 *     clear (chain state decides what happens next)
 */
export class TxPendingError extends Error {
  constructor(key, pending) {
    super(`tx ${pending.hash} (${pending.label}) for ${key} is still pending; not sending another`);
    this.name = "TxPendingError";
    this.key = key;
    this.pending = pending;
  }
}

export class TxTimeoutError extends Error {
  constructor(key, pending, timeoutMs) {
    super(`tx ${pending.hash} (${pending.label}) for ${key} not mined within ${timeoutMs} ms; job left retryable`);
    this.name = "TxTimeoutError";
    this.key = key;
    this.pending = pending;
  }
}

function isTimeout(error) {
  return error?.code === "TIMEOUT" || /wait for transaction timeout/i.test(String(error?.message ?? error));
}

function isDefiniteOutcome(error) {
  return error?.code === "CALL_EXCEPTION" || error?.code === "TRANSACTION_REPLACED";
}

export function createTxTracker({
  state,
  provider,
  timeoutMs,
  alert = () => {},
  persist = () => {},
  now = () => Date.now(),
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("tx wait timeout must be positive");
  state.pendingTxs ??= {};

  function clear(key) {
    if (!state.pendingTxs[key]) return;
    delete state.pendingTxs[key];
    persist();
  }

  /** Resolve a remembered tx. Returns null when the key is free to send. */
  async function pendingFor(key) {
    const pending = state.pendingTxs[key];
    if (!pending) return null;
    const receipt = await provider.getTransactionReceipt(pending.hash);
    if (receipt) {
      clear(key);
      return null;
    }
    const known = await provider.getTransaction(pending.hash);
    if (known) {
      alert(
        LeaseAlertCode.TX_TIMEOUT,
        {
          job: key,
          label: pending.label,
          hash: pending.hash,
          nonce: pending.nonce,
          from: pending.from,
          pendingSec: Math.floor((now() - Number(pending.sentAt || 0)) / 1000),
          state: "still-pending",
        },
        { key: `pending:${key}` }
      );
      return pending;
    }
    // Unknown to the node and never mined: dropped (its nonce is free again and
    // the next send reuses it) or replaced by another tx at the same nonce.
    // Either way nothing of ours is outstanding under this key any more.
    clear(key);
    return null;
  }

  /**
   * Send and wait with a deadline. `sendFn` must return the ethers
   * TransactionResponse promise (e.g. () => contract.fn(args)).
   */
  async function send(key, label, sendFn) {
    const outstanding = await pendingFor(key);
    if (outstanding) throw new TxPendingError(key, outstanding);
    const tx = await sendFn();
    const record = {
      hash: tx.hash,
      nonce: tx.nonce,
      from: tx.from,
      label,
      sentAt: now(),
    };
    state.pendingTxs[key] = record;
    // Durable before waiting: a watchdog restart must still know this tx exists.
    persist();
    try {
      const receipt = await tx.wait(1, timeoutMs);
      clear(key);
      return receipt;
    } catch (error) {
      if (isTimeout(error)) {
        alert(
          LeaseAlertCode.TX_TIMEOUT,
          {
            job: key,
            label,
            hash: record.hash,
            nonce: record.nonce,
            from: record.from,
            timeoutMs,
          },
          { key: `timeout:${key}` }
        );
        throw new TxTimeoutError(key, record, timeoutMs);
      }
      // A revert receipt or a replacement is a definite outcome. Anything else
      // (RPC hiccup mid-wait) is not: keep the record so the next tick resolves
      // it from the receipt/mempool instead of blindly sending again.
      if (isDefiniteOutcome(error)) clear(key);
      throw error;
    }
  }

  return { send, pendingFor, clear };
}
