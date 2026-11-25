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
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), '[render]', ...a);

const spritesNum = new Map(); // числовой адрес -> то же описание (быстрый поиск при разборе кадра)
const sprites = new Map();     // адрес спрайта в игре -> { n, ...описание }
const byN = [];                // номер -> описание
const atlases = new Map();     // адрес атласа -> { w, h, rgba } | 'wait'
const pngs = new Map();        // номер спрайта -> PNG
const atlasIdx = new Map();    // адрес атласа -> номер (для адресов кусков атласа)
const atlasByIdx = [];         // номер -> адрес
const tilePngs = new Map();    // "номер/x-y" -> PNG куска 1024×1024
let game = null, frame = null, frames = 0, convMs = 0, convN = 0, frameTime = 0;
let gen = Date.now().toString(36); // поколение номеров спрайтов: меняется при переподключении игры (в адресе картинок)
const viewers = new Set();
export const renderViewers = () => viewers.size;

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
function decode(raw, w, h, fmt2) {
  if (!worker) {
    worker = new Worker(new URL('./bcn-worker.mjs', import.meta.url));
    worker.on('message', ({ id, rgba }) => { jobs.get(id)?.(rgba); jobs.delete(id); });
    worker.on('error', (e) => { log('распаковка:', e.message); for (const r of jobs.values()) r(null); jobs.clear(); worker = null; });
  }
  const id = ++jobId;
  return new Promise((resolve) => { jobs.set(id, resolve); worker.postMessage({ id, raw, w, h, fmt2 }, [raw.buffer]); });
}

