#!/usr/bin/env node
// Разведка: ходьба со стартом у кромки воды и вплотную к постройке (сцена: вода y>=-146, насос у (-148.5,-146.5)).
import { call, lua } from './lib.mjs';
const A = 't-b1';
const cases = JSON.parse(process.argv[2]);
const extra = process.argv[3] ? JSON.parse(process.argv[3]) : {};
await call(A, 'status');
for (const [x, y, gx, gy] of cases) {
  const p = await lua(`local e = storage.agent.agents['bench-1'].entity local ok = e.teleport({A.x, A.y}) return {ok, e.position.x, e.position.y, e.surface.entity_prototype_collides('character', e.position, false)}`, { x, y });
  const r = await call(A, 'walk_to', { x: gx, y: gy, ...extra });
  console.log(JSON.stringify(p), '->', gx, gy, r.ok, r.ok ? JSON.stringify(r.position) + ' walked ' + r.walked + ' ms ' + Math.round(r.ms) : r.error.code + ' ' + r.error.message + ' ms ' + Math.round(r.ms));
}
process.exit(0);
