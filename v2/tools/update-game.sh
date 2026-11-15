#!/bin/bash
# Обновление кода мода на рабочем сервере игры: остановить сервер (он сохраняет карту), сделать резервную копию
# сохранения, заменить файлы сценария внутри него, запустить, проверить версию мода.
#   update-game.sh            — обновить
#   update-game.sh --remove   — вернуть штатный сценарий свободной игры (мод убирается, его состояние остаётся в сохранении)
# Перезапуск сервера выбивает людей из игры: согласовать заранее. Откат — вернуть файл из каталога backups.
set -e
D=$(dirname "$(readlink -f "$0")")
GAME=${GAME_DIR:-$HOME/robot/factorio/space-age-1}
SAVE=${SAVE_NAME:-space-age-1.zip}
SERVICE=${GAME_SERVICE:-factorio-space-age-1}
CONTAINER=${ROBOT_CONTAINER:-robot}
RCON_JSON=${RCON_JSON:-$D/../../rcon.json}

echo "останавливаю сервер игры ($SERVICE)…"
docker exec "$CONTAINER" supervisorctl stop "$SERVICE"
# При остановке сервер сохраняет карту в тот же файл; если файл не обновился — последнее состояние не в нём.
AGE=$(( $(date +%s) - $(stat -c %Y "$GAME/$SAVE") ))
if [ "$AGE" -gt 120 ]; then
  echo "сохранение $SAVE не обновилось при остановке (ему $AGE с): ничего не меняю, запускаю сервер как был"
  docker exec "$CONTAINER" supervisorctl start "$SERVICE"
  exit 1
fi
mkdir -p "$GAME/backups"
BACKUP="$GAME/backups/${SAVE%.zip}.$(date +%Y%m%d-%H%M%S).zip"
cp -p "$GAME/$SAVE" "$BACKUP"
echo "резервная копия: $BACKUP"
if ! "$D/install-scenario.py" "$GAME/$SAVE" $1; then
  echo "замена сценария не удалась — сохранение не тронуто, запускаю сервер как был"
  cp -p "$BACKUP" "$GAME/$SAVE"
fi
docker exec "$CONTAINER" supervisorctl start "$SERVICE"
echo "жду сервер…"
export V2_RCON_PORT=$(python3 -c "import json;print(json.load(open('$RCON_JSON'))['port'])")
export V2_RCON_PW=$(python3 -c "import json;print(json.load(open('$RCON_JSON'))['password'])")
for i in $(seq 1 60); do
  OUT=$(node "$D/rc.mjs" '/agent {"op":"ping"}' 2>/dev/null || true)
  case "$OUT" in
    *'"mod":"agent"'*) echo "мод на связи: $(echo "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin)['result'];print('версия', d['version'], 'тик', d['tick'])")"; exit 0;;
  esac
  sleep 1
done
if [ "$1" = "--remove" ]; then echo "сервер запущен без мода"; exit 0; fi
echo "мод не ответил за 60 с — смотри журнал сервера; откат: остановить сервер, вернуть $BACKUP на место $GAME/$SAVE, запустить"
exit 1
