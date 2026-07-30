#!/usr/bin/env bash
set -euo pipefail

# Minimal compatibility-safe hotfix for the still-running V15 workers.
#
# V15's factory cannot use V16's terminal returnGas flow, so do not replace the
# complete worker. This script changes only V15's pullGas funding calculation:
# 1e12 wei was less than one measured Yominet bot action (~4.03e12), and pulling
# a full reserve instead of the deficit can move excess refundable escrow into
# an ephemeral V15 operator that has no terminal native-gas return path.
#
# Default mode is read-only. Pass --apply to create timestamped backups, update
# both worker copies, syntax-check them, restart both services, and verify that
# they returned to active state.

readonly OLD_RESERVE_LINE='  const reserve = 1_000_000_000_000n;'
readonly NEW_RESERVE_LINE='  const reserve = 30_000_000_000_000n;'
readonly OLD_AMOUNT_LINE='  const amount = request.gasBudget < reserve ? request.gasBudget : reserve;'
readonly NEW_DEFICIT_LINE='  const deficit = reserve - balance;'
readonly NEW_AMOUNT_LINE='  const amount = request.gasBudget < deficit ? request.gasBudget : deficit;'
readonly WORKER_ROOT='/root/kamigotchi/tools'
readonly MUSU_WORKER="${WORKER_ROOT}/vault-kit-v15-musu/renter-pod-worker.mjs"
readonly VIPP_WORKER="${WORKER_ROOT}/vault-kit-v15-vipp/renter-pod-worker.mjs"
readonly MUSU_SERVICE='kami-renter-pod-v15-musu'
readonly VIPP_SERVICE='kami-renter-pod-v15-vipp'

mode="${1:---check}"
if [[ "${mode}" != '--check' && "${mode}" != '--apply' ]]; then
  echo "usage: $0 [--check|--apply]" >&2
  exit 64
fi

workers=("${MUSU_WORKER}" "${VIPP_WORKER}")
services=("${MUSU_SERVICE}" "${VIPP_SERVICE}")
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"

check_worker() {
  local worker="$1"
  local old_reserve new_reserve old_amount new_deficit new_amount

  [[ -f "${worker}" ]] || {
    echo "missing worker: ${worker}" >&2
    return 1
  }

  old_reserve="$(grep -Fxc "${OLD_RESERVE_LINE}" "${worker}" || true)"
  new_reserve="$(grep -Fxc "${NEW_RESERVE_LINE}" "${worker}" || true)"
  old_amount="$(grep -Fxc "${OLD_AMOUNT_LINE}" "${worker}" || true)"
  new_deficit="$(grep -Fxc "${NEW_DEFICIT_LINE}" "${worker}" || true)"
  new_amount="$(grep -Fxc "${NEW_AMOUNT_LINE}" "${worker}" || true)"

  if [[ "${new_reserve}" == '1' && "${old_reserve}" == '0' \
      && "${old_amount}" == '0' && "${new_deficit}" == '1' && "${new_amount}" == '1' ]]; then
    echo "HOTFIX_PRESENT ${worker}"
    return 0
  fi
  if [[ "$((old_reserve + new_reserve))" == '1' \
      && "${old_amount}" == '1' && "${new_deficit}" == '0' && "${new_amount}" == '0' ]]; then
    echo "NEEDS_HOTFIX ${worker}"
    return 2
  fi

  echo "REFUSING unexpected gas-funding layout in ${worker}" >&2
  echo "reserve_old=${old_reserve} reserve_new=${new_reserve} amount_old=${old_amount} deficit_new=${new_deficit} amount_new=${new_amount}" >&2
  return 1
}

if [[ "${mode}" == '--check' ]]; then
  rc=0
  for worker in "${workers[@]}"; do
    check_worker "${worker}" || rc=$?
  done
  for service in "${services[@]}"; do
    systemctl is-active "${service}" || rc=1
  done
  exit "${rc}"
fi

for worker in "${workers[@]}"; do
  if check_worker "${worker}"; then
    continue
  else
    rc=$?
  fi
  [[ "${rc}" == '2' ]] || exit "${rc}"

  backup="${worker}.bak-${timestamp}"
  cp -p -- "${worker}" "${backup}"
  sed -i \
    -e "s/${OLD_RESERVE_LINE}/${NEW_RESERVE_LINE}/" \
    -e "s/${OLD_AMOUNT_LINE}/${NEW_DEFICIT_LINE}\\n${NEW_AMOUNT_LINE}/" \
    "${worker}"

  check_worker "${worker}"
  node --check "${worker}"
  echo "BACKUP ${backup}"
done

systemctl restart "${services[@]}"
for service in "${services[@]}"; do
  systemctl is-active --quiet "${service}"
  echo "ACTIVE ${service}"
  journalctl -u "${service}" -n 12 --no-pager
done
