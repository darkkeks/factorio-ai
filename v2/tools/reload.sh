#!/bin/bash
# Тестовый цикл: остановить тестовый сервер, вшить текущий код мода в сохранение, запустить.
#   reload.sh            — в текущее test.zip (состояние сохраняется)
#   reload.sh --fresh    — в свежую копию base-copy.zip (как при первом переносе)
D=$(dirname "$(readlink -f "$0")"); T=${V2_TEST_DIR:-$HOME/claude/factorio-v2-test}
"$D/test-server.sh" stop >/dev/null
[ "$1" = "--fresh" ] && cp "$T/base-copy.zip" "$T/test.zip"
"$D/install-scenario.py" "$T/test.zip" >/dev/null && "$D/test-server.sh" start && grep -n "Error\|error\|agent:" "$T/server.log" | grep -v "EOF on stdin" | head -20
