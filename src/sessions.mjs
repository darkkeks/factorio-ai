// Хозяин сессий: держит процессы Claude (по одному на человека) и ничего не знает ни про Discord, ни про звук.
// Вынесен в отдельный процесс, чтобы голосового бота можно было перезапускать, не прерывая сессии и их саб-агентов.
// Перезапуск ЭТОГО процесса сессии прерывает — менять его нужно редко.
//
// Протокол: TCP 127.0.0.1:8766, по одному JSON в строке.
//   → {op:'ensure', id, human, bot}   завести сессию человека, если её ещё нет
//   → {op:'say', id, text}            передать сессии реплику
//   → {op:'present', ids:[...]}       кто сейчас в голосовом канале
//   ← {ev:'text'|'error'|'reset'|'rules', bot, text}
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Agent, forgetSession, slug, RULES_PATH } from './agent.mjs';
import { ROOT } from './config.mjs';
import { lua } from './rcon.mjs';

const PORT = Number(process.env.SESSIONS_PORT || 8766);
const BOTS_DIR = path.join(os.homedir(), 'robot/bots'); // на хосте; в контейнере это /home/robot/bots
const RULES_SRC = path.join(ROOT, 'rules/RULES.md');
const RULES_DST = path.join(BOTS_DIR, path.basename(RULES_PATH));

const stamp = () => new Date().toISOString().slice(11, 23);
const agents = new Map(); // id -> Agent
let present = new Set();
const clients = new Set();

function emit(ev) {
  console.log(stamp(), ev.ev, ev.bot ?? '', String(ev.text ?? '').replace(/\s+/g, ' ').slice(0, 200));
  const line = JSON.stringify(ev) + '\n';
  for (const c of clients) c.write(line);
}

function startAgent(id, human, bot) {
  const agent = new Agent(id, human, bot);
  agent.on('text', (text) => emit({ ev: 'text', bot, text }));
  agent.on('error', (e) => emit({ ev: 'error', bot, text: e.message }));
  agents.set(id, agent);
  return agent;
}

net.createServer((sock) => {
  clients.add(sock);
  let buf = '';
  sock.on('data', (d) => {
    buf += d;
    for (let i; (i = buf.indexOf('\n')) >= 0;) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        if (m.op === 'ensure') { if (!agents.has(m.id)) startAgent(m.id, m.human, m.bot); }
        else if (m.op === 'say') agents.get(m.id)?.send(m.text);
        else if (m.op === 'present') present = new Set(m.ids);
      } catch (e) { console.log(stamp(), 'плохое сообщение:', e.message); }
    }
  });
  const drop = () => clients.delete(sock);
  sock.on('close', drop);
  sock.on('error', drop);
}).listen(PORT, '127.0.0.1', () => console.log(stamp(), `хозяин сессий слушает 127.0.0.1:${PORT}`));

// ── Игровой чат ботов → сессии остальных персонажей ──
let chatSeq = null;
setInterval(async () => {
  try {
    const r = await lua(`
      local c = storage.vb_chat or {seq=0, items={}}
      local out = {}
      for _, m in pairs(c.items) do if m.seq > A.since then out[#out+1] = {from=m.from, text=m.text} end end
      return {seq=c.seq, messages=out}`, { since: chatSeq ?? Number.MAX_SAFE_INTEGER });
    if (chatSeq !== null && Array.isArray(r.messages)) {
      for (const m of r.messages) {
        for (const [id, agent] of agents) {
          // Пока хозяина нет в канале, чат будит только занятого бота: иначе дозорные скрипты жгли бы ходы впустую.
          if (agent.bot !== m.from && (present.has(id) || agent.busy)) agent.send(`[игровой чат] ${m.from}: ${m.text}`);
        }
      }
    }
    chatSeq = r.seq;
  } catch { /* сервер игры перезапускается */ }
}, 2000);

// ── Сброс сессии по просьбе хозяина: бот создаёт файл RESET в своей папке ──
setInterval(() => {
  for (const [id, agent] of agents) {
    const flag = path.join(BOTS_DIR, slug(agent.bot), 'RESET');
    if (!fs.existsSync(flag)) continue;
    fs.rmSync(flag, { force: true });
    agent.close();
    forgetSession(id);
    startAgent(id, agent.human, agent.bot);
    emit({ ev: 'reset', bot: agent.bot, text: 'сессия сброшена по просьбе хозяина, начата новая' });
  }
}, 2000);

// ── Правила: файл в репозитории — источник; копия лежит в контейнере. Изменился — сообщаем всем сессиям ──
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
fs.mkdirSync(BOTS_DIR, { recursive: true });
let rules = read(RULES_SRC);
if (rules && read(RULES_DST) !== rules) fs.writeFileSync(RULES_DST, rules);
setInterval(() => {
  const now = read(RULES_SRC);
  if (!now || now === rules) return;
  let diff = '';
  try {
    const old = path.join(os.tmpdir(), `rules-old-${process.pid}.md`);
    fs.writeFileSync(old, rules);
    try { execFileSync('diff', ['-U1', old, RULES_SRC], { encoding: 'utf8' }); } catch (e) { diff = String(e.stdout || ''); }
    fs.rmSync(old, { force: true });
  } catch { /* без перечня изменений */ }
  // Только изменённые строки, без служебных заголовков diff.
  diff = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l)).join('\n').slice(0, 3000);
  rules = now;
  fs.writeFileSync(RULES_DST, now);
  for (const agent of agents.values()) {
    agent.send(`[система]: правила обновились (${RULES_PATH}). Изменённые строки («-» убрано, «+» добавлено):\n${diff || '(перечитай файл целиком)'}\nПрименяй с этого момента; если у тебя работает саб-агент, которого это касается, передай ему.`);
  }
  emit({ ev: 'rules', text: `правила обновлены и разосланы сессиям: ${agents.size}` });
}, 3000);

// Веб-карта слушает тот же номер порта на другом адресе (172.25.0.1:8766) и перезапускается сигналом SIGUSR2.
// Команда вида «kill -USR2 всем, кто слушает :8766» попадает и сюда; без обработчика такой сигнал молча убивает процесс,
// а с ним — все сессии и их саб-агентов (так было 15.11.2026 десять раз за день). Поэтому сигнал явно игнорируется.
process.on('SIGUSR2', () => console.log(stamp(), 'получен SIGUSR2 — он для веб-карты, хозяин сессий его игнорирует'));

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => { for (const a of agents.values()) a.close(); process.exit(0); });
}