// ---------- приём от игры ----------
function onMessage(type, data) {
  if (type === 2) {
    const fresh = [];
    for (const d of JSON.parse(data.toString('latin1'))) {
      if (sprites.has(d.id)) continue;
      const s = { ...d, n: byN.length };
      sprites.set(d.id, s); spritesNum.set(parseInt(d.id, 16), s); byN.push(s); fresh.push(s);
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
      decode(copy, head.w, head.h, head.fmt2).then((rgba) => {
        if (atlases.get(head.atlas) !== 'wait') return; // игра переподключилась
        if (!rgba) { log(`атлас ${head.atlas}: ${head.cls} ${head.w}×${head.h}, ${raw.length} байт — формат не распознан`); return; }
        atlases.set(head.atlas, { w: head.w, h: head.h, rgba: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.length) });
        log(`атлас ${head.atlas}: ${head.cls} ${head.w}×${head.h}, распакован за ${Date.now() - t0} мс`);
        broadcast(JSON.stringify({ t: 'atlas' }));
      });
      return;
    }
    broadcast(JSON.stringify({ t: 'atlas' })); // страница перезапросит спрайты, которые не загрузились
  } else if (type === 7) {
    onGround(data);
  } else if (type === 1 || type === 5 || type === 6) {
    // 5 — с отметкой времени съёмки; 6 — ещё и с окном: какой RenderParameters (основной вид или окно-камера интерфейса),
    // его размер, масштаб и центр (camera-hook/v2-capture.js, frame_end).
    let key = 'main', info = null, time = Date.now();
    if (type === 5) { time = data.readDoubleLE(0); data = data.subarray(8); }
    if (type === 6) {
      time = data.readDoubleLE(0); key = data.readBigUInt64LE(8).toString(16);
      info = { w: data.readInt16LE(16), h: data.readInt16LE(18), zoom: data.readDoubleLE(24), x: data.readInt32LE(32) / 256, y: data.readInt32LE(36) / 256 };
      data = data.subarray(40);
    }
    frames++;
    onWindowFrame(key, info, time, data);
  }
}
// Кадр от игры: готовые записи SpriteDrawOrder (по 64 байта, см. camera-hook/v2-capture.js) — точка на экране
// в пикселях, итоговый масштаб, поворот, цвет, вырезка из атласа и ключ сортировки (в нём мировая позиция).
// Переводим экран в мир: масштаб — итоговый масштаб записи / масштаб спрайта, сдвиг камеры — медиана
// (экран − масштаб·мировая позиция из ключа). Сортируем как игра: по слою, внутри — по ключу;
// тени (слой 1000) — одним буфером между слоями 119 и 120.
const REC = 64;
let lastCal = 0, calBad = 0;
// Без BigInt и объектов на запись (было ~29 мс на кадр в 15 тыс. записей — при 30 кадрах в секунду это весь процессор):
// поля читаются типизированными массивами, ключ — двумя u32, спрайт — по числовому адресу.
const ord = (l) => (l === 1000 ? 239 : l === 1001 ? 511 : l * 2);
let cv = null; // рабочие массивы, растут по надобности
function work(n) {
  if (cv && cv.n >= n) return cv;
  return cv = { n, idx: new Uint32Array(n), sn: new Int32Array(n), pri: new Float64Array(n), lo: new Uint32Array(n), kx: new Float64Array(n), ky: new Float64Array(n), cal: new Float64Array(2 * n) };
}
function convert(data, zoomIn = camZoom) {
  if (data.byteOffset & 3) data = Buffer.from(data); // выравнивание для типизированных массивов
  const n = data.length / REC, u = new Uint32Array(data.buffer, data.byteOffset, n * 16), f = new Float32Array(data.buffer, data.byteOffset, n * 16);
  const W = work(n), zoom = zoomIn, Z = 32 * zoom;
  let m = 0, nc = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 16, s = spritesNum.get(u[o] + u[o + 1] * 4294967296);
    if (!s) continue;
    if (u[o + 7] & 0x400) continue;                // такие записи игра пропускает при отрисовке
    const lo = u[o + 2], hi = u[o + 3];
    // v = ключ − 0x8000000000000080; x — биты 6–37 минус 2^28, y — биты 35 и выше (29 бит со знаком), единица 1/256 клетки.
    const vlo = (lo - 0x80) >>> 0, vhi = (hi - 0x80000000 - (lo < 0x80 ? 1 : 0)) >>> 0;
    let kx = (((vlo >>> 6) | ((vhi & 0x3f) << 26)) >>> 0) - 2 ** 28; if (kx >= 2 ** 31) kx -= 2 ** 32;
    let ky = vhi >>> 3; if (ky >= 2 ** 28) ky -= 2 ** 29;
    W.idx[m] = i; W.sn[i] = s.n; W.pri[i] = ord(u[o + 15]) * 4294967296 + hi; W.lo[i] = lo;
    // Калибруем по спрайтам без сдвига (предметы, значки): у них точка на экране — ровно позиция из ключа.
    if (!u[o + 6] && Math.abs(s.shiftX) < 0.01 && Math.abs(s.shiftY) < 0.01 && Math.abs(kx) < 2.56e8 && Math.abs(ky) < 2.56e8) {
      W.cal[2 * nc] = f[o + 4] - Z * kx / 256; W.cal[2 * nc + 1] = f[o + 5] - Z * ky / 256; nc++;
    }
    m++;
  }
  // Сдвиг экрана — самое частое значение (экранные точки у спрайтов без сдвига совпадают до пикселя), а не медиана.
  const mode = (d) => { const c = new Map(); let best = 0, bv = 0; for (let i = 0; i < nc; i++) { const k = Math.round(W.cal[2 * i + d] * 4); const q = (c.get(k) || 0) + 1; c.set(k, q); if (q > best) { best = q; bv = k / 4; } } return [bv, best]; };
  const [CX, nx] = mode(0), [CY, ny] = mode(1);
  if (Math.min(nx, ny) < 5) calBad++;
  if (Date.now() - lastCal > 600000) { lastCal = Date.now(); log(`калибровка: плохих кадров ${calBad}, совпадений ${nx}/${ny} из ${nc}, масштаб ${zoom.toFixed(3)}, центр экрана в мире ${((640 - CX) / Z).toFixed(2)}, ${((360 - CY) / Z).toFixed(2)}, записей ${m}`); }
  // Порядок как в игре: по слою, внутри — по ключу сортировки (u64 без знака).
  const idx = W.idx.subarray(0, m), pri = W.pri, klo = W.lo;
  idx.sort((a, b) => pri[a] - pri[b] || klo[a] - klo[b]);
  // Браузеру — по 10 целых (последнее — флаги записи): номер спрайта, x, y (1/256 клетки), поворот (16 бит) | слой (16 бит),
  // масштаб x, y (×1000, в «пикселях атласа на 32 клетки»), цвет, вырезка x|y<<16, w|h<<16.
  const out = new Int32Array(m * 10);
  let k = 0;
  for (let q = 0; q < m; q++) {
    const i = idx[q], o = i * 16;
    out[k++] = W.sn[i];
    out[k++] = Math.round((f[o + 4] - CX) / Z * 256); out[k++] = Math.round((f[o + 5] - CY) / Z * 256);
    out[k++] = ((u[o + 6] >>> 16) << 16) | (u[o + 15] & 0xffff);
    out[k++] = Math.round(f[o + 8] / zoom * 1000); out[k++] = Math.round(f[o + 9] / zoom * 1000);
    out[k++] = u[o + 10] | 0;
    out[k++] = (Math.round(f[o + 11]) & 0xffff) | (Math.round(f[o + 12]) << 16); out[k++] = (Math.round(f[o + 13]) & 0xffff) | (Math.round(f[o + 14]) << 16);
    out[k++] = u[o + 7] | 0; // флаги записи (режим смешивания и т. п.)
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
  sprites.clear(); spritesNum.clear(); byN.length = 0; atlases.clear(); pngs.clear(); atlasIdx.clear(); atlasByIdx.length = 0; tilePngs.clear();
  gen = Date.now().toString(36);
  for (const ws of viewers) ws.prevFrame = null;
  wins.clear(); mainKey = 'main'; for (const sl of slots) sl.key = null; // у нового клиента окна — по новым адресам
  ground.clear(); for (const ws of viewers) ws.groundSent = null; // номера спрайтов у земли — от прошлого подключения
  sweepAt = 0; // новый клиент — обойти заново
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
// ---------- земля ----------
// Игра готовит землю областями (camera-hook/v2-capture.js, тип 7): чанк при загрузке или полоса, впервые попавшая в вид.
// Подготовка — группы заказов TileDrawOrder по слоям земли (слой — номер вектора TileDrawQueue) с эффектом группы.
// Заказ (64 байта): +0x00 спрайт (+0x68), +0x08 маска (спрайт +0x68 или 0), +0x18 u32 (?), +0x1c/+0x1e u16 клетка
// от начала сетки, +0x28/+0x2c f32 размер спрайта (пиксели), +0x30..+0x37 байты (размер в клетках и др.), +0x38 f32.
// Храним по чанкам (по клетке заказа): новая подготовка области заменяет заказы с клетками в этой области; заказы,
// пришедшие в нескольких соседних областях (большие спрайты на стыке), — одним (по совпадению всех полей).
const ground = new Map();   // "cx,cy" -> { cx, cy, ver, at, buf: Int32Array 'GND1' }
let groundVer = 0;
const GR = 12;              // целых на заказ для страницы
function onGround(data) {
  if (data.byteOffset & 3) data = Buffer.from(data);
  const conv = new Map();   // номер подготовки -> { r: [x1, y1, x2, y2] (клетки), ox, oy, groups }
  let o = 0;
  while (o + 40 <= data.length) {
    const h = []; for (let i = 0; i < 10; i++) h.push(data.readInt32LE(o + i * 4));
    o += 40;
    const n = h[9];
    if (o + n * 64 > data.length) break;
    let c = conv.get(h[6]);
    if (!c) conv.set(h[6], c = { r: [h[0] / 256, h[1] / 256, h[2] / 256, h[3] / 256], ox: h[4], oy: h[5], groups: [] });
    c.groups.push({ eff: h[7], layer: h[8], at: o, n });
    o += n * 64;
  }
  // Чанк хранится одним буфером (страничный формат 'GND1': 4 целых заголовка + по GR на заказ): миллионы отдельных
  // заказов объектами съедали гигабайты. При обновлении области затронутые чанки разбираются, правятся и собираются заново.
  const edits = new Map();  // "cx,cy" -> { cx, cy, list: [Int32Array(GR)] }
  const edit = (cx, cy) => {
    const k = `${cx},${cy}`;
    let e = edits.get(k);
    if (!e) {
      const ch = ground.get(k), list = [];
      if (ch) for (let i = 0; i < ch.buf[3]; i++) list.push(ch.buf.subarray(4 + i * GR, 4 + (i + 1) * GR));
      edits.set(k, e = { cx, cy, list, keys: null });
    }
    return e;
  };
  if (fs.existsSync(path.join(path.dirname(SOCK), "ground-debug"))) for (const c of conv.values()) log(`земля: область ${c.r.map((v) => v.toFixed(1)).join(' ')}, групп ${c.groups.length}, заказов ${c.groups.reduce((s, g) => s + g.n, 0)}`);
  for (const c of conv.values()) {
    const [x1, y1, x2, y2] = c.r;
    // Убрать старые заказы с клеткой внутри области.
    for (let cx = Math.floor(x1 / 32); cx <= Math.floor((x2 - 1e-6) / 32); cx++) for (let cy = Math.floor(y1 / 32); cy <= Math.floor((y2 - 1e-6) / 32); cy++) {
      if (!ground.has(`${cx},${cy}`) && !edits.has(`${cx},${cy}`)) continue;
      const e = edit(cx, cy);
      e.list = e.list.filter((r) => !(r[2] >= x1 && r[2] < x2 && r[3] >= y1 && r[3] < y2));
      e.keys = null;
    }
    for (const g of c.groups) for (let i = 0; i < g.n; i++) {
      const p = g.at + i * 64;
      const sp = spritesNum.get(Number(data.readBigUInt64LE(p)) - 0x68), mp = data.readBigUInt64LE(p + 8);
      const mask = mp ? spritesNum.get(Number(mp) - 0x68) : null;
      if (!sp || (mp && !mask)) continue;
      const r = new Int32Array(GR);
      r[0] = sp.n; r[1] = mask ? mask.n : -1;
      r[2] = c.ox + data.readUInt16LE(p + 0x1c); r[3] = c.oy + data.readUInt16LE(p + 0x1e);
      r[4] = Math.round(data.readFloatLE(p + 0x28)); r[5] = Math.round(data.readFloatLE(p + 0x2c));
      r[6] = data.readInt32LE(p + 0x30); r[7] = data.readInt32LE(p + 0x34);
      r[8] = Math.round(data.readFloatLE(p + 0x38) * 1000); r[9] = data.readInt32LE(p + 0x18);
      r[10] = g.eff; r[11] = g.layer * 65536 + i;   // слой и порядок внутри подготовки
      const e = edit(Math.floor(r[2] / 32), Math.floor(r[3] / 32));
      // Тот же заказ уже есть (большой спрайт на стыке двух областей) — второй раз не кладём.
      e.keys ??= new Set(e.list.map((q) => q.subarray(0, 11).join(',') + ',' + (q[11] >> 16)));
      const key = r.subarray(0, 11).join(',') + ',' + g.layer;
      if (e.keys.has(key)) continue;
      e.keys.add(key); e.list.push(r);
    }
  }
  // Порядок в чанке: слой, клетка (по строкам), порядок внутри подготовки.
  for (const e of edits.values()) {
    const list = e.list.sort((a, b) => (a[11] >> 16) - (b[11] >> 16) || a[3] - b[3] || a[2] - b[2] || (a[11] & 0xffff) - (b[11] & 0xffff));
    const out = new Int32Array(4 + list.length * GR);
    out[0] = 0x31444e47; out[1] = e.cx; out[2] = e.cy; out[3] = list.length; // 'GND1'
    list.forEach((r, i) => out.set(r, 4 + i * GR));
    ground.set(`${e.cx},${e.cy}`, { cx: e.cx, cy: e.cy, buf: out, ver: ++groundVer, at: Date.now() });
  }
  groundDirty = true;
  for (const c of conv.values()) for (const w of [...groundWaiters]) if (c.r[0] <= w.x + 1 && c.r[2] >= w.x - 1 && c.r[1] <= w.y + 1 && c.r[3] >= w.y - 1) { groundWaiters.delete(w); w.done(); }
}
let groundDirty = false;
const groundWaiters = new Set();
const waitGround = (x, y, ms) => new Promise((done) => { const w = { x, y, done }; groundWaiters.add(w); setTimeout(() => { if (groundWaiters.delete(w)) done(); }, ms); });

// Обходчик: окно-камера в мелком масштабе проходит по всей разведанной карте — игра готовит для него землю, и она есть
// заранее, до того как туда посмотрит зритель (окно зрителя переезжает за 0,3–0,5 с, а земля под ним уже нарисована).
// Ближнее к зрителям и камере — первым. После обхода окно убирается (каждое окно стоит игре кадров), повтор — через 10 минут.
const SWEEP_ZOOM = 0.25, SWEEP_EVERY = 10 * 60_000;
let sweepAt = 0;
async function sweepLoop() {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    if (!game || !runLua || Date.now() - sweepAt < SWEEP_EVERY) continue;
    try {
      const charted = await runLua(`local s = game.surfaces[A.surface] local f = game.forces.player local out = {}
        for c in s.get_chunks() do if f.is_chunk_charted(s, c) then out[#out + 1] = c.x out[#out + 1] = c.y end end return out`, {});
      const hw = WIN_W / 2 / 32 / SWEEP_ZOOM, hh = WIN_H / 2 / 32 / SWEEP_ZOOM;
      const cells = new Map();
      for (let i = 0; i + 1 < charted.length; i += 2) {
        const gx = Math.floor(charted[i] * 32 / (hw * 2) ), gy = Math.floor(charted[i + 1] * 32 / (hh * 2));
        cells.set(`${gx},${gy}`, [(gx + 0.5) * hw * 2, (gy + 0.5) * hh * 2]);
      }
      const near = [...viewers].map((v) => v.view).filter(Boolean).concat(cam ? [cam] : []);
      const dist = (c) => Math.min(1e9, ...near.map((v) => Math.hypot(c[0] - v.x, c[1] - v.y)));
      const list = [...cells.values()].sort((a, b) => dist(a) - dist(b));
      const t0 = Date.now();
      log(`обход земли: разведано чанков ${charted.length / 2}, позиций окна ${list.length}`);
      for (const [i, [x, y]] of list.entries()) {
        if (!game) break;
        if (i && i % 100 === 0) log(`обход земли: ${i}/${list.length}, ${((Date.now() - t0) / 1000).toFixed(0)} с, чанков с землёй ${ground.size}`);
        await runLua(SLOT_LUA, { name: 'web_render_sweep', x, y, zoom: SWEEP_ZOOM, w: WIN_W, h: WIN_H });
        await waitGround(x, y, 1500);
      }
      await runLua(`local p = game.get_player(A.camera) local g = p and p.gui.screen.web_render_sweep if g then g.destroy() end return true`, {});
      log(`обход земли: за ${((Date.now() - t0) / 1000).toFixed(0)} с, чанков с землёй ${ground.size}`);
      sweepAt = Date.now();
    } catch (e) { log('обход земли:', e.message); }
  }
}
setTimeout(sweepLoop, 10_000);
// Чанки зрителю: вокруг его вида (или вида камеры), новые и изменившиеся.
function sendGround(ws) {
  if (ws.readyState !== 1 || ws.bufferedAmount > 4_000_000) return;
  const v = ws.view || (cam ? { x: cam.x, y: cam.y, w: cam.w, h: cam.h } : null);
  if (!v) return;
  ws.groundSent ??= new Map();
  // Сначала — то, что на экране, затем с запасом в два экрана с каждой стороны: при сдвиге и отдалении земля уже у страницы.
  const order = [];
  for (const m of [0.5, 2.5]) {
    const x1 = Math.floor((v.x - v.w * m) / 32), x2 = Math.floor((v.x + v.w * m) / 32), y1 = Math.floor((v.y - v.h * m) / 32), y2 = Math.floor((v.y + v.h * m) / 32);
    for (let cx = x1; cx <= x2; cx++) for (let cy = y1; cy <= y2; cy++) order.push([cx, cy]);
  }
  let sent = 0;
  for (const [cx, cy] of order) {
    const c = ground.get(`${cx},${cy}`);
    if (!c || ws.groundSent.get(`${cx},${cy}`) === c.ver) continue;
    ws.send(Buffer.from(c.buf.buffer, c.buf.byteOffset, c.buf.byteLength)); ws.groundSent.set(`${cx},${cy}`, c.ver);
    if (++sent >= 96) return;
  }
}
setInterval(() => { for (const ws of viewers) if (ws.delta) sendGround(ws); groundDirty = false; }, 250);

