#!/usr/bin/env bash
# cleanup-secret-backups.sh - VPS-12. OWNER runs it on the VPS as root.
#
# Dry-run by default (prints file names, modes, sizes and DERIVED ADDRESSES; never
# file contents, keys or seeds). With --apply, in every v16 market dir
# ($KAMI_ROOT/vault-kit-v16-<market>):
#   1. shreds a stale secret backup (.env.*bak* / .env-*bak*, e.g. .env.bak-stackA,
#      which holds a KEEPER_PRIVATE_KEY) ONLY when both hold:
#        - no systemd unit file under $UNIT_DIR references it, and
#        - it is PROVEN redundant: the address of every *PRIVATE_KEY* value in it,
#          and every *SEED* / *MNEMONIC* value, is also present in a live .env on
#          this box ($KAMI_ROOT/*/.env). Addresses are derived with node + ethers
#          and only addresses are printed.
#      A backup holding a key or seed found in no live .env is REPORT-ONLY: it is
#      kept, with its derived addresses printed, until the OWNER has copied it
#      off-box and re-runs with --confirm-offbox-copy. If node/ethers cannot derive
#      the addresses, nothing is proven and the file is kept.
#   2. removes group/world write from every regular file in the dir (the live
#      renter-pod-worker.mjs.bak-* files are 777) and makes *.bak* code backups
#      root-only (600).
# With --prune-days N (and --apply) it also deletes deploy backups and staging dirs
# older than N days: $BACKUP_ROOT/worker-* (code + state snapshots with operator
# keys; older ones also hold .env copies) and $STAGING_ROOT/worker-*. Files are
# shredded before the directory is removed. A dir holding a .env copy that is not
# proven redundant (same rule as 1.) is kept unless --confirm-offbox-copy.
#
# Nothing is restarted and no worker code or state is changed. There is no
# rollback for a shred: that is the point. Run the dry-run first and read it.
{ # one block: safe to pipe into `bash -s`
set -euo pipefail

MODE="dry-run"
PRUNE_DAYS=""
CONFIRM_OFFBOX=0
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) MODE="dry-run" ;;
    --apply) MODE="apply" ;;
    --prune-days) PRUNE_DAYS="${2:?--prune-days needs a number of days}"; shift ;;
    --confirm-offbox-copy) CONFIRM_OFFBOX=1 ;;
    -h|--help) sed -n '2,30p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -z "$PRUNE_DAYS" ] || [[ "$PRUNE_DAYS" =~ ^[0-9]+$ ]] || { echo "--prune-days must be a number" >&2; exit 2; }

KAMI_ROOT="${KAMI_ROOT:-/root/kamigotchi/tools}"
V16_MARKETS="${V16_MARKETS:-musu vipp}"
UNIT_DIR="${UNIT_DIR:-/etc/systemd/system}"
BACKUP_ROOT="${BACKUP_ROOT:-/root/launch-ops-backups}"
STAGING_ROOT="${STAGING_ROOT:-/root/launch-ops-staging}"
NODE_BIN="${NODE_BIN:-/opt/kami-lease/runtime/node-v22.23.4/bin/node}"
ETHERS_NODE_PATH="${ETHERS_NODE_PATH:-/root/kamigotchi/tools/vault-kit/node_modules}"

log() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }
die() { log "ERROR: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "run as root on the VPS"
describe() { stat -c '%a %s bytes' "$1"; }
wipe() { # file: shred (fallback rm) - contents are never printed
  if command -v shred >/dev/null 2>&1; then shred -u -z "$1"; else rm -f "$1"; fi
}

# Proof that a backup's fund-bearing secrets exist in a live .env. Reads the files
# inside node; prints only variable names, derived addresses and verdicts.
PROOF_JS='
const fs = require("fs");
const { Wallet } = require("ethers");
const parse = (file) => {
  const env = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*)$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.length >= 2 && (v[0] === "\"" || v[0] === "\x27") && v[v.length - 1] === v[0]) v = v.slice(1, -1).trim();
    if (v) env.push([m[1], v]);
  }
  return env;
};
const isKey = (k) => /PRIVATE_KEY/i.test(k);
const isSeed = (k) => /SEED|MNEMONIC/i.test(k);
const address = (v) => { try { return new Wallet(v.startsWith("0x") ? v : "0x" + v).address; } catch { return null; } };
const liveAddrs = new Set(), liveSeeds = new Set();
for (const f of process.env.LIVE_ENVS.split("\n").filter(Boolean)) {
  for (const [k, v] of parse(f)) {
    if (isKey(k)) { const a = address(v); if (a) liveAddrs.add(a.toLowerCase()); }
    else if (isSeed(k)) liveSeeds.add(v);
  }
}
let unique = 0, secrets = 0;
for (const [k, v] of parse(process.env.BACKUP)) {
  if (isKey(k)) {
    secrets++;
    const a = address(v);
    if (!a) { unique++; console.log(`KEY ${k} underivable (kept: cannot prove it exists elsewhere)`); continue; }
    const live = liveAddrs.has(a.toLowerCase());
    if (!live) unique++;
    console.log(`KEY ${k} ${a} ${live ? "also in a live .env" : "NOT in any live .env"}`);
  } else if (isSeed(k)) {
    secrets++;
    const live = liveSeeds.has(v);
    if (!live) unique++;
    console.log(`SEED ${k} ${live ? "also in a live .env" : "NOT in any live .env"}`);
  }
}
console.log(`VERDICT ${unique === 0 ? "redundant" : "unique"} secrets=${secrets} unique=${unique}`);
'
LIVE_ENVS=$(for f in "$KAMI_ROOT"/*/.env; do [ -f "$f" ] && printf '%s\n' "$f"; done || true)
PROOF_OK=1
if ! [ -x "$NODE_BIN" ] && command -v node >/dev/null 2>&1; then NODE_BIN=$(command -v node); fi
if ! [ -x "$NODE_BIN" ] || ! [ -d "$ETHERS_NODE_PATH/ethers" ]; then
  PROOF_OK=0
  log "WARN: node/ethers not available ($NODE_BIN, $ETHERS_NODE_PATH): no key can be proven redundant, so every .env backup is kept (report only)"
fi
PROVE_OUT=""
prove_redundant() { # backup file -> 0 when every key/seed in it is in a live .env; PROVE_OUT holds the report
  PROVE_OUT=""
  [ "$PROOF_OK" = 1 ] || { PROVE_OUT="VERDICT unknown (no node/ethers)"; return 1; }
  PROVE_OUT=$(LIVE_ENVS="$LIVE_ENVS" BACKUP="$1" NODE_PATH="$ETHERS_NODE_PATH" "$NODE_BIN" -e "$PROOF_JS" 2>&1) \
    || { PROVE_OUT="VERDICT unknown (address derivation failed)"; return 1; }
  grep -q '^VERDICT redundant' <<<"$PROVE_OUT"
}
report_proof() { sed 's/^/          /' <<<"$PROVE_OUT"; }

log "cleanup-secret-backups mode=$MODE markets=[$V16_MARKETS] prune-days=${PRUNE_DAYS:-off} confirm-offbox-copy=$CONFIRM_OFFBOX live-envs=$(grep -c . <<<"$LIVE_ENVS" || true)"
ACTIONS=0
KEPT=0
for m in $V16_MARKETS; do
  dir="$KAMI_ROOT/vault-kit-v16-$m"
  [ -d "$dir" ] || { log "== $m: $dir missing; skipped"; continue; }
  log "== $m ($dir)"
  # 1. stale .env backups
  for f in "$dir"/.env.*bak* "$dir"/.env-*bak*; do # .env.*bak* also covers .env.bak*
    [ -f "$f" ] || continue
    b=$(basename "$f")
    [ "$b" != .env ] || continue
    refs=$(grep -rlF -- "$b" "$UNIT_DIR" 2>/dev/null || true)
    if [ -n "$refs" ]; then
      log "  KEEP    $b ($(describe "$f")): referenced by $(tr '\n' ' ' <<<"$refs")"
      continue
    fi
    if prove_redundant "$f"; then
      why="no unit references it; every key/seed in it is also in a live .env"
    elif [ "$CONFIRM_OFFBOX" = 1 ]; then
      why="no unit references it; holds secrets found in no live .env, shredded on --confirm-offbox-copy"
    else
      KEPT=$((KEPT + 1))
      log "  KEEP (report only) $b ($(describe "$f")): holds a key/seed found in no live .env on this box. Copy it OFF-BOX first, then re-run with --confirm-offbox-copy:"
      report_proof
      continue
    fi
    ACTIONS=$((ACTIONS + 1))
    if [ "$MODE" = apply ]; then wipe "$f"; log "  shredded $b ($why)"; else log "  WOULD shred $b ($(describe "$f")): $why"; fi
    report_proof
  done
  # 2. write bits and code backups
  while IFS= read -r -d '' f; do
    b=$(basename "$f")
    case "$b" in .env|.env.*|.env-*) want="go-rwx" ;; *.bak*) want=600 ;; *) want="go-w" ;; esac
    ACTIONS=$((ACTIONS + 1))
    if [ "$MODE" = apply ]; then chmod "$want" "$f"; log "  chmod $want $b (now $(stat -c %a "$f"))"; else log "  WOULD chmod $want $b (mode $(stat -c %a "$f"))"; fi
  done < <(find "$dir" -maxdepth 1 -type f -perm /022 -print0)
  while IFS= read -r -d '' f; do
    b=$(basename "$f")
    ACTIONS=$((ACTIONS + 1))
    if [ "$MODE" = apply ]; then chmod 600 "$f"; log "  chmod 600 $b"; else log "  WOULD chmod 600 $b (mode $(stat -c %a "$f"))"; fi
  done < <(find "$dir" -maxdepth 1 -type f -name '*.bak*' ! -name '.env*' -perm /044 ! -perm /022 -print0)
done

# 3. old deploy backups and staging dirs
if [ -n "$PRUNE_DAYS" ]; then
  for root in "$BACKUP_ROOT" "$STAGING_ROOT"; do
    [ -d "$root" ] || continue
    while IFS= read -r -d '' d; do
      unique_envs=""
      while IFS= read -r -d '' e; do
        prove_redundant "$e" || unique_envs="$unique_envs ${e#"$d"/}"
      done < <(find "$d" -type f -name '.env*' -print0)
      if [ -n "$unique_envs" ] && [ "$CONFIRM_OFFBOX" != 1 ]; then
        KEPT=$((KEPT + 1))
        log "  KEEP (report only) $d: .env copy(ies)${unique_envs} hold a key/seed found in no live .env. Copy off-box, then --confirm-offbox-copy"
        continue
      fi
      ACTIONS=$((ACTIONS + 1))
      if [ "$MODE" = apply ]; then
        find "$d" -type f -print0 | while IFS= read -r -d '' f; do wipe "$f"; done
        rm -rf "$d"
        log "  pruned $d"
      else
        log "  WOULD prune $d ($(find "$d" -type f | wc -l) files, older than $PRUNE_DAYS days)"
      fi
    done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -name 'worker-*' -mtime "+$PRUNE_DAYS" -print0)
  done
fi

if [ "$MODE" = apply ]; then log "done: $ACTIONS action(s) applied, $KEPT secret backup(s) kept (report only)"; else log "[dry-run] $ACTIONS action(s) planned, $KEPT secret backup(s) kept (report only); nothing changed"; fi
exit 0
}
