// Сжатие кадров прототипа отрисовки разностью с прошлым кадром.
//
// Кадр — записи по R = 10 целых (см. convert в map-render.mjs). От кадра к кадру ~3/4 записей не меняются вовсе
// (постройки, земля, стоящие предметы) — их передаём ссылкой на запись прошлого кадра, обычно целыми отрезками подряд.
// Остальные (движущиеся предметы, кадры анимации) — целиком, по столбцам, x и y — разностью с предыдущей новой записью:
// так сжатие WebSocket (permessage-deflate) работает лучше. Итог на плотной базе — примерно в 3 раза меньше, чем
// просто сжатый кадр.
//
// Формат (Int32): MAGIC, время съёмки (мс по часам камеры, младшие 31 бит), прямоугольник окна x0, y0, x1, y1
// (1/16 клетки; все 0 — неизвестен), число записей кадра, число операций K, операции, число новых записей M, столбцы новых (R·M).
// Операции по порядку записей кадра: 0 — следующая новая запись; v < 0 — копия записи прошлого кадра с номером −1 − v;
// v > 0 — ещё v записей прошлого кадра подряд за последней скопированной.
export const R = 10;
export const MAGIC = 0x33445246; // 'FRD3'

const hash = (f, o) => {
  let h = 0x811c9dc5;
  for (let c = 0; c < R; c++) h = Math.imul(h ^ f[o + c], 0x01000193);
  return h;
};
const same = (a, i, b, j) => { for (let c = 0; c < R; c++) if (a[i + c] !== b[j + c]) return false; return true; };

/** f, prev — Int32Array кадров (prev может быть null — тогда все записи новые). Возвращает Buffer. */
export function encodeFrame(f, prev, time = 0, rect = null) {
  const idx = new Map();
  if (prev) for (let o = prev.length - R; o >= 0; o -= R) idx.set(hash(prev, o), o); // при совпадении хешей — первая
  const n = f.length / R, ops = [], nw = [];
  let last = -2, run = 0;
  const flush = () => { if (run) { ops.push(run); run = 0; } };
  for (let o = 0; o < f.length; o += R) {
    let j = -1;
    if (prev) {
      // Сначала — следующая за последней скопированной (самый частый случай), потом — по хешу.
      const nx = (last + 1) * R;
      if (last >= 0 && nx < prev.length && same(f, o, prev, nx)) j = last + 1;
      else { const p = idx.get(hash(f, o)); if (p !== undefined && same(f, o, prev, p)) j = p / R; }
    }
    if (j < 0) { flush(); ops.push(0); for (let c = 0; c < R; c++) nw.push(f[o + c]); last = -2; continue; }
    if (j === last + 1 && last >= 0) run++;
    else { flush(); ops.push(-1 - j); }
    last = j;
  }
  flush();
  const m = nw.length / R, out = new Int32Array(9 + ops.length + R * m);
  let k = 0;
  out[k++] = MAGIC; out[k++] = Math.round(time) & 0x7fffffff;
  for (let i = 0; i < 4; i++) out[k++] = rect ? Math.round(rect[i] * 16) : 0;
  out[k++] = n; out[k++] = ops.length;
  for (const v of ops) out[k++] = v;
  out[k++] = m;
  for (let c = 0; c < R; c++) for (let i = 0; i < m; i++) out[k++] = (c === 1 || c === 2) && i ? nw[i * R + c] - nw[(i - 1) * R + c] : nw[i * R + c];
  return Buffer.from(out.buffer);
}

/** Обратное (для проверки; в браузере — такая же функция в render.html). */
export function decodeFrame(d, prev) {
  let k = 0;
  if (d[k++] !== MAGIC) return d;
  k += 5; // время, прямоугольник окна
  const n = d[k++], K = d[k++], opsAt = k; k += K;
  const m = d[k++], cols = k, f = new Int32Array(n * R);
  let o = 0, last = -2, ni = 0;
  const take = (j) => { for (let c = 0; c < R; c++) f[o + c] = prev[j * R + c]; o += R; last = j; };
  const px = [0, 0];
  for (let q = 0; q < K; q++) {
    const v = d[opsAt + q];
    if (v === 0) {
      for (let c = 0; c < R; c++) f[o + c] = d[cols + c * m + ni];
      if (ni) { f[o + 1] += px[0]; f[o + 2] += px[1]; }
      px[0] = f[o + 1]; px[1] = f[o + 2]; ni++; o += R; last = -2;
    } else if (v < 0) take(-1 - v);
    else for (let t = 0; t < v; t++) take(last + 1);
  }
  return f;
}