// ---------- окна ----------
// Основной вид клиента-камеры следит за ботами (режим «следить»). Зритель, который сам двигает и зумит карту, получает
// своё окно — элемент интерфейса «камера» (LuaGuiElement camera) у игрока-камеры: игра рисует его отдельно, со своим
// RenderParameters, перехват отправляет его кадры отдельно. Окно берётся с запасом вокруг вида зрителя: сдвиг и
// приближение внутри запаса не ждут ничего; иначе окно переезжает (команда через сервер — ~0,1–0,2 с), а страница пока
// показывает подложку.
const MAX_WIN = Number(process.env.RENDER_WINDOWS || 4);
const WIN_W = 960, WIN_H = 540;           // размер окна в пикселях клиента: элемент интерфейса не больше экрана клиента (1280×720), и не как у основного вида — по размеру их и различаем
const MARGIN = 1.6;                       // окно — во столько раз больше вида зрителя (по каждой стороне)
const ZMIN = 0.2, ZMAX = 2;               // масштаб окна: дальше игра рисует слишком много, ближе — незачем
const wins = new Map();                   // ключ (адрес RenderParameters | 'main') -> { info, time, raw, frame, frameAt, at }
const slots = Array.from({ length: MAX_WIN }, (_, i) => ({ name: `web_render_${i}`, spec: null, applied: null, key: null, busy: false, used: 0 }));
let runLua = null;                        // (код, аргументы) -> Promise; даёт сервис карты (map.mjs)
export function setLuaRunner(fn) {
  runLua = fn;
  // Окна живут в состоянии игры (и в сохранении): оставшиеся от прошлого запуска сервиса убираем, иначе игра рисует их зря.
  const clean = () => fn(`local p = game.get_player(A.camera) if not p then return 0 end local n = 0
    for _, g in pairs(p.gui.screen.children) do if g.name:find('^web_render_') then g.destroy() n = n + 1 end end return n`, {})
    .then((n) => { if (n) log(`убрано окон от прошлого запуска: ${n}`); }).catch(() => setTimeout(clean, 10_000));
  setTimeout(clean, 3000);
}

