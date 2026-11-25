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
import { encodeFrame } from './render-delta.mjs';
import { createRequire } from 'node:module';

const { WebSocketServer } = createRequire(import.meta.url)('ws');
const SOCK = process.env.V2_SOCK || path.join(os.homedir(), 'factorio-camera/hook/v2.sock');
const PAGE = path.join(ROOT, 'src/map-web/render.html');
const LUT_NIGHT = path.join(process.env.GAME_DATA || path.join(os.homedir(), 'factorio-camera/factorio/data'), 'core/graphics/color_luts/lut-night.png');
const DUMP = path.join(os.homedir(), 'factorio-camera/hook/raw'); // есть папка — сжатые атласы пишутся туда (отладка)
const SEND_MS = 100;           // кадров зрителям — не чаще 10 в секунду
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[render]', ...a);

const sprites = new Map();     // адрес спрайта в игре -> { n, ...описание }
const byN = [];                // номер -> описание
const atlases = new Map();     // адрес атласа -> { w, h, rgba } | 'wait'
const pngs = new Map();        // номер спрайта -> PNG
const atlasIdx = new Map();    // адрес атласа -> номер (для адресов кусков атласа)
const atlasByIdx = [];         // номер -> адрес
const tilePngs = new Map();    // "номер/x-y" -> PNG куска 1024×1024
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
function png(rgba, w, h, level = 6) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) rgba.copy(raw, y * (w * 4 + 1) + 1, y * w * 4, (y + 1) * w * 4);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 6;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw, { level })), chunk('IEND', Buffer.alloc(0))]);
}
// Кусок атласа 256×256 (по краям меньше): браузер грузит сотни небольших кусков вместо тысяч отдельных картинок
// и не тянет лишнего (кусок 1024 — ~1 МБ, а нужна в нём обычно малая часть).
const TILE = 256;
function atlasTilePng(ai, tx, ty) {
  const k = `${ai}/${tx}-${ty}`;
  let p = tilePngs.get(k);
  if (p) return p;
  const a = atlases.get(atlasByIdx[ai]);
  if (!a || a === 'wait') return null;
  const x0 = tx * TILE, y0 = ty * TILE, w = Math.min(TILE, a.w - x0), h = Math.min(TILE, a.h - y0);
  if (w <= 0 || h <= 0) return null;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) a.rgba.copy(out, y * w * 4, ((y0 + y) * a.w + x0) * 4, ((y0 + y) * a.w + x0 + w) * 4);
  for (let i = 0; i < out.length; i += 4) {
    const al = out[i + 3];
    if (al && al < 255) { out[i] = Math.min(255, out[i] * 255 / al); out[i + 1] = Math.min(255, out[i + 1] * 255 / al); out[i + 2] = Math.min(255, out[i + 2] * 255 / al); }
  }
  tilePngs.set(k, p = png(out, w, h, 3));
  return p;
}

