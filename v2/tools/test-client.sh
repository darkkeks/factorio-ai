#!/bin/bash
# Тестовый клиент игры (игрок-человек для проверок): копия игры из ~/factorio-camera с отдельным каталогом данных,
# под Xvfb, подключается к тестовому серверу.   test-client.sh start [имя] | stop [имя] | shot [имя] <файл.png> | log [имя]
T=${V2_TEST_DIR:-$HOME/claude/factorio-v2-test}
GAME=${V2_CLIENT_GAME:-$HOME/factorio-camera/factorio}
PORT=${V2_TEST_PORT:-34297}
cmd=$1; NAME=${2:-tester}
case "$NAME" in tester) DISP=:97;; tester2) DISP=:98;; *) DISP=:99;; esac
C="$T/client-$NAME"
case "$cmd" in
  start)
    [ -f "$C/pid" ] && kill -0 -- -"$(cat "$C/pid")" 2>/dev/null && { echo "уже запущен"; exit 1; }
    mkdir -p "$C/config" "$C/mods"
    cp "$GAME/mods/mod-list.json" "$C/mods/" 2>/dev/null
    cat > "$C/config/config.ini" <<INI
[path]
read-data=$GAME/data
write-data=$C
[general]
locale=en
[other]
check-updates=false
enable-crash-log-uploading=false
[interface]
[graphics]
full-screen=false
max-threads=4
show-game-simulations-in-background=false
graphics-quality=low
[sound]
INI
    [ -f "$C/player-data.json" ] || echo "{\"service-username\": \"$NAME\", \"service-token\": \"\"}" > "$C/player-data.json"
    PW=$(python3 -c "import json;print(json.load(open('$T/server-settings.json')).get('game_password',''))")
    env -u LD_LIBRARY_PATH setsid sh -c "Xvfb $DISP -screen 0 1280x720x24 -nolisten tcp & X=\$!; sleep 1; DISPLAY=$DISP nice -n 10 \"$GAME/bin/x64/factorio\" --config \"$C/config/config.ini\" --mp-connect 127.0.0.1:$PORT --disable-audio --window-size 1280x720 ${PW:+--password \"$PW\"}; kill \$X" > "$C/client.log" 2>&1 &
    echo $! > "$C/pid"; echo "запущен клиент $NAME (группа $(cat "$C/pid"), дисплей $DISP)";;
  stop)
    [ -f "$C/pid" ] && kill -TERM -- -"$(cat "$C/pid")" 2>/dev/null; rm -f "$C/pid"; echo "остановлен";;
  shot)
    env -u LD_LIBRARY_PATH ffmpeg -loglevel error -y -f x11grab -video_size 1280x720 -i $DISP -frames:v 1 "$3" && echo "$3";;
  log) tail -${3:-30} "$C/client.log";;
  *) echo "start|stop|shot|log"; exit 1;;
esac
