#!/bin/bash
# Полная проверка текущего кода v2/ на тестовом стенде: свежая копия сохранения с вшитым модом, сервер ботов,
# все наборы проверок. Код выхода 0 — всё прошло. Стенд один: одновременно запускать нельзя.
#   verify.sh [--quick]   — без долгих наборов (sweep, restart)
D=$(dirname "$(readlink -f "$0")"); T=${V2_TEST_DIR:-$HOME/claude/factorio-v2-test}
SUITES="core actions planning observe"
[ "$1" = "--quick" ] || SUITES="$SUITES restart sweep"
fail() { echo "ПРОВЕРКА НЕ ПРОЙДЕНА: $*"; "$D/test-api.sh" stop >/dev/null 2>&1; "$D/test-server.sh" stop >/dev/null 2>&1; exit 1; }
for f in "$D"/../server/*.mjs "$D"/../tests/*.mjs; do node --check "$f" || fail "синтаксис $f"; done
"$D/test-api.sh" stop >/dev/null 2>&1
OUT=$("$D/reload.sh" --fresh 2>&1) || fail "мод не загрузился: $(echo "$OUT" | tail -5; grep -i "error" "$T/server.log" | tail -5)"
BAD=$(grep -E " Error |rror while|non-recoverable|Cannot execute" "$T/server.log" | grep -v "EOF on stdin" | head -5)
[ -n "$BAD" ] && fail "ошибки при загрузке мода: $BAD"
"$D/test-api.sh" start >/dev/null 2>&1
for i in $(seq 1 50); do curl -sf http://127.0.0.1:8790/v2/help >/dev/null 2>&1 && break; sleep 0.2; done
sleep 1.5
RC=0
for s in $SUITES; do
  OUT=$(cd "$D/../tests" && timeout 900 node "$s.test.mjs" 2>&1)
  if echo "$OUT" | tail -1 | grep -q "^все "; then echo "$s: $(echo "$OUT" | tail -1)"
  else echo "$s: НЕ ПРОШЛО"; echo "$OUT" | grep -A3 "✗" | head -30; echo "$OUT" | tail -3; RC=1; fi
done
grep -q "ошибка в обработчике события\|внутренняя ошибка" "$T/server.log" && { echo "в журнале игры есть ошибки мода:"; grep -A4 "ошибка в обработчике события\|внутренняя ошибка" "$T/server.log" | head -20; RC=1; }
"$D/test-api.sh" stop >/dev/null 2>&1; "$D/test-server.sh" stop >/dev/null 2>&1
[ $RC = 0 ] && echo "ПРОВЕРКА ПРОЙДЕНА" || echo "ПРОВЕРКА НЕ ПРОЙДЕНА"
exit $RC
