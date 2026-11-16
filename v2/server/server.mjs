#!/usr/bin/env node
// Сервер на хосте: HTTP с JSON для ботов → короткие запросы к моду по RCON. Игрового состояния не хранит:
// его перезапуск не обрывает действий, журнал событий после запуска дочитывается из мода.
//
//   POST /v2/<операция>   тело — JSON с параметрами, заголовок Authorization: Bearer <токен>
//   GET  /v2/help         описание операций
//
// Настройки — config.json рядом (или путь в V2_CONFIG): { http: {host, port}, rcon: {host, port, password},
// tokens: "файл с токенами", logDir: "каталог журналов", publicUrl: "внешний адрес — для справки ботам" }.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Game, GameError } from './game.mjs';
import { API, helpDocument } from './api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const confPath = process.env.V2_CONFIG || path.join(HERE, 'config.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const resolve = (p) => path.resolve(path.dirname(confPath), p);
const TOKENS = resolve(conf.tokens || 'tokens.json');
const LOG_DIR = resolve(conf.logDir || 'log');
fs.mkdirSync(LOG_DIR, { recursive: true });

// Режим ожидания: пока существует этот файл, действия ботов не принимаются (читать мир можно). Его ставят люди,
// когда никто не играет, чтобы скрипты ботов не играли сами: v2/tools/hold.sh on | off. Сторож паузы в этом режиме
// держит игру на паузе, пока в ней нет людей.
const HOLD = conf.holdFile ? resolve(conf.holdFile) : null;
const onHold = () => HOLD !== null && fs.existsSync(HOLD);

const WAIT_DEFAULT_S = 30;  // сколько сервер сам ждёт завершения действия
const WAIT_MAX_S = 110;
const EVENTS_WAIT_MAX_S = 60;
const WAIT_EXTERNAL_S = 50;
const EXTERNAL = Symbol('external');

const stamp = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 23); };
const log = (...a) => console.log(stamp(), ...a);

