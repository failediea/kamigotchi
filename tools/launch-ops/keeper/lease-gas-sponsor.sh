#!/usr/bin/env bash
# lease-gas-sponsor - H7 / CON-01 / H2 containment for the sealed v16 markets.
#
# A v16 renter can extend with 1 wei, and in terminal stages the factory
# cannot refill the pod operator from escrow, so a leased kami's per-lease
# operator EOA can run dry and wedge the lease (worker ensureOperatorGas
# throws before endLease / stop-harvest / KamiSend). The platform CAN send
# ETH straight to that EOA. This script does exactly that, with hard caps.
#
# For every non-returned job in each v16 worker state file (read-only; only
# tokenIndex/operator/pod are read, never keys) it checks the chain:
#   factory.requests(token).pod == job.pod   (same lease, not a stale job)
#   factory.requests(token).stage in SPONSOR_STAGES (default 3 = ACTIVE)
#   operator has no code (plain EOA)
#   balance < EXIT_RESERVE_ACTIONS x OPERATOR_ACTION_GAS_FLOOR x gasPrice
# and then tops the operator up to SPONSOR_TARGET_GAS_UNITS x gasPrice, bounded by
#   SPONSOR_MAX_PER_LEASE_WEI  cumulative per (market, token, pod) from the ledger
#   SPONSOR_MAX_PER_DAY_WEI    rolling 24 h across all leases
#   SPONSOR_WALLET_FLOOR_WEI   the sponsor never goes below this balance
#   SPONSOR_MAX_TX_PER_RUN     transfers per run
#
# Modes:
#   --dry-run (default)  read-only: print every lease, its operator balance and
#                        the transfer that WOULD be made
#   --apply              send the transfers (needs SPONSOR_KEY_FILE + SPONSOR_ADDRESS)
#
# Idempotent: a topped-up operator is above the threshold on the next run, and
# the ledger caps repeat funding. Rollback: nothing to undo on-chain (the ETH
# is on the lease's operator EOA; with TERMINAL_GAS_RETURN_MODE=skip the
# leftover is not returned, which the caps bound). To stop:
# `systemctl disable --now kami-lease-gas-sponsor.timer`.
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

MODE="dry-run"
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    -h|--help) sed -n '2,32p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done

LAUNCH_OPS_ENV="${LAUNCH_OPS_ENV:-/etc/kami-lease-ops/launch-ops.env}"
# shellcheck disable=SC1090
if [ -r "$LAUNCH_OPS_ENV" ]; then set -a; . "$LAUNCH_OPS_ENV"; set +a; fi

