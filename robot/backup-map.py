#!/usr/bin/env python3
"""Регулярные резервные копии карты Factorio с прореживанием: чем старше копия, тем реже они оставлены.

Сервер игры сам пишет автосохранение каждые 5 минут игры (10 файлов по кругу — хвост меньше часа). Этот скрипт
запускается по расписанию (cron, раз в 5 минут), забирает новые автосохранения в отдельный каталог и прореживает старые:

    возраст до 3 часов   — все автосохранения (каждые 5 минут)
    до суток             — по одному на 30 минут
    до недели            — по одному на 3 часа
    до месяца            — по одному в день
    до года              — по одному в неделю
    старше               — по одному на 30 дней, бессрочно

Пока игра на паузе, новых автосохранений нет и копировать нечего. Каждая копия проверяется как архив.

    backup-map.py            скопировать новое и проредить (для cron)
    backup-map.py --list     что хранится, по ступеням
    backup-map.py --dry-run  показать, что было бы сделано

Восстановление: остановить сервер игры (docker exec robot supervisorctl stop factorio-space-age-1), положить выбранную
копию на место ~/robot/factorio/space-age-1/space-age-1.zip, запустить сервер (… start …).
Каталоги: SRC_DIR (по умолчанию ~/robot/factorio/space-age-1), BACKUP_DIR (по умолчанию ~/backups/factorio/space-age-1).
"""
import fcntl, os, re, shutil, sys, time, zipfile

SRC = os.environ.get('SRC_DIR') or os.path.expanduser('~/robot/factorio/space-age-1')
DST = os.environ.get('BACKUP_DIR') or os.path.expanduser('~/backups/factorio/space-age-1')
NAME = os.environ.get('SAVE_NAME', 'space-age-1')
SETTLE = 20  # секунд после записи: файл моложе может быть ещё не дописан

H, D = 3600, 86400
# (возраст до, одна копия на интервал); None — оставлять все
TIERS = [(3 * H, None), (D, 30 * 60), (7 * D, 3 * H), (30 * D, D), (365 * D, 7 * D), (float('inf'), 30 * D)]
TIER_NAMES = ['до 3 часов (все)', 'до суток (раз в 30 минут)', 'до недели (раз в 3 часа)', 'до месяца (раз в день)',
              'до года (раз в неделю)', 'старше года (раз в 30 дней)']
PATTERN = re.compile(r'^' + re.escape(NAME) + r'\.(\d{8})-(\d{6})\.zip$')


def stamp(ts):
    return time.strftime('%Y%m%d-%H%M%S', time.localtime(ts))


def when(name):
    m = PATTERN.match(name)
    return time.mktime(time.strptime(m.group(1) + m.group(2), '%Y%m%d%H%M%S')) if m else None


def log(*a):
    print(time.strftime('%F %T'), *a, flush=True)


def tier_of(age):
    for i, (limit, _) in enumerate(TIERS):
        if age < limit:
            return i
    return len(TIERS) - 1


def plan(names, now):
    """Какие копии оставить и какие удалить. В каждом интервале ступени остаётся самая ранняя копия:
    оставленная однажды, она живёт, пока не перейдёт в следующую ступень."""
    keep, drop, seen = [], [], set()
    for name in sorted(names, key=when):
        ts = when(name)
        i = tier_of(now - ts)
        step = TIERS[i][1]
        if step is None:
            keep.append(name)
            continue
        key = (i, int(ts // step))
        if key in seen:
            drop.append(name)
        else:
            seen.add(key)
            keep.append(name)
    return keep, drop


def sources():
    """Готовые сохранения сервера, которых ещё нет в копиях: автосохранения и основной файл (его пишет остановка сервера)."""
    out = []
    for f in os.listdir(SRC):
        if not (re.match(r'^_autosave\d+\.zip$', f) or f == NAME + '.zip'):
            continue
        p = os.path.join(SRC, f)
        st = os.stat(p)
        if time.time() - st.st_mtime < SETTLE or st.st_size == 0:
            continue
        out.append((st.st_mtime, p))
    return sorted(out)


def copy_new(dry):
    have = {f for f in os.listdir(DST) if PATTERN.match(f)}
    newest = max((when(f) for f in have), default=0)
    done = 0
    for mtime, path in sources():
        name = f'{NAME}.{stamp(mtime)}.zip'
        if name in have or int(mtime) <= newest:
            continue  # уже есть; более старое, чем последняя копия, не берём (иначе после прореживания копировалось бы заново)
        if dry:
            log('скопировал бы', os.path.basename(path), '→', name)
            continue
        tmp = os.path.join(DST, '.' + name + '.tmp')
        try:
            shutil.copy2(path, tmp)
            with zipfile.ZipFile(tmp) as z:
                bad = z.testzip()
                if bad or not any(n.endswith('level.dat0') or n.endswith('level-init.dat') for n in z.namelist()):
                    raise ValueError(f'архив повреждён или это не сохранение ({bad})')
            os.replace(tmp, os.path.join(DST, name))
            have.add(name)
            done += 1
        except Exception as e:  # автосохранение могло перезаписываться в момент копирования — возьмём в следующий раз
            log('не скопировано', os.path.basename(path), '—', e)
            try:
                os.remove(tmp)
            except OSError:
                pass
    return done


def main():
    dry = '--dry-run' in sys.argv
    os.makedirs(DST, exist_ok=True)
    if '--list' in sys.argv:
        names = sorted((f for f in os.listdir(DST) if PATTERN.match(f)), key=when)
        now = time.time()
        total = sum(os.path.getsize(os.path.join(DST, f)) for f in names)
        print(f'{DST}: копий {len(names)}, {total / 1e6:.0f} МБ')
        for i, title in enumerate(TIER_NAMES):
            group = [f for f in names if tier_of(now - when(f)) == i]
            if group:
                print(f'  {title}: {len(group)} — с {stamp(when(group[0]))} по {stamp(when(group[-1]))}')
        return
    lock = open(os.path.join(DST, '.lock'), 'w')
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        return  # предыдущий запуск ещё идёт
    copied = copy_new(dry)
    names = [f for f in os.listdir(DST) if PATTERN.match(f)]
    keep, drop = plan(names, time.time())
    for f in drop:
        if dry:
            log('удалил бы', f)
        else:
            os.remove(os.path.join(DST, f))
    if copied or drop:
        log(f'скопировано {copied}, прорежено {len(drop)}, хранится {len(keep)}')


if __name__ == '__main__':
    main()
