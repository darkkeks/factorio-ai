// Прототип отрисовки в браузере (factorio.darkkeks.me/render/; /v2/ на этом домене — API ботов): игра рисуется в браузере из перехваченной очереди отрисовки.
//
// Клиент игры с Frida Gadget (~/factorio-camera/hook/v2-capture.js) шлёт сюда по unix-сокету:
//   тип 1 — кадр: записи по 32 байта (u64 спрайт, i32 x, i32 y в 1/256 клетки, f32 масштаб x, y, u32 цвет RGBA, u32 слой | вид<<8);
//   тип 2 — описания новых спрайтов (JSON): где лежат в атласе, сдвиг, масштаб;
//   тип 3 — пиксели атласа (JSON-заголовок, перевод строки, RGBA).
// Сервис раздаёт браузерам кадры по WebSocket (/render/ws) и вырезает картинки спрайтов из атласов (/render/sprite/<n>.png).
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';
import { ROOT } from './config.mjs';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const { WebSocketServer } = createRequire(import.meta.url)('ws');
const SOCK = process.env.V2_SOCK || path.join(os.homedir(), 'factorio-camera/hook/v2.sock');
const PAGE = path.join(ROOT, 'src/map-web/render.html');
const DUMP = path.join(os.homedir(), 'factorio-camera/hook/raw'); // есть папка — сжатые атласы пишутся туда (отладка)
const SEND_MS = 100;           // кадров зрителям — не чаще 10 в секунду
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[render]', ...a);

const sprites = new Map();     // адрес спрайта в игре -> { n, ...описание }
const byN = [];                // номер -> описание
const atlases = new Map();     // адрес атласа -> { w, h, rgba } | 'wait'
const pngs = new Map();        // номер спрайта -> PNG
let game = null, frame = null, frameAt = 0, frames = 0;
let gen = Date.now().toString(36); // поколение номеров спрайтов: меняется при переподключении игры (в адресе картинок)
const viewers = new Set();

// ---------- PNG ----------
const CRC = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  let c = -1;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  out.writeUInt32BE((c ^ -1) >>> 0, 8 + data.length);
  return out;
}
function png(rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
function spritePng(n) {
  let p = pngs.get(n);
  if (p) return p;
  const s = byN[n], a = s && atlases.get(s.atlas);
  if (!a || a === 'wait' || !s.w || !s.h || s.x + s.w > a.w || s.y + s.h > a.h) return null;
  const out = Buffer.alloc(s.w * s.h * 4);
  for (let y = 0; y < s.h; y++) a.rgba.copy(out, y * s.w * 4, ((s.y + y) * a.w + s.x) * 4, ((s.y + y) * a.w + s.x + s.w) * 4);
  pngs.set(n, p = png(out, s.w, s.h));
  return p;
}

// ---------- распаковка в отдельном потоке ----------
let worker = null, jobId = 0;
const jobs = new Map();
function decode(raw, w, h) {
  if (!worker) {
    worker = new Worker(new URL('./bcn-worker.mjs', import.meta.url));
    worker.on('message', ({ id, rgba }) => { jobs.get(id)?.(rgba); jobs.delete(id); });
    worker.on('error', (e) => { log('распаковка:', e.message); for (const r of jobs.values()) r(null); jobs.clear(); worker = null; });
  }
  const id = ++jobId;
  return new Promise((resolve) => { jobs.set(id, resolve); worker.postMessage({ id, raw, w, h }, [raw.buffer]); });
}

// ---------- приём от игры ----------
function onMessage(type, data) {
  if (type === 2) {
    const fresh = [];
    for (const d of JSON.parse(data.toString('latin1'))) {
      if (sprites.has(d.id)) continue;
      const s = { ...d, n: byN.length };
      sprites.set(d.id, s); byN.push(s); fresh.push(s);
      if (!atlases.has(d.atlas)) { atlases.set(d.atlas, 'wait'); game?.write(`atlas ${d.atlas}\n`); }
    }
    if (fresh.length) broadcast(JSON.stringify({ t: 'sprites', list: fresh.map(pub) }));
  } else if (type === 3) {
    const i = data.indexOf(10), head = JSON.parse(data.subarray(0, i).toString());
    const raw = data.subarray(i + 1), t0 = Date.now();
    // С видеокарты приходит готовый RGBA. Остальное распаковывается в отдельном потоке (секунда на атлас —
    // в основном потоке это остановило бы весь сервис карты): атлас из памяти клиента — YCoCg + альфа, маска — 1 байт.
    if (raw.length === head.w * head.h * 4) { atlases.set(head.atlas, { w: head.w, h: head.h, rgba: raw }); log(`атлас ${head.atlas}: ${head.cls} ${head.w}×${head.h}`); }
    else {
      const copy = new Uint8Array(raw.length); copy.set(raw);
      decode(copy, head.w, head.h).then((rgba) => {
        if (atlases.get(head.atlas) !== 'wait') return; // игра переподключилась
        if (!rgba) { log(`атлас ${head.atlas}: ${head.cls} ${head.w}×${head.h}, ${raw.length} байт — формат не распознан`); return; }
        atlases.set(head.atlas, { w: head.w, h: head.h, rgba: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length) });
        log(`атлас ${head.atlas}: ${head.cls} ${head.w}×${head.h}, распакован за ${Date.now() - t0} мс`);
        broadcast(JSON.stringify({ t: 'atlas' }));
      });
      return;
    }
    broadcast(JSON.stringify({ t: 'atlas' })); // страница перезапросит спрайты, которые не загрузились
  } else if (type === 1) {
    frames++;
    // Перекладываем в формат для браузера: номер спрайта вместо адреса, по 7 чисел на запись.
    const n = data.length / 32, out = new Int32Array(n * 7);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 32, s = sprites.get('0x' + data.readBigUInt64LE(o).toString(16));
      if (!s) continue;
      out[k++] = s.n; out[k++] = data.readInt32LE(o + 8); out[k++] = data.readInt32LE(o + 12);
      out[k++] = Math.round(data.readFloatLE(o + 16) * 1000); out[k++] = Math.round(data.readFloatLE(o + 20) * 1000);
      out[k++] = data.readUInt32LE(o + 24) | 0; out[k++] = data.readUInt32LE(o + 28);
    }
    frame = Buffer.from(out.buffer, 0, k * 4);
  }
}
const pub = (s) => ({ n: s.n, w: s.w, h: s.h, sx: s.shiftX, sy: s.shiftY, sc: s.scale });