function onWindowFrame(key, info, time, data) {
  let w = wins.get(key);
  if (!w) wins.set(key, w = { key, info: null, time: 0, raw: null, frame: null, frameAt: null, at: 0 });
  w.info = info; w.time = time; w.at = Date.now(); w.raw = data; w.frame = null;
  // Чьё это окно: совпадает с тем, что мы поставили окну-слоту (центр и масштаб), — его; иначе основной вид.
  if (info && !slots.some((s) => s.key === key)) {
    const s = slots.find((s) => s.applied && Math.abs(s.applied.x - info.x) < 0.6 && Math.abs(s.applied.y - info.y) < 0.6 && !(info.w === mainSize.w && info.h === mainSize.h));
    if (s) { s.key = key; log(`окно ${s.name}: ${info.w}×${info.h}, масштаб ${info.zoom.toFixed(3)}`); }
  }
  if (!slots.some((s) => s.key === key) && (!info || (info.w === mainSize.w && info.h === mainSize.h))) mainKey = key;
  const subs = [...viewers].filter((ws) => sourceOf(ws) === key);
  if (!subs.length) return;
  const t = performance.now();
  w.frame = convert(data, info ? info.zoom : camZoom);
  convMs += performance.now() - t; convN++;
  if (key === mainKey) { frame = w.frame; frameTime = time; }
  const cache = new Map();
  for (const ws of subs) sendFrame(ws, w, cache);
}
let mainKey = 'main';
const mainSize = { w: 1280, h: 720 };
export function setMainSize(w, h) { mainSize.w = w; mainSize.h = h; }
// Источник кадров зрителя: окно его слота, если оно уже рисует там, где надо; иначе основной вид.
function sourceOf(ws) {
  const s = ws.slot;
  if (s && s.key && wins.get(s.key)?.info && Date.now() - wins.get(s.key).at < 2000) return s.key;
  return mainKey;
}
function rectOf(w) {
  const i = w.info;
  if (!i) return cam ? [cam.x - cam.w / 2, cam.y - cam.h / 2, cam.x + cam.w / 2, cam.y + cam.h / 2] : null;
  const hw = i.w / 2 / 32 / i.zoom, hh = i.h / 2 / 32 / i.zoom;
  return [i.x - hw, i.y - hh, i.x + hw, i.y + hh];
}
// Кадр зрителю — разностью с тем кадром, что ушёл ему в прошлый раз (render-delta.mjs); новому зрителю и после
// сброса — целиком (разность с пустым). Зрители одного окна обычно получают одно и то же — кодируем один раз.
const asInts = (b) => new Int32Array(b.buffer, b.byteOffset, b.length >> 2);
function sendFrame(ws, w, cache) {
  if (ws.readyState !== 1 || ws.bufferedAmount > 2_000_000 || !w.frame) return;
  if (!ws.delta) { ws.send(w.frame); return; }
  const cur = asInts(w.frame), prev = ws.prevFrame || null;
  let enc = cache.get(prev);
  if (!enc) { enc = encodeFrame(cur, prev && prev.length ? prev : null, w.time, rectOf(w)); cache.set(prev, enc); }
  ws.send(enc);
  ws.prevFrame = cur;
}

