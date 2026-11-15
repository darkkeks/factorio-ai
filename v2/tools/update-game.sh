#!/bin/bash
# Обновление кода мода на рабочем сервере игры: остановить сервер (он сохраняет карту), сделать резервную копию
# сохранения, заменить файлы сценария внутри него, запустить, проверить, что мод отвечает и это та самая сборка.
# Если мод после запуска не отвечает — сохранение возвращается из резервной копии и сервер запускается как был.
#   update-game.sh [--build <коммит>]   — обновить; сборка попадает в ответ ping
#   update-game.sh --remove             — вернуть штатный сценарий свободной игры (состояние мода остаётся в сохранении)
# Коды выхода: 0 — обновлено; 1 — не начато (сервер запущен как был); 2 — не удалось, выполнен откат.
# Для ботов перезапуск прозрачен (очереди продолжаются, запросы ждут); людей выбивает из игры на несколько секунд.
set -e
D=$(dirname "$(readlink -f "$0")")
GAME=${GAME_DIR:-$HOME/robot/factorio/space-age-1}
SAVE=${SAVE_NAME:-space-age-1.zip}
SERVICE=${GAME_SERVICE:-factorio-space-age-1}
CONTAINER=${ROBOT_CONTAINER:-robot}
RCON_JSON=${RCON_JSON:-$D/../../rcon.json}
# Чем останавливать и запускать сервер игры (для проверки самого скрипта на тестовом стенде — test-server.sh).
CTL=${GAME_CTL:-docker exec $CONTAINER supervisorctl}
MOD=${MOD_DIR:-$D/../mod}
REMOVE=""; BUILD=""
while [ $# -gt 0 ]; do case "$1" in --remove) REMOVE=1;; --build) BUILD=$2; shift;; *) echo "неизвестный параметр $1"; exit 1;; esac; shift; done
export V2_RCON_PORT=$(python3 -c "import json;print(json.load(open('$RCON_JSON'))['port'])")
export V2_RCON_PW=$(python3 -c "import json;print(json.load(open('$RCON_JSON'))['password'])")

ping_mod() { # ждать ответа мода до 30 с (обычный запуск — около 3 с); печатает ответ ping
  for i in $(seq 1 30); do
    OUT=$(node "$D/rc.mjs" '/agent {"op":"ping"}' 2>/dev/null || true)
    case "$OUT" in *'"mod":"agent"'*) echo "$OUT"; return 0;; esac
    sleep 1
  done
  return 1
}

echo "останавливаю сервер игры ($SERVICE)…"
$CTL stop "$SERVICE"
# При остановке сервер сохраняет карту в тот же файл; если файл не обновился — последнее состояние не в нём.
AGE=$(( $(date +%s) - $(stat -c %Y "$GAME/$SAVE") ))
if [ "$AGE" -gt 120 ]; then
  echo "сохранение $SAVE не обновилось при остановке (ему $AGE с): ничего не меняю, запускаю сервер как был"
  $CTL start "$SERVICE"
  exit 1
fi
mkdir -p "$GAME/backups"
BACKUP="$GAME/backups/${SAVE%.zip}.$(date +%Y%m%d-%H%M%S).zip"
cp -p "$GAME/$SAVE" "$BACKUP"
echo "резервная копия: $BACKUP"
# Старые копии не копим: остаются последние 30.
ls -1t "$GAME/backups"/*.zip 2>/dev/null | tail -n +31 | xargs -r rm -f
if ! "$D/install-scenario.py" "$GAME/$SAVE" --mod "$MOD" ${REMOVE:+--remove} ${BUILD:+--build "$BUILD"}; then
  echo "замена сценария не удалась — возвращаю сохранение и запускаю сервер как был"
  cp -p "$BACKUP" "$GAME/$SAVE"
  $CTL start "$SERVICE"
  exit 1
fi
# Сервер с неработающим модом не запустится, и команда запуска вернёт ошибку: это не повод бросать дело на полпути —
# ниже проверка ответа мода и откат.
$CTL start "$SERVICE" || echo "команда запуска вернула ошибку"
if [ -n "$REMOVE" ]; then echo "сервер запущен без мода"; exit 0; fi
echo "жду сервер…"
if OUT=$(ping_mod); then
  GOT=$(echo "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin)['result'];print(d.get('build',''))")
  echo "мод на связи: $(echo "$OUT" | python3 -c "import json,sys;d=json.load(sys.stdin)['result'];print('версия', d['version'], 'сборка', d.get('build'), 'тик', d['tick'])")"
  if [ -z "$BUILD" ] || [ "$GOT" = "$BUILD" ]; then exit 0; fi
  echo "сборка не та: ждали $BUILD"
fi
echo "мод не ответил как надо — откат: возвращаю сохранение из $BACKUP"
$CTL stop "$SERVICE" || true
cp -p "$GAME/$SAVE" "$GAME/backups/${SAVE%.zip}.failed-$(date +%Y%m%d-%H%M%S).zip"
cp -p "$BACKUP" "$GAME/$SAVE"
$CTL start "$SERVICE" || true
if ping_mod >/dev/null; then echo "откат выполнен: работает прежняя сборка"; else echo "после отката мод не отвечает — нужен человек"; fi
exit 2
