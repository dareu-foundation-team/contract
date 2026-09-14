#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NETWORK="${1:-preprod}"
KEEPER_CONTRACT_VERSION="${DAREU_KEEPER_CONTRACT_VERSION:-v3}"
RESTART_DELAY_SEC="${KEEPER_RESTART_DELAY_SEC:-20}"
STOPPING=0
CHILD_PID=""

cd "$ROOT_DIR"

case "$KEEPER_CONTRACT_VERSION" in
  v2|v3) ;;
  *) echo "Unsupported DAREU_KEEPER_CONTRACT_VERSION: $KEEPER_CONTRACT_VERSION" >&2; exit 2 ;;
esac

# The mirror is read-only: no Keeper wallet, proof server or private-state
# namespace is loaded. Its default cadence can be overridden for operations.
export SYNC_INTERVAL_SEC="${SYNC_INTERVAL_SEC:-30}"

stop_process_tree() {
  local parent_pid="$1"
  local child_pid
  while IFS= read -r child_pid; do
    [[ -n "$child_pid" ]] && stop_process_tree "$child_pid"
  done < <(pgrep -P "$parent_pid" 2>/dev/null || true)
  kill -TERM "$parent_pid" 2>/dev/null || true
}

stop_child() {
  STOPPING=1
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    stop_process_tree "$CHILD_PID"
    wait "$CHILD_PID" 2>/dev/null || true
  fi
}

trap stop_child INT TERM

while [[ "$STOPPING" -eq 0 ]]; do
  echo "[sync-supervisor] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting ${KEEPER_CONTRACT_VERSION} mirror on $NETWORK (${SYNC_INTERVAL_SEC}s)"
  npm run "keeper:${KEEPER_CONTRACT_VERSION}:sync" -- "$NETWORK" &
  CHILD_PID=$!
  wait "$CHILD_PID"
  STATUS=$?
  CHILD_PID=""

  if [[ "$STOPPING" -ne 0 ]]; then
    break
  fi

  echo "[sync-supervisor] mirror exited with status $STATUS; restarting in ${RESTART_DELAY_SEC}s"
  sleep "$RESTART_DELAY_SEC" &
  CHILD_PID=$!
  wait "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""
done

echo "[sync-supervisor] stopped"
