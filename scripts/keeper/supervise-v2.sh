#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
NETWORK="${1:-preprod}"
RESTART_DELAY_SEC="${KEEPER_RESTART_DELAY_SEC:-20}"
STOPPING=0
CHILD_PID=""

cd "$ROOT_DIR"

stop_child() {
  STOPPING=1
  if [[ -n "$CHILD_PID" ]] && kill -0 "$CHILD_PID" 2>/dev/null; then
    kill "$CHILD_PID" 2>/dev/null || true
    wait "$CHILD_PID" 2>/dev/null || true
  fi
}

trap stop_child INT TERM

while [[ "$STOPPING" -eq 0 ]]; do
  echo "[keeper-supervisor] $(date -u +%Y-%m-%dT%H:%M:%SZ) starting V2 keeper on $NETWORK"
  npm run keeper:run -- "$NETWORK" &
  CHILD_PID=$!
  wait "$CHILD_PID"
  STATUS=$?
  CHILD_PID=""

  if [[ "$STOPPING" -ne 0 ]]; then
    break
  fi

  echo "[keeper-supervisor] keeper exited with status $STATUS; restarting in ${RESTART_DELAY_SEC}s"
  sleep "$RESTART_DELAY_SEC" &
  CHILD_PID=$!
  wait "$CHILD_PID" 2>/dev/null || true
  CHILD_PID=""
done

echo "[keeper-supervisor] stopped"