function spritePng(n, cx = 0, cy = 0, cw = 0, ch = 0) {
  const k = `${n}:${cx}:${cy}:${cw}:${ch}`;
  let p = pngs.get(k);
  if (p) return p;
  const s = byN[n], a = s && atlases.get(s.atlas);
  const x0 = (s?.x ?? 0) + cx, y0 = (s?.y ?? 0) + cy, w = cw || s?.w, h = ch || s?.h;
  if (!a || a === 'wait' || !w || !h || x0 < 0 || y0 < 0 || x0 + w > a.w || y0 + h > a.h) return null;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) a.rgba.copy(out, y * w * 4, ((y0 + y) * a.w + x0) * 4, ((y0 + y) * a.w + x0 + w) * 4);
  // В атласах игры цвет предумножен на прозрачность; браузер ждёт обычный — делим обратно.
  for (let i = 0; i < out.length; i += 4) {
    const al = out[i + 3];
    if (al && al < 255) { out[i] = Math.min(255, out[i] * 255 / al); out[i + 1] = Math.min(255, out[i + 1] * 255 / al); out[i + 2] = Math.min(255, out[i + 2] * 255 / al); }
  }
  pngs.set(k, p = png(out, w, h));
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
      if (!atlasIdx.has(d.atlas)) { atlasIdx.set(d.atlas, atlasByIdx.length); atlasByIdx.push(d.atlas); }
    }
    if (fresh.length) broadcast(JSON.stringify({ t: 'sprites', list: fresh.map(pub) }));
  } else if (type === 3) {
    const i = data.indexOf(10), head = JSON.parse(data.subarray(0, i).toString());
    const raw = data.subarray(i + 1), t0 = Date.now();
    // С видеокарты приходит готовый RGBA. Остальное распаковывается в отдельном потоке (секунда на атлас —
    // в основном потоке это остановило бы весь сервис карты): атлас из памяти клиента — YCoCg + альфа, маска — 1 байт.
    if (raw.length === head.w * head.h * 4) { atlases.set(head.atlas, { w: head.w, h: head.h, rgba: raw }); log(`атлас ${head.atlas}: ${head.cls} ${head.w}×${head.h}`); }
    else {
      if (fs.existsSync(DUMP)) fs.writeFileSync(path.join(DUMP, `raw-${head.w}x${head.h}-${head.fmt}-${head.fmt2}-${head.atlas}.bin`), raw);
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
    frame = convert(data);
  }
}

