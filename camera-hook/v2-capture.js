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
// Сокет сервиса: переменная окружения V2_SOCK процесса игры (второй экземпляр карты), иначе — основной.
const SOCK = (() => {
  try {
    const v = new NativeFunction(Module.getGlobalExportByName('getenv'), 'pointer', ['pointer'])(Memory.allocUtf8String('V2_SOCK'));
    if (!v.isNull()) return v.readUtf8String();
  } catch (e) { console.log('[v2] getenv:', e.message); }
  return '/home/darkkeks/factorio-camera/hook/v2.sock';
})();
const MAX = 32768;       // записей в кадре
const REC = 64;          // байт на запись
// Кадров в секунду сервису: не «каждый N-й кадр игры», а по времени — ровный поток, сколько бы ни рисовала игра.
const FPS = (() => { try { const v = new NativeFunction(Module.getGlobalExportByName('getenv'), 'pointer', ['pointer'])(Memory.allocUtf8String('V2_FPS')); if (!v.isNull()) return Number(v.readUtf8String()) || 30; } catch (e) { /* нет */ } return 30; })();

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
// Всё, что делается на каждом кадре, — в C (CModule): JS в потоке отрисовки стоил игре 13–18 мс на кадр
// (перебор 15 тыс. записей), камера рисовала ~22 кадра в секунду вместо 60.
//   * новые спрайты отмечаются хеш-таблицей прямо при сборе записей, JS описывает только их;
//   * кадр уходит по времени (FPS в секунду) копией в очередь, сокет пишет и читает отдельный поток (GThread) —
//     поток отрисовки на сеть не ждёт; не успевает сокет — кадр пропускается.
// Сообщение сервису: u32 длина (тип + данные), u8 тип, данные. Тип 1 — кадр, 2 — описания спрайтов (JSON), 3 — атлас.
const LIBC = ['socket', 'connect', 'send', 'recv', 'close', 'malloc', 'free', 'memcpy', 'memset', 'memmove', 'usleep', 'clock_gettime',
  'pthread_create', 'pthread_mutex_lock', 'pthread_mutex_unlock', 'pthread_cond_timedwait', 'pthread_cond_signal'];
const STATE = {};
for (const [n, size] of [['known', 8 << 17], ['nknown', 8], ['fresh', 8 * 4096], ['nfresh', 8], ['reconnected', 8], ['want_reset', 8], ['path', 112], ['fd', 8],
  ['kmu', 64], ['qmu', 64], ['qcv', 64], ['lmu', 64], ['q', 8 * 64], ['qh', 8], ['qt', 8], ['lines', 8192], ['nlines', 8], ['last_sent', 8], ['interval_us', 8], ['cur_params', 8], ['wins', 16 * 16]]) STATE[n] = Memory.alloc(size);
