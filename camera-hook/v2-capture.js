// Перехват отрисовки Factorio для прототипа веб-карты v2 (factorio.darkkeks.me/v2/).
// Загружается в клиент игры через Frida Gadget (LD_PRELOAD=gadget.so, gadget.config указывает на этот файл).
//
// Каждый вызов DrawQueue::draw* («нарисуй спрайт в точке карты») записывается C-обработчиком в общий буфер:
// спрайт, позиция, масштаб, цвет, слой. В начале DrawEngine::render (очереди кадра уже собраны) буфер кадра
// уходит сервису по unix-сокету. Описание каждого нового спрайта (где он лежит в атласе) отправляется один раз;
// пиксели атласа сервис запрашивает сам, их читаем из видеопамяти (glGetTexImage) в потоке отрисовки.
'use strict';
// В QuickJS нет TextEncoder: строки здесь только ASCII (JSON с числами и адресами).
const enc = (str) => { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; return a; };
const SOCK = '/home/darkkeks/factorio-camera/hook/v2.sock';
const MAX = 65536;       // записей в кадре
const REC = 32;          // байт на запись
const EVERY = 3;         // отправлять каждый N-й кадр (~20 в секунду при 60 кадрах)

const mod = Process.mainModule;
const syms = new Map(mod.enumerateSymbols().map((s) => [s.name, s.address]));
const find = (prefix) => { for (const [n, a] of syms) if (n.startsWith(prefix)) return a; return null; };

const buf = Memory.alloc(MAX * REC);
const count = Memory.alloc(8);
// Регистры по дизассемблеру 2.1.24 (компилятор местами отходит от ABI по сигнатуре, поэтому смотрим на код, не на имена):
//   kind 0 draw:                       rsi спрайт, rdx позиция, r8d слой
//   kind 1 drawTinted:                 + цвет xmm0 (r,g) xmm1 (b,a)
//   kind 2 drawScaledTinted:           масштаб xmm0, xmm1 (double); цвет xmm2, xmm3; r8d слой
//   kind 3 drawScaledTintedWithoutTint: как 2
//   kind 4 drawInfoIcon:               rsi спрайт (может быть 0), rcx позиция, xmm0 масштаб (double), r9d слой
//   kind 5 drawScaledRotatedTintedRegion: rdx позиция, масштаб xmm0, xmm1, цвет xmm6, xmm7, r8d флаги
//   kind 6 drawMaskWithData:           rsi спрайт, rcx позиция, цвет xmm0, xmm1
//   kind 7 прочие (rsi спрайт, rdx позиция)
const cm = new CModule(`
#include <glib.h>
#include <gum/guminterceptor.h>
extern unsigned char buf[];
extern volatile gint count;
#define CAP ${MAX}
static inline unsigned int rgba(float r, float g, float b, float a) {
  int R = r * 255, G = g * 255, B = b * 255, A = a * 255;
  if (R < 0) R = 0; if (R > 255) R = 255; if (G < 0) G = 0; if (G > 255) G = 255;
  if (B < 0) B = 0; if (B > 255) B = 255; if (A < 0) A = 0; if (A > 255) A = 255;
  return R | (G << 8) | (B << 16) | ((unsigned) A << 24);
}
void onEnter(GumInvocationContext *ic) {
  GumCpuContext *c = ic->cpu_context;
  int kind = GPOINTER_TO_INT(gum_invocation_context_get_listener_function_data(ic));
  unsigned char *x = (unsigned char *) c->xmm;
  guint64 sprite = c->rsi; gint32 *pos = (gint32 *) c->rdx;
  float sx = 1, sy = 1; unsigned int tint = 0xffffffff; unsigned int layer = (unsigned int) c->r8 & 0xff;
  if (kind == 1) tint = rgba(*(float *)(x + 0), *(float *)(x + 4), *(float *)(x + 16), *(float *)(x + 20));
  else if (kind == 2 || kind == 3) { sx = *(double *)(x + 0); sy = *(double *)(x + 16); tint = rgba(*(float *)(x + 32), *(float *)(x + 36), *(float *)(x + 48), *(float *)(x + 52)); }
  else if (kind == 4) { pos = (gint32 *) c->rcx; sx = sy = *(double *)(x + 0); layer = (unsigned int) c->r9 & 0xff; }
  else if (kind == 5) { sx = *(double *)(x + 0); sy = *(double *)(x + 16); tint = rgba(*(float *)(x + 96), *(float *)(x + 100), *(float *)(x + 112), *(float *)(x + 116)); }
  else if (kind == 6) { pos = (gint32 *) c->rcx; tint = rgba(*(float *)(x + 0), *(float *)(x + 4), *(float *)(x + 16), *(float *)(x + 20)); }
  if (!sprite || !pos) return;
  int i = g_atomic_int_add(&count, 1);
  if (i >= CAP) return;
  unsigned char *r = buf + i * ${REC};
  *(guint64 *)(r + 0) = sprite;
  *(gint32 *)(r + 8) = pos[0];
  *(gint32 *)(r + 12) = pos[1];
  *(float *)(r + 16) = sx;
  *(float *)(r + 20) = sy;
  *(unsigned int *)(r + 24) = tint;
  *(unsigned int *)(r + 28) = layer | (kind << 8);
}`, { buf, count });