RPC="${YOMINET_RPC_PUBLIC:-https://jsonrpc-yominet-1.anvil.asia-southeast.initia.xyz}"
RPC_TIMEOUT_SEC="${RPC_TIMEOUT_SEC:-15}"
KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
V16_MARKETS="${V16_MARKETS:-musu vipp}"
MUSU_MARKET="${MUSU_MARKET:-0x1FeF5Ce51f9d3BACD0C3f707eEeBbD7A44d69319}"
VIPP_MARKET="${VIPP_MARKET:-0x4A34d4847D8E2958E4017353e71fAB7afb85bD23}"
SPONSOR_STAGES="${SPONSOR_STAGES:-3}"
EXIT_RESERVE_ACTIONS="${EXIT_RESERVE_ACTIONS:-3}"
OPERATOR_ACTION_GAS_FLOOR="${OPERATOR_ACTION_GAS_FLOOR:-1700000}"
SPONSOR_TARGET_GAS_UNITS="${SPONSOR_TARGET_GAS_UNITS:-12000000}"
SPONSOR_MAX_PER_LEASE_WEI="${SPONSOR_MAX_PER_LEASE_WEI:-100000000000000}"  # 1e14 (~3 days of worst-case grief)
SPONSOR_MAX_PER_DAY_WEI="${SPONSOR_MAX_PER_DAY_WEI:-300000000000000}"      # 3e14
SPONSOR_WALLET_FLOOR_WEI="${SPONSOR_WALLET_FLOOR_WEI:-200000000000000}"    # 2e14
SPONSOR_MAX_TX_PER_RUN="${SPONSOR_MAX_TX_PER_RUN:-3}"
TX_WAIT_TIMEOUT_MS="${TX_WAIT_TIMEOUT_MS:-120000}"
SPONSOR_KEY_FILE="${SPONSOR_KEY_FILE:-}"
SPONSOR_ADDRESS="${SPONSOR_ADDRESS:-}"
NODE_BIN="${NODE_BIN:-/root/.nvm/versions/node/v20.20.0/bin/node}"
ETHERS_NODE_PATH="${ETHERS_NODE_PATH:-/root/kamigotchi/tools/vault-kit/node_modules}"
PERSIST_DIR="${ALERT_PERSIST_DIR:-/var/lib/kami-lease-ops}"
LEDGER="$PERSIST_DIR/sponsor-ledger.tsv"
LOCK_FILE="${SPONSOR_LOCK_FILE:-/run/lock/kami-lease-sponsor-key.lock}"
TRANSFER_GAS=21000

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
word() { local h=${1#0x}; printf '%s' "${h:$(( $2 * 64 )):64}"; }
hex2dec() { local h=${1#0x}; h="${h#"${h%%[!0]*}"}"; if [ -z "$h" ]; then echo 0; elif [ ${#h} -gt 15 ]; then echo 1152921504606846975; else echo $((16#$h)); fi; }
u32word() { printf '%064x' "$1"; }
wei_eth() { awk -v w="$1" 'BEGIN{printf "%.6f", w/1e18}'; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
market_dir() { printf '%s/vault-kit-v16-%s' "$KAMI_ROOT" "$1"; }
market_addr() { if [ "$1" = musu ]; then printf '%s' "$MUSU_MARKET"; else printf '%s' "$VIPP_MARKET"; fi; }
state_file_for() {
  local dir="$1" v=""
  if [ -r "$dir/.env" ]; then
    v=$(grep -E '^WORKER_STATE_FILE=' "$dir/.env" | tail -1 | cut -d= -f2- | tr -d '\r' | sed -E 's/^ +| +$//g' || true)
  fi
  [ -n "$v" ] || v="$dir/renter-pod-worker-state.json"
  case "$v" in /*) ;; *) v="$dir/$v" ;; esac
  printf '%s' "$v"
}
ledger_sum() { # awk filter over the ledger: $1 = mode (lease|day), $2 = key
  [ -r "$LEDGER" ] || { echo 0; return; }
  awk -F'\t' -v mode="$1" -v key="$2" -v now="$NOW" '
    mode=="lease" && ($3 ":" $4 ":" $5)==key { s += $7 }
    mode=="day" && (now - $1) < 86400 { s += $7 }
    END { printf "%.0f", s + 0 }' "$LEDGER"
}

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
send_tx() {
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

command -v jq >/dev/null || die "jq is required"
command -v curl >/dev/null || die "curl is required"
if [ "$MODE" = apply ]; then
  check_key_file
  mkdir -p "$PERSIST_DIR" "$(dirname "$LOCK_FILE")"
  chmod 700 "$PERSIST_DIR"
  exec 9>"$LOCK_FILE"
  flock -w 60 9 || die "another sponsor-key job holds $LOCK_FILE"
fi

NOW=$(date +%s)
gp_hex=$(rpc_result eth_gasPrice '[]') || die "eth_gasPrice failed"
GAS_PRICE=$(hex2dec "$gp_hex")
[ "$GAS_PRICE" -gt 0 ] || die "gas price is zero"
EXIT_RESERVE_WEI=$((GAS_PRICE * OPERATOR_ACTION_GAS_FLOOR * EXIT_RESERVE_ACTIONS))
TARGET_WEI=$((GAS_PRICE * SPONSOR_TARGET_GAS_UNITS))
[ "$TARGET_WEI" -ge "$EXIT_RESERVE_WEI" ] || TARGET_WEI=$EXIT_RESERVE_WEI
TX_COST_WEI=$((GAS_PRICE * TRANSFER_GAS * 12 / 10))
DAY_USED=$(ledger_sum day x)

log "lease-gas-sponsor mode=$MODE gasPrice=$GAS_PRICE exitReserve=$EXIT_RESERVE_WEI target=$TARGET_WEI stages=[$SPONSOR_STAGES]"
log "caps: perLease=$SPONSOR_MAX_PER_LEASE_WEI perDay=$SPONSOR_MAX_PER_DAY_WEI (used 24h: $DAY_USED) walletFloor=$SPONSOR_WALLET_FLOOR_WEI maxTx=$SPONSOR_MAX_TX_PER_RUN"

WALLET=""
if [ -n "$SPONSOR_ADDRESS" ]; then
  sb=$(rpc_result eth_getBalance "[\"$SPONSOR_ADDRESS\",\"latest\"]") || die "cannot read sponsor balance"
  WALLET=$(hex2dec "$sb")
  log "sponsor $SPONSOR_ADDRESS balance $WALLET wei ($(wei_eth "$WALLET") ETH)"
  if [ "$WALLET" -le "$SPONSOR_WALLET_FLOOR_WEI" ]; then
    log "[LEASE-ALERT] ESCROW_LOW sponsor=$SPONSOR_ADDRESS balance=$WALLET at/below floor $SPONSOR_WALLET_FLOOR_WEI; sponsor cannot fund operators"
  fi
else
  log "SPONSOR_ADDRESS unset: wallet floor not evaluated (dry-run only)"
fi

PLAN=() # market|token|pod|operator|amount
for m in $V16_MARKETS; do
  dir=$(market_dir "$m")
  sf=$(state_file_for "$dir")
  maddr=$(market_addr "$m")
  if [ -n "${LAUNCH_OPS_TEST_STATE_JSON:-}" ]; then
    state_json=$LAUNCH_OPS_TEST_STATE_JSON # test hook only (tests/run-tests.sh); never set in production
  elif [ -r "$sf" ]; then
    state_json=$(cat "$sf")
  else
    log "market $m: no readable state file at $sf"; continue
  fi
  f_hex=$(eth_call "$maddr" 0xe1fc685a) || die "leaseFactory() failed on $maddr"
  factory="0x$(word "$f_hex" 0 | cut -c25-64)"
  jobs=$(jq -r '.jobs // {} | to_entries[] | .value | select((.returned // false) != true) | [(.tokenIndex|tostring), (.operator // ""), (.pod // "")] | @tsv' <<<"$state_json")
  log "market $m ($maddr, factory $factory): $(grep -c . <<<"$jobs" || true) non-returned job(s)"
  while IFS=$'\t' read -r tok op pod; do
    [ -n "$tok" ] || continue
    r=$(eth_call "$factory" "0x0ab469b0$(u32word "$tok")") || { log "  #$tok requests() failed; skipped"; continue; }
    stage=$(hex2dec "$(word "$r" 5)")
    chain_pod="0x$(word "$r" 1 | cut -c25-64)"
    escrow=$(hex2dec "$(word "$r" 2)")
    if [ "$(lc "$chain_pod")" != "$(lc "$pod")" ]; then
      log "  #$tok stage=$stage: chain pod $chain_pod != job pod $pod (stale job); skipped"
      continue
    fi
    case " $SPONSOR_STAGES " in *" $stage "*) ;; *) log "  #$tok stage=$stage not in [$SPONSOR_STAGES]; skipped"; continue ;; esac
    code=$(rpc_result eth_getCode "[\"$op\",\"latest\"]" || echo "?")
    if [ "$code" != "0x" ]; then log "  #$tok operator $op is not a plain EOA (code=${code:0:10}); skipped"; continue; fi
    bal_hex=$(rpc_result eth_getBalance "[\"$op\",\"latest\"]") || { log "  #$tok balance read failed; skipped"; continue; }
    bal=$(hex2dec "$bal_hex")
    if [ "$bal" -ge "$EXIT_RESERVE_WEI" ]; then
      log "  #$tok stage=$stage operator=$op balance=$bal escrow=$escrow >= exit reserve; ok"
      continue
    fi
    want=$((TARGET_WEI - bal))
    lease_key="$(lc "$maddr"):$tok:$(lc "$pod")"
    used=$(ledger_sum lease "$lease_key")
    room=$((SPONSOR_MAX_PER_LEASE_WEI - used))
    if [ "$room" -le 0 ]; then
      log "  [LEASE-ALERT] ESCROW_LOW market=$m token=$tok operator=$op balance=$bal: per-lease sponsor cap reached (used $used); needs a human"
      continue
    fi
    [ "$want" -le "$room" ] || want=$room
    log "  #$tok stage=$stage operator=$op balance=$bal escrow=$escrow < exitReserve=$EXIT_RESERVE_WEI -> top up $want wei (lease used $used)"
    PLAN+=("$maddr|$tok|$pod|$op|$want")
  done <<<"$jobs"
done

log "${#PLAN[@]} top-up(s) planned"
if [ "$MODE" != apply ]; then
  for p in "${PLAN[@]}"; do IFS='|' read -r ma tk pd op amt <<<"$p"; log "[dry-run] WOULD send $amt wei ($(wei_eth "$amt") ETH) to $op for #$tk ($ma)"; done
  log "[dry-run] no transactions sent"
  exit 0
fi
[ "${#PLAN[@]}" -gt 0 ] || exit 0

sent=0; failed=0
for p in "${PLAN[@]}"; do
  IFS='|' read -r ma tk pd op amt <<<"$p"
  if [ "$sent" -ge "$SPONSOR_MAX_TX_PER_RUN" ]; then
    log "[LEASE-ALERT] ESCROW_LOW per-run cap $SPONSOR_MAX_TX_PER_RUN reached; rest waits for the next run"; break
  fi
  if [ $((DAY_USED + amt)) -gt "$SPONSOR_MAX_PER_DAY_WEI" ]; then
    log "[LEASE-ALERT] ESCROW_LOW daily sponsor cap reached (used $DAY_USED of $SPONSOR_MAX_PER_DAY_WEI); #$tk not funded"; break
  fi
  if [ $((WALLET - amt - TX_COST_WEI)) -lt "$SPONSOR_WALLET_FLOOR_WEI" ]; then
    log "[LEASE-ALERT] ESCROW_LOW sponsor wallet floor: balance $WALLET - $amt would cross $SPONSOR_WALLET_FLOOR_WEI; stopping"; break
  fi
  # re-read the operator balance right before sending (another run or the worker may have funded it)
  bal=$(hex2dec "$(rpc_result eth_getBalance "[\"$op\",\"latest\"]" || echo 0x0)")
  if [ "$bal" -ge "$EXIT_RESERVE_WEI" ]; then log "#$tk operator already refilled ($bal); skipped"; continue; fi
  log "sending $amt wei to $op for #$tk ($ma)"
  if out=$(send_tx "$op" 0x "$amt"); then
    hash=$(sed -n 's/^TXHASH //p' <<<"$out")
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$(date +%s)" topup "$(lc "$ma")" "$tk" "$(lc "$pd")" "$op" "$amt" "$hash" >> "$LEDGER"
    log "top-up #$tk ok tx=$hash"
    DAY_USED=$((DAY_USED + amt)); WALLET=$((WALLET - amt - TX_COST_WEI)); sent=$((sent + 1))
  else
    log "[LEASE-ALERT] TX_TIMEOUT sponsor top-up for #$tk to $op failed or timed out: $(tail -1 <<<"$out")"
    failed=$((failed + 1)); sent=$((sent + 1))
  fi
done
log "done: sent=$sent failed=$failed"
[ "$failed" -eq 0 ]
exit $?
}
