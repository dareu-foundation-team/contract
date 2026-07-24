#!/usr/bin/env bash
set -u

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ACTION="${1:-status}"
NETWORK="${2:-preprod}"
CATEGORIES=(crypto stocks sports)

cd "$ROOT_DIR"
mkdir -p logs

pid_file() {
  echo "$ROOT_DIR/logs/keeper-$1-supervisor.pid"
}

log_file() {
  echo "$ROOT_DIR/logs/keeper-$1.log"
}

is_running() {
  local file
  file="$(pid_file "$1")"
  [[ -f "$file" ]] || return 1
  local pid
  pid="$(tr -d '[:space:]' < "$file")"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

start_one() {
  local category="$1"
  local env_file="$ROOT_DIR/.env.keeper.${category}.local"
  local file
  file="$(pid_file "$category")"

  if is_running "$category"; then
    echo "[$category] already running (PID $(tr -d '[:space:]' < "$file"))"
    return 0
  fi
  local discovered
  discovered="$(pgrep -f "scripts/keeper/run-v2.ts ${NETWORK} ${category}$|scripts/keeper/supervise-v2.sh ${NETWORK} ${category}$" 2>/dev/null || true)"
  if [[ -n "$discovered" ]]; then
    echo "[$category] refusing duplicate start; Keeper process already exists: $discovered" >&2
    return 1
  fi
  if [[ ! -f "$env_file" ]]; then
    echo "[$category] missing $env_file" >&2
    return 1
  fi

  nohup bash scripts/keeper/supervise-v2.sh "$NETWORK" "$category" \
    >> "$(log_file "$category")" 2>&1 &
  local pid=$!
  echo "$pid" > "$file"
  echo "[$category] started supervisor PID $pid; log: $(log_file "$category")"
}

stop_one() {
  local category="$1"
  local file
  file="$(pid_file "$category")"
  if ! is_running "$category"; then
    echo "[$category] not running"
    rm -f "$file"
    return 0
  fi

  local pid
  pid="$(tr -d '[:space:]' < "$file")"
  kill -TERM "$pid" 2>/dev/null || true
  for _ in {1..20}; do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.5
  done
  if kill -0 "$pid" 2>/dev/null; then
    echo "[$category] supervisor PID $pid did not stop; inspect it manually" >&2
    return 1
  fi
  rm -f "$file"
  echo "[$category] stopped"
}

status_one() {
  local category="$1"
  local file
  file="$(pid_file "$category")"
  if is_running "$category"; then
    echo "[$category] running (supervisor PID $(tr -d '[:space:]' < "$file"))"
  else
    echo "[$category] stopped"
  fi
}

case "$ACTION" in
  start)
    legacy="$(pgrep -f "scripts/keeper/run-v2.ts ${NETWORK}$|scripts/keeper/supervise-v2.sh ${NETWORK}$" 2>/dev/null || true)"
    if [[ -n "$legacy" ]]; then
      echo "Refusing to start category Keepers while an unscoped legacy Keeper is running: $legacy" >&2
      echo "Stop the old supervisor and run-v2 process first." >&2
      exit 1
    fi
    failed=0
    for category in "${CATEGORIES[@]}"; do start_one "$category" || failed=1; done
    exit "$failed"
    ;;
  stop)
    failed=0
    for category in "${CATEGORIES[@]}"; do stop_one "$category" || failed=1; done
    exit "$failed"
    ;;
  restart)
    failed=0
    for category in "${CATEGORIES[@]}"; do stop_one "$category" || failed=1; done
    for category in "${CATEGORIES[@]}"; do start_one "$category" || failed=1; done
    exit "$failed"
    ;;
  status)
    for category in "${CATEGORIES[@]}"; do status_one "$category"; done
    ;;
  *)
    echo "Usage: $0 <start|stop|restart|status> [network]" >&2
    exit 2
    ;;
esac
