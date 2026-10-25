#!/usr/bin/env bash
# BASELINE (read-only copy, 2026-09-29) of the live
#   root@68.183.190.126:/root/kamigotchi/tools/alerts/worker-alerts.sh
# Kept verbatim except that the embedded ntfy topic is redacted into the
# NTFY_TOPIC env var. This file is reference only; the extended script is
# ../worker-alerts-v2.sh. Do not install this copy.
#
# Worker health alerts -> ntfy.sh push. Two conditions per kami unit:
#   dead unit (is-active != active), or >= ERR_THRESHOLD error lines in the
#   last WINDOW. 60-min cooldown per (unit, condition) so a firing condition
#   pings once an hour, not every timer tick. Born from kami #5846: 8,600
#   identical errors over three days that nobody saw.
TOPIC="${NTFY_TOPIC:?NTFY_TOPIC is required (was embedded in the live script; redacted here)}"
WINDOW="10 minutes ago"
ERR_THRESHOLD=20
COOLDOWN_SECS=3600
STATE=/run/kami-worker-alerts
mkdir -p "$STATE"

notify() { # key title body
  local key="$1" now last
  now=$(date +%s)
  last=$(cat "$STATE/$key" 2>/dev/null || echo 0)
  [ $((now - last)) -lt "$COOLDOWN_SECS" ] && return 0
  echo "$now" > "$STATE/$key"
  curl -s -m 10 -H "Title: $2" -d "$3" "https://ntfy.sh/$TOPIC" >/dev/null || true
}

for s in kami-renter-pod-v15-musu kami-renter-pod-v15-vipp kami-renter-pod-v16-musu kami-renter-pod-v16-vipp; do
  state=$(systemctl is-active "$s" 2>/dev/null)
  if [ "$state" != "active" ]; then
    notify "dead-$s" "worker DOWN" "$s is $state"
    continue
  fi
  n=$(journalctl -u "$s" --since "$WINDOW" --no-pager 2>/dev/null | grep -ciE "error|insufficient|fail|missing revert|reverted" || true)
  if [ "${n:-0}" -ge "$ERR_THRESHOLD" ]; then
    sample=$(journalctl -u "$s" --since "$WINDOW" --no-pager | grep -iE "error|insufficient|fail|missing revert|reverted" | tail -1 | cut -c1-180)
    notify "errs-$s" "worker errors: $s" "$n error lines in 10m. Last: $sample"
  fi
done
