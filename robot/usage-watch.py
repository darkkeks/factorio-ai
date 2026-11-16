#!/usr/bin/env python3
"""Сторож расхода подписки ботами Factorio.

Раз в 10 минут (cron) записывает строку в ~/robot/logs/usage.csv:
  - недельный процент подписки (общий на аккаунт: боты + всё остальное под тем же логином);
  - расход каждого бота за интервал в «эквиваленте входных токенов»
    (ввод ×1, запись кэша ×1,25 / ×2 для часового, чтение кэша ×0,1, вывод ×5), по транскриптам сессий;
  - для сравнения — расход остальных сессий аккаунта на хосте (~/.claude/projects).
Бюджет: к сбросу недели процент не должен превысить TARGET. Допустимая линия — прямая от точки старта
наблюдения (или от нуля после сброса недели) до TARGET в момент сброса.

  usage-watch.py            снять замер (для cron)
  usage-watch.py --status   показать сводку по журналу, ничего не записывая
"""
import csv, glob, json, os, re, sys, time, urllib.request
from datetime import datetime, timezone

HOME = os.path.expanduser('~')
TARGET = 50.0                      # потолок недельного процента
BOT_ROOT = f'{HOME}/robot/.claude/projects'
HOST_ROOT = f'{HOME}/.claude/projects'
CREDS = f'{HOME}/robot/.claude/.credentials.json'
SESSIONS_LOG = f'{HOME}/claude/discord-voice/sessions.log'
STATE = f'{HOME}/robot/logs/usage-state.json'
LOG = f'{HOME}/robot/logs/usage.csv'
BOTS = ['darkkeks-бот', 'Marshal-бот', 'ArthurREW-бот']
FIELDS = ['time', 'pct', 'allowed', 'resets_at'] + BOTS + ['bots_other', 'host_other', 'bots_requests']


def fetch_usage():
    token = json.load(open(CREDS))['claudeAiOauth']['accessToken']
    req = urllib.request.Request('https://api.anthropic.com/api/oauth/usage', headers={
        'Authorization': f'Bearer {token}', 'anthropic-beta': 'oauth-2025-04-20', 'User-Agent': 'usage-watch'})
    d = json.load(urllib.request.urlopen(req, timeout=30))
    w = d['seven_day']
    return float(w['utilization']), w['resets_at']


def session_owners():
    owners = {}
    try:
        for m in re.finditer(r'\[agent ([^\]]+)\] сессия ([0-9a-f-]{36})', open(SESSIONS_LOG, errors='replace').read()):
            owners[m.group(2)] = m.group(1)
    except OSError:
        pass
    return owners


def eq(u):
    cw = u.get('cache_creation_input_tokens', 0)
    cw1h = (u.get('cache_creation') or {}).get('ephemeral_1h_input_tokens', 0)
    return (u.get('input_tokens', 0) + (cw - cw1h) * 1.25 + cw1h * 2
            + u.get('cache_read_input_tokens', 0) * 0.1 + u.get('output_tokens', 0) * 5)


def scan(root, offsets, first_run):
    """Новые ответы моделей с прошлого замера: {id верхней сессии: [экв. токены, запросы]}."""
    out = {}
    for f in glob.glob(root + '/**/*.jsonl', recursive=True):
        try:
            size = os.path.getsize(f)
        except OSError:
            continue
        st = offsets.get(f, {})
        if first_run:                       # до первого замера ничего не считаем
            offsets[f] = {'pos': size, 'last': None}
            continue
        pos = st.get('pos', 0)
        if size <= pos:
            continue
        seen = {}
        with open(f, 'rb') as fh:
            fh.seek(pos)
            data = fh.read()
        end = data.rfind(b'\n') + 1         # неполную последнюю строку дочитаем в следующий раз
        for line in data[:end].splitlines():
            if b'"usage"' not in line:
                continue
            try:
                d = json.loads(line)
            except ValueError:
                continue
            m = d.get('message') or {}
            if d.get('type') != 'assistant' or not m.get('usage'):
                continue
            seen[m.get('id') or d.get('uuid')] = eq(m['usage'])   # ответ пишется несколькими строками
        seen.pop(st.get('last'), None)      # этот ответ уже посчитан прошлым замером
        offsets[f] = {'pos': pos + end, 'last': next(reversed(seen), st.get('last'))}
        top = os.path.relpath(f, root).split('/')[1].replace('.jsonl', '') if '/' in os.path.relpath(f, root) else ''
        a = out.setdefault(top, [0.0, 0])
        a[0] += sum(seen.values()); a[1] += len(seen)
    return out


