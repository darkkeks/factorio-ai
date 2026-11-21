#!/usr/bin/env python3
"""Пересылка датаграмм мода из контейнера игры серверу ботов на хосте.

Игра умеет слать UDP только на свой localhost (helpers.send_udp, ключ запуска --enable-lua-udp), а сервер ботов
работает на хосте. Этот процесс живёт в контейнере рядом с игрой (supervisord, как сторож паузы), слушает
127.0.0.1:LISTEN_PORT и каждую датаграмму без изменений отправляет на TARGET_HOST:TARGET_PORT — адрес хоста
в сети контейнера, где слушает сервер ботов (config.json → bell). В датаграммах — события журнала мода; потеря
не страшна: сервер ботов дочитает журнал по RCON.
"""
import os, socket, time

LISTEN = ('127.0.0.1', int(os.environ.get('LISTEN_PORT', '27017')))
TARGET = (os.environ.get('TARGET_HOST', '172.31.250.1'), int(os.environ.get('TARGET_PORT', '27017')))

src = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
src.bind(LISTEN)
dst = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
print(time.strftime('%F %T'), 'пересылаю %s:%d → %s:%d' % (LISTEN + TARGET), flush=True)
count, shown = 0, time.time()
while True:
    data = src.recv(65535)
    try:
        dst.sendto(data, TARGET)
        count += 1
    except OSError as e:  # сервер ботов перезапускается — датаграмма пропадёт, журнал дочитают по RCON
        if time.time() - shown > 60:
            print(time.strftime('%F %T'), 'не отправлено:', e, flush=True)
            shown = time.time()
    if count and count % 100000 == 0:
        print(time.strftime('%F %T'), 'переслано датаграмм:', count, flush=True)
