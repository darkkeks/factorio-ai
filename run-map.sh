#!/bin/sh
# Веб-карта сервера Factorio. Запуск: tmux new-window -d -t 0: -n factorio-map ~/claude/discord-voice/run-map.sh
# Сервис сам запускает клиент-камеру (~/factorio-camera) и останавливает его при штатной остановке.
cd "$(dirname "$0")"
trap 'kill $pid 2>/dev/null; exit 0' INT TERM HUP
while true; do
  node src/map.mjs >> map.log 2>&1 &
  pid=$!
  wait $pid
  sleep 3
done