const HOOKS = [
  ['_ZN9DrawQueue4drawERK6SpriteRK11MapPosition12DrawingFlags', 0],
  ['_ZN9DrawQueue10drawTintedERK6Sprite', 1],
  ['_ZN9DrawQueue16drawScaledTintedERK6Sprite', 2],
  ['_ZN9DrawQueue27drawScaledTintedWithoutTintE', 3],
  ['_ZN9DrawQueue12drawInfoIconE', 4],
  ['_ZN9DrawQueue29drawScaledRotatedTintedRegionE', 5],
  ['_ZN9DrawQueue16drawMaskWithDataE', 6],
  ['_ZN9DrawQueue28drawScaledRotatedWithoutTintE', 7],
  ['_ZN9DrawQueue30drawMaskWithOptionalShadowSkipE', 7],
  ['_ZN9DrawQueue10drawScaledE', 7],
  ['_ZN9DrawQueue17drawScaledRotatedE', 7],
];
for (const [p, kind] of HOOKS) {
  const a = find(p);
  if (a) Interceptor.attach(a, cm.onEnter, ptr(kind)); else console.log('[v2] нет функции', p);
}

// ---------- связь с сервисом ----------
let conn = null, connecting = false, frame = 0;
const known = new Set();     // спрайты, описание которых уже отправлено
const atlasWanted = [];      // какие атласы просит сервис
async function connect() {
  if (connecting) return;
  connecting = true;
  try {
    conn = await Socket.connect({ family: 'unix', path: SOCK });
    known.clear();
    console.log('[v2] подключён к сервису');
    readLoop(conn);
  } catch (e) { conn = null; }
  connecting = false;
}
async function readLoop(c) {
  let pending = '';
  try {
    for (;;) {
      const d = await c.input.read(4096);
      if (d.byteLength === 0) break;
      pending += String.fromCharCode(...new Uint8Array(d));
      let i;
      while ((i = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, i); pending = pending.slice(i + 1);
        if (line.startsWith('atlas ')) atlasWanted.push(line.slice(6));
      }
    }
  } catch (e) { /* соединение закрыто */ }
  if (conn === c) conn = null;
}
// Сообщение: u32 длина, u8 тип, данные. Тип 1 — кадр, 2 — описания спрайтов (JSON), 3 — атлас (JSON-заголовок + RGBA).
let sending = Promise.resolve(), inflight = 0;
function post(type, payload) {
  const c = conn;
  if (!c) return;
  if (type === 1 && inflight > 2) return; // сокет не успевает (идёт атлас) — кадр пропускаем
  inflight++;
  const head = new ArrayBuffer(5), dv = new DataView(head);
  dv.setUint32(0, payload.byteLength + 1, true); dv.setUint8(4, type);
  sending = sending.then(() => c.output.writeAll(head)).then(() => c.output.writeAll(payload)).catch(() => { if (conn === c) conn = null; }).finally(() => { inflight--; });
}

// Описание спрайта (смещения разобраны по дампам Sprite в 2.1.24):
//   +0x28 double сдвиг x (клетки), +0x30 double сдвиг y, +0x38 double масштаб,
//   +0x68 объект атласа (в нём +0x08 номер текстуры GL, +0x18/+0x1c размер), +0x70/+0x74 x, y в атласе, +0x78/+0x7a ширина, высота.
function describe(sp) {
  const atlas = sp.add(0x68).readPointer();
  return {
    id: sp.toString(), atlas: atlas.toString(),
    x: sp.add(0x70).readU32(), y: sp.add(0x74).readU32(), w: sp.add(0x78).readU16(), h: sp.add(0x7a).readU16(),
    shiftX: sp.add(0x28).readDouble(), shiftY: sp.add(0x30).readDouble(), scale: sp.add(0x38).readDouble(),
  };
}

