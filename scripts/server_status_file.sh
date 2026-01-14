#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/_common.sh"

cd "$ROOT_DIR"

OUTPUT_FILE="${STATUS_FILE_PATH:-$ROOT_DIR/server_status.txt}"
STATUS_FILE_INTERVAL="${STATUS_FILE_INTERVAL:-300}"
LOG_TAIL_LINES="${STATUS_FILE_LOG_LINES:-8}"

load_env_if_present() {
  if [ -f "$ROOT_DIR/.env" ]; then
    while IFS= read -r line; do
      line="${line#"${line%%[![:space:]]*}"}"
      [ -z "$line" ] && continue
      [[ "$line" == \#* ]] && continue
      if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
        export "$line"
      fi
    done < "$ROOT_DIR/.env"
  fi
}

count_connections() {
  local port="$1"
  if command -v ss >/dev/null 2>&1; then
    ss -Htan "( sport = :$port or dport = :$port )" 2>/dev/null | wc -l
  elif command -v netstat >/dev/null 2>&1; then
    netstat -ant 2>/dev/null | awk -v p=":$port" '$4 ~ p || $5 ~ p' | wc -l
  else
    echo "n/a"
  fi
}

collect_log_metrics() {
  if ! command -v python3 >/dev/null 2>&1; then
    echo "REQ_LAST_HOUR=0"
    echo "REQ_4XX_LAST_HOUR=0"
    echo "REQ_5XX_LAST_HOUR=0"
    echo "REQ_AVG_MS_LAST_HOUR=0"
    return
  fi

  if [ ! -f "$LOG_FILE" ]; then
    echo "REQ_LAST_HOUR=0"
    echo "REQ_4XX_LAST_HOUR=0"
    echo "REQ_5XX_LAST_HOUR=0"
    echo "REQ_AVG_MS_LAST_HOUR=0"
    return
  fi

  LOG_FILE="$LOG_FILE" python3 <<'PY'
import json
import os
import time
from datetime import datetime

path = os.environ.get("LOG_FILE")
cutoff = time.time() - 3600
total = four_xx = five_xx = 0
durations = []

def parse_ts(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None

with open(path, "r", encoding="utf-8", errors="ignore") as f:
    for line in f:
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            data = json.loads(line)
        except Exception:
            continue
        if data.get("event") != "http_request":
            continue
        ts = parse_ts(data.get("ts"))
        if ts is None or ts < cutoff:
            continue
        total += 1
        status = int(data.get("status", 0) or 0)
        if 400 <= status < 500:
            four_xx += 1
        elif status >= 500:
            five_xx += 1
        dur = data.get("durationMs")
        try:
            dur = float(dur)
        except Exception:
            dur = None
        if dur is not None:
            durations.append(dur)

avg = (sum(durations) / len(durations)) if durations else 0
print(f"REQ_LAST_HOUR={total}")
print(f"REQ_4XX_LAST_HOUR={four_xx}")
print(f"REQ_5XX_LAST_HOUR={five_xx}")
print(f"REQ_AVG_MS_LAST_HOUR={avg:.2f}")
PY
}

collect_system_metrics() {
  if [ -r /proc/loadavg ]; then
    LOAD_AVG="$(awk '{printf "%s | %s | %s", $1, $2, $3}' /proc/loadavg)"
  else
    LOAD_AVG="$(uptime 2>/dev/null | sed 's/^.*load average: //')"
  fi

  if command -v free >/dev/null 2>&1; then
    MEM_TOTAL="$(free -h | awk '/Mem:/ {print $2}')"
    MEM_USED="$(free -h | awk '/Mem:/ {print $3}')"
    SWAP_USED="$(free -h | awk '/Swap:/ {print $3}')"
    SWAP_TOTAL="$(free -h | awk '/Swap:/ {print $2}')"
  else
    MEM_TOTAL="n/a"
    MEM_USED="n/a"
    SWAP_USED="n/a"
    SWAP_TOTAL="n/a"
  fi

  DISK_LINE="$(df -h "$ROOT_DIR" 2>/dev/null | awk 'NR==2 {print $3" / "$2" ("$5")"}')"
  DISK_USAGE="${DISK_LINE:-n/a}"
}

collect_server_process() {
  SERVER_STATUS="stopped"
  SERVER_PID="n/a"
  SERVER_UPTIME="n/a"
  SERVER_CPU="n/a"
  SERVER_MEM="n/a"

  if is_server_running; then
    SERVER_PID="$(cat "$PID_FILE")"
    SERVER_STATUS="running"
    if command -v ps >/dev/null 2>&1; then
      SERVER_UPTIME="$(ps -p "$SERVER_PID" -o etime= | tr -d ' ')"
      SERVER_CPU="$(ps -p "$SERVER_PID" -o %cpu= | tr -d ' ')"
      SERVER_MEM="$(ps -p "$SERVER_PID" -o %mem= | tr -d ' ')"
    fi
  fi
}

collect_postgres_metrics() {
  DB_STATUS="not checked"
  DB_CONNECTIONS="n/a"
  DB_SIZE="n/a"
  TOTAL_USERS="n/a"
  TOTAL_EMAILS="n/a"

  if ! command -v psql >/dev/null 2>&1; then
    DB_STATUS="psql not found"
    return
  fi

  local db_name="${DB_NAME:-${PGDATABASE:-agent_messaging}}"
  local db_host="${DB_HOST:-${PGHOST:-}}"
  local db_port="${DB_PORT:-${PGPORT:-}}"
  local db_user="${DB_USER:-${PGUSER:-}}"

  [ -n "$db_host" ] && export PGHOST="$db_host"
  [ -n "$db_port" ] && export PGPORT="$db_port"
  [ -n "$db_user" ] && export PGUSER="$db_user"
  [ -n "${DB_PASSWORD:-}" ] && export PGPASSWORD="$DB_PASSWORD"

  local base_cmd=(psql -X -A -t -d "$db_name")

  if command -v pg_isready >/dev/null 2>&1; then
    if pg_isready -d "$db_name" >/dev/null 2>&1; then
      DB_STATUS="available"
    else
      DB_STATUS="unreachable"
      return
    fi
  else
    DB_STATUS="psql available"
  fi

  DB_CONNECTIONS="$("${base_cmd[@]}" -c "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null | tr -d '[:space:]' || echo "n/a")"
  DB_SIZE="$("${base_cmd[@]}" -c "SELECT pg_size_pretty(pg_database_size(current_database()));" 2>/dev/null | tr -d '[:space:]' || echo "n/a")"
  TOTAL_USERS="$("${base_cmd[@]}" -c "SELECT count(*) FROM users;" 2>/dev/null | tr -d '[:space:]' || echo "n/a")"
  TOTAL_EMAILS="$TOTAL_USERS"
}

collect_redis_metrics() {
  REDIS_STATUS="not checked"
  REDIS_CLIENTS="n/a"
  REDIS_MEMORY="n/a"
  REDIS_CONNECTIONS="n/a"

  if ! command -v redis-cli >/dev/null 2>&1; then
    REDIS_STATUS="redis-cli not found"
    return
  fi

  local host="${REDIS_HOST:-127.0.0.1}"
  local port="${REDIS_PORT:-6379}"
  local password="${REDIS_PASSWORD:-}"
  local url="${REDIS_URL:-}"
  local db_index="${REDIS_DB:-0}"

  local cmd=(redis-cli)
  if [ -n "$url" ]; then
    cmd+=("-u" "$url")
  else
    cmd+=("-h" "$host" "-p" "$port" "-n" "$db_index")
    [ -n "$password" ] && cmd+=("-a" "$password")
  fi

  if ! "${cmd[@]}" ping >/dev/null 2>&1; then
    REDIS_STATUS="unreachable"
    return
  fi

  REDIS_STATUS="online"
  REDIS_CLIENTS="$("${cmd[@]}" info clients 2>/dev/null | awk -F= '/connected_clients/ {print $2}' | tr -d '\r' | head -n1)"
  REDIS_MEMORY="$("${cmd[@]}" info memory 2>/dev/null | awk -F= '/used_memory_human/ {print $2}' | tr -d '\r' | head -n1)"
  REDIS_CONNECTIONS="$("${cmd[@]}" info stats 2>/dev/null | awk -F= '/total_connections_received/ {print $2}' | tr -d '\r' | head -n1)"
}

write_status_file() {
  APP_PORT="${PORT:-3000}"
  HTTPS_PORT="${HTTPS_PORT:-$APP_PORT}"
  USE_HTTPS="$(echo "${HTTPS_ENABLED:-false}" | tr '[:upper:]' '[:lower:]')"
  ACTIVE_PORT="$APP_PORT"
  [[ "$USE_HTTPS" == "true" ]] && ACTIVE_PORT="$HTTPS_PORT"

  CURRENT_CONNECTIONS="$(count_connections "$ACTIVE_PORT")"
  ERROR_TOTAL=$((REQ_4XX_LAST_HOUR + REQ_5XX_LAST_HOUR))
  if [ "${REQ_LAST_HOUR:-0}" -gt 0 ]; then
    if command -v python3 >/dev/null 2>&1; then
      ERROR_RATE="$(python3 - <<PY
total = float("${REQ_LAST_HOUR}")
errors = float("${ERROR_TOTAL}")
print(f"{(errors/total)*100:.2f}%")
PY
)"
    else
      ERROR_RATE="$(awk -v t="$REQ_LAST_HOUR" -v e="$ERROR_TOTAL" 'BEGIN { if (t>0) printf "%.2f%%", (e/t)*100; else print "0%"; }')"
    fi
  else
    ERROR_RATE="0%"
  fi

  {
    echo "Server Status Snapshot - $(date -Iseconds)"
    echo
    echo "Process & Traffic"
    echo "  Server: $SERVER_STATUS (PID: $SERVER_PID)"
    echo "  Port (active): $ACTIVE_PORT (HTTPS enabled: $USE_HTTPS)"
    echo "  Uptime: $SERVER_UPTIME"
    echo "  CPU % / MEM %: $SERVER_CPU / $SERVER_MEM"
    echo "  Current connections: $CURRENT_CONNECTIONS"
    echo "  Requests last hour: $REQ_LAST_HOUR total | 4xx: $REQ_4XX_LAST_HOUR | 5xx: $REQ_5XX_LAST_HOUR | err rate: $ERROR_RATE"
    echo "  Avg latency last hour: ${REQ_AVG_MS_LAST_HOUR} ms"
    echo
    echo "System Resources"
    echo "  Load (1/5/15m): $LOAD_AVG"
    echo "  Memory used: $MEM_USED / $MEM_TOTAL"
    echo "  Swap used: $SWAP_USED / $SWAP_TOTAL"
    echo "  Disk (repo mount): $DISK_USAGE"
    echo
    echo "PostgreSQL"
    echo "  Status: $DB_STATUS"
    echo "  Connections: $DB_CONNECTIONS"
    echo "  DB size: $DB_SIZE"
    echo "  Total registered users: $TOTAL_USERS"
    echo "  Stored emails: $TOTAL_EMAILS (users.email in Postgres)"
    echo
    echo "Redis"
    echo "  Status: $REDIS_STATUS"
    echo "  Connected clients: $REDIS_CLIENTS"
    echo "  Total connections (lifetime): $REDIS_CONNECTIONS"
    echo "  Memory used: $REDIS_MEMORY"
    echo
    echo "Recent Logs (server.log)"
    if [ -f "$LOG_FILE" ]; then
      tail -n "$LOG_TAIL_LINES" "$LOG_FILE" | sed 's/^/  /'
    else
      echo "  Log file not found at $LOG_FILE"
    fi
    echo
    echo "Next refresh: every ${STATUS_FILE_INTERVAL}s"
  } > "$OUTPUT_FILE"
}

echo "[status-file] Writing status snapshots to $OUTPUT_FILE every ${STATUS_FILE_INTERVAL}s (Ctrl+C to stop)"

load_env_if_present

while true; do
  collect_system_metrics
  collect_server_process
  eval "$(collect_log_metrics)"
  collect_postgres_metrics
  collect_redis_metrics
  write_status_file
  sleep "$STATUS_FILE_INTERVAL"
done
