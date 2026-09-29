import { keccak256 } from "ethers";
import { LeaseAlertCode } from "./renter-pod-alerts.mjs";

/**
 * Bounded transaction waits with duplicate-send protection.
 *
 * Every worker action is re-derived from chain state on each tick. Before this
 * module, `await (await tx).wait()` blocked forever on a dropped tx; simply
 * adding a timeout would make the NEXT tick re-derive the same action and send
 * it again while the first tx may still be in the mempool - a second tx that
 * at best reverts and burns renter-escrowed gas (and for pullGas, which is not
 * idempotent, moves more escrow onto the operator EOA).
 *
 * So every tx is SIGNED LOCALLY and its record {hash, nonce, from, raw} is
 * persisted (state.pendingTxs, keyed by job) BEFORE it is broadcast. A
 * broadcast that times out client-side, a crash or a watchdog restart
 * therefore never leaves an unrecorded tx behind. That job sends nothing else
 * until the record is resolved:
 *   - mined (receipt exists)                       -> clear, job continues
 *   - still known to the node (in the mempool)      -> job stays paused
 *   - unknown, and the account nonce has moved past
 *     the record's nonce (mined / replaced)         -> clear; chain state decides
 *   - unknown, nonce NOT consumed                   -> rebroadcast the stored raw
 *     tx (same hash, idempotent) and keep waiting; only after it has been
 *     unseen for dropAfterMs is it declared dropped. The freed nonce is then
 *     remembered (state.txNonceHints) and the next send for that job from the
 *     same address reuses it explicitly, so a late original and the retry can
 *     never both be mined.
 *
 * A node may hide mempool txs from eth_getTransactionByHash. Its refusals are
 * then the only evidence that the tx still exists, so:
 *   - a rebroadcast refused as "already known" (or as an underpriced
 *     replacement, i.e. another tx holds the nonce) counts as SEEN: the tx is
 *     still pending and is never declared dropped on that basis;
 *   - a resend on a hinted nonce refused the same way restores the original
 *     record (kept on the hint) instead of forgetting the nonce, and the hint
 *     itself is kept until the account's "latest" nonce has passed it. A
 *     second tx at nonce+1 can therefore never be signed while the original
 *     may still mine.
 * A record that lay DORMANT (not checked by this code for dormantAfterMs, e.g.
 * across a rollback to the pre-hardening worker and back) is never
 * rebroadcast: its bytes were derived from chain state that may be long gone.
 * It is still resolved by receipt / nonce, and dropped after dropAfterMs with
 * its nonce pinned for the next send.
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

const lower = (value) => String(value ?? "").toLowerCase();
const text = (error) => (error instanceof Error ? error.message : String(error)).slice(0, 200);

function isTimeout(error) {
  return error?.code === "TIMEOUT" || /wait for transaction timeout/i.test(String(error?.message ?? error));
}

function isDefiniteOutcome(error) {
  return error?.code === "CALL_EXCEPTION" || error?.code === "TRANSACTION_REPLACED";
}

/**
 * The node definitively refused the broadcast, so this tx is not in any
 * mempool and can never be mined: safe to forget. Anything else (timeout,
 * socket error, 5xx) is ambiguous - the node may have accepted it.
 */
export function isDefiniteBroadcastRejection(error) {
  const code = error?.code;
  if (code === "INSUFFICIENT_FUNDS" || code === "NONCE_EXPIRED" || code === "REPLACEMENT_UNDERPRICED") return true;
  const message = String(error?.error?.message ?? error?.info?.error?.message ?? error?.message ?? "");
  return /insufficient funds|nonce too low|replacement transaction underpriced|intrinsic gas too low|exceeds block gas limit/i
    .test(message);
}

function errorTexts(error) {
  return [
    error?.shortMessage,
    error?.message,
    error?.error?.message,
    error?.info?.error?.message,
  ].filter(Boolean).join(" | ");
}

