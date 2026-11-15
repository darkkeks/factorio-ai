#!/usr/bin/env python3
"""Заменяет файлы сценария внутри сохранения: control.lua и каталог agent/.

    install-scenario.py <сохранение.zip> [--out <новое.zip>] [--mod <каталог mod>] [--remove]

Без --out сохранение переписывается на месте (через временный файл); исходник должен быть уже скопирован в резерв.
--remove возвращает штатный control.lua свободной игры и убирает agent/ (откат).
Сервер игры при этом должен быть остановлен.
"""
import argparse, os, sys, zipfile

STOCK = "require('__base__/script/freeplay/control.lua')\n"

ap = argparse.ArgumentParser()
ap.add_argument('save')
ap.add_argument('--out')
ap.add_argument('--mod', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'mod'))
ap.add_argument('--remove', action='store_true')
ap.add_argument('--build', help='идентификатор сборки (коммит): попадает в agent/build.lua, его возвращает ping')
a = ap.parse_args()

src = zipfile.ZipFile(a.save)
names = src.namelist()
root = names[0].split('/')[0]
assert all(n.split('/')[0] == root for n in names), 'в архиве больше одного корневого каталога'

new = {}
if a.remove:
    new[f'{root}/control.lua'] = STOCK.encode()
else:
    for base, _, files in os.walk(a.mod):
        for f in files:
            if f.endswith('.lua') or f.endswith('.cfg'):
                p = os.path.join(base, f)
                rel = os.path.relpath(p, a.mod).replace(os.sep, '/')
                new[f'{root}/{rel}'] = open(p, 'rb').read()
    assert f'{root}/control.lua' in new, 'в каталоге мода нет control.lua'
    if a.build:
        assert all(c.isalnum() or c in '-._' for c in a.build), 'недопустимый идентификатор сборки'
        new[f'{root}/agent/build.lua'] = f"return '{a.build}'\n".encode()

out = a.out or a.save + '.tmp'
dst = zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED)
kept = replaced = dropped = 0
for info in src.infolist():
    n = info.filename
    if n in new:
        replaced += 1
        continue
    if n.startswith(f'{root}/agent/') or (n.startswith(f'{root}/locale/') and n.endswith('/agent.cfg')):
        dropped += 1
        continue
    dst.writestr(info, src.read(n), zipfile.ZIP_DEFLATED)
    kept += 1
for n, data in sorted(new.items()):
    dst.writestr(n, data, zipfile.ZIP_DEFLATED)
dst.close(); src.close()
if not a.out:
    os.replace(out, a.save)
print(f'{a.out or a.save}: записано файлов сценария {len(new)} (заменено {replaced}, убрано старых {dropped}), остальных {kept}')
