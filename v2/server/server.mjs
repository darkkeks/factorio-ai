#!/usr/bin/env node
// Сервер на хосте: HTTP с JSON для ботов → короткие запросы к моду по RCON. Игрового состояния не хранит:
// его перезапуск не обрывает действий, журнал событий после запуска дочитывается из мода.
//
//   POST /v2/<операция>   тело — JSON с параметрами, заголовок Authorization: Bearer <токен>
//   GET  /v2/help         описание операций
//
// Настройки — config.json рядом (или путь в V2_CONFIG): { http: {host, port}, rcon: {host, port, password},
// tokens: "файл с токенами", logDir: "каталог журналов" }.
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

const WAIT_DEFAULT_S = 30;  // сколько сервер сам ждёт завершения действия
const WAIT_MAX_S = 110;
const EVENTS_WAIT_MAX_S = 60;

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

const game = new Game({ rcon: conf.rcon, pollMs: conf.pollMs ?? 100, log });

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
  return Math.min(s, WAIT_MAX_S);
};

const CONTROL = new Set(['wait', 'wait_s', 'id']);
function stripControl(body) {
  const p = {};
  for (const k in body) if (!CONTROL.has(k)) p[k] = body[k];
  return p;
}

// ── Операции ──
const lastTouch = new Map();
function touch(agent) { // бот жив, хотя его запрос до мода не дошёл (чтение буфера событий)
  const now = Date.now();
  if (now - (lastTouch.get(agent) || 0) < 2000) return;
  lastTouch.set(agent, now);
  game.call({ agent, op: 'touch' }).catch(() => {});
}

async function runAct(who, body) {
  const waitS = waitSeconds(body);
  const since = game.seq ?? 0;
  const params = stripControl(body);
  const r = await game.write({ agent: who.agent, op: 'act', params, id: body.id ?? `s-${crypto.randomUUID()}` });
  const ids = r.actions.map((a) => a.action_id);
  // Повтор запроса с тем же id: мод вернул только номера действий, итоги ищем во всём буфере журнала.
  const res = await settle(who.agent, ids, r.finished, r.replayed ? 0 : since, waitS);
  const actions = r.actions.map((a) => actionView(a.action_id, a.action, res.get(a.action_id)));
  return { actions, running: actions.some((a) => a.state === 'running') };
}

async function runSingleAction(who, op, body) {
  const { actions } = await runAct(who, { actions: [{ type: op, ...stripControl(body) }], wait: body.wait, wait_s: body.wait_s, id: body.id });
  const a = actions[0];
  if (a.state === 'running') return { running: true, action_id: a.action_id };
  if (a.state === 'done') return { action_id: a.action_id, ...a.result };
  throw Object.assign(new GameError(a.error.code, a.error.message, a.error.data), { action_id: a.action_id });
}

const special = {
  async help() { return helpDocument(game.info); },

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
    waitS = Math.min(waitS, EVENTS_WAIT_MAX_S);
    const limit = Math.min(Number(body.limit) || 200, 1000);
    const types = body.types ? new Set([].concat(body.types)) : null;
    const me = who.agent;
    if (me) touch(me);
    // Без since бот начинает «с этого момента»: получает текущий номер и дальше спрашивает от него.
    if (body.since == null) await game.pull(); // «с этого момента»: дочитать журнал, чтобы уже случившееся не пришло как новое
    if (body.since == null && waitS === 0) return { events: [], seq: game.seq ?? 0, first: game.first };
    const since = body.since == null ? (game.seq ?? 0) : Number(body.since);
    const match = (ev) => (me ? mine(me)(ev) : true) && (!types || types.has(ev.type)) && !(ev.type === 'chat' && ev.from === me);
    const got = await game.wait({ since, match, done: (l) => l.length > 0, timeoutMs: waitS * 1000 });
    const events = got.slice(0, limit);
    // seq — номер, с которого спрашивать дальше: если отдали не всё, это номер последнего отданного события.
    const seq = events.length < got.length ? events[events.length - 1].seq : Math.max(game.seq ?? 0, since);
    return { events, seq, first: game.first, more: events.length < got.length || undefined, missed: since < game.first - 1 ? true : undefined };
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
  if (special[op]) return special[op](who, body);
  if (spec.kind === 'action') return runSingleAction(who, op, body);
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
    if (!op) throw new GameError('unknown_op', 'адрес: POST /v2/<операция>, описание — GET /v2/help');
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
    if (!game.ready && op !== 'metrics') throw new GameError(game.lastError?.includes('несовместим') ? 'incompatible' : 'game_unavailable', `игра недоступна: ${game.lastError || 'нет связи'}`);
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
  record({ t: stamp(), agent: who?.agent || (who?.admin ? '(admin)' : null), op, ms, ok: out.ok, code: out.ok ? undefined : out.error.code, tick: game.tick }, { args: body, response: out });
});

server.listen(conf.http.port, conf.http.host || '127.0.0.1', () => log(`сервер ботов слушает ${conf.http.host || '127.0.0.1'}:${conf.http.port}`));
if (!(await game.start())) log(`игра пока недоступна (${game.lastError || 'журнал ещё читается'}); сервер ждёт её`);
process.on('SIGTERM', () => { game.stop(); server.close(); process.exit(0); });
process.on('SIGINT', () => { game.stop(); server.close(); process.exit(0); });
