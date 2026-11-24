#!/bin/sh
# Второй экземпляр веб-карты — на тестовый сервер (~/factorio-test2, мир Warger's 100%) для сравнения отрисовки.
# Порт 8767 (снаружи — factorio.darkkeks.me/test/), своя клиент-камера (~/factorio-camera2), свой сокет перехвата.
cd "$(dirname "$0")"
export MAP_PORT=8767 MAP_RCON_JSON=/home/darkkeks/factorio-test2/rcon.json MAP_SERVER_SETTINGS=/home/darkkeks/factorio-test2/server-settings.json \
  GAME_ADDR=127.0.0.1:34210 CAMERA_DIR=/home/darkkeks/factorio-camera2 CAMERA_DATA=/home/darkkeks/factorio-camera2/data CAMERA_CONFIG=/home/darkkeks/factorio-camera2/data/config/config.ini CAMERA_DISPLAY=:94 \
  V2_SOCK=/home/darkkeks/factorio-camera2/hook/v2.sock CLAUDE_SESSIONS=/home/darkkeks/factorio-camera2/sessions-none
trap 'kill $pid 2>/dev/null; exit 0' INT TERM HUP
while true; do
  node src/map.mjs >> map-test2.log 2>&1 &
  pid=$!
  wait $pid
  sleep 3
done
