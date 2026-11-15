#!/bin/bash
# Сервер ботов для тестового экземпляра: test-api.sh start | stop | log
T=${V2_TEST_DIR:-$HOME/claude/factorio-v2-test}; D=$(dirname "$(readlink -f "$0")")
case "$1" in
  start) [ -f "$T/api.pid" ] && kill -0 "$(cat "$T/api.pid")" 2>/dev/null && { echo "уже запущен"; exit 1; }
    V2_CONFIG="$T/server-config.json" setsid nohup node "$D/../server/server.mjs" >> "$T/api.log" 2>&1 & echo $! > "$T/api.pid"; sleep 0.7; tail -3 "$T/api.log";;
  stop) [ -f "$T/api.pid" ] && kill "$(cat "$T/api.pid")" 2>/dev/null; rm -f "$T/api.pid"; echo остановлен;;
  log) tail -${2:-20} "$T/api.log";;
esac
