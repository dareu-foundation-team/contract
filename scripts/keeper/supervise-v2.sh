#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NETWORK="${1:-preprod}"
CATEGORY="${2:-}"
RESTART_DELAY_SEC="${KEEPER_RESTART_DELAY_SEC:-20}"
STOPPING=0
CHILD_PID=""

cd "$ROOT_DIR"

case "$CATEGORY" in
  crypto|stocks|sports) ;;
  *)
    echo "Usage: $0 <network> <crypto|stocks|sports>" >&2
    exit 2
    ;;
esac

# Each category owns a different Midnight wallet. The TypeScript env loader reads
# this file before .env/.env.local, while common DB/network/operator settings can
# remain in .env.local.
KEEPER_ENV_FILE="${DAREU_KEEPER_ENV_FILE:-$ROOT_DIR/.env.keeper.${CATEGORY}.local}"
if [[ ! -f "$KEEPER_ENV_FILE" ]]; then
  echo "[keeper-supervisor:$CATEGORY] missing wallet env file: $KEEPER_ENV_FILE" >&2
  echo "Copy .env.keeper.${CATEGORY}.example to .env.keeper.${CATEGORY}.local and add the wallet secret." >&2
  exit 2
fi

export DAREU_ENV_FILE="$KEEPER_ENV_FILE"
export DAREU_KEEPER_CATEGORY="$CATEGORY"
export MIDNIGHT_WALLET_CACHE_NAMESPACE="${MIDNIGHT_WALLET_CACHE_NAMESPACE:-$CATEGORY}"
export MIDNIGHT_PRIVATE_STATE_NAMESPACE="${MIDNIGHT_PRIVATE_STATE_NAMESPACE:-$CATEGORY}"

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
    # npm -> tsx -> node is a process tree. Killing only npm can orphan the actual
    # Keeper, so terminate descendants first and wait for the root child.
    stop_process_tree "$CHILD_PID"
    wait "$CHILD_PID" 2>/dev/null || true
  fi
}

trap stop_child INT TERM

while [[ "$STOPPING" -eq 0 ]]; do
  echo "[keeper-supervisor:$CATEGORY] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting V2 keeper on $NETWORK"
  npm run keeper:run -- "$NETWORK" "$CATEGORY" &
  CHILD_PID=$!
  wait "$CHILD_PID"
  STATUS=$?
  CHILD_PID=""

  if [[ "$STOPPING" -ne 0 ]]; then
    break
  fi

  echo "[keeper-supervisor:$CATEGORY] keeper exited with status $STATUS; restarting in ${RESTART_DELAY_SEC}s"
  sleep "$RESTART_DELAY_SEC" &
  CHILD_PID=$!
  wait "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""
done

echo "[keeper-supervisor:$CATEGORY] stopped"
