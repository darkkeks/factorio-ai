#!/bin/sh
# Сетевой MCP к Factorio для внешних ботов. Запуск: tmux new-window -d -t 0: -n factorio-mcp ~/claude/discord-voice/run-mcp.sh
cd "$(dirname "$0")"
while true; do node src/mcp-http.mjs 2>&1 | tee -a mcp.log; sleep 3; done
