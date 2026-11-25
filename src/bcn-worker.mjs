// Поток распаковки атласов для src/map-render.mjs.
import { parentPort } from 'node:worker_threads';
import { decodeYCoCgAtlas, decodeBC4Mask, decodeBC3, decodeBC1 } from './bcn.mjs';

parentPort.on('message', ({ id, raw, w, h, fmt2 }) => {
  const src = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  let rgba = decodeYCoCgAtlas(src, w, h);
  const nb = Math.ceil(w / 4) * Math.ceil(h / 4);
  // Полбайта на пиксель: BC1 — земля (у игры признак формата 8), BC4 — тени (0xa).
  if (!rgba && src.length === nb * 8) rgba = fmt2 === 8 ? decodeBC1(src, w, h) : decodeBC4Mask(src, w, h);
  if (!rgba && src.length === nb * 16) rgba = decodeBC3(src, w, h);      // байт на пиксель — BC3 (дым и т. п.)
  const out = rgba ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length) : null;
  parentPort.postMessage({ id, rgba: out }, out ? [out.buffer] : []);
});
