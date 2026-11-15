#!/bin/sh
# Сервер ботов (HTTP → мод в игре). Запуск: tmux new-window -d -t 0: -n factorio-api ~/claude/discord-voice/run-api.sh
# Игрового состояния не хранит: перезапуск не обрывает действий ботов, журнал событий дочитывается из игры.
cd "$(dirname "$0")"
while true; do node v2/server/server.mjs 2>&1 | tee -a api.log; sleep 3; done