// ── Журнал вызовов и счётчики ──
const counters = { started: Date.now(), ops: {}, errors: {} };
function record(entry, full) {
  const c = (counters.ops[entry.op] ??= { n: 0, fail: 0, ms: [] });
  c.n++;
  if (!entry.ok) { c.fail++; counters.errors[entry.code] = (counters.errors[entry.code] || 0) + 1; }
  c.ms.push(entry.ms);
  if (c.ms.length > 2000) c.ms.splice(0, 1000);
  const day = new Date().toISOString().slice(0, 10);
  // Краткая строка — в calls-<день>.log, полный запрос и ответ без обрезки — в full-<день>.jsonl.
  fs.appendFile(path.join(LOG_DIR, `calls-${day}.log`), JSON.stringify(entry) + '\n', () => {});
  fs.appendFile(path.join(LOG_DIR, `full-${day}.jsonl`), JSON.stringify({ ...entry, ...full }) + '\n', () => {});
}
const pct = (arr, p) => { if (!arr.length) return null; const s = [...arr].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

// ── Токены: файл { "токен": "имя персонажа" | {"admin": true} }, перечитывается при изменении ──
let tokens = {}, tokensMtime = 0;
function auth(req) {
  try {
    const m = fs.statSync(TOKENS).mtimeMs;
    if (m !== tokensMtime) { tokens = JSON.parse(fs.readFileSync(TOKENS, 'utf8')); tokensMtime = m; }
  } catch (e) { log(`токены: ${e.message}`); }
  const h = req.headers.authorization || '';
  const t = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  const v = t && Object.hasOwn(tokens, t) ? tokens[t] : null;
  if (!v) return null;
  return typeof v === 'string' ? { agent: v } : v;
}

// Очередь заявок общая с обработчиком (src/feedback-worker.mjs); на тестовом стенде — свой каталог.
if (conf.feedbackDir) process.env.FEEDBACK_DIR = resolve(conf.feedbackDir);
const FB = await import('../../src/feedback.mjs');

const game = new Game({ rcon: conf.rcon, pollMs: conf.pollMs ?? 100, holdMs: conf.holdMs ?? 90000, log });

// ── Ожидание завершения действий ──
const mine = (agent) => (ev) => ev.agent === agent || ev.agent == null;

/** Итоги действий с номерами ids: из ответа мода (finished) и из журнала (action_done). */
async function settle(agent, ids, finished, since, waitS) {
  const res = new Map();
  for (const f of finished) res.set(f.action_id, f);
  const want = new Set(ids.filter((id) => !res.has(id)));
  if (want.size) {
    const got = await game.wait({
      since,
      match: (ev) => ev.agent === agent && ev.type === 'action_done' && want.has(ev.action_id),
      done: (list) => list.length >= want.size,
      timeoutMs: waitS * 1000,
    });
    for (const ev of got) res.set(ev.action_id, { action_id: ev.action_id, action: ev.action, ok: ev.ok, result: ev.result, error: ev.error, ticks: ev.ticks });
  }
  return res;
}

function actionView(id, kind, r) {
  if (!r) return { action_id: id, action: kind, state: 'running' };
  const v = { action_id: id, action: r.action || kind, state: r.ok ? 'done' : (r.error?.code === 'cancelled' ? 'cancelled' : 'failed') };
  if (r.ok) v.result = r.result; else v.error = r.error;
  if (r.ticks != null) v.ticks = r.ticks;
  return v;
}

const waitSeconds = (body) => {
  if (body.wait === false) return 0;
  const s = body.wait_s == null ? WAIT_DEFAULT_S : Number(body.wait_s);
  if (!Number.isFinite(s) || s < 0) throw new GameError('bad_request', 'wait_s — неотрицательное число секунд');
  // Снаружи запросы идут через nginx с таймаутом 60 с: ждём меньше, действие продолжается, итог — wait_action.
  return Math.min(s, body[EXTERNAL] ? WAIT_EXTERNAL_S : WAIT_MAX_S);
};

const CONTROL = new Set(['wait', 'wait_s', 'id']);
function stripControl(body) {
  const p = {};
  for (const k in body) if (!CONTROL.has(k)) p[k] = body[k];
  return p;
}
const carry = (from, to) => { if (from[EXTERNAL]) to[EXTERNAL] = true; return to; };

// ── Операции ──
const lastTouch = new Map();
function touch(agent) { // бот жив, хотя его запрос до мода не дошёл (чтение буфера событий)
  const now = Date.now();
  if (now - (lastTouch.get(agent) || 0) < 2000) return;
  lastTouch.set(agent, now);
  game.once({ agent, op: 'touch' }).catch(() => {});
}

async function runAct(who, body) {
  const waitS = waitSeconds(body);
  const since = game.seq ?? 0;
  const params = stripControl(body);
  const r = await game.write({ agent: who.agent, op: 'act', params, id: body.id ?? `s-${crypto.randomUUID()}` }, body[EXTERNAL] ? 40000 : undefined);
  const ids = r.actions.map((a) => a.action_id);
  // Повтор запроса с тем же id: мод вернул только номера действий, итоги ищем во всём буфере журнала.
  const res = await settle(who.agent, ids, r.finished, r.replayed ? 0 : since, waitS);
  const actions = r.actions.map((a) => actionView(a.action_id, a.action, res.get(a.action_id)));
  return { actions, running: actions.some((a) => a.state === 'running') };
}

async function runSingleAction(who, op, body) {
  const { actions } = await runAct(who, carry(body, { actions: [{ type: op, ...stripControl(body) }], wait: body.wait, wait_s: body.wait_s, id: body.id }));
  const a = actions[0];
  if (a.state === 'running') return { running: true, action_id: a.action_id };
  if (a.state === 'done') return { action_id: a.action_id, ...a.result };
  throw Object.assign(new GameError(a.error.code, a.error.message, a.error.data), { action_id: a.action_id });
}

const special = {
  async help() { return helpDocument(game.info, conf.publicUrl); },

  async act(who, body) { return runAct(who, body); },

  async wait_action(who, body) {
    const ids = body.action_ids ?? (body.action_id != null ? [body.action_id] : null);
    if (!Array.isArray(ids) || !ids.length) throw new GameError('bad_request', 'нужен action_id или action_ids');
    const waitS = waitSeconds(body);
    // Действия могли закончиться давно: смотрим весь буфер журнала; чего там нет — ждём, пока оно в очереди.
    const res = await settle(who.agent, ids, [], 0, 0);
    let pending = ids.filter((id) => !res.has(id));
    if (pending.length) {
      const q = await game.call({ agent: who.agent, op: 'queue' });
      const inQueue = new Set(q.queue.map((a) => a.action_id));
      const live = pending.filter((id) => inQueue.has(id));
      if (live.length && waitS > 0) {
        const more = await settle(who.agent, live, [], game.seq ?? 0, waitS);
        for (const [k, v] of more) res.set(k, v);
      }
      // Событие о завершении могло ещё не дойти до буфера: дочитываем журнал и смотрим ещё раз.
      await game.pull();
      const late = await settle(who.agent, ids.filter((id) => !res.has(id)), [], 0, 0);
      for (const [k, v] of late) res.set(k, v);
      for (const id of pending) if (!inQueue.has(id) && !res.has(id)) res.set(id, { action_id: id, ok: false, error: { code: 'not_found', message: 'такого действия нет в очереди и в журнале событий' } });
    }
    const actions = ids.map((id) => actionView(id, undefined, res.get(id)));
    return { actions, running: actions.some((a) => a.state === 'running') };
  },

  async events(who, body) {
    let waitS = body.wait_s == null ? 0 : Number(body.wait_s);
    if (!Number.isFinite(waitS) || waitS < 0) throw new GameError('bad_request', 'wait_s — неотрицательное число секунд');
    waitS = Math.min(waitS, body[EXTERNAL] ? WAIT_EXTERNAL_S : EVENTS_WAIT_MAX_S);
    const limit = Math.min(Number(body.limit) || 200, 1000);
    const types = body.types ? new Set([].concat(body.types)) : null;
    const me = who.agent;
    if (me) touch(me);
    // Без since бот начинает «с этого момента»: получает текущий номер и дальше спрашивает от него.
    // Без ожидания — сначала дочитать журнал: только что завершённое действие уже должно быть видно,
    // а «с этого момента» (без since) не должно потом отдать уже случившееся как новое.
    if (body.since == null || waitS === 0) await game.pull();
    if (body.since == null && waitS === 0) return { events: [], seq: game.seq ?? 0, first: game.first };
    const since = body.since == null ? (game.seq ?? 0) : Number(body.since);
    // Своё не приходит: собственные реплики в чате и сводки о собственной стройке и сносе («кем-то другим»).
    const match = (ev) => (me ? mine(me)(ev) : true) && (!types || types.has(ev.type)) && !(ev.type === 'chat' && ev.from === me) && !(ev.by === me && ev.agent == null);
    const got = await game.wait({ since, match, done: (l) => l.length > 0, timeoutMs: waitS * 1000 });
    const events = got.slice(0, limit);
    // seq — номер, с которого спрашивать дальше: если отдали не всё, это номер последнего отданного события.
    const seq = events.length < got.length ? events[events.length - 1].seq : Math.max(game.seq ?? 0, since);
    return { events, seq, first: game.first, more: events.length < got.length || undefined, missed: since < game.first - 1 ? true : undefined };
  },

  // Карта области: одна команда в игре считает не больше 32×32 клеток (чтобы не задерживать тик),
  // большую область сервер запрашивает частями и склеивает.
  async area(who, body) {
    const p = stripControl(body);
    let x1, y1, x2, y2;
    if (p.area) {
      const a = p.area;
      const v = [a.x1 ?? a[0], a.y1 ?? a[1], a.x2 ?? a[2], a.y2 ?? a[3]].map(Number);
      if (v.some((n) => !Number.isFinite(n))) throw new GameError('bad_request', 'area: {x1, y1, x2, y2} — числа');
      [x1, y1, x2, y2] = [Math.floor(Math.min(v[0], v[2])), Math.floor(Math.min(v[1], v[3])), Math.ceil(Math.max(v[0], v[2])), Math.ceil(Math.max(v[1], v[3]))];
    } else if (p.radius != null) {
      let c = { x: p.x, y: p.y };
      if (typeof c.x !== 'number' || typeof c.y !== 'number') c = (await game.call({ agent: who.agent, op: 'status' })).position;
      [x1, y1, x2, y2] = [Math.floor(c.x - p.radius), Math.floor(c.y - p.radius), Math.ceil(c.x + p.radius), Math.ceil(c.y + p.radius)];
    } else throw new GameError('bad_request', 'нужна area {x1, y1, x2, y2} или radius (вокруг x, y или вокруг персонажа)');
    const w = x2 - x1, h = y2 - y1;
    if (w < 1 || h < 1) throw new GameError('bad_request', 'пустая область');
    if (w * h > 16384) throw new GameError('bad_request', 'область больше 16384 клеток (например 128×128): запрашивай частями');
    const one = (a, extra = {}) => game.call({ agent: who.agent, op: 'area', params: { ...p, x: undefined, y: undefined, radius: undefined, area: a, ...extra } });
    if (w * h <= 1024) return one({ x1, y1, x2, y2 });
    const limit = Math.min(p.limit ?? 300, 2000), offset = p.offset ?? 0;
    const SYMBOLS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789#$%&*+=<>^!/|{}[]();:';
    const symbolOf = new Map(), legend = {};
    const sym = (label) => { let s = symbolOf.get(label); if (!s) { s = SYMBOLS[symbolOf.size] ?? '?'; symbolOf.set(label, s); legend[s] = label; } return s; };
    const rows = Array.from({ length: h }, () => new Array(w).fill(' '));
    const fog = Array.from({ length: h }, () => new Array(w).fill('v'));
    let anyFog = false, total = 0;
    const objects = [], resources = {};
    for (let ty = y1; ty < y2; ty += 32) for (let tx = x1; tx < x2; tx += 32) {
      const a = { x1: tx, y1: ty, x2: Math.min(tx + 32, x2), y2: Math.min(ty + 32, y2) };
      const r = await one(a, { limit: 2000, offset: 0 });
      const map = {};
      for (const [s, label] of Object.entries(r.legend)) map[s] = sym(label);
      r.rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) { const ch = row[i]; rows[a.y1 - y1 + j][a.x1 - x1 + i] = map[ch] ?? ch; } });
      if (r.fog_rows) { anyFog = true; r.fog_rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) fog[a.y1 - y1 + j][a.x1 - x1 + i] = row[i]; }); }
      total += r.objects_total;
      for (const o of r.objects || []) objects.push(o);
      for (const [name, t] of Object.entries(r.resources || {})) { const g = (resources[name] ??= { tiles: 0, amount: 0 }); g.tiles += t.tiles; g.amount += t.amount; }
    }
    const out = { x1, y1, x2, y2, width: w, height: h, rows: rows.map((r) => r.join('')), legend,
      note: "rows[j][i] — клетка с углом (x1 + i, y1 + j), считая с нуля; '.' — свободно, '~' — вода или обрыв, ' ' — не открыто, '@' — ты",
      objects_total: total, resources: Object.keys(resources).length ? resources : undefined };
    if (anyFog) out.fog_rows = fog.map((r) => r.join(''));
    if (p.objects) { out.objects = objects.slice(offset, offset + limit); out.more = objects.length > offset + limit || undefined; }
    return out;
  },

  // Заявка разработчикам: встаёт в очередь (feedback/queue.jsonl), её разбирает обработчик заявок.
  async feedback(who, body) {
    const text = String(body.text ?? '').trim();
    if (!text) throw new GameError('bad_request', 'text: что делал, что получил, чего ожидал');
    if (text.length > 8000) throw new GameError('bad_request', 'текст длиннее 8000 символов');
    try { return FB.submitFeedback(who.agent || '(admin)', text); } catch (e) { throw new GameError('busy', e.message); }
  },

  // Что стало с заявками: свои (или все, all: true) со статусом и ответом разработчиков.
  async feedback_status(who, body) {
    const limit = Math.min(Number(body.limit) || 15, 100);
    let items = FB.readItems();
    if (!body.all) items = items.filter((i) => i.from === who.agent);
    const view = (i) => ({ id: i.id, from: i.from, at: i.at, text: i.text.length > 400 ? i.text.slice(0, 400) + '…' : i.text,
      status: i.status, answer: i.note, released: i.status === 'done' ? i.released !== false : undefined });
    return { feedback: items.slice(-limit).map(view), waiting: items.filter((i) => i.status === 'new').length };
  },

  async metrics(who) {
    if (!who.admin) throw new GameError('forbidden', 'только администратору');
    const ops = {};
    for (const [k, c] of Object.entries(counters.ops)) ops[k] = { n: c.n, fail: c.fail, p50: pct(c.ms, 0.5), p95: pct(c.ms, 0.95), max: Math.max(...c.ms) };
    return { uptime_s: Math.round((Date.now() - counters.started) / 1000), ops, errors: counters.errors, journal: { seq: game.seq, first: game.first, buffered: game.events.length }, mod: game.info };
  },
};

