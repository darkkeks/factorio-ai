#!/bin/bash
# Тестовый экземпляр сервера игры: отдельная копия игры и сохранения, свои порты. Рабочий сервер не трогает.
#   test-server.sh start [сохранение.zip] | stop | status | log
T=${V2_TEST_DIR:-$HOME/claude/factorio-v2-test}
PORT=${V2_TEST_PORT:-34297}; RCON_PORT=${V2_TEST_RCON:-27115}; RCON_PW=${V2_TEST_RCON_PW:-test}
# Свой порт UDP игры: включает helpers.send_udp — «звонок» мода серверу ботов о новых событиях (V2_TEST_UDP=0 — без него).
UDP_PORT=${V2_TEST_UDP:-27116}
cd "$T" || exit 1
case "$1" in
  start)
    [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null && { echo "уже запущен: $(cat server.pid)"; exit 1; }
    SAVE=${2:-test.zip}; case "$SAVE" in *.zip) ;; *) SAVE=test.zip;; esac
    setsid nohup ./factorio/bin/x64/factorio --start-server "$SAVE" --server-settings server-settings.json \
      --port "$PORT" --rcon-bind 127.0.0.1:"$RCON_PORT" --rcon-password "$RCON_PW" \
      $([ "$UDP_PORT" != 0 ] && echo --enable-lua-udp "$UDP_PORT") > server.log 2>&1 &
    echo $! > server.pid
    for i in $(seq 1 60); do grep -q "Starting RCON interface" server.log && { echo "запущен: $(cat server.pid)"; exit 0; }
      kill -0 "$(cat server.pid)" 2>/dev/null || { echo "не запустился"; tail -20 server.log; exit 1; }; sleep 0.5; done
    echo "нет RCON за 30 с"; tail -20 server.log; exit 1;;
  stop)
    [ -f server.pid ] || { echo "не запущен"; exit 0; }
    P=$(cat server.pid); kill -INT "$P" 2>/dev/null
    for i in $(seq 1 60); do kill -0 "$P" 2>/dev/null || { rm -f server.pid; echo "остановлен"; exit 0; }; sleep 0.5; done
    echo "не остановился за 30 с"; exit 1;;
  status) [ -f server.pid ] && kill -0 "$(cat server.pid)" 2>/dev/null && echo "работает: $(cat server.pid)" || echo "не запущен";;
  log) tail -${2:-30} server.log;;
  *) echo "start|stop|status|log"; exit 1;;
esac
