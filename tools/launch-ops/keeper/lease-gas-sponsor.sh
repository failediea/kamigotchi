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
#   factory.requests(token).stage in SPONSOR_STAGES (default "0 3 4 5")
#   stage 3/4/5: factory.requests(token).pod == job.pod (same lease, not a stale job)
#   stage 0 (request cleared; the worker still owes the custody return, which needs
#     operator gas with allowPull=false): request pod is 0, the token is listed on
#     this market (listing.owner != 0) and not re-leased (listing.renter == 0).
#     All stage-0 worker actions except WAIT/COMPLETE are operator-signed.
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
# the ledger caps repeat funding. The signer appends the ledger row ("sent") right
# after broadcasting and BEFORE waiting, so a transfer that times out (or a run
# killed by systemd) still counts toward both caps. Every --apply run first
# resolves unresolved ledger rows (receipt -> mined/reverted; unknown to the node
# -> dropped) and compares the sponsor's pending and latest nonce: while any
# sponsor tx is still in flight it sends nothing and logs
# [LEASE-ALERT] TX_TIMEOUT source=sponsor ... (no re-send while the first
# transfer sits in the mempool). Dropped transfers stay counted (conservative). Rollback: nothing to undo on-chain (the ETH
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
SPONSOR_STAGES="${SPONSOR_STAGES:-0 3 4 5}"
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
ZERO_ADDR="0x0000000000000000000000000000000000000000"

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
addr_word() { printf '0x%s' "$(word "$1" "$2" | cut -c25-64)"; }
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
# Ledger rows (tab separated):
#   <ts> topup  <market> <token> <pod> <operator> <wei> <hash> <nonce> sent      (written by the signer, before waiting)
#   <ts> result -        -       -     -          0     <hash> -       mined|reverted|dropped
# Caps sum every "topup" row, resolved or not.
ledger_sum() { # awk filter over the ledger: $1 = mode (lease|day), $2 = key
  [ -r "$LEDGER" ] || { echo 0; return; }
  awk -F'\t' -v mode="$1" -v key="$2" -v now="$NOW" '
    $2 != "topup" { next }
    mode=="lease" && ($3 ":" $4 ":" $5)==key { s += $7 }
    mode=="day" && (now - $1) < 86400 { s += $7 }
    END { printf "%.0f", s + 0 }' "$LEDGER"
}
INFLIGHT=0
resolve_ledger() { # checks every topup row without a result row; appends results in --apply
  INFLIGHT=0
  [ -r "$LEDGER" ] || return 0
  local h raw st
  for h in $(awk -F'\t' '$2=="topup"{s[$8]=1} $2=="result"{r[$8]=1} END{for (h in s) if (!(h in r) && h ~ /^0x/) print h}' "$LEDGER"); do
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
    if [ "$MODE" = apply ]; then
      printf '%s\tresult\t-\t-\t-\t-\t0\t%s\t-\t%s\n' "$(date +%s)" "$h" "$st" >> "$LEDGER"
    fi
  done
}
jobs_tsv() { # state JSON on stdin -> "tokenIndex<TAB>operator<TAB>pod" per non-returned job
  if command -v jq >/dev/null 2>&1; then
    jq -r '.jobs // {} | to_entries[] | .value | select((.returned // false) != true) | [(.tokenIndex|tostring), (.operator // ""), (.pod // "")] | @tsv'
    return
  fi
  local node="$NODE_BIN"
  [ -x "$node" ] || node=$(command -v node || true)
  [ -n "$node" ] || { log "ERROR: neither jq nor node is available to read the worker state" >&2; return 1; }
  "$node" -e 'const s = JSON.parse(require("fs").readFileSync(0, "utf8"));
    for (const j of Object.values(s.jobs || {})) {
      if (j && j.returned !== true) console.log([String(j.tokenIndex), j.operator || "", j.pod || ""].join("\t"));
    }'
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
  // Durable BEFORE waiting: a timeout or a kill still leaves this transfer on the
  // ledger, so the caps count it and the next run sees it in flight.
  try {
    fs.appendFileSync(process.env.LEDGER_FILE, [Math.floor(Date.now() / 1000), process.env.LEDGER_ROW, sent.hash, sent.nonce, "sent"].join("\t") + "\n");
  } catch (e) { console.error("ledger append failed: " + e.message); }
  const receipt = await sent.wait(1, Number(process.env.TX_WAIT_TIMEOUT_MS || 120000));
  console.log("STATUS " + receipt.status + " GASUSED " + receipt.gasUsed);
  if (receipt.status !== 1) process.exit(3);
})().catch((e) => { console.error("send failed: " + String((e && (e.shortMessage || e.message)) || e).slice(0, 300)); process.exit(1); });
'
send_tx() { # to data value ledger_row
  KEY_FILE="$SPONSOR_KEY_FILE" EXPECT_FROM="$SPONSOR_ADDRESS" RPC="$RPC" TX_TO="$1" TX_DATA="$2" TX_VALUE="$3" \
    LEDGER_FILE="$LEDGER" LEDGER_ROW="$4" \
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
  chmod 700 "$PERSIST_DIR"
  exec 9>"$LOCK_FILE"
  # The expiry keeper holds this lock while it waits on its own txs. Skipping is
  # correct (the next timer run retries) and must not fire the OnFailure push.
  if ! flock -n 9; then
    log "another sponsor-key job (expiry keeper?) holds $LOCK_FILE; skipping this run"
    exit 0
  fi
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
    log "[LEASE-ALERT] ESCROW_LOW source=sponsor sponsor=$SPONSOR_ADDRESS balance=$WALLET floor=$SPONSOR_WALLET_FLOOR_WEI reason=sponsor-at-floor"
  fi
else
  log "SPONSOR_ADDRESS unset: wallet floor not evaluated (dry-run only)"
fi

# In-flight guard: never send while an earlier sponsor tx may still be in the mempool.
resolve_ledger
if [ -n "$SPONSOR_ADDRESS" ]; then
  if nl=$(rpc_result eth_getTransactionCount "[\"$SPONSOR_ADDRESS\",\"latest\"]") \
      && np=$(rpc_result eth_getTransactionCount "[\"$SPONSOR_ADDRESS\",\"pending\"]"); then
    nl=$(hex2dec "$nl"); np=$(hex2dec "$np")
    if [ "$np" -gt "$nl" ]; then
      INFLIGHT=$((INFLIGHT + np - nl)); log "  sponsor nonce pending=$np > latest=$nl"
    fi
  else
    [ "$MODE" = apply ] && die "cannot read the sponsor nonce (latest/pending); not sending"
    log "  sponsor nonce not readable (dry-run: ignored)"
  fi
fi
if [ "$INFLIGHT" -gt 0 ]; then
  log "[LEASE-ALERT] TX_TIMEOUT source=sponsor sponsor=$SPONSOR_ADDRESS inflight=$INFLIGHT action=no-new-sends (an earlier top-up is not mined yet)"
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
  jobs=$(jobs_tsv <<<"$state_json") || die "cannot read jobs from the $m state file"
  log "market $m ($maddr, factory $factory): $(grep -c . <<<"$jobs" || true) non-returned job(s)"
  while IFS=$'\t' read -r tok op pod; do
    [ -n "$tok" ] || continue
    r=$(eth_call "$factory" "0x0ab469b0$(u32word "$tok")") || { log "  #$tok requests() failed; skipped"; continue; }
    stage=$(hex2dec "$(word "$r" 5)")
    chain_pod="0x$(word "$r" 1 | cut -c25-64)"
    escrow=$(hex2dec "$(word "$r" 2)")
    case " $SPONSOR_STAGES " in *" $stage "*) ;; *) log "  #$tok stage=$stage not in [$SPONSOR_STAGES]; skipped"; continue ;; esac
    if [ "$stage" = 0 ]; then
      # request cleared on chain: validate against the listing instead of request.pod
      l=$(eth_call "$maddr" "0xf81c2347$(u32word "$tok")") || { log "  #$tok listings() failed; skipped"; continue; }
      l_owner=$(addr_word "$l" 0); l_renter=$(addr_word "$l" 8)
      if [ "$(lc "$chain_pod")" != "$ZERO_ADDR" ]; then
        log "  #$tok stage=0: request pod $chain_pod is set (not this job's lease); skipped"; continue
      elif [ "$(lc "$l_owner")" = "$ZERO_ADDR" ]; then
        log "  #$tok stage=0: not listed on this market (stale job); skipped"; continue
      elif [ "$(lc "$l_renter")" != "$ZERO_ADDR" ]; then
        log "  #$tok stage=0: listing re-leased to $l_renter (stale job); skipped"; continue
      fi
      log "  #$tok stage=0: request cleared, listing not re-leased: worker custody-return work for pod $pod needs operator gas"
    elif [ "$(lc "$chain_pod")" != "$(lc "$pod")" ]; then
      log "  #$tok stage=$stage: chain pod $chain_pod != job pod $pod (stale job); skipped"
      continue
    fi
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
      log "  [LEASE-ALERT] ESCROW_LOW source=sponsor market=$m token=$tok stage=$stage operator=$op balance=$bal reason=per-lease-cap used=$used cap=$SPONSOR_MAX_PER_LEASE_WEI"
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
if [ "$INFLIGHT" -gt 0 ]; then
  log "${#PLAN[@]} top-up(s) held back until the in-flight sponsor tx resolves"
  exit 0