STATE.fd.writeS32(-1);
const cm = new CModule(`
#include <glib.h>
#include <gum/guminterceptor.h>
typedef unsigned long long u64;
typedef unsigned int u32;
extern unsigned char buf[];
extern volatile gint count;
extern volatile int skip;
extern int socket(int, int, int);
extern int connect(int, const void *, unsigned int);
extern long send(int, const void *, unsigned long, int);
extern long recv(int, void *, unsigned long, int);
extern int close(int);
extern void *malloc(unsigned long);
extern void free(void *);
extern void *memcpy(void *, const void *, unsigned long);
extern void *memset(void *, int, unsigned long);
extern void *memmove(void *, const void *, unsigned long);
extern int usleep(unsigned int);
extern int clock_gettime(int, void *);
extern int pthread_create(void *, const void *, void *(*)(void *), void *);
extern int pthread_mutex_lock(void *);
extern int pthread_mutex_unlock(void *);
extern int pthread_cond_timedwait(void *, void *, const void *);
extern int pthread_cond_signal(void *);
#define CAP ${MAX}
#define REC ${REC}
#define KN (1 << 17)
#define QN 64
/* Изменяемое состояние — в памяти, выделенной из JS (статические данные CModule только для чтения). */
extern u64 known[KN];
extern int nknown;
extern u64 fresh[4096];
extern volatile int nfresh;
extern volatile int reconnected;
extern volatile int want_reset;
extern char path[108];
extern volatile int fd;
/* pthread_mutex_t (40 байт) и pthread_cond_t (48 байт) в glibc; нули — статическая инициализация. */
extern u64 kmu[8], qmu[8], qcv[8], lmu[8];
extern unsigned char *q[QN];
extern int qh, qt;
extern char lines[8192];
extern int nlines;
extern long long last_sent;
extern long long interval_us;
extern volatile u64 cur_params;     /* RenderParameters текущей отрисовки (у каждого окна — свои) */
extern long long wins[32];           /* окна: пары {RenderParameters*, когда отправлен последний кадр} */

static long long now_us(void) { long long ts[2]; clock_gettime(1, ts); return ts[0] * 1000000 + ts[1] / 1000; } /* CLOCK_MONOTONIC */

static int is_new(u64 k) {
  u64 h0 = (k * 0x9E3779B97F4A7C15ull) >> 47, h = h0;
  /* Сначала без блокировки (чаще всего спрайт уже известен); очереди могут собираться в нескольких потоках. */
  for (;;) { h &= KN - 1; if (known[h] == k) return 0; if (!known[h]) break; h++; }
  pthread_mutex_lock(kmu);
  int r = 0;
  for (h = h0;;) {
    h &= KN - 1;
    if (known[h] == k) break;
    if (!known[h]) {
      if (nknown > KN / 2 || nfresh >= 4096) break;   /* переполнено или JS ещё не забрал — отметим в следующий раз */
      fresh[nfresh] = k; nfresh++; known[h] = k; nknown++; r = 1;
      break;
    }
    h++;
  }
  pthread_mutex_unlock(kmu);
  return r;
}
static void put(u64 key, unsigned char *o, unsigned int layer) {
  if (!o) return;
  int i = g_atomic_int_add(&count, 1);
  if (i >= CAP) return;
  unsigned char *r = buf + i * REC;
  u64 sp = *(u64 *)(o + 0) - 0x68;
  *(u64 *)(r + 0) = sp;
  *(u64 *)(r + 8) = key;
  *(float *)(r + 16) = *(float *)(o + 0x10);
  *(float *)(r + 20) = *(float *)(o + 0x14);
  *(u32 *)(r + 24) = *(u32 *)(o + 0x18);
  *(u32 *)(r + 28) = *(u32 *)(o + 0x1c);
  *(float *)(r + 32) = *(float *)(o + 0x24);
  *(float *)(r + 36) = *(float *)(o + 0x28);
  *(u32 *)(r + 40) = *(u32 *)(o + 0x2c);
  *(float *)(r + 44) = *(float *)(o + 0x30);
  *(float *)(r + 48) = *(float *)(o + 0x34);
  *(float *)(r + 52) = *(float *)(o + 0x38);
  *(float *)(r + 56) = *(float *)(o + 0x3c);
  *(u32 *)(r + 60) = layer;
  is_new(sp);
}
static void list(unsigned char *e, unsigned int layer) {
  unsigned char *arr = *(unsigned char **)e;
  unsigned int n = *(unsigned int *)(e + 8), cap = *(unsigned int *)(e + 12);
  if (!arr || n > cap || n > 1000000) return;
  for (unsigned int k = 0; k < n; k++) put(*(u64 *)(arr + k * 16), *(unsigned char **)(arr + k * 16 + 8), layer);
}
void onLoad(GumInvocationContext *ic) {
  if (skip) return;
  unsigned char *qq = (unsigned char *) gum_invocation_context_get_nth_argument(ic, 1);
  cur_params = *(u64 *)qq;   /* DrawQueue+0 — указатель на RenderParameters его отрисовки */
  for (int l = 0; l < 256; l++) list(qq + 0x30 + l * 16, l);
  list(qq + 0x1040, 1000);   /* тени */
  list(qq + 0x1030, 1001);   /* свечение */
}

/* Очередь сообщений (кольцо): каждое — [u32 длина = 1 + данные][u8 тип][данные] одним куском. */
static int qlen(void) { return (qt - qh + QN) % QN; }
static int push(int type, const void *a, unsigned long na, const void *b, unsigned long nb, int frame) {
  pthread_mutex_lock(qmu);
  if (qlen() >= QN - 1 || (frame && qlen() >= 12)) { pthread_mutex_unlock(qmu); return 0; } /* сокет не успевает */
  pthread_mutex_unlock(qmu);
  unsigned char *m = malloc(5 + na + nb);
  if (!m) return 0;
  *(u32 *)m = (u32)(1 + na + nb);
  m[4] = (unsigned char)type;
  if (na) memcpy(m + 5, a, na);
  if (nb) memcpy(m + 5 + na, b, nb);
  pthread_mutex_lock(qmu);
  q[qt] = m; qt = (qt + 1) % QN;
  pthread_cond_signal(qcv);
  pthread_mutex_unlock(qmu);
  return 1;
}
static unsigned char *pop(int wait_ms) {
  pthread_mutex_lock(qmu);
  if (qh == qt) {
    long long ts[2]; clock_gettime(0, ts);          /* CLOCK_REALTIME — для timedwait */
    ts[1] += wait_ms * 1000000LL; if (ts[1] >= 1000000000LL) { ts[0]++; ts[1] -= 1000000000LL; }
    pthread_cond_timedwait(qcv, qmu, ts);
  }
  unsigned char *m = 0;
  if (qh != qt) { m = q[qh]; qh = (qh + 1) % QN; }
  pthread_mutex_unlock(qmu);
  return m;
}
void post2(int type, const void *a, unsigned long na, const void *b, unsigned long nb) { if (fd >= 0) push(type, a, na, b, nb, 0); }
int connected(void) { return fd >= 0; }

/* Граница отрисовки (начало DrawEngine::render): основной вид и каждое окно-камера интерфейса (LuaGuiElement camera)
   рисуются отдельно, у каждого — свой RenderParameters. Кадр окна уходит, если с его прошлого кадра прошёл интервал
   (без 8 мс: при 60 кадрах игры и 30 в секунду — ровно каждый второй) и сокет успевает.
   Тип 6: double время съёмки (мс), u64 адрес RenderParameters (номер окна), i16 ширина, i16 высота (пиксели), i32 0,
   double масштаб, i32 x, y центра (1/256 клетки), затем записи.
   RenderParameters (по updateCornersAndPixelShift): +0x188/+0x18a i16 размер, +0x190 double масштаб, +0x198 MapPosition центра. */
int frame_end(void) {
  int n = count, sent = 0;
  if (n > CAP) n = CAP;
  if (want_reset) { memset(known, 0, sizeof known); nknown = 0; nfresh = 0; want_reset = 0; }
  long long t = now_us();
  u64 key = cur_params;
  int w = -1;
  for (int i = 0; i < 16; i++) if ((u64)wins[2 * i] == key) { w = i; break; }
  if (w < 0) {                                  /* новое окно — на место самого давно не отправлявшегося */
    w = 0;
    for (int i = 1; i < 16; i++) if (wins[2 * i + 1] < wins[2 * w + 1]) w = i;
    wins[2 * w] = (long long)key; wins[2 * w + 1] = 0;
  }
  if (fd >= 0 && n > 0 && key && t - wins[2 * w + 1] >= interval_us - 8000) {
    unsigned char h[40], *pp = (unsigned char *)key;
    memset(h, 0, sizeof h);
    *(double *)(h + 0) = t / 1000.0;
    *(u64 *)(h + 8) = key;
    *(short *)(h + 16) = *(short *)(pp + 0x188); *(short *)(h + 18) = *(short *)(pp + 0x18a);
    *(double *)(h + 24) = *(double *)(pp + 0x190);
    *(int *)(h + 32) = *(int *)(pp + 0x198); *(int *)(h + 36) = *(int *)(pp + 0x19c);
    if (push(6, h, 40, buf, (unsigned long)n * REC, 1)) { wins[2 * w + 1] = t; sent = 1; }
  }
  count = 0; cur_params = 0;
  return sent;
}
void fresh_done(void) { nfresh = 0; }

/* Строки от сервиса («atlas <адрес>») — забирает JS. */
int take_lines(char *out, int cap) {
  pthread_mutex_lock(lmu);
  int n = nlines < cap ? nlines : cap;
  memcpy(out, lines, n);
  memmove(lines, lines + n, nlines - n); nlines -= n;
  pthread_mutex_unlock(lmu);
  return n;
}

static void *sender(void *unused) {
  struct { unsigned short fam; char p[108]; } addr;
  for (;;) {
    if (fd < 0) {
      int s = socket(1, 1 | 0x80000, 0);                 /* AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC */
      memset(&addr, 0, sizeof addr); addr.fam = 1; memcpy(addr.p, path, sizeof addr.p);
      if (s >= 0 && connect(s, &addr, sizeof addr) == 0) {
        unsigned char *m;
        while ((m = pop(0))) free(m);                    /* старое — от прошлого соединения */
        want_reset = 1; reconnected = 1; fd = s;
      } else { if (s >= 0) close(s); usleep(1000000); continue; }
    }
    unsigned char *m = pop(50);
    if (m) {
      unsigned long len = 4 + *(u32 *)m, off = 0;
      while (off < len) { long w = send(fd, m + off, len - off, 0x4000); if (w <= 0) break; off += w; } /* MSG_NOSIGNAL */
      free(m);
      if (off < len) { close(fd); fd = -1; continue; }
    }
    char tmp[4096];
    long r = recv(fd, tmp, sizeof tmp, 0x40);           /* MSG_DONTWAIT */
    if (r == 0) { close(fd); fd = -1; continue; }
    if (r > 0) { pthread_mutex_lock(lmu); if (nlines + r <= (long)sizeof lines) { memcpy(lines + nlines, tmp, r); nlines += r; } pthread_mutex_unlock(lmu); }
  }
  return 0;
}
void start(const char *sock, int fps) {
  int i = 0;
  while (sock[i] && i < 107) { path[i] = sock[i]; i++; }
  interval_us = 1000000 / (fps > 0 ? fps : 30);
  u64 th;
  pthread_create(&th, 0, sender, 0);
}
`, Object.assign({ buf, count, skip }, Object.fromEntries(LIBC.map((n) => [n, Module.getGlobalExportByName(n)])), STATE));
Interceptor.attach(find('_ZN10DrawEngine4loadEPK9DrawQueue'), cm.onLoad);