// Вид зрителя: { x, y — центр (клетки), w, h — размер (клетки) } или null — следить за ботами (основной вид).
function fits(spec, v) {
  if (!spec) return false;
  const hw = WIN_W / 2 / 32 / spec.zoom, hh = WIN_H / 2 / 32 / spec.zoom;
  const inside = v.x - v.w / 2 >= spec.x - hw && v.x + v.w / 2 <= spec.x + hw && v.y - v.h / 2 >= spec.y - hh && v.y + v.h / 2 <= spec.y + hh;
  // Окно намного больше вида (зритель сильно приблизил) — игра рисует лишнее; перестраиваем, но не ради мелочи.
  const tooBig = hw * 2 > v.w * MARGIN * 2.5 && spec.zoom < ZMAX;
  // Вид больше, чем окно может охватить, — окно и так максимальное, лучше не будет.
  const maxed = spec.zoom <= ZMIN && !inside && Math.abs(v.x - spec.x) < 1 && Math.abs(v.y - spec.y) < 1;
  return (inside && !tooBig) || maxed;
}
function specFor(v) {
  const zoom = Math.max(ZMIN, Math.min(ZMAX, Math.min(WIN_W / 32 / (v.w * MARGIN), WIN_H / 32 / (v.h * MARGIN))));
  return { x: Math.round(v.x * 4) / 4, y: Math.round(v.y * 4) / 4, zoom: Math.round(zoom * 1000) / 1000 };
}
function onView(ws, v) {
  ws.view = v;
  if (v) sendGround(ws); // земля под новым видом — сразу, не дожидаясь очередного круга рассылки
  if (!v) { releaseSlot(ws); return; }
  if (!ws.slot) {
    // Свободный слот или давно не нужный; иначе — зритель смотрит основной вид (окон больше нет).
    const now = Date.now();
    const s = slots.find((s) => ![...viewers].some((o) => o.slot === s)) ;
    if (!s) return;
    ws.slot = s; s.used = now;
  }
  const s = ws.slot;
  if (fits(s.spec, v)) return;
  s.spec = specFor(v);
  applySlot(s);
}
function releaseSlot(ws) { if (ws.slot) { ws.slot = null; } }
async function applySlot(s) {
  if (s.busy || !runLua) return;
  s.busy = true;
  try {
    while (s.spec && s.spec !== s.applied) {
      const spec = s.spec;
      // Землю игра готовит только для чанков, впервые попавших в окно (остальное берёт из прошлого кадра). Если в
      // области окна есть чанки, которых у нас нет, чуть меняем масштаб — окно перерисовывает землю целиком.
      const nudge = groundMissing(spec) ? 1 + (s.nudge = -(s.nudge || 1e-4)) : 1;
      await runLua(SLOT_LUA, { name: s.name, x: spec.x, y: spec.y, zoom: spec.zoom * nudge, w: WIN_W, h: WIN_H });
      s.applied = spec; s.groundAt = Date.now();
    }
  } catch (e) { log(`окно ${s.name}:`, e.message); s.applied = null; }
  finally { s.busy = false; }
}
function groundMissing(spec) {
  const hw = WIN_W / 2 / 32 / spec.zoom, hh = WIN_H / 2 / 32 / spec.zoom;
  for (let cx = Math.floor((spec.x - hw) / 32); cx <= Math.floor((spec.x + hw) / 32); cx++)
    for (let cy = Math.floor((spec.y - hh) / 32); cy <= Math.floor((spec.y + hh) / 32); cy++) if (!ground.has(`${cx},${cy}`)) return true;
  return false;
}
// Окно-камера у игрока-камеры: создаётся при первом запросе, дальше меняются только место и масштаб.
// Команда выполняется у сервера и у клиента-камеры (элементы интерфейса — часть общего состояния игры).
const SLOT_LUA = `
  local p = game.get_player(A.camera)
  if not p then return false end
  local g = p.gui.screen[A.name]
  if not g then
    g = p.gui.screen.add{type = 'camera', name = A.name, position = {A.x, A.y}, surface_index = game.surfaces[A.surface].index, zoom = A.zoom}
  end
  -- Почти за краем экрана клиента (виден угол 5×5): основной вид клиента остаётся чистым, а землю игра для окна
  -- готовит, только если оно хоть немного на экране (совсем за краем — рисует постройки, но не землю).
  local r = p.display_resolution
  g.location = {r.width - 5, r.height - 5}
  -- Размер и масштаб элемента интерфейса умножаются на масштаб интерфейса игрока — делим, чтобы окно было ровно A.w×A.h
  local k = p.display_scale or 1
  g.style.width = math.floor(A.w / k + 0.5) g.style.height = math.floor(A.h / k + 0.5)
  g.position = {A.x, A.y} g.zoom = A.zoom / k
  return true`;
