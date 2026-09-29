#!/usr/bin/env bash
# lease-expiry-keeper - H7 / CON-01 containment for the sealed v16 markets.
#
# v16 extendLeaseAndTopUp accepts 1 wei and the worker only calls endLease
# after ensureOperatorGas succeeds, so a starved pod operator can keep an
# expired lease alive. KamiLeaseMarket.endLease(tokenIndex) is permissionless
# once block.timestamp > leaseEnd (f781b2d KamiLeaseMarket.sol:635-648). This
# script finds every listing on both v16 markets that is
#     renter != 0  AND  !ending  AND  leaseEnd > 0  AND  now > leaseEnd + EXPIRY_GRACE_SEC
# and (with --apply) calls endLease for it from a SPONSOR wallet. The grace
# gives the worker's own endLease (every 30 s tick) the first chance.
#
# Modes:
#   --dry-run (default)  read-only: list active leases and endLease candidates
#   --apply              send endLease txs (needs SPONSOR_KEY_FILE + SPONSOR_ADDRESS),
#                        at most EXPIRY_MAX_TX_PER_RUN per run, each simulated first
#
# Safety: flock shared with the gas sponsor (one sender per sponsor nonce; a run
# that finds the lock taken skips and exits 0), key file must be root-owned mode
# 600 and is never printed, every tx waits at most TX_WAIT_TIMEOUT_MS. The signer
# signs locally and appends the ledger row ("sent") BEFORE broadcasting
# (reserve-then-confirm), so a lost RPC reply cannot hide a sent tx.
# Before sending, --apply resolves unresolved ledger rows and compares the sponsor's
# pending and latest nonce; while any sponsor tx (keeper or gas sponsor) is still
# in flight it sends nothing and logs [LEASE-ALERT] TX_TIMEOUT source=expiry-keeper.
# Idempotent: a lease that is already ending is not a candidate; a tx that
# would revert (someone else ended it) is skipped by the eth_call simulation.
# Rollback: nothing to roll back on-chain (endLease is what the protocol
# does at expiry anyway); to stop, `systemctl disable --now kami-lease-expiry-keeper.timer`.
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

MODE="dry-run"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    -h|--help) sed -n '2,29p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

LAUNCH_OPS_ENV="${LAUNCH_OPS_ENV:-/etc/kami-lease-ops/launch-ops.env}"
# shellcheck disable=SC1090
if [ -r "$LAUNCH_OPS_ENV" ]; then set -a; . "$LAUNCH_OPS_ENV"; set +a; fi

