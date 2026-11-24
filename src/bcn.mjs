// Распаковка блочного сжатия текстур (BC1 цвет, BC3/BC4 одноканальный блок) — для атласов игры, которые клиент держит
// в памяти сжатыми. Блок — 4×4 пикселя.

/** BC4 (он же альфа-блок BC3): 8 байт -> 16 значений 0..255. */
export function bc4(src, o, out) {
  const a0 = src[o], a1 = src[o + 1], pal = [a0, a1, 0, 0, 0, 0, 0, 0];
  if (a0 > a1) for (let i = 1; i < 7; i++) pal[i + 1] = ((7 - i) * a0 + i * a1) / 7 | 0;
  else { for (let i = 1; i < 5; i++) pal[i + 1] = ((5 - i) * a0 + i * a1) / 5 | 0; pal[6] = 0; pal[7] = 255; }
  // 48 бит индексов по 3 бита
  let lo = src[o + 2] | (src[o + 3] << 8) | (src[o + 4] << 16), hi = src[o + 5] | (src[o + 6] << 8) | (src[o + 7] << 16);
  for (let i = 0; i < 8; i++) { out[i] = pal[lo & 7]; lo >>= 3; }
  for (let i = 8; i < 16; i++) { out[i] = pal[hi & 7]; hi >>= 3; }
}

/** Цветовой блок BC1 (8 байт) -> 16 пикселей RGB (out — 48 чисел); fourColor — всегда 4 цвета (как в BC3). */
export function bc1(src, o, out, fourColor = true) {
  const c0 = src[o] | (src[o + 1] << 8), c1 = src[o + 2] | (src[o + 3] << 8);
  const rgb = (c) => [((c >> 11) & 31) * 255 / 31 | 0, ((c >> 5) & 63) * 255 / 63 | 0, (c & 31) * 255 / 31 | 0];
  const p0 = rgb(c0), p1 = rgb(c1), pal = [p0, p1];
  if (fourColor || c0 > c1) { pal[2] = p0.map((v, i) => (2 * v + p1[i]) / 3 | 0); pal[3] = p0.map((v, i) => (v + 2 * p1[i]) / 3 | 0); }
  else { pal[2] = p0.map((v, i) => (v + p1[i]) / 2 | 0); pal[3] = [0, 0, 0]; }
  let bits = src[o + 4] | (src[o + 5] << 8) | (src[o + 6] << 16) | (src[o + 7] << 24);
  for (let i = 0; i < 16; i++) { const p = pal[bits & 3]; out[i * 3] = p[0]; out[i * 3 + 1] = p[1]; out[i * 3 + 2] = p[2]; bits >>>= 2; }
}

/**
 * Атлас клиента в памяти (CustomVideoBitmap, «высокое качество» сжатия): 24 байта на блок 4×4, две плоскости подряд —
 * сначала все блоки BC3 с цветом в YCoCg (яркость Y — в альфа-блоке, Co/Cg и масштаб — в цветовом), затем все блоки BC4
 * с прозрачностью. Возвращает RGBA w×h.
 */
export function decodeYCoCgAtlas(src, w, h) {
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), nb = bw * bh;
  if (src.length < nb * 24) return null;
  const out = Buffer.alloc(w * h * 4), y = new Array(16), c = new Array(48), a = new Array(16);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const b = by * bw + bx;
    bc4(src, b * 16, y); bc1(src, b * 16 + 8, c); bc4(src, nb * 16 + b * 8, a);
    for (let i = 0; i < 16; i++) {
      const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
      if (px >= w || py >= h) continue;
      const sc = c[i * 3 + 2] / 8 + 1, co = (c[i * 3] - 128) / sc, cg = (c[i * 3 + 1] - 128) / sc, Y = y[i], o = (py * w + px) * 4;
      const R = Y + co - cg, G = Y + cg, B = Y - co - cg;
      out[o] = R < 0 ? 0 : R > 255 ? 255 : R; out[o + 1] = G < 0 ? 0 : G > 255 ? 255 : G; out[o + 2] = B < 0 ? 0 : B > 255 ? 255 : B; out[o + 3] = a[i];
    }
  }
  return out;
}

/** Маска BC4 (8 байт на блок 4×4, один канал) -> RGBA: чёрный цвет, канал — прозрачность (тени). */
export function decodeBC4Mask(src, w, h) {
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), out = Buffer.alloc(w * h * 4), a = new Array(16);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    bc4(src, (by * bw + bx) * 8, a);
    for (let i = 0; i < 16; i++) {
      const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
      if (px < w && py < h) out[(py * w + px) * 4 + 3] = a[i];
    }
  }
  return out;
}

/** BC3 (DXT5): 16 байт на блок 4×4 — альфа-блок (как BC4), затем цветовой блок BC1. Возвращает RGBA. */
export function decodeBC3(src, w, h) {
  const bw = Math.ceil(w / 4), bh = Math.ceil(h / 4), out = Buffer.alloc(w * h * 4), a = new Array(16), c = new Array(48);
  for (let by = 0; by < bh; by++) for (let bx = 0; bx < bw; bx++) {
    const b = (by * bw + bx) * 16;
    bc4(src, b, a); bc1(src, b + 8, c);
    for (let i = 0; i < 16; i++) {
      const px = bx * 4 + (i & 3), py = by * 4 + (i >> 2);
      if (px >= w || py >= h) continue;
      const o = (py * w + px) * 4;
      out[o] = c[i * 3]; out[o + 1] = c[i * 3 + 1]; out[o + 2] = c[i * 3 + 2]; out[o + 3] = a[i];
    }
  }
  return out;
}