let glGetIntegerv_; const glGetIntegerv = (...a) => (glGetIntegerv_ ??= new NativeFunction(Module.getGlobalExportByName('glGetIntegerv'), 'void', ['uint', 'pointer']))(...a);
let glBindTexture_; const glBindTexture = (...a) => (glBindTexture_ ??= new NativeFunction(Module.getGlobalExportByName('glBindTexture'), 'void', ['uint', 'uint']))(...a);
let glGetTexImage_; const glGetTexImage = (...a) => (glGetTexImage_ ??= new NativeFunction(Module.getGlobalExportByName('glGetTexImage'), 'void', ['uint', 'int', 'uint', 'uint', 'pointer']))(...a);
let glPixelStorei_; const glPixelStorei = (...a) => (glPixelStorei_ ??= new NativeFunction(Module.getGlobalExportByName('glPixelStorei'), 'void', ['uint', 'int']))(...a);
const GL_TEXTURE_2D = 0x0DE1, GL_TEXTURE_BINDING_2D = 0x8069, GL_RGBA = 0x1908, GL_UNSIGNED_BYTE = 0x1401, GL_PACK_ALIGNMENT = 0x0D05;
let glGetTexLevelParameteriv_; const glGetTexLevelParameteriv = (...a) => (glGetTexLevelParameteriv_ ??= new NativeFunction(Module.getGlobalExportByName('glGetTexLevelParameteriv'), 'void', ['uint', 'int', 'uint', 'pointer']))(...a);
let glIsTexture_; const glIsTexture = (...a) => (glIsTexture_ ??= new NativeFunction(Module.getGlobalExportByName('glIsTexture'), 'uint8', ['uint']))(...a);
// Пиксели атласа берём собственной функцией игры copyDataRaw(std::vector<uint8>&, размер): часть атласов живёт
// в памяти (CustomVideoBitmap), часть — на видеокарте (VideoBitmapOpenGL); класс узнаём по указателю на vtable.
const CLASSES = [
  ['CustomVideoBitmap', syms.get('_ZTV17CustomVideoBitmap'), syms.get('_ZNK17CustomVideoBitmap11copyDataRawERSt6vectorIhSaIhEEm')],
  ['VideoBitmapOpenGL', syms.get('_ZTV17VideoBitmapOpenGL'), syms.get('_ZNK17VideoBitmapOpenGL11copyDataRawERSt6vectorIhSaIhEEm')],
];
function readAtlas(a) {
  const p = ptr(a), vptr = p.readPointer();
  const cls = CLASSES.find(([, vt]) => vt && vt.add(16).equals(vptr));
  const w = p.add(0x18).readU32(), h = p.add(0x1c).readU32();
  if (!cls || !cls[2] || w > 16384 || h > 16384) { console.log('[v2] атлас', a, 'неизвестного класса', DebugSymbol.fromAddress(vptr).toString()); return; }
  const vec = Memory.alloc(24); // std::vector<uint8_t>: begin, end, end_of_storage
  vec.writeByteArray(new Array(24).fill(0));
  new NativeFunction(cls[2], 'void', ['pointer', 'pointer', 'uint64'])(p, vec, 0);
  const begin = vec.readPointer(), size = vec.add(8).readPointer().sub(begin).toInt32();
  console.log('[v2] атлас', a, cls[0], w + 'x' + h, 'байт', size, 'на пиксель', (size / (w * h)).toFixed(3), 'поля +0x28', p.add(0x28).readU32().toString(16), p.add(0x2c).readU32().toString(16));
  const head = enc(JSON.stringify({ atlas: a, w, h, cls: cls[0], size, fmt: p.add(0x28).readU32(), fmt2: p.add(0x2c).readU32() }) + '\n');
  const all = new Uint8Array(head.length + size);
  all.set(head); all.set(new Uint8Array(begin.readByteArray(size)), head.length);
  post(3, all.buffer);
}

// Граница кадра: начало DrawEngine::render — все очереди кадра уже собраны, контекст GL текущий.
Interceptor.attach(find('_ZN10DrawEngine6renderE'), { onEnter() {
  frame++;
  const n = Math.min(count.readS32(), MAX);
  if (conn && frame % EVERY === 0 && n > 0) {
    const fresh = [];
    for (let i = 0; i < n; i++) {
      const sp = buf.add(i * REC).readPointer(), k = sp.toString();
      if (!known.has(k)) { known.add(k); try { fresh.push(describe(sp)); } catch (e) { /* не спрайт */ } }
    }
    if (fresh.length) post(2, enc(JSON.stringify(fresh)).buffer);
    post(1, buf.readByteArray(n * REC));
  }
  while (atlasWanted.length) { try { readAtlas(atlasWanted.shift()); } catch (e) { console.log('[v2] атлас:', e.message); } }
  count.writeS32(0);
  if (!conn && frame % 120 === 0) connect();
} });
console.log('[v2] перехват установлен');
