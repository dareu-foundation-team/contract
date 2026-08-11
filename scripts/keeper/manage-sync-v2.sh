#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACTION="${1:-status}"
NETWORK="${2:-preprod}"
LOG_TIMESTAMP="${KEEPER_LOG_TIMESTAMP:-$(date '+%Y%m%d-%H%M%S')}"
PID_FILE="$ROOT_DIR/logs/keeper-sync-supervisor.pid"
LOG_PATH_FILE="$ROOT_DIR/logs/keeper-sync-supervisor.log-path"

cd "$ROOT_DIR"
mkdir -p logs

is_running() {
  [[ -f "$PID_FILE" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

new_log_file() {
  local base="$ROOT_DIR/logs/keeper-sync-${LOG_TIMESTAMP}"
  local candidate="${base}.log"
  local suffix=1
  while [[ -e "$candidate" ]]; do
    candidate="${base}-${suffix}.log"
    suffix=$((suffix + 1))
  done
  echo "$candidate"
}

start_sync() {
  if is_running; then
    echo "[sync] already running (PID $(tr -d '[:space:]' < "$PID_FILE"))"
    return 0
  fi
  local discovered
  discovered="$(pgrep -f "scripts/keeper/sync-v2.ts ${NETWORK}$|scripts/keeper/supervise-sync-v2.sh ${NETWORK}$" 2>/dev/null || true)"
  if [[ -n "$discovered" ]]; then
    echo "[sync] refusing duplicate start; mirror process already exists: $discovered" >&2
    return 1
  fi

  local log
  log="$(new_log_file)"
  printf '[sync-manager] %s starting supervisor on %s\n' \
    "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$NETWORK" > "$log"
  nohup bash scripts/keeper/supervise-sync-v2.sh "$NETWORK" >> "$log" 2>&1 &
  local pid=$!
  echo "$pid" > "$PID_FILE"
  echo "$log" > "$LOG_PATH_FILE"
  echo "[sync] started supervisor PID $pid; log: $log"
}

stop_sync() {
  if ! is_running; then
    echo "[sync] not running"
    rm -f "$PID_FILE"
    return 0
  fi
  local pid
  pid="$(tr -d '[:space:]' < "$PID_FILE")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[sync] supervisor PID $pid did not stop; inspect it manually" >&2
    return 1
  fi
  rm -f "$PID_FILE"
  echo "[sync] stopped"
}

status_sync() {
  local log=""
  if [[ -f "$LOG_PATH_FILE" ]]; then
    log="$(tr -d '\r\n' < "$LOG_PATH_FILE")"
  fi
  if is_running; then
    echo "[sync] running (supervisor PID $(tr -d '[:space:]' < "$PID_FILE")); log: $log"
  elif [[ -n "$log" ]]; then
    echo "[sync] stopped; last log: $log"
  else
    echo "[sync] stopped"
  fi
}

case "$ACTION" in
  start) start_sync ;;
  stop) stop_sync ;;
  restart) stop_sync && start_sync ;;
  status) status_sync ;;
  *)
    echo "Usage: $0 <start|stop|restart|status> [network]" >&2
    exit 2
    ;;
esac
