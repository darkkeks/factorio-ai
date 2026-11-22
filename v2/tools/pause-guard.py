#!/usr/bin/env python3
"""Сторож паузы: игра идёт, пока в ней есть люди или хотя бы один подключённый бот что-то делает (непустая очередь
действий или ручного крафта). Иначе — пауза. Бот, от которого 5 минут нет запросов, считается отключённым: часы
моду сообщает сторож (now), поэтому молчание меряется и тогда, когда игра стоит.

Правило исполняет мод одной командой (операция pause_if_idle), поэтому гонки «бот поставил действие, пока сторож
решал» нет; поставленное действие само снимает паузу, не дожидаясь сторожа. Чтение мира игру не будит.
Люди в голосовом канале сами по себе игру не держат: боты могут быть где угодно, а не только у голосового бота.
Если мода в игре нет (старое сохранение), пауза ставится, когда в игре нет людей.
"""
import json, os, socket, struct, time

# Режим ожидания (v2/tools/hold.sh): файл ставят люди, когда никто не играет. Действия ботов сервер ботов в это время
# не принимает, а игра стоит на паузе, пока в ней нет людей, — очереди ботов не учитываются.
HOLD = os.path.expanduser('~/hold')
# «Не ставить паузу» (v2/tools/keep-running.sh): пока есть этот файл, игра идёт всегда — и без людей, и без занятых
# ботов. Нужно, когда мир должен жить сам (например, для разработки веб-карты). С режимом ожидания совместимо:
# боты не играют, а игра идёт.
KEEP = os.path.expanduser('~/keep-running')
PASSWORD = os.environ['RCON_PASSWORD']
PORT = int(os.environ.get('RCON_PORT', '27015'))
# Клиент-камера веб-карты — не человек: с ним одним игра должна вставать на паузу.
CAMERA = os.environ.get('CAMERA_PLAYER', 'camera')


class Rcon:
    def __init__(self):
        self.sock = socket.create_connection(('127.0.0.1', PORT), timeout=10)
        self.call(3, PASSWORD)

    def call(self, kind, body):
        data = struct.pack('<ii', 1, kind) + body.encode() + b'\0\0'
        self.sock.sendall(struct.pack('<i', len(data)) + data)
        size = struct.unpack('<i', self.read(4))[0]
        packet = self.read(size)
        if struct.unpack('<i', packet[:4])[0] == -1:
            raise RuntimeError('RCON: неверный пароль')
        return packet[8:-2].decode()

    def read(self, n):
        buf = b''
        while len(buf) < n:
            chunk = self.sock.recv(n - len(buf))
            if not chunk:
                raise ConnectionError('RCON: соединение закрыто')
            buf += chunk
        return buf


def legacy(rcon):
    players, paused = rcon.call(2, '/silent-command local n = 0 for _, p in pairs(game.connected_players) do if p.name ~= "%s" then n = n + 1 end end rcon.print(n .. " " .. tostring(game.tick_paused))' % CAMERA).split()
    want = players == '0'
    if want != (paused == 'true'):
        rcon.call(2, '/silent-command game.tick_paused = %s' % ('true' if want else 'false'))
        return want, 'игроков: %s (мода нет)' % players
    return None, None


rcon = None
while True:
    try:
        rcon = rcon or Rcon()
        hold = os.path.exists(HOLD)
        keep = os.path.exists(KEEP)
        req = {'op': 'pause_if_idle', 'admin': True, 'params': {'ignore': [CAMERA], 'now': int(time.time()), 'bots_off': hold, 'keep': keep}}
        out = rcon.call(2, '/agent ' + json.dumps(req, ensure_ascii=False))
        try:
            r = json.loads(out)
        except ValueError:
            r = None
        if r and r.get('ok'):
            r = r['result']
            if r['changed']:
                print(time.strftime('%F %T'), 'пауза' if r['paused'] else 'игра идёт',
                      '(%s%sигроков: %s, занятых ботов: %s, отключённых с очередью: %s)' % ('пауза запрещена; ' if keep else '', 'режим ожидания; ' if hold else '', r['humans'], r['busy'], r.get('silent', 0)), flush=True)
        else:
            changed, why = legacy(rcon)
            if changed is not None:
                print(time.strftime('%F %T'), 'пауза' if changed else 'игра идёт', '(%s)' % why, flush=True)
    except Exception as e:  # сервер перезапускается — пробуем снова
        print(time.strftime('%F %T'), 'ошибка:', e, flush=True)
        rcon = None
    time.sleep(5)
