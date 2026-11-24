// Поток распаковки атласов для src/map-render.mjs.
import { parentPort } from 'node:worker_threads';
import { decodeYCoCgAtlas, decodeBC4Mask, decodeBC3 } from './bcn.mjs';

parentPort.on('message', ({ id, raw, w, h }) => {
  const src = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  let rgba = decodeYCoCgAtlas(src, w, h);
  const nb = Math.ceil(w / 4) * Math.ceil(h / 4);
  if (!rgba && src.length === nb * 8) rgba = decodeBC4Mask(src, w, h); // тени на видеокарте — BC4 (полбайта на пиксель)
  if (!rgba && src.length === nb * 16) rgba = decodeBC3(src, w, h);      // байт на пиксель — BC3 (дым и т. п.)
  const out = rgba ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length) : null;
  parentPort.postMessage({ id, rgba: out }, out ? [out.buffer] : []);
});
