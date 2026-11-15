#!/bin/bash
# Переключение рабочей карты со старой системы (инструменты MCP из src/factorio.mjs) на новую (v2/).
# Запускать из основной копии проекта (~/claude/discord-voice) ПОСЛЕ слияния ветки v2 и по согласованию с darkkeks:
# сервер игры перезапускается, людей выбивает из игры на время перезапуска.
#
#   cutover.sh check                 — только проверки, ничего не меняет
#   cutover.sh go                    — переключить
#   cutover.sh rollback <копия.zip>  — вернуть старую систему и сохранение из резервной копии
#
# Старая и новая системы одним персонажем одновременно не управляют: сначала останавливаются исполнители ботов
# и старый процесс инструментов, потом меняется сценарий в сохранении, потом запускается новый сервер.
set -e
D=$(dirname "$(readlink -f "$0")")
ROOT=$(readlink -f "$D/../..")
GAME=${GAME_DIR:-$HOME/robot/factorio/space-age-1}
SAVE=space-age-1.zip
CONTAINER=robot
TMUX_SESSION=0

say() { echo "── $*"; }
win() { tmux list-windows -t "$TMUX_SESSION" -F '#W' | grep -qx "$1"; }

executors() { # процессы собственных скриптов ботов в контейнере: рабочая папка внутри ~/bots или вызов fx
  docker exec "$CONTAINER" sh -c 'for p in /proc/[0-9]*; do pid=${p#/proc/}; cwd=$(readlink $p/cwd 2>/dev/null); cmd=$(tr "\0" " " < $p/cmdline 2>/dev/null); case "$cmd" in *claude*|"") continue;; esac; case "$cwd $cmd" in /home/robot/bots/*|*"/home/robot/bin/fx "*|*" /home/robot/bots/"*) echo "$pid $cmd";; esac; done' 2>/dev/null | cut -c1-140
}

check() {
  say "ветка и код"
  [ -f "$ROOT/v2/mod/control.lua" ] && [ -f "$ROOT/run-api.sh" ] || { echo "нет v2/ в $ROOT: сначала слить ветку v2"; return 1; }
  ( cd "$ROOT" && git status --short | grep -v '^??' ) && { echo "есть незакоммиченные правки"; return 1; } || true
  say "сервер игры"; docker exec "$CONTAINER" supervisorctl status
  say "сохранение"; ls -la "$GAME/$SAVE"; df -h "$GAME" | tail -1
  say "окна tmux"; tmux list-windows -t "$TMUX_SESSION" -F '#W' | grep -E 'factorio|discord|feedback' | tr '\n' ' '; echo
  say "исполнители ботов в контейнере (будут остановлены)"; executors || true
  say "люди в игре"; V2_RCON_PORT=$(python3 -c "import json;print(json.load(open('$ROOT/rcon.json'))['port'])") V2_RCON_PW=$(python3 -c "import json;print(json.load(open('$ROOT/rcon.json'))['password'])") \
    node "$D/rc.mjs" '/silent-command local t = {} for _, p in pairs(game.connected_players) do t[#t+1] = p.name end rcon.print(#t .. ": " .. table.concat(t, ", "))'
}

go() {
  check
  say "1. обработчик заявок: его предмет (src/factorio.mjs) удалён — окно останавливается"
  win feedback-worker && tmux kill-window -t "$TMUX_SESSION:feedback-worker" || true
  say "2. исполнители ботов: их скрипты поверх fx останавливаются"
  executors | while read -r pid rest; do docker exec "$CONTAINER" kill "$pid" 2>/dev/null || true; done
  say "3. старый процесс инструментов"
  win factorio-mcp && tmux kill-window -t "$TMUX_SESSION:factorio-mcp" || true
  say "4. сервер игры: остановка, резервная копия, замена сценария, запуск"
  RCON_JSON="$ROOT/rcon.json" "$D/update-game.sh"
  say "5. сервер ботов на прежнем адресе старых инструментов (у ботов он в FX_URL)"
  [ -f "$ROOT/v2/server/config.json" ] || python3 - "$ROOT" <<'PY'
import json, sys
root = sys.argv[1]
r = json.load(open(f'{root}/rcon.json'))
conf = {'http': {'host': '172.25.0.1', 'port': 8765}, 'rcon': {'host': r['host'], 'port': r['port'], 'password': r['password']},
        'tokens': '../../mcp-tokens.json', 'logDir': 'log', 'pollMs': 100}
json.dump(conf, open(f'{root}/v2/server/config.json', 'w'), indent=1)
PY
  chmod 600 "$ROOT/v2/server/config.json"
  win factorio-api || tmux new-window -d -t "$TMUX_SESSION:" -n factorio-api "$ROOT/run-api.sh"
  sleep 3; tail -3 "$ROOT/api.log"
  say "6. сторож паузы: учитывает очереди ботов"
  cp -p "$HOME/robot/bin/pause-guard.py" "$HOME/robot/bin/pause-guard.py.old"
  cp "$D/pause-guard.py" "$HOME/robot/bin/pause-guard.py"
  docker exec "$CONTAINER" supervisorctl restart pause-guard
  say "7. голосовой бот: новый код создания персонажей"
  win discord-voice && tmux kill-window -t "$TMUX_SESSION:discord-voice"
  tmux new-window -d -t "$TMUX_SESSION:" -n discord-voice "$ROOT/run.sh"
  say "готово. Правила (rules/RULES.md) хозяин сессий разошлёт ботам сам. Проверка: curl -s http://172.25.0.1:8765/v2/help | head -c 300"
}

rollback() {
  BACKUP=$1
  [ -f "$BACKUP" ] || { echo "укажи резервную копию сохранения: $GAME/backups/…zip"; exit 1; }
  say "останавливаю сервер ботов и сервер игры"
  win factorio-api && tmux kill-window -t "$TMUX_SESSION:factorio-api" || true
  docker exec "$CONTAINER" supervisorctl stop factorio-space-age-1
  cp -p "$GAME/$SAVE" "$GAME/backups/${SAVE%.zip}.before-rollback.$(date +%Y%m%d-%H%M%S).zip"
  cp -p "$BACKUP" "$GAME/$SAVE"
  [ -f "$HOME/robot/bin/pause-guard.py.old" ] && cp -p "$HOME/robot/bin/pause-guard.py.old" "$HOME/robot/bin/pause-guard.py"
  docker exec "$CONTAINER" supervisorctl start factorio-space-age-1
  docker exec "$CONTAINER" supervisorctl restart pause-guard
  say "сохранение и сторож паузы возвращены. Осталось вернуть код: в $ROOT выполнить git revert слияния v2 (вернутся src/factorio.mjs,"
  say "run-mcp.sh и прежние правила — хозяин сессий разошлёт их сам), затем запустить окна factorio-mcp и discord-voice, как в README."
}

case "$1" in check) check;; go) go;; rollback) rollback "$2";; *) sed -n 2,12p "$0"; exit 1;; esac