def iso(ts):
    return datetime.fromisoformat(ts).timestamp()


def rows():
    try:
        return list(csv.DictReader(open(LOG)))
    except OSError:
        return []


def sample():
    try:
        state = json.load(open(STATE))
    except (OSError, ValueError):
        state = {}
    first = 'offsets' not in state
    offsets = state.setdefault('offsets', {})
    now = time.time()
    pct, resets_at = fetch_usage()
    reset_ts = iso(resets_at)
    base = state.get('base')
    if not base or abs(base['reset'] - reset_ts) > 3600:
        # Новая неделя: линия идёт от нуля с её начала; при первом запуске — от текущей точки.
        base = {'reset': reset_ts, 't': now, 'pct': pct} if not base else {'reset': reset_ts, 't': reset_ts - 7 * 86400, 'pct': 0.0}
        state['base'] = base
    allowed = base['pct'] + (TARGET - base['pct']) * (now - base['t']) / max(1, base['reset'] - base['t'])
    owners = session_owners()
    per = dict.fromkeys(BOTS + ['bots_other', 'host_other'], 0.0)
    reqs = 0
    for top, (tok, n) in scan(BOT_ROOT, offsets, first).items():
        bot = owners.get(top)
        per[bot if bot in BOTS else 'bots_other'] += tok
        reqs += n
    per['host_other'] = sum(t for t, _ in scan(HOST_ROOT, offsets, first).values())
    row = {'time': datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'pct': pct,
           'allowed': round(allowed, 2), 'resets_at': resets_at, 'bots_requests': reqs,
           **{k: round(v / 1e6, 3) for k, v in per.items()}}
    new = not os.path.exists(LOG)
    with open(LOG, 'a', newline='') as fh:
        w = csv.DictWriter(fh, FIELDS)
        if new:
            w.writeheader()
        w.writerow(row)
    tmp = STATE + '.tmp'
    json.dump(state, open(tmp, 'w'))
    os.replace(tmp, STATE)


def status():
    rs = rows()
    if not rs:
        print('замеров ещё нет'); return
    last = rs[-1]
    now, reset = iso(last['time'].replace('Z', '+00:00')), iso(last['resets_at'])
    pct, allowed = float(last['pct']), float(last['allowed'])
    left_h = (reset - now) / 3600
    print(f"{last['time']}: использовано {pct:.0f}% недели, по линии бюджета допустимо {allowed:.1f}% "
          f"({'В НОРМЕ' if pct <= allowed + 0.5 else 'ПРЕВЫШЕНИЕ'}); до сброса {left_h:.0f} ч")
    print(f"  чтобы уложиться в {TARGET:.0f}%: не больше {(TARGET - pct) / left_h:.2f}% в час")
    for hours in (1, 3, 12, 24):
        win = [r for r in rs if now - iso(r['time'].replace('Z', '+00:00')) <= hours * 3600 + 60 and r['resets_at'][:13] == last['resets_at'][:13]]
        if len(win) < 2:
            continue
        span = (now - iso(win[0]['time'].replace('Z', '+00:00'))) / 3600
        if span < hours * 0.6:
            continue
        dp = pct - float(win[0]['pct'])
        tok = {k: sum(float(r[k]) for r in win[1:]) for k in BOTS + ['bots_other', 'host_other']}
        bots = sum(tok[k] for k in BOTS + ['bots_other'])
        print(f"  за {span:.1f} ч: +{dp:.0f}% ({dp / span:.2f}%/ч, прогноз к сбросу {pct + dp / span * left_h:.0f}%); "
              f"боты {bots:.1f} млн экв. ({bots / span:.1f}/ч): "
              + ', '.join(f"{k.replace('-бот', '')} {tok[k]:.1f}" for k in BOTS) + f"; прочее на хосте {tok['host_other']:.1f}")


if __name__ == '__main__':
    status() if '--status' in sys.argv else sample()
