#!/usr/bin/env node
// Замер задержек интерфейса ботов со стороны клиента — так, как их видит бот.
//   latency.mjs <адрес> <токен> [повторов=30]
//   адрес — http://127.0.0.1:8790 (стенд), http://172.25.0.1:8765 (рабочий, напрямую) или https://factorio.darkkeks.me (снаружи)
// Токен — персонажа, которым не играют: замер ставит ему действия wait (тело стоит на месте) и будит игру.
// Что меряется (мс, медиана / 95-й процентиль / минимум):
//   ping, новое соединение     — команда с установкой соединения на каждый запрос (так работает curl из скрипта)
//   ping, постоянное           — та же команда по уже открытому соединению
//   действие с итогом          — wait на 1 тик, итог в том же запросе (act с wait: true)
//   событие, долгий опрос      — от отправки действия до его action_done в ответе events (опрос уже открыт)
//   событие, поток             — то же, но событие приходит в открытый поток stream
//   10 событий, долгий опрос   — десять действий подряд: до последнего action_done, переоткрывая опрос после каждого ответа
//   10 событий, поток          — то же по потоку
import http from 'node:http';
import https from 'node:https';

const [base, token, nArg] = process.argv.slice(2);
if (!base || !token) { console.error('latency.mjs <адрес> <токен> [повторов]'); process.exit(1); }
const N = Number(nArg) || 30;
const u = new URL(base);
const lib = u.protocol === 'https:' ? https : http;
const keepAlive = new lib.Agent({ keepAlive: true, maxSockets: 8 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(op, body, { agent = keepAlive, method = 'POST' } = {}) {
  return new Promise((resolve, reject) => {
    const data = method === 'POST' ? JSON.stringify(body || {}) : null;
    const req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname.replace(/\/$/, '')}/v2/${op}`, method, agent,
      headers: { authorization: `Bearer ${token}`, ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { reject(new Error(`${op}: не JSON (${res.statusCode}): ${buf.slice(0, 120)}`)); } });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** Поток событий: onEvent(событие). Возвращает {ready, close}. */
function stream(types, onEvent) {
  let req;
  const ready = new Promise((resolve, reject) => {
    req = lib.request({ protocol: u.protocol, hostname: u.hostname, port: u.port, path: `${u.pathname.replace(/\/$/, '')}/v2/stream?types=${types.join(',')}`, method: 'GET',
      agent: new lib.Agent({ keepAlive: false }), headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' } }, (res) => {
      if (res.statusCode !== 200) { reject(new Error(`stream: HTTP ${res.statusCode}`)); return; }
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const type = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1];
          if (type === 'hello') resolve();
          else if (data) onEvent(JSON.parse(data));
        }
      });
    });
    req.on('error', reject);
    req.end();
  });
  return { ready, close: () => req.destroy() };
}

const stats = (a) => { const s = [...a].sort((x, y) => x - y); const p = (q) => s[Math.min(s.length - 1, Math.floor(s.length * q))]; return { p50: p(0.5), p95: p(0.95), min: s[0], n: s.length }; };
const rows = [];
const report = (name, a) => { const s = stats(a); rows.push([name, s.p50, s.p95, s.min, s.n]); };
// Перед каждым замером — случайная пауза до двух тиков: иначе запросы попадают в одну и ту же фазу тика игры
// (предыдущий ответ приходит сразу после тика), и разница между замерами оказывается артефактом фазы.
const jitter = () => sleep(Math.random() * 34);
async function times(n, fn) { const out = []; for (let i = 0; i < n; i++) { await jitter(); const t0 = performance.now(); await fn(); out.push(performance.now() - t0); } return out; }

const first = await request('ping');
if (!first.ok) { console.error('ping:', JSON.stringify(first.error)); process.exit(1); }
const st = await request('status');
if (!st.ok && st.error?.code === 'offline') await request('login');

// 1–2. Цена соединения.
report('ping, новое соединение', await times(N, () => request('ping', {}, { agent: new lib.Agent({ keepAlive: false }) })));
await request('ping');
report('ping, постоянное', await times(N, () => request('ping')));

// 3. Действие с итогом в том же запросе.
await request('wait', { ticks: 30 }); // разбудить игру и прогреть
report('действие с итогом (wait 1 тик)', await times(N, async () => { const r = await request('wait', { ticks: 1 }); if (!r.ok) throw new Error(JSON.stringify(r.error)); }));

// 4. Событие по долгому опросу: опрос открыт заранее, как у бота, который слушает события.
{
  const out = [];
  for (let i = 0; i < N; i++) {
    const since = (await request('events')).seq;
    const poll = request('events', { since, wait_s: 20, types: ['action_done'] });
    await sleep(30 + Math.random() * 34); // опрос успел дойти до сервера; фаза тика случайна
    const t0 = performance.now();
    const a = await request('wait', { ticks: 1, wait: false });
    let got = await poll;
    while (!got.events.some((e) => e.action_id === a.action_id)) got = await request('events', { since: got.seq, wait_s: 20, types: ['action_done'] });
    out.push(performance.now() - t0);
  }
  report('событие, долгий опрос', out);
}

// 5. Событие по потоку.
const waiting = new Map(); // action_id → resolve
const early = new Set();   // событие пришло раньше, чем вернулся ответ на постановку действия
const s = stream(['action_done'], (ev) => { const w = waiting.get(ev.action_id); if (w) { waiting.delete(ev.action_id); w(); } else early.add(ev.action_id); });
let streamOk = true;
try { await s.ready; } catch (e) { streamOk = false; console.error('поток недоступен:', e.message); }
const viaStream = (id) => new Promise((r) => { if (early.delete(id)) r(); else waiting.set(id, r); });
if (streamOk) {
  const out = [];
  for (let i = 0; i < N; i++) {
    await jitter();
    const t0 = performance.now();
    const a = await request('wait', { ticks: 1, wait: false });
    await viaStream(a.action_id);
    out.push(performance.now() - t0);
  }
  report('событие, поток', out);
}

// 6–7. Десять событий подряд: действия по одному тику друг за другом.
const BURST = 10, ROUNDS = Math.max(3, Math.round(N / 5));
const burst = () => request('act', { actions: Array.from({ length: BURST }, () => ({ type: 'wait', ticks: 1 })), wait: false });
{
  const out = [];
  for (let i = 0; i < ROUNDS; i++) {
    let since = (await request('events')).seq;
    await jitter();
    const t0 = performance.now();
    const a = await burst();
    const ids = new Set(a.actions.map((x) => x.action_id));
    while (ids.size) {
      const got = await request('events', { since, wait_s: 20, types: ['action_done'] });
      for (const e of got.events) ids.delete(e.action_id);
      since = got.seq;
    }
    out.push(performance.now() - t0);
  }
  report(`${BURST} событий подряд, долгий опрос`, out);
}
if (streamOk) {
  const out = [];
  for (let i = 0; i < ROUNDS; i++) {
    await jitter();
    const t0 = performance.now();
    const a = await burst();
    await Promise.all(a.actions.map((x) => viaStream(x.action_id)));
    out.push(performance.now() - t0);
  }
  report(`${BURST} событий подряд, поток`, out);
}
s.close();

console.log(`\n${base} — мс (повторов ${N}; 1 тик игры = 16,7 мс)`);
console.log('замер'.padEnd(36) + 'медиана'.padStart(9) + '95 %'.padStart(9) + 'минимум'.padStart(9));
for (const [name, p50, p95, min] of rows) console.log(name.padEnd(36) + p50.toFixed(1).padStart(9) + p95.toFixed(1).padStart(9) + min.toFixed(1).padStart(9));
process.exit(0);