// ---------- связь с сервисом ----------
const C = {
  start: new NativeFunction(cm.start, 'void', ['pointer', 'int']),
  post2: new NativeFunction(cm.post2, 'void', ['int', 'pointer', 'ulong', 'pointer', 'ulong']),
  connected: new NativeFunction(cm.connected, 'int', []),
  frameEnd: new NativeFunction(cm.frame_end, 'int', []),
  freshDone: new NativeFunction(cm.fresh_done, 'void', []),
  takeLines: new NativeFunction(cm.take_lines, 'int', ['pointer', 'int']),
};
const freshBuf = STATE.fresh, nfresh = STATE.nfresh, reconnected = STATE.reconnected;
const known = new Set();     // спрайты (и слои цепочек), описание которых уже отправлено
const atlasWanted = [];      // какие атласы просит сервис
const lineBuf = Memory.alloc(8192);
let pendingLines = '';
function readLines() {
  const n = C.takeLines(lineBuf, 8192);
  if (!n) return;
  pendingLines += String.fromCharCode(...new Uint8Array(lineBuf.readByteArray(n)));
  let i;
  while ((i = pendingLines.indexOf('\n')) >= 0) {
    const line = pendingLines.slice(0, i); pendingLines = pendingLines.slice(i + 1);
    if (line.startsWith('atlas ')) atlasWanted.push(line.slice(6));
  }
}
// Сообщение уходит через очередь C-потока (порядок сохраняется): тип 2 — описания спрайтов, 3 — атлас.
function post(type, payload) {
  const b = Memory.alloc(payload.byteLength);
  b.writeByteArray(payload);
  C.post2(type, b, payload.byteLength, NULL, 0);
}
C.start(Memory.allocUtf8String(SOCK), FPS);
console.log(`[v2] сокет ${SOCK}, кадров в секунду ${FPS}`);

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
  const hb = Memory.alloc(head.length); hb.writeByteArray(head);
  C.post2(3, hb, head.length, begin, size); // пиксели копирует C прямо из вектора игры
}