fs.rmSync(SOCK, { force: true });
net.createServer((c) => {
  if (game) game.destroy();
  game = c;
  log('игра подключилась');
  setTimeout(() => broadcast(JSON.stringify({ t: 'game', on: true })), 0);
  // Атласы, полученные раньше, могли устареть (другой запуск игры) — начинаем с чистого листа.
  sprites.clear(); byN.length = 0; atlases.clear(); pngs.clear();
  gen = Date.now().toString(36);
  broadcast(JSON.stringify({ t: 'reset', gen }));
  // Атлас — десятки мегабайт: куски копим списком и склеиваем один раз, когда сообщение пришло целиком.
  let parts = [], have = 0, need = 4;
  c.on('data', (d) => {
    parts.push(d); have += d.length;
    while (have >= need) {
      let buf = parts.length === 1 ? parts[0] : Buffer.concat(parts, have);
      parts = [buf];
      if (need === 4) { need = 4 + buf.readUInt32LE(0); if (have < need) break; }
      try { onMessage(buf[4], buf.subarray(5, need)); } catch (e) { log('разбор:', e.message); }
      buf = buf.subarray(need); parts = buf.length ? [buf] : []; have = buf.length; need = 4;
    }
  });
  c.on('close', () => { if (game === c) { game = null; log('игра отключилась'); broadcast(JSON.stringify({ t: 'game', on: false })); } });
  c.on('error', () => {});
}).listen(SOCK, () => log('ждёт игру на', SOCK));

// ---------- зрители ----------
function broadcast(s) { for (const ws of viewers) if (ws.readyState === 1) ws.send(s); }
setInterval(() => {
  if (!frame || frame === frameAt) return;
  frameAt = frame;
  for (const ws of viewers) if (ws.readyState === 1 && ws.bufferedAmount < 2_000_000) ws.send(frame);
}, SEND_MS);
setInterval(() => { if (frames) log(`кадров от игры за минуту ${frames}, спрайтов ${byN.length}, атласов ${atlases.size}, зрителей ${viewers.size}`); frames = 0; }, 60_000);

export const wssRender = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: { threshold: 1024 } });
wssRender.on('connection', (ws) => {
  viewers.add(ws);
  ws.send(JSON.stringify({ t: 'reset', gen }));
  ws.send(JSON.stringify({ t: 'sprites', list: byN.map(pub), game: !!game }));
  if (frame) ws.send(frame);
  ws.on('close', () => viewers.delete(ws));
  ws.on('error', () => viewers.delete(ws));
});

/** HTTP для /render/…; true — запрос обработан. */
export function handleRender(url, reply) {
  if (url.pathname === '/render' || url.pathname === '/render/') { reply(200, 'text/html; charset=utf-8', fs.readFileSync(PAGE)); return true; }
  // Отладка: атлас целиком, уменьшенный (/render/debug/atlas/<номер>.png) и список спрайтов (/render/debug/sprites.json).
  const d = url.pathname.match(/^\/render\/debug\/atlas\/(\d{1,3})\.png$/);
  if (d) {
    const a = [...atlases.values()].filter((x) => x !== 'wait')[Number(d[1])];
    if (!a) { reply(404, 'text/plain', ''); return true; }
    const f = 4, w = a.w / f | 0, h = a.h / f | 0, out = Buffer.alloc(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) a.rgba.copy(out, (y * w + x) * 4, ((y * f) * a.w + x * f) * 4, ((y * f) * a.w + x * f) * 4 + 4);
    reply(200, 'image/png', png(out, w, h)); return true;
  }
  if (url.pathname === '/render/debug/sprites.json') { reply(200, 'application/json', JSON.stringify({ atlases: [...atlases].map(([k, v]) => [k, v === 'wait' ? 'wait' : [v.w, v.h]]), sprites: byN })); return true; }
  const m = url.pathname.match(/^\/render\/sprite\/([a-z0-9]{1,12})\/(\d{1,7})\.png$/);
  if (m) {
    const p = m[1] === gen ? spritePng(Number(m[2])) : null;
    if (p) reply(200, 'image/png', p, 'public, max-age=600'); else reply(404, 'text/plain', '', 'no-cache');
    return true;
  }
  return false;
}
