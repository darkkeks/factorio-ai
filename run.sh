#!/bin/sh
# Перезапуск: tmux kill-window -t 0:discord-voice; tmux new-window -d -t 0: -n discord-voice ~/claude/discord-voice/run.sh
cd "$(dirname "$0")"
# Claude работает в контейнере robot; ROBOT_CONTAINER= ./run.sh вернёт запуск на хосте.
export ROBOT_CONTAINER="${ROBOT_CONTAINER-robot}"
while true; do node src/main.mjs 2>&1 | grep --line-buffered -v -E "resampler|sample_rate" | tee -a bot.log; sleep 3; done