// Кадр от игры: готовые записи SpriteDrawOrder (по 64 байта, см. camera-hook/v2-capture.js) — точка на экране
// в пикселях, итоговый масштаб, поворот, цвет, вырезка из атласа и ключ сортировки (в нём мировая позиция).
// Переводим экран в мир: масштаб — итоговый масштаб записи / масштаб спрайта, сдвиг камеры — медиана
// (экран − масштаб·мировая позиция из ключа). Сортируем как игра: по слою, внутри — по ключу;
// тени (слой 1000) — одним буфером между слоями 119 и 120.
const REC = 64;
let lastCal = 0, calBad = 0;
const median = (a) => { a.sort((x, y) => x - y); return a.length ? a[a.length >> 1] : 0; };
function convert(data) {
  const n = data.length / REC, recs = [], zs = [];
  for (let i = 0; i < n; i++) {
    const o = i * REC, s = sprites.get('0x' + data.readBigUInt64LE(o).toString(16));
    if (!s) continue;
    const fl = data.readUInt32LE(o + 28);
    if (fl & 0x400) continue;                      // такие записи игра пропускает при отрисовке
    const key = data.readBigUInt64LE(o + 8), v = (key - 0x8000000000000080n) & 0xffffffffffffffffn;
    let kx = Number((v >> 6n) & 0xffffffffn) - 2 ** 28; if (kx >= 2 ** 31) kx -= 2 ** 32;
    let ky = Number(v >> 35n); if (ky >= 2 ** 28) ky -= 2 ** 29;
    const r = { s, key, fl, kx: kx / 256, ky: ky / 256, px: data.readFloatLE(o + 16), py: data.readFloatLE(o + 20), rot: data.readUInt32LE(o + 24),
      sx: data.readFloatLE(o + 32), sy: data.readFloatLE(o + 36), tint: data.readUInt32LE(o + 40) | 0,
      cx: Math.round(data.readFloatLE(o + 44)), cy: Math.round(data.readFloatLE(o + 48)), cw: Math.round(data.readFloatLE(o + 52)), ch: Math.round(data.readFloatLE(o + 56)),
      layer: data.readUInt32LE(o + 60) };
    if (s.scale > 0 && r.sx > 0) zs.push(r.sx / s.scale);
    recs.push(r);
  }
  // Масштаб — у самой камеры (ширина её вида известна сервису карты); медиана по записям врёт: у значков свой масштаб.
  const zoom = camZoom, Z = 32 * zoom;
  const cxs = [], cys = [];
  // Калибруем по спрайтам без сдвига (предметы, значки): у них точка на экране — ровно позиция из ключа.
  for (const r of recs) if (Math.abs(r.kx) < 1e6 && Math.abs(r.ky) < 1e6 && !r.rot && Math.abs(r.s.shiftX) < 0.01 && Math.abs(r.s.shiftY) < 0.01) { cxs.push(r.px - Z * r.kx); cys.push(r.py - Z * r.ky); }
  // Сдвиг экрана — самое частое значение (экранные точки у спрайтов без сдвига совпадают до пикселя), а не медиана.
  const mode = (a) => { const c = new Map(); let best = 0, bv = 0; for (const v of a) { const k = Math.round(v * 4); const n = (c.get(k) || 0) + 1; c.set(k, n); if (n > best) { best = n; bv = k / 4; } } return [bv, best]; };
  const [CX, nx] = mode(cxs), [CY, ny] = mode(cys);
  if (Math.min(nx, ny) < 5) calBad++;
  if (Date.now() - lastCal > 600000) { lastCal = Date.now(); log(`калибровка: плохих кадров ${calBad}, совпадений ${nx}/${ny} из ${cxs.length}, масштаб ${zoom.toFixed(3)}, центр экрана в мире ${((640 - CX) / Z).toFixed(2)}, ${((360 - CY) / Z).toFixed(2)}, записей ${recs.length}, пример ключ ${recs[0]?.kx},${recs[0]?.ky} экран ${recs[0]?.px},${recs[0]?.py}`); }
  const ord = (l) => (l === 1000 ? 239 : l === 1001 ? 511 : l * 2);
  recs.sort((a, b) => ord(a.layer) - ord(b.layer) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  // Браузеру — по 10 целых (последнее — флаги записи): номер спрайта, x, y (1/256 клетки), поворот (16 бит) | слой (16 бит),
  // масштаб x, y (×1000, в «пикселях атласа на 32 клетки»), цвет, вырезка x|y<<16, w|h<<16.
  const out = new Int32Array(recs.length * 10);
  let k = 0;
  for (const r of recs) {
    out[k++] = r.s.n;
    out[k++] = Math.round((r.px - CX) / Z * 256); out[k++] = Math.round((r.py - CY) / Z * 256);
    out[k++] = ((r.rot >>> 16) << 16) | (r.layer & 0xffff);
    out[k++] = Math.round(r.sx / zoom * 1000); out[k++] = Math.round(r.sy / zoom * 1000);
    out[k++] = r.tint;
    out[k++] = (r.cx & 0xffff) | (r.cy << 16); out[k++] = (r.cw & 0xffff) | (r.ch << 16);
    out[k++] = r.fl; // флаги записи (режим смешивания и т. п.)
  }
  return Buffer.from(out.buffer, 0, k * 4);
}
const pub = (s) => ({ n: s.n, w: s.w, h: s.h, sx: s.shiftX, sy: s.shiftY, sc: s.scale, fl: s.fl, a: atlasIdx.get(s.atlas), ax: s.x, ay: s.y, next: s.next ? sprites.get(s.next)?.n ?? -1 : -1 });

fs.rmSync(SOCK, { force: true });
net.createServer((c) => {
  if (game) game.destroy();
  game = c;
  log('игра подключилась');
  setTimeout(() => broadcast(JSON.stringify({ t: 'game', on: true })), 0);
  // Атласы, полученные раньше, могли устареть (другой запуск игры) — начинаем с чистого листа.
  sprites.clear(); byN.length = 0; atlases.clear(); pngs.clear(); atlasIdx.clear(); atlasByIdx.length = 0; tilePngs.clear();
  gen = Date.now().toString(36);
  for (const ws of viewers) ws.prevFrame = null;
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
// Что видит клиент-камера: прямоугольник в клетках. Всё вне его на странице — только подложка со снимков.
let cam = null, camSent = '';
// Темнота поверхности (0 — день, до ~0.85 — ночь): страница строит по ней карту освещения.
let dark = 0, darkSent = '';
export function setDarkness(d) {
  dark = Math.round(d * 100) / 100;
  const s = JSON.stringify({ t: 'dark', dark });
  if (s !== darkSent) { darkSent = s; broadcast(s); }
}
// Масштаб клиента-камеры (из игры): по нему экранные точки записей переводятся в клетки.
let camZoom = 0.75;
export function setZoom(z) { if (z > 0) camZoom = z; }
export function setCamera(c) {
  cam = c;
  const s = c ? JSON.stringify({ t: 'cam', ...c }) : '{"t":"cam"}';
  if (s !== camSent) { camSent = s; broadcast(s); }
}
function broadcast(s) { for (const ws of viewers) if (ws.readyState === 1) ws.send(s); }
// Кадр зрителю — разностью с тем кадром, что ушёл ему в прошлый раз (render-delta.mjs); новому зрителю и после
// сброса — целиком (разность с пустым). Обычно у всех зрителей прошлый кадр один, кодируем один раз.
const asInts = (b) => new Int32Array(b.buffer, b.byteOffset, b.length >> 2);
function sendFrame(ws, cache) {
  if (ws.readyState !== 1 || ws.bufferedAmount > 2_000_000) return;
  if (!ws.delta) { ws.send(frame); return; }
  const cur = asInts(frame), key = ws.prevFrame || null;
  let enc = cache.get(key);
  if (!enc) { enc = encodeFrame(cur, key && key.length ? key : null); cache.set(key, enc); }
  ws.send(enc);
  ws.prevFrame = cur;
}
setInterval(() => {
  if (!frame || frame === frameAt) return;
  frameAt = frame;
  const cache = new Map();
  for (const ws of viewers) sendFrame(ws, cache);
}, SEND_MS);
setInterval(() => { if (frames) log(`кадров от игры за минуту ${frames}, спрайтов ${byN.length}, атласов ${atlases.size}, зрителей ${viewers.size}`); frames = 0; }, 60_000);

export const wssRender = new WebSocketServer({ noServer: true, maxPayload: 1024, perMessageDeflate: { threshold: 1024 } });
wssRender.on('connection', (ws, req) => {
  ws.delta = /[?&]d=1/.test(req?.url || ''); // страница умеет разность (старые открытые вкладки получают кадры целиком)
  viewers.add(ws);
  ws.send(JSON.stringify({ t: 'reset', gen }));
  ws.send(JSON.stringify({ t: 'sprites', list: byN.map(pub), game: !!game }));
  if (camSent) ws.send(camSent);
  if (darkSent) ws.send(darkSent);
  if (frame) sendFrame(ws, new Map());
  ws.on('close', () => viewers.delete(ws));
  ws.on('error', () => viewers.delete(ws));
});

/** HTTP для /render/…; true — запрос обработан. */
export function handleRender(url, reply) {
  // Таблица цветов ночи — из данных игры (клиент-камеры), как есть.
  if (url.pathname === '/render/lut-night.png') {
    try { reply(200, 'image/png', fs.readFileSync(LUT_NIGHT)); } catch { reply(404, 'text/plain', 'нет таблицы'); }
    return true;
  }
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
  const t = url.pathname.match(/^\/render\/atlas\/([a-z0-9]{1,12})\/(\d{1,3})\/(\d{1,3})-(\d{1,3})\.png$/);
  if (t) {
    const p = t[1] === gen ? atlasTilePng(Number(t[2]), Number(t[3]), Number(t[4])) : null;
    if (p) reply(200, 'image/png', p, 'public, max-age=3600'); else reply(404, 'text/plain', '', 'no-store');
    return true;
  }
  const m = url.pathname.match(/^\/render\/sprite\/([a-z0-9]{1,12})\/(\d{1,7})(?:-(\d{1,5})-(\d{1,5})-(\d{1,5})-(\d{1,5}))?\.png$/);
  if (m) {
    const p = m[1] === gen ? spritePng(Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0), Number(m[5] ?? 0), Number(m[6] ?? 0)) : null;
    if (p) reply(200, 'image/png', p, 'public, max-age=600'); else reply(404, 'text/plain', '', 'no-cache');
    return true;
  }
  return false;
}