// Окна без зрителей убираем (игра рисует каждое окно каждый кадр).
setInterval(() => {
  for (const s of slots) {
    // У окна есть зритель, а кадров от него нет (окно убрали, клиент перезапустился) — ставим заново.
    const v = [...viewers].find((o) => o.slot === s);
    if (v && v.view && s.applied && !s.busy && (!s.key || Date.now() - (wins.get(s.key)?.at || 0) > 5000)) { s.key = null; s.applied = null; s.spec = specFor(v.view); applySlot(s); }
    else if (v && s.applied && !s.busy && Date.now() - (s.groundAt || 0) > 3000 && groundMissing(s.applied)) { s.spec = { ...s.applied }; applySlot(s); }
    if (!s.applied || v) continue;
    if (Date.now() - s.used < 30_000) continue;
    s.spec = null; s.applied = null; s.key = null;
    runLua?.(`local p = game.get_player(A.camera) local g = p and p.gui.screen[A.name] if g then g.destroy() end return true`, { name: s.name }).catch(() => {});
  }
  for (const [k, w] of wins) if (Date.now() - w.at > 60_000) wins.delete(k);
}, 10_000);

setInterval(() => { if (frames) log(`кадров от игры за минуту ${frames} (окон ${wins.size}), разбор кадра ${convN ? (convMs / convN).toFixed(1) : '—'} мс, спрайтов ${byN.length}, атласов ${atlases.size}, зрителей ${viewers.size}`); frames = 0; convMs = 0; convN = 0; }, 60_000);