fi

sent=0; failed=0
for p in "${PLAN[@]}"; do
  IFS='|' read -r ma tk pd op amt <<<"$p"
  if [ "$sent" -ge "$SPONSOR_MAX_TX_PER_RUN" ]; then
    log "[LEASE-ALERT] ESCROW_LOW source=sponsor reason=per-run-cap cap=$SPONSOR_MAX_TX_PER_RUN"; break
  fi
  if [ $((DAY_USED + amt)) -gt "$SPONSOR_MAX_PER_DAY_WEI" ]; then
    log "[LEASE-ALERT] ESCROW_LOW source=sponsor reason=daily-cap token=$tk used=$DAY_USED cap=$SPONSOR_MAX_PER_DAY_WEI"; break
  fi
  if [ $((WALLET - amt - TX_COST_WEI)) -lt "$SPONSOR_WALLET_FLOOR_WEI" ]; then
    log "[LEASE-ALERT] ESCROW_LOW source=sponsor reason=wallet-floor token=$tk balance=$WALLET amount=$amt floor=$SPONSOR_WALLET_FLOOR_WEI"; break
  fi
  # re-read the operator balance right before sending (another run or the worker may have funded it)
  bal=$(hex2dec "$(rpc_result eth_getBalance "[\"$op\",\"latest\"]" || echo 0x0)")
  if [ "$bal" -ge "$EXIT_RESERVE_WEI" ]; then log "#$tk operator already refilled ($bal); skipped"; continue; fi
  log "sending $amt wei to $op for #$tk ($ma)"
  row="topup"$'\t'"$(lc "$ma")"$'\t'"$tk"$'\t'"$(lc "$pd")"$'\t'"$op"$'\t'"$amt"
  rc=0; out=$(send_tx "$op" 0x "$amt" "$row" 2>&1) || rc=$?
  hash=$(sed -n 's/^TXHASH //p' <<<"$out" | head -1)
  if [ -n "$hash" ]; then
    # broadcast: the signer already wrote the "sent" ledger row, so it counts toward the caps
    DAY_USED=$((DAY_USED + amt)); WALLET=$((WALLET - amt - TX_COST_WEI))
  fi
  if [ "$rc" = 0 ]; then
    printf '%s\tresult\t-\t-\t-\t-\t0\t%s\t-\tmined\n' "$(date +%s)" "$hash" >> "$LEDGER"
    log "top-up #$tk ok tx=$hash"
    sent=$((sent + 1))
  elif [ -n "$hash" ]; then
    [ "$rc" = 3 ] && printf '%s\tresult\t-\t-\t-\t-\t0\t%s\t-\treverted\n' "$(date +%s)" "$hash" >> "$LEDGER"
    log "[LEASE-ALERT] TX_TIMEOUT source=sponsor token=$tk operator=$op hash=$hash exit=$rc detail=$(tail -1 <<<"$out" | tr ' ' '_' | cut -c1-160)"
    failed=$((failed + 1)); sent=$((sent + 1))
    # broadcast but not confirmed: stop, the next run resolves it before sending again
    break
  else
    log "[LEASE-ALERT] TX_TIMEOUT source=sponsor token=$tk operator=$op hash=none exit=$rc detail=$(tail -1 <<<"$out" | tr ' ' '_' | cut -c1-160)"
    failed=$((failed + 1)); sent=$((sent + 1))
  fi
done
log "done: sent=$sent failed=$failed"
[ "$failed" -eq 0 ]
exit $?
}