// Клиент-камера ещё и снимает тайлы карты (RenderUtil::takeScreenshots): эти отрисовки — не вид камеры.
const shots = find('_ZN10RenderUtil15takeScreenshotsE');
if (shots) Interceptor.attach(shots, { onEnter() { skip.writeS32(1); }, onLeave() { skip.writeS32(0); } });

// Граница кадра: начало DrawEngine::render — все очереди кадра уже собраны, контекст GL текущий.
let statT = Date.now(), statF = 0, statMs = 0, statSent = 0;
Interceptor.attach(find('_ZN10DrawEngine6renderE'), { onEnter() {
  if (skip.readS32()) return; // кадр снимка карты
  const t0 = Date.now(); statF++;
  if (t0 - statT > 30000) { console.log(`[v2] кадров игры ${(statF * 1000 / (t0 - statT)).toFixed(1)}/с, отправлено ${(statSent * 1000 / (t0 - statT)).toFixed(1)}/с, перехват ${(statMs / statF).toFixed(2)} мс на кадр`); statT = t0; statF = 0; statMs = 0; statSent = 0; }
  if (reconnected.readS32()) { reconnected.writeS32(0); known.clear(); console.log('[v2] подключён к сервису'); }
  // Новые спрайты кадра (C отметил их при сборе записей) — описания всей цепочки слоёв, до кадра в очереди.
  const nf = nfresh.readS32();
  if (nf > 0) {
    const fresh = [];
    for (let i = 0; i < nf; i++) {
      let p = freshBuf.add(i * 8).readPointer();
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
    C.freshDone();
    if (fresh.length && C.connected()) post(2, enc(JSON.stringify(fresh)).buffer);
  }
  if (C.frameEnd()) statSent++;
  readLines();
  while (atlasWanted.length) { try { readAtlas(atlasWanted.shift()); } catch (e) { console.log('[v2] атлас:', e.message); } }
  statMs += Date.now() - t0;
} });
console.log('[v2] перехват установлен');