export const wssRender = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, perMessageDeflate: { threshold: 1024 } });
wssRender.on('connection', (ws, req) => {
  ws.delta = /[?&]d=1/.test(req?.url || ''); // страница умеет разность (старые открытые вкладки получают кадры целиком)
  viewers.add(ws);
  ws.send(JSON.stringify({ t: 'reset', gen }));
  ws.send(JSON.stringify({ t: 'sprites', list: byN.map(pub), game: !!game }));
  if (camSent) ws.send(camSent);
  if (darkSent) ws.send(darkSent);
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d); } catch { return; }
    if (m.t === 'gforget' && Array.isArray(m.keys)) { for (const k of m.keys.slice(0, 5000)) ws.groundSent?.delete(String(k)); return; }
    if (m.t !== 'view') return;
    if (m.auto) return onView(ws, null);
    if (![m.x, m.y, m.w, m.h].every(Number.isFinite) || m.w <= 0 || m.h <= 0 || m.w > 1e4 || m.h > 1e4) return;
    onView(ws, { x: m.x, y: m.y, w: m.w, h: m.h });
  });
  const bye = () => { viewers.delete(ws); if (ws.slot) ws.slot.used = Date.now(); releaseSlot(ws); };
  ws.on('close', bye);
  ws.on('error', bye);
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
