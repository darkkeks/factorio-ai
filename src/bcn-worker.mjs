// Поток распаковки атласов для src/map-v2.mjs.
import { parentPort } from 'node:worker_threads';
import { decodeYCoCgAtlas } from './bcn.mjs';

parentPort.on('message', ({ id, raw, w, h }) => {
  const src = Buffer.from(raw.buffer, raw.byteOffset, raw.length);
  let rgba = decodeYCoCgAtlas(src, w, h);
  if (!rgba && src.length === w * h) {
    // Один байт на пиксель — маска (тени): чёрный цвет с этой прозрачностью.
    rgba = Buffer.alloc(w * h * 4);
    for (let p = 0; p < src.length; p++) rgba[p * 4 + 3] = src[p];
  }
  const out = rgba ? new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.length) : null;
  parentPort.postMessage({ id, rgba: out }, out ? [out.buffer] : []);
});