async function dispatch(who, op, body) {
  const spec = API[op];
  if (!spec) throw new GameError('unknown_op', `нет такой операции: ${op}; список — GET /v2/help`);
  if (spec.admin && !who.admin) throw new GameError('forbidden', 'операция только для администратора');
  if (spec.agent !== false && !who.agent && !spec.admin && spec.kind !== 'query') throw new GameError('forbidden', 'токен не привязан к персонажу');
  if (who.agent && (spec.kind === 'action' || op === 'act') && onHold()) {
    throw new GameError('paused', 'игра остановлена людьми: действия не принимаются, пока её не возобновят. Не повторяй запрос в цикле — проверяй не чаще раза в минуту (ping → hold).');
  }
  if (special[op]) return special[op](who, body);
  if (spec.kind === 'action') return runSingleAction(who, op, body);
  if (op === 'ping') return { ...(await game.call({ op: 'ping' })), hold: onHold() };
  const req = { op, params: stripControl(body) };
  if (who.agent) req.agent = who.agent;
  if (spec.admin) req.admin = true;
  if (spec.write) { req.id = body.id ?? `s-${crypto.randomUUID()}`; return game.write(req); }
  return game.call(req);
}

// ── HTTP ──
const HTTP_STATUS = { bad_request: 400, unknown_op: 404, forbidden: 403, unauthorized: 401, game_unavailable: 503, incompatible: 503, internal: 500 };

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > 4 << 20) { reject(new GameError('bad_request', 'тело запроса больше 4 МБ')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      const s = Buffer.concat(chunks).toString('utf8').trim();
      if (!s) return resolve({});
      try { const v = JSON.parse(s); if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('не объект'); resolve(v); }
      catch (e) { reject(new GameError('bad_request', `тело запроса — не JSON-объект: ${e.message}`)); }
    });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const t0 = performance.now();
  const url = new URL(req.url, 'http://x');
  const m = url.pathname.match(/^(?:\/[^/]+)*?\/v2\/([a-z_]+)\/?$/);
  let op = m?.[1], who = null, body = {}, out, status = 200;
  try {
    if (!op) {
      // Старый интерфейс (MCP и команда fx) слал сюда JSON-RPC: отвечаем в его же виде, чтобы скрипты показали причину.
      if (req.method === 'POST' && !url.pathname.includes('/v2/')) {
        // Номер запроса возвращаем тот же, иначе клиент MCP не сопоставит ответ и будет ждать до таймаута.
        let rpc = null;
        try { rpc = await readBody(req); } catch { /* не JSON */ }
        const message = 'Интерфейс заменён: инструментов MCP и команды fx больше нет. Теперь это HTTP с JSON: описание — curl -s ${FX_URL}v2/help, правила — /home/robot/bots/RULES.md.';
        send(res, 200, { jsonrpc: '2.0', id: rpc?.id ?? 1, error: { code: -32601, message } });
        return;
      }
      throw new GameError('unknown_op', 'адрес: POST /v2/<операция>, описание — GET /v2/help');
    }
    if (op === 'help' && req.method === 'GET') {
      out = await special.help();
      send(res, 200, out);
      return;
    }
    who = auth(req);
    if (!who) throw new GameError('unauthorized', 'нужен заголовок Authorization: Bearer <токен>');
    if (req.method === 'POST') body = await readBody(req);
    else if (req.method === 'GET') for (const [k, v] of url.searchParams) { try { body[k] = JSON.parse(v); } catch { body[k] = v; } }
    else throw new GameError('bad_request', 'метод: POST (или GET для запросов без тела)');
    if (req.headers['x-forwarded-for']) body[EXTERNAL] = true;
    // Права администратора — только изнутри: снаружи токен администратора не действует.
    if (body[EXTERNAL] && who.admin) throw new GameError('forbidden', 'операции администратора снаружи недоступны');
    // Сервер игры перезапускается: запрос ждёт его возвращения (снаружи — меньше, под таймауты nginx), а не отклоняется.
    if (!game.ready && !['metrics', 'feedback', 'feedback_status', 'help'].includes(op)) {
      const t1 = performance.now();
      const back = await game.whenReady(body[EXTERNAL] ? 40000 : undefined);
      if (!back) throw new GameError(game.lastError?.includes('несовместим') ? 'incompatible' : 'game_unavailable', `игра недоступна: ${game.lastError || 'нет связи'}`);
      log(`${who.agent || '(admin)'} ${op}: ждал возвращения сервера игры ${((performance.now() - t1) / 1000).toFixed(1)} с`);
    }
    const result = await dispatch(who, op, body);
    out = { ok: true, ...result };
  } catch (e) {
    const code = e instanceof GameError ? e.code : 'internal';
    if (!(e instanceof GameError)) log(`ошибка в ${op}: ${e.stack}`);
    status = HTTP_STATUS[code] || 200; // отказ игры (не дотянулся, нет предмета) — обычный ответ с ok: false
    out = { ok: false, error: { code, message: e.message, data: e.data } };
    if (e.action_id != null) out.action_id = e.action_id;
  }
  const ms = Math.round((performance.now() - t0) * 10) / 10;
  send(res, status, out);
  // Строка на вызов в общий журнал (её же показывает веб-карта в панели бота); опрос событий туда не пишется.
  if (who?.agent && op !== 'events') {
    const args = Object.keys(body).length ? ' ' + JSON.stringify(body).slice(0, 300) : '';
    const { ok: _ok, ...rest } = out;
    const brief = out.ok ? JSON.stringify(rest).slice(0, 300) : `❌ ${out.error.code}: ${out.error.message}`.slice(0, 300);
    console.log(`${stamp().slice(11)} 🔧 ${who.agent} ${op}${args} [${(ms / 1000).toFixed(2)} с] → ${brief}`);
  }
  record({ t: stamp(), agent: who?.agent || (who?.admin ? '(admin)' : null), op, ms, ok: out.ok, code: out.ok ? undefined : out.error.code, tick: game.tick }, { args: body, response: out });
});

server.listen(conf.http.port, conf.http.host || '127.0.0.1', () => log(`сервер ботов слушает ${conf.http.host || '127.0.0.1'}:${conf.http.port}`));
if (!(await game.start())) log(`игра пока недоступна (${game.lastError || 'журнал ещё читается'}); сервер ждёт её`);
process.on('SIGTERM', () => { game.stop(); server.close(); process.exit(0); });
process.on('SIGINT', () => { game.stop(); server.close(); process.exit(0); });
