// Перехват отрисовки Factorio для прототипа отрисовки в браузере (factorio.darkkeks.me/render/).
// Загружается в клиент игры через Frida Gadget (LD_PRELOAD=gadget.so, gadget.config указывает на этот файл).
//
// Каждый вызов DrawQueue::draw* («нарисуй спрайт в точке карты») записывается C-обработчиком в общий буфер:
// спрайт, позиция, масштаб, цвет, слой. В начале DrawEngine::render (очереди кадра уже собраны) буфер кадра
// уходит сервису (src/map-render.mjs) по unix-сокету. Описание каждого нового спрайта (где он лежит в атласе) отправляется один раз;
// пиксели атласа сервис запрашивает сам, их читаем из видеопамяти (glGetTexImage) в потоке отрисовки.
'use strict';
// В QuickJS нет TextEncoder: строки здесь только ASCII (JSON с числами и адресами).
const enc = (str) => { const a = new Uint8Array(str.length); for (let i = 0; i < str.length; i++) a[i] = str.charCodeAt(i) & 0xff; return a; };
const SOCK = '/home/darkkeks/factorio-camera/hook/v2.sock';
const MAX = 32768;       // записей в кадре
const REC = 64;          // байт на запись
const EVERY = 3;         // отправлять каждый N-й кадр (~20 в секунду при 60 кадрах)

const mod = Process.mainModule;
const syms = new Map(mod.enumerateSymbols().map((s) => [s.name, s.address]));
const find = (prefix) => { for (const [n, a] of syms) if (n.startsWith(prefix)) return a; return null; };

const buf = Memory.alloc(MAX * REC);
const count = Memory.alloc(8);
const skip = Memory.alloc(8);
// Записи кадра читаем в DrawEngine::load(DrawQueue*): игра передаёт сюда каждую очередь кадра, пока та ещё полная.
// Устройство DrawQueue (2.1.24, по коду draw*): +0x28 u8 смещение слоёв очереди; +0x30 + (смещение + слой)·16 — массив
// пар {u64 ключ сортировки, SpriteDrawOrder*} для слоя: {указатель, u32 число, u32 ёмкость}; +0x1030 — свечение
// (при затенении света), +0x1040 — тени (рисуются одним буфером между слоями 119 и 120).
// SpriteDrawOrder (по renderSpriteDrawOrderRange): +0x00 указатель на поле атласа спрайта (спрайт = он − 0x68),
// +0x10/+0x14 f32 точка на экране в пикселях, +0x18 u32 поворот (доля оборота), +0x1c u32 флаги,
// +0x24/+0x28 f32 итоговый масштаб, +0x2c u32 цвет RGBA, +0x30/+0x34 f32 сдвиг вырезки в атласе, +0x38/+0x3c f32 её размер.
// Запись (REC байт): u64 спрайт, u64 ключ, f32 x, y, u32 поворот, u32 флаги, f32 масштаб x, y, u32 цвет, f32 вырезка x, y, w, h, u32 слой.
const cm = new CModule(`
#include <glib.h>
#include <gum/guminterceptor.h>
extern unsigned char buf[];
extern volatile gint count;
extern volatile gint skip;
#define CAP ${MAX}
static void put(guint64 key, unsigned char *o, unsigned int layer) {
  if (!o) return;
  int i = g_atomic_int_add(&count, 1);
  if (i >= CAP) return;
  unsigned char *r = buf + i * ${REC};
  *(guint64 *)(r + 0) = *(guint64 *)(o + 0) - 0x68;
  *(guint64 *)(r + 8) = key;
  *(float *)(r + 16) = *(float *)(o + 0x10);
  *(float *)(r + 20) = *(float *)(o + 0x14);
  *(guint32 *)(r + 24) = *(guint32 *)(o + 0x18);
  *(guint32 *)(r + 28) = *(guint32 *)(o + 0x1c);
  *(float *)(r + 32) = *(float *)(o + 0x24);
  *(float *)(r + 36) = *(float *)(o + 0x28);
  *(guint32 *)(r + 40) = *(guint32 *)(o + 0x2c);
  *(float *)(r + 44) = *(float *)(o + 0x30);
  *(float *)(r + 48) = *(float *)(o + 0x34);
  *(float *)(r + 52) = *(float *)(o + 0x38);
  *(float *)(r + 56) = *(float *)(o + 0x3c);
  *(guint32 *)(r + 60) = layer;
}
static void list(unsigned char *e, unsigned int layer) {
  unsigned char *arr = *(unsigned char **)e;
  unsigned int n = *(unsigned int *)(e + 8), cap = *(unsigned int *)(e + 12);
  if (!arr || n > cap || n > 1000000) return;
  for (unsigned int k = 0; k < n; k++) put(*(guint64 *)(arr + k * 16), *(unsigned char **)(arr + k * 16 + 8), layer);
}
void onLoad(GumInvocationContext *ic) {
  if (skip) return;
  unsigned char *q = (unsigned char *) gum_invocation_context_get_nth_argument(ic, 1);
  for (int l = 0; l < 256; l++) list(q + 0x30 + l * 16, l);
  list(q + 0x1040, 1000);   /* тени */
  list(q + 0x1030, 1001);   /* свечение */
}`, { buf, count, skip });
Interceptor.attach(find('_ZN10DrawEngine4loadEPK9DrawQueue'), cm.onLoad);

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
//   +0x54 флаги слоя (биты 1–3: тень / свечение / свет — по коду drawSliced*: testb $0xe,0x54(...)), +0x80 следующий слой:
//   Sprite — цепочка слоёв, функции draw* рисуют её целиком.
function describe(sp) {
  const atlas = sp.add(0x68).readPointer(), next = sp.add(0x80).readPointer();
  return {
    id: sp.toString(), atlas: atlas.toString(), next: next.isNull() ? null : next.toString(), fl: sp.add(0x54).readU8(), fl2: sp.add(0x55).readU8(), fl3: sp.add(0x56).readU8(),
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

// Клиент-камера ещё и снимает тайлы карты (RenderUtil::takeScreenshots): эти отрисовки — не вид камеры.
const shots = find('_ZN10RenderUtil15takeScreenshotsE');
if (shots) Interceptor.attach(shots, { onEnter() { skip.writeS32(1); }, onLeave() { skip.writeS32(0); } });

// Граница кадра: начало DrawEngine::render — все очереди кадра уже собраны, контекст GL текущий.
Interceptor.attach(find('_ZN10DrawEngine6renderE'), { onEnter() {
  if (skip.readS32()) return; // кадр снимка карты
  frame++;
  const n = Math.min(count.readS32(), MAX);
  if (conn && frame % EVERY === 0 && n > 0) {
    const fresh = [];
    for (let i = 0; i < n; i++) {
      const sp = buf.add(i * REC).readPointer(), k = sp.toString();
      // Вся цепочка слоёв (не больше 16 — на случай мусора)
      let p = sp;
      for (let d = 0; d < 16 && !p.isNull(); d++) {
        const pk = p.toString();
        if (known.has(pk)) break;
        known.add(pk);
        let desc;
        try { desc = describe(p); } catch (e) { break; }
        fresh.push(desc);
        p = desc.next ? ptr(desc.next) : NULL;
      }
    }
    if (fresh.length) post(2, enc(JSON.stringify(fresh)).buffer);
    post(1, buf.readByteArray(n * REC));
  }
  while (atlasWanted.length) { try { readAtlas(atlasWanted.shift()); } catch (e) { console.log('[v2] атлас:', e.message); } }
  count.writeS32(0);
  if (!conn && frame % 120 === 0) connect();
} });
console.log('[v2] перехват установлен');
