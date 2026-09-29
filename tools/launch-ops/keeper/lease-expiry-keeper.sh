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
# Safety: flock shared with the gas sponsor (one sender per sponsor nonce),
# key file must be root-owned mode 600 and is never printed, every tx waits at
# most TX_WAIT_TIMEOUT_MS, a ledger line is appended per tx.
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
    -h|--help) sed -n '2,26p' "$0" 2>/dev/null || true; exit 0 ;;
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
eth_call_from() { rpc_result eth_call "[{\"from\":\"$1\",\"to\":\"$2\",\"data\":\"$3\"},\"latest\"]"; }
word() { local h=${1#0x}; printf '%s' "${h:$(( $2 * 64 )):64}"; }
hex2dec() { local h=${1#0x}; h="${h#"${h%%[!0]*}"}"; if [ -z "$h" ]; then echo 0; elif [ ${#h} -gt 15 ]; then echo 1152921504606846975; else echo $((16#$h)); fi; }
u32word() { printf '%064x' "$1"; }
wei_eth() { awk -v w="$1" 'BEGIN{printf "%.6f", w/1e18}'; }
fmt_ts() { date -u -d "@$1" +%FT%TZ 2>/dev/null || echo "$1"; }

# Signs and sends one legacy (type 0) tx with ethers from the VPS vault-kit.
# The key is read from SPONSOR_KEY_FILE inside node and never echoed.
SIGNER_JS='
const fs = require("fs");
const { JsonRpcProvider, Wallet } = require("ethers");
(async () => {
  const key = fs.readFileSync(process.env.KEY_FILE, "utf8").trim();
  const provider = new JsonRpcProvider(process.env.RPC);
  const wallet = new Wallet(key, provider);
  if (wallet.address.toLowerCase() !== String(process.env.EXPECT_FROM).toLowerCase()) {
    throw new Error("SPONSOR_KEY_FILE does not match SPONSOR_ADDRESS");
  }
  const gasPrice = (await provider.getFeeData()).gasPrice;
  if (gasPrice == null) throw new Error("RPC returned no gas price");
  const tx = { to: process.env.TX_TO, data: process.env.TX_DATA || "0x", value: BigInt(process.env.TX_VALUE || "0"), type: 0, gasPrice };
  tx.gasLimit = ((await provider.estimateGas({ ...tx, from: wallet.address })) * 12n) / 10n;
  const sent = await wallet.sendTransaction(tx);
  console.log("TXHASH " + sent.hash);
  const receipt = await sent.wait(1, Number(process.env.TX_WAIT_TIMEOUT_MS || 120000));
  console.log("STATUS " + receipt.status + " GASUSED " + receipt.gasUsed);
  if (receipt.status !== 1) process.exit(3);
})().catch((e) => { console.error("send failed: " + String((e && (e.shortMessage || e.message)) || e).slice(0, 300)); process.exit(1); });
'
send_tx() { # to data value -> stdout lines TXHASH/STATUS; non-zero on failure
  KEY_FILE="$SPONSOR_KEY_FILE" EXPECT_FROM="$SPONSOR_ADDRESS" RPC="$RPC" TX_TO="$1" TX_DATA="$2" TX_VALUE="$3" \
    TX_WAIT_TIMEOUT_MS="$TX_WAIT_TIMEOUT_MS" NODE_PATH="$ETHERS_NODE_PATH" "$NODE_BIN" -e "$SIGNER_JS"
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
  flock -w 60 9 || die "another sponsor-key job holds $LOCK_FILE"
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
  log "[LEASE-ALERT] STAGE_STUCK expired leases not ending: ${CANDIDATES[*]} (expiry keeper mode=$MODE)"
fi
[ "$MODE" = apply ] || { log "[dry-run] no transactions sent"; exit 0; }
[ "${#CANDIDATES[@]}" -gt 0 ] || exit 0

sb=$(rpc_result eth_getBalance "[\"$SPONSOR_ADDRESS\",\"latest\"]") || die "cannot read sponsor balance"
if [ "$(hex2dec "$sb")" -lt "$SPONSOR_MIN_SEND_WEI" ]; then
  log "[LEASE-ALERT] ESCROW_LOW sponsor=$SPONSOR_ADDRESS balance=$(hex2dec "$sb") below SPONSOR_MIN_SEND_WEI=$SPONSOR_MIN_SEND_WEI; not sending"
  exit 1
fi

sent=0
failed=0
for c in "${CANDIDATES[@]}"; do
  if [ "$sent" -ge "$EXPIRY_MAX_TX_PER_RUN" ]; then
    log "[LEASE-ALERT] STAGE_STUCK per-run cap $EXPIRY_MAX_TX_PER_RUN reached; remaining candidates wait for the next run"
    break
  fi
  market=${c%%:*}; tok=${c##*:}
  data="0xd2267fe9$(u32word "$tok")" # endLease(uint32)
  if ! eth_call_from "$SPONSOR_ADDRESS" "$market" "$data" >/dev/null; then
    log "skip #$tok on $market: endLease simulation reverts (already ending or no longer leased)"
    continue
  fi
  log "sending endLease(#$tok) on $market"
  if out=$(send_tx "$market" "$data" 0); then
    hash=$(sed -n 's/^TXHASH //p' <<<"$out")
    log "endLease #$tok ok tx=$hash"
    printf '%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" endLease "$market" "$tok" "$hash" >> "$PERSIST_DIR/expiry-keeper-ledger.tsv"
    sent=$((sent + 1))
  else
    log "[LEASE-ALERT] TX_TIMEOUT endLease #$tok on $market failed or timed out: $(tail -1 <<<"$out")"
    failed=$((failed + 1))
    sent=$((sent + 1))
  fi
done
log "done: sent=$sent failed=$failed"
[ "$failed" -eq 0 ]
exit $?
}