RPC="${YOMINET_RPC_PUBLIC:-https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz}"
RPC_TIMEOUT_SEC="${RPC_TIMEOUT_SEC:-15}"
MARKETS="${EXPIRY_MARKETS:-${MUSU_MARKET:-0x1FeF5Ce51f9d3BACD0C3f707eEeBbD7A44d69319} ${VIPP_MARKET:-0x4A34d4847D8E2958E4017353e71fAB7afb85bD23}}"
EXPIRY_GRACE_SEC="${EXPIRY_GRACE_SEC:-600}"
EXPIRY_MAX_TX_PER_RUN="${EXPIRY_MAX_TX_PER_RUN:-5}"
TX_WAIT_TIMEOUT_MS="${TX_WAIT_TIMEOUT_MS:-120000}"
SPONSOR_KEY_FILE="${SPONSOR_KEY_FILE:-}"
SPONSOR_ADDRESS="${SPONSOR_ADDRESS:-}"
SPONSOR_MIN_SEND_WEI="${SPONSOR_MIN_SEND_WEI:-100000000000000}" # 1e14: refuse to send below this sponsor balance
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v20.20.0/bin/node}"
ETHERS_NODE_PATH="${ETHERS_NODE_PATH:-/root/kamigotchi/tools/vault-kit/node_modules}"
PERSIST_DIR="${ALERT_PERSIST_DIR:-/var/lib/kami-lease-ops}"
LEDGER="$PERSIST_DIR/expiry-keeper-ledger.tsv"
LOCK_FILE="${SPONSOR_LOCK_FILE:-/run/lock/kami-lease-sponsor-key.lock}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
rpc_result() {
  local out
  out=$(curl -sS -m "$RPC_TIMEOUT_SEC" -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC" 2>/dev/null) || return 1
  # jq-free on purpose: a JSON-RPC reply is {"jsonrpc","id","result":"0x.."} or {"error":..}
  local r
  r=$(sed -nE 's/.*"result"[[:space:]]*:[[:space:]]*"(0x[0-9a-fA-F]*)".*/\1/p' <<<"$out")
  [ -n "$r" ] || return 1
  printf '%s' "$r"
}
eth_call() { rpc_result eth_call "[{\"to\":\"$1\",\"data\":\"$2\"},\"latest\"]"; }
rpc_raw() { # method params -> raw JSON reply (non-zero unless it carries a "result")
  local out
  out=$(curl -sS -m "$RPC_TIMEOUT_SEC" -X POST -H 'content-type: application/json' \
    --data "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$1\",\"params\":$2}" "$RPC" 2>/dev/null) || return 1
  grep -q '"result"' <<<"$out" || return 1
  printf '%s' "$out"
}
result_is_null() { grep -Eq '"result"[[:space:]]*:[[:space:]]*null' <<<"$1"; }
eth_call_from() { rpc_result eth_call "[{\"from\":\"$1\",\"to\":\"$2\",\"data\":\"$3\"},\"latest\"]"; }
word() { local h=${1#0x}; printf '%s' "${h:$(( $2 * 64 )):64}"; }
hex2dec() { local h=${1#0x}; h="${h#"${h%%[!0]*}"}"; if [ -z "$h" ]; then echo 0; elif [ ${#h} -gt 15 ]; then echo 1152921504606846975; else echo $((16#$h)); fi; }
u32word() { printf '%064x' "$1"; }
wei_eth() { awk -v w="$1" 'BEGIN{printf "%.6f", w/1e18}'; }
fmt_ts() { date -u -d "@$1" +%FT%TZ 2>/dev/null || echo "$1"; }

# Signs and sends one legacy (type 0) tx with ethers from the VPS vault-kit.
# The key is read from SPONSOR_KEY_FILE inside node and never echoed.
# Reserve-then-confirm (same as lease-gas-sponsor.sh): sign locally, append the
# "sent" ledger row BEFORE broadcasting (no broadcast when the append fails, exit 4);
# a lost broadcast reply (exit 5) or receipt timeout (exit 1) leaves the row, so the
# next run sees the tx in flight instead of sending a duplicate.
SIGNER_JS='
const fs = require("fs");
const { FetchRequest, JsonRpcProvider, Wallet, keccak256 } = require("ethers");
const short = (e) => String((e && (e.shortMessage || e.message)) || e).slice(0, 300);
(async () => {
  const key = fs.readFileSync(process.env.KEY_FILE, "utf8").trim();
  const request = new FetchRequest(process.env.RPC);
  request.timeout = Number(process.env.SIGNER_RPC_TIMEOUT_MS || 20000);
  const provider = new JsonRpcProvider(request, undefined, { batchMaxCount: 1 });
  const wallet = new Wallet(key, provider);
  if (wallet.address.toLowerCase() !== String(process.env.EXPECT_FROM).toLowerCase()) {
    throw new Error("SPONSOR_KEY_FILE does not match SPONSOR_ADDRESS");
  }
  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gas price");
  const tx = { to: process.env.TX_TO, data: process.env.TX_DATA || "0x", value: BigInt(process.env.TX_VALUE || "0"), type: 0, gasPrice };
  tx.gasLimit = ((await provider.estimateGas({ ...tx, from: wallet.address })) * 12n) / 10n;
  const populated = await wallet.populateTransaction(tx);
  const raw = await wallet.signTransaction(populated);
  const hash = keccak256(raw);
  try {
    fs.appendFileSync(process.env.LEDGER_FILE, [Math.floor(Date.now() / 1000), process.env.LEDGER_ROW, hash, populated.nonce, "sent"].join("\t") + "\n");
  } catch (e) { console.error("ledger append failed, NOT broadcasting: " + short(e)); process.exit(4); }
  console.log("TXHASH " + hash);
  try {
    await provider.broadcastTransaction(raw);
  } catch (e) { console.error("broadcast failed or its reply was lost (ledger row kept): " + short(e)); process.exit(5); }
  const receipt = await provider.waitForTransaction(hash, 1, Number(process.env.TX_WAIT_TIMEOUT_MS || 120000));
  if (!receipt) throw new Error("no receipt for " + hash);
  console.log("STATUS " + receipt.status + " GASUSED " + receipt.gasUsed);
  if (receipt.status !== 1) process.exit(3);
})().catch((e) => { console.error("send failed: " + short(e)); process.exit(1); });
'
send_tx() { # to data value ledger_row -> stdout lines TXHASH/STATUS; non-zero on failure
  KEY_FILE="$SPONSOR_KEY_FILE" EXPECT_FROM="$SPONSOR_ADDRESS" RPC="$RPC" TX_TO="$1" TX_DATA="$2" TX_VALUE="$3" \
    LEDGER_FILE="$LEDGER" LEDGER_ROW="$4" SIGNER_RPC_TIMEOUT_MS="${SIGNER_RPC_TIMEOUT_MS:-20000}" \
    TX_WAIT_TIMEOUT_MS="$TX_WAIT_TIMEOUT_MS" NODE_PATH="$ETHERS_NODE_PATH" "$NODE_BIN" -e "$SIGNER_JS"
}

# Ledger rows (tab separated):
#   <ts> endLease <market> <token> <hash> <nonce> sent     (written by the signer, before broadcasting)
#   <ts> result   -        -       <hash> -       mined|reverted|dropped
INFLIGHT=0
resolve_ledger() { # checks every endLease row without a result row; appends results in --apply
  INFLIGHT=0
  [ -r "$LEDGER" ] || return 0
  local h raw st
  for h in $(awk -F'\t' '$2=="endLease"{s[$5]=1} $2=="result"{r[$5]=1} END{for (h in s) if (!(h in r) && h ~ /^0x/) print h}' "$LEDGER"); do
    if ! raw=$(rpc_raw eth_getTransactionReceipt "[\"$h\"]"); then
      INFLIGHT=$((INFLIGHT + 1)); log "  ledger tx $h: receipt read failed (treated as in flight)"; continue
    fi
    if result_is_null "$raw"; then
      if ! raw=$(rpc_raw eth_getTransactionByHash "[\"$h\"]"); then
        INFLIGHT=$((INFLIGHT + 1)); log "  ledger tx $h: lookup failed (treated as in flight)"; continue
      fi
      if ! result_is_null "$raw"; then
        INFLIGHT=$((INFLIGHT + 1)); log "  ledger tx $h: still in flight (known to the node, not mined)"; continue
      fi
      st=dropped
    elif grep -Eq '"status"[[:space:]]*:[[:space:]]*"0x0*1"' <<<"$raw"; then
      st=mined
    else
      st=reverted
    fi
    log "  ledger tx $h resolved: $st"
    [ "$MODE" != apply ] || printf '%s\tresult\t-\t-\t%s\t-\t%s\n' "$(date +%s)" "$h" "$st" >> "$LEDGER"
  done
}
sponsor_nonce_inflight() { # adds (pending - latest) of the sponsor address to INFLIGHT
  local nl np
  nl=$(rpc_result eth_getTransactionCount "[\"$SPONSOR_ADDRESS\",\"latest\"]") || return 1
  np=$(rpc_result eth_getTransactionCount "[\"$SPONSOR_ADDRESS\",\"pending\"]") || return 1
  nl=$(hex2dec "$nl"); np=$(hex2dec "$np")
  if [ "$np" -gt "$nl" ]; then INFLIGHT=$((INFLIGHT + np - nl)); log "  sponsor nonce pending=$np > latest=$nl"; fi
  return 0
}

check_key_file() {
  [ -n "$SPONSOR_KEY_FILE" ] || die "--apply needs SPONSOR_KEY_FILE (path to a root-owned mode-600 file holding the sponsor key)"
  [ -n "$SPONSOR_ADDRESS" ] || die "--apply needs SPONSOR_ADDRESS (public address of that key)"
  [ -f "$SPONSOR_KEY_FILE" ] || die "SPONSOR_KEY_FILE does not exist"
  local perm owner
  perm=$(stat -c %a "$SPONSOR_KEY_FILE"); owner=$(stat -c %U "$SPONSOR_KEY_FILE")
  [ "$perm" = 600 ] || [ "$perm" = 400 ] || die "SPONSOR_KEY_FILE mode is $perm; must be 600 or 400"
  [ "$owner" = "$(id -un)" ] || die "SPONSOR_KEY_FILE owner is $owner; must be $(id -un)"
  [ -x "$NODE_BIN" ] || die "NODE_BIN $NODE_BIN not executable"
  [ -d "$ETHERS_NODE_PATH/ethers" ] || die "ethers not found under ETHERS_NODE_PATH"
}

command -v curl >/dev/null || die "curl is required"

if [ "$MODE" = apply ]; then
  check_key_file
  mkdir -p "$PERSIST_DIR" "$(dirname "$LOCK_FILE")"
  exec 9>"$LOCK_FILE"
  # The gas sponsor holds this lock while it waits on its own txs. Skipping is
  # correct (the next timer run retries) and must not fire the OnFailure push.
  if ! flock -n 9; then
    log "another sponsor-key job (gas sponsor?) holds $LOCK_FILE; skipping this run"
    exit 0
  fi
fi

NOW=$(date +%s)
log "lease-expiry-keeper mode=$MODE grace=${EXPIRY_GRACE_SEC}s maxTx=$EXPIRY_MAX_TX_PER_RUN rpc=$RPC"

if [ -n "$SPONSOR_ADDRESS" ]; then
  sb=$(rpc_result eth_getBalance "[\"$SPONSOR_ADDRESS\",\"latest\"]" || true)
  [ -n "$sb" ] && log "sponsor $SPONSOR_ADDRESS balance $(wei_eth "$(hex2dec "$sb")") ETH"
fi

CANDIDATES=()
for market in $MARKETS; do
  n_hex=$(eth_call "$market" 0x90af04c1) || die "numListings() failed on $market" # numListings()
  n=$(hex2dec "$n_hex")
  f_hex=$(eth_call "$market" 0xe1fc685a) || die "leaseFactory() failed on $market"
  factory="0x$(word "$f_hex" 0 | cut -c25-64)"
  log "market $market factory $factory listings=$n (only leased listings are printed below)"
  for ((i = 0; i < n; i++)); do
    t_hex=$(eth_call "$market" "0x44d110b9$(u32word "$i")") || die "tokenIndices($i) failed" # tokenIndices(uint256)
    tok=$(hex2dec "$t_hex")
    l=$(eth_call "$market" "0xf81c2347$(u32word "$tok")") || die "listings($tok) failed" # listings(uint32)
    renter="0x$(word "$l" 8 | cut -c25-64)"
    ending=$(hex2dec "$(word "$l" 7)")
    lease_end=$(hex2dec "$(word "$l" 12)")
    [ "$renter" != "0x0000000000000000000000000000000000000000" ] || continue
    r=$(eth_call "$factory" "0x0ab469b0$(u32word "$tok")" || echo "") # requests(uint32)
    stage=$([ -n "$r" ] && hex2dec "$(word "$r" 5)" || echo "?")
    overdue=$((NOW - lease_end))
    status="active"
    if [ "$ending" = 1 ]; then
      status="ending"
    elif [ "$lease_end" -gt 0 ] && [ "$overdue" -gt "$EXPIRY_GRACE_SEC" ]; then
      status="CANDIDATE"
      CANDIDATES+=("$market:$tok")
    elif [ "$lease_end" -gt 0 ] && [ "$overdue" -gt 0 ]; then
      status="expired-within-grace"
    fi
    log "  #$tok renter=$renter stage=$stage leaseEnd=$(fmt_ts "$lease_end") overdue=${overdue}s -> $status"
  done
done

log "${#CANDIDATES[@]} endLease candidate(s): ${CANDIDATES[*]:-none}"
if [ "${#CANDIDATES[@]}" -gt 0 ]; then
  cands="${CANDIDATES[*]}"
  log "[LEASE-ALERT] STAGE_STUCK source=expiry-keeper reason=expired-not-ending count=${#CANDIDATES[@]} candidates=${cands// /,} mode=$MODE"
fi
resolve_ledger
[ -z "$SPONSOR_ADDRESS" ] || sponsor_nonce_inflight || {
  [ "$MODE" = apply ] && die "cannot read the sponsor nonce (latest/pending); not sending"
  log "  sponsor nonce not readable (dry-run: ignored)"
}
[ "$MODE" = apply ] || { log "[dry-run] no transactions sent"; exit 0; }
[ "${#CANDIDATES[@]}" -gt 0 ] || exit 0
if [ "$INFLIGHT" -gt 0 ]; then
  log "[LEASE-ALERT] TX_TIMEOUT source=expiry-keeper sponsor=$SPONSOR_ADDRESS inflight=$INFLIGHT action=no-new-sends candidates=${#CANDIDATES[@]}"
  exit 0
fi

sb=$(rpc_result eth_getBalance "[\"$SPONSOR_ADDRESS\",\"latest\"]") || die "cannot read sponsor balance"
if [ "$(hex2dec "$sb")" -lt "$SPONSOR_MIN_SEND_WEI" ]; then
  log "[LEASE-ALERT] ESCROW_LOW source=expiry-keeper sponsor=$SPONSOR_ADDRESS balance=$(hex2dec "$sb") min=$SPONSOR_MIN_SEND_WEI reason=sponsor-below-min action=not-sending"
  exit 1
fi

sent=0
failed=0
for c in "${CANDIDATES[@]}"; do
  if [ "$sent" -ge "$EXPIRY_MAX_TX_PER_RUN" ]; then
    log "[LEASE-ALERT] STAGE_STUCK source=expiry-keeper reason=per-run-cap cap=$EXPIRY_MAX_TX_PER_RUN"
    break
  fi
  market=${c%%:*}; tok=${c##*:}
  data="0xd2267fe9$(u32word "$tok")" # endLease(uint32)
  if ! eth_call_from "$SPONSOR_ADDRESS" "$market" "$data" >/dev/null; then
    log "skip #$tok on $market: endLease simulation reverts (already ending or no longer leased)"
    continue
  fi
  log "sending endLease(#$tok) on $market"
  rc=0; out=$(send_tx "$market" "$data" 0 "endLease"$'\t'"$market"$'\t'"$tok" 2>&1) || rc=$?
  hash=$(sed -n 's/^TXHASH //p' <<<"$out" | head -1)
  if [ "$rc" = 0 ]; then
    log "endLease #$tok ok tx=$hash"
    printf '%s\tresult\t-\t-\t%s\t-\tmined\n' "$(date +%s)" "$hash" >> "$LEDGER"
    sent=$((sent + 1))
  else
    [ -n "$hash" ] && [ "$rc" = 3 ] && printf '%s\tresult\t-\t-\t%s\t-\treverted\n' "$(date +%s)" "$hash" >> "$LEDGER"
    log "[LEASE-ALERT] TX_TIMEOUT source=expiry-keeper market=$market token=$tok hash=${hash:-none} exit=$rc detail=$(tail -1 <<<"$out" | tr ' ' '_' | cut -c1-160)"
    failed=$((failed + 1))
    sent=$((sent + 1))
    # Only a mined revert (rc 3: e.g. someone else ended it first) moves on to the next
    # candidate. Anything else stops the run: a written ledger row may be in flight
    # (the next run resolves it first), and without a hash the signer itself is failing.
    [ "$rc" = 3 ] || break
  fi
done
log "done: sent=$sent failed=$failed"
[ "$failed" -eq 0 ]
exit $?
}
