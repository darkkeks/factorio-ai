#!/bin/sh
# Хозяин сессий Claude. Запуск: tmux new-window -d -t 0: -n factorio-sessions ~/claude/discord-voice/run-sessions.sh
# Перезапуск этого процесса прерывает сессии ботов и их саб-агентов — делать только при изменении src/sessions.mjs или src/agent.mjs.
cd "$(dirname "$0")"
export ROBOT_CONTAINER="${ROBOT_CONTAINER-robot}"
while true; do node src/sessions.mjs 2>&1 | tee -a sessions.log; sleep 3; done
