#!/bin/bash
# Режим ожидания: игра и службы работают, но боты не играют, а игра стоит на паузе, пока в ней нет людей.
#   hold.sh on     — включить: действия ботов не принимаются, их очереди очищаются
#   hold.sh off    — выключить: боты снова могут действовать
#   hold.sh status
# Сессии ботов (окно factorio-sessions) этот режим не трогает: их останавливают и запускают отдельно.
D=$(dirname "$(readlink -f "$0")"); ROOT=$(readlink -f "$D/../..")
FLAG=${HOLD_FILE:-$HOME/robot/hold}
export V2_RCON_PORT=${V2_RCON_PORT:-$(python3 -c "import json;print(json.load(open('$ROOT/rcon.json'))['port'])")}
export V2_RCON_PW=${V2_RCON_PW:-$(python3 -c "import json;print(json.load(open('$ROOT/rcon.json'))['password'])")}
case "$1" in
  on)
    date '+%F %T' > "$FLAG"; echo "режим ожидания включён ($FLAG)"
    # Очереди действий ботов очищаются: то, что уже поставлено, исполняться не должно.
    NAMES=$(node "$D/rc.mjs" '/agent {"op":"agents"}' 2>/dev/null | python3 -c "
import json,sys
try: print('\n'.join(a['name'] for a in json.load(sys.stdin)['result']['agents'] if a.get('queue')))
except Exception: pass")
    while IFS= read -r n; do [ -n "$n" ] || continue
      node "$D/rc.mjs" "/agent $(python3 -c "import json,sys;print(json.dumps({'op':'clear','agent':sys.argv[1]},ensure_ascii=False))" "$n")" >/dev/null && echo "очередь очищена: $n"
    done <<< "$NAMES";;
  off) rm -f "$FLAG"; echo "режим ожидания выключен: боты могут действовать";;
  status) [ -f "$FLAG" ] && echo "режим ожидания включён с $(cat "$FLAG")" || echo "режим ожидания выключен";;
  *) sed -n 2,6p "$0"; exit 1;;
esac