/**
 * The node refused a broadcast because a tx with this nonce from this sender
 * is ALREADY in its mempool: either these exact bytes ("already known",
 * "known transaction") or another tx it will not replace ("replacement
 * transaction underpriced"). Either way the nonce is occupied by a tx that can
 * still be mined, so nothing of ours is free to go out at a later nonce.
 */
export function isNonceHeldByMempool(error) {
  if (error?.code === "REPLACEMENT_UNDERPRICED") return true;
  return /already known|known transaction|alreadyknown|already exists|already in (the )?(mempool|tx ?pool)|replacement transaction underpriced|replacement fee too low/i
    .test(errorTexts(error));
}

/** Default for records that were not checked by this tracker for this long. */
export const DEFAULT_DORMANT_AFTER_MS = 60 * 60_000;

export function createTxTracker({
  state,
  provider,
  timeoutMs,
  dropAfterMs = 2 * timeoutMs,
  dormantAfterMs = DEFAULT_DORMANT_AFTER_MS,
  feeOverrides = async () => ({}),
  alert = () => {},
  persist = () => {},
  now = () => Date.now(),
}) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("tx wait timeout must be positive");
  if (!Number.isFinite(dropAfterMs) || dropAfterMs <= 0) throw new Error("tx drop age must be positive");
  if (!Number.isFinite(dormantAfterMs) || dormantAfterMs <= dropAfterMs) {
    throw new Error("tx dormant age must exceed the drop age");
  }
  state.pendingTxs ??= {};
  state.txNonceHints ??= {};

  function clear(key) {
    if (!state.pendingTxs[key]) return;
    delete state.pendingTxs[key];
    persist();
  }

  function pendingAlert(key, pending, extra) {
    alert(
      LeaseAlertCode.TX_TIMEOUT,
      {
        job: key,
        label: pending.label,
        hash: pending.hash,
        nonce: pending.nonce,
        from: pending.from,
        pendingSec: Math.floor((now() - Number(pending.sentAt || 0)) / 1000),
        ...extra,
      },
      { key: `pending:${key}` }
    );
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
    // Dormant: nothing checked this record for dormantAfterMs (the worker was
    // stopped or rolled back meanwhile). Decided BEFORE checkedAt is renewed.
    const lastLook = Number(pending.checkedAt ?? pending.sentAt ?? 0);
    if (!pending.noRebroadcast && now() - lastLook > dormantAfterMs) pending.noRebroadcast = "dormant";
    pending.checkedAt = now();

    const known = await provider.getTransaction(pending.hash);
    if (known) {
      if (pending.unseenSince != null) {
        delete pending.unseenSince;
        persist();
      }
      pendingAlert(key, pending, { state: "still-pending" });
      return pending;
    }

    // Unknown to this node. A lagging or flaky RPC can say that about a tx
    // that is still in the mempool, so decide from the account nonce, never
    // from a single null.
    const latest = Number(await provider.getTransactionCount(pending.from, "latest"));
    if (Number.isFinite(latest) && latest > Number(pending.nonce)) {
      // The nonce is used up: our tx (receipt not yet served) or a
      // replacement was mined. Nothing of ours can be mined any more.
      clear(key);
      return null;
    }

    if (pending.raw && !pending.noRebroadcast) {
      try {
        await provider.broadcastTransaction(pending.raw);
        pending.rebroadcasts = (Number(pending.rebroadcasts) || 0) + 1;
        delete pending.lastRebroadcastError;
      } catch (error) {
        pending.lastRebroadcastError = text(error);
        if (isNonceHeldByMempool(error)) {
          // The node still holds this tx (or another at its nonce) even though
          // it will not show it: the same evidence as a non-null getTransaction.
          delete pending.unseenSince;
          pending.heldByMempoolAt = now();
          persist();
          pendingAlert(key, pending, { state: "still-pending", via: "rebroadcast-refused-known" });
          return pending;
        }
      }
    }
    pending.unseenSince ??= now();
    persist();
    const unseenMs = now() - Number(pending.unseenSince);
    if (unseenMs < dropAfterMs) {
      pendingAlert(key, pending, {
        state: pending.noRebroadcast ? "unseen-dormant" : "unseen-rebroadcast",
        unseenSec: Math.floor(unseenMs / 1000),
      });
      return pending;
    }

    // Unseen for dropAfterMs with its nonce still free: dropped. The next send
    // for this job from the same address reuses this nonce explicitly; the
    // record is kept on the hint so a refused resend can restore it.
    const { unseenSince: _unseen, ...prevRecord } = pending;
    state.txNonceHints[key] = {
      from: pending.from,
      nonce: Number(pending.nonce),
      label: pending.label,
      at: now(),
      prevRecord,
    };
    delete state.pendingTxs[key];
    persist();
    return null;
  }

  /**
   * Explicit nonce for a resend after a declared drop (see pendingFor). The
   * hint lives until the account's "latest" nonce has passed it: only then is
   * it certain that no tx of ours can still be mined at that nonce.
   */
  async function hintedNonce(key, from) {
    const hint = state.txNonceHints[key];
    if (!hint) return undefined;
    if (lower(hint.from) !== lower(from)) return undefined;
    const latest = Number(await provider.getTransactionCount(from, "latest"));
    if (Number.isFinite(latest) && latest > Number(hint.nonce)) {
      delete state.txNonceHints[key];
      persist();
      return undefined;
    }
    return Number(hint.nonce);
  }

  /**
   * A resend on a hinted nonce was refused because the nonce is still held in
   * the mempool: the "dropped" original is alive. Put its record back (or,
   * for a hint without one, the refused record, which stands for "nonce N is
   * occupied") so the job stays paused until that nonce resolves.
   */
  function restoreHeldOriginal(key, hint, refused, error) {
    const restored = { ...(hint.prevRecord ?? refused) };
    delete restored.unseenSince;
    restored.checkedAt = now();
    restored.restoredAt = now();
    restored.lastRebroadcastError = text(error);
    state.pendingTxs[key] = restored;
    persist();
    pendingAlert(key, restored, { state: "resend-refused-original-pending", resendHash: refused.hash });
    return new TxPendingError(key, restored);
  }

  /**
   * Sign, record, broadcast and wait with a deadline.
   *   signer    ethers Wallet connected to the provider
   *   request   unsigned tx (or a function returning one), e.g.
   *             () => contract.getFunction("endLease").populateTransaction(7)
   *   preflight optional async check run right before signing (throws to abort)
   */
  async function send(key, label, { signer, request, preflight }) {
    const outstanding = await pendingFor(key);
    if (outstanding) throw new TxPendingError(key, outstanding);
    if (preflight) await preflight();

    const unsigned = typeof request === "function" ? await request() : request;
    // Explicit fields on the request (returnGas prices itself) win over the
    // configured fee policy.
    const txRequest = { ...(await feeOverrides()), ...unsigned };
    const from = signer.address;
    let hint = null;
    if (txRequest.nonce == null) {
      const nonce = await hintedNonce(key, from);
      if (nonce !== undefined) {
        txRequest.nonce = nonce;
        hint = state.txNonceHints[key];
      }
    }
    const populated = await signer.populateTransaction(txRequest);
    const raw = await signer.signTransaction(populated);
    const record = {
      hash: keccak256(raw),
      nonce: Number(populated.nonce),
      from,
      label,
      sentAt: now(),
      raw,
    };
    state.pendingTxs[key] = record;
    // The nonce hint (if any) stays: hintedNonce drops it once the chain's
    // "latest" nonce has passed it, never merely because we sent again.
    // Durable BEFORE broadcasting: whatever happens next, this tx is known.
    persist();

    let response;
    try {
      response = await provider.broadcastTransaction(raw);
    } catch (error) {
      if (hint && Number(hint.nonce) === record.nonce && isNonceHeldByMempool(error)) {
        throw restoreHeldOriginal(key, hint, record, error);
      }
      if (isDefiniteBroadcastRejection(error)) clear(key);
      // Otherwise (timeout, socket error) the node may have accepted it: keep
      // the record; the next tick resolves it via receipt / mempool / nonce.
      throw error;
    }

    try {
      const receipt = await response.wait(1, timeoutMs);
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
