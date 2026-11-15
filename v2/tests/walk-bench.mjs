#!/usr/bin/env node
// Замер ходьбы по критерию раздела 4.4 ТЗ: набор из N переходов по текущей базе.
// «Встроенная ходьба не справилась», если доходит меньше 95% или средняя длина пути больше 1,3 прямой.
//   node walk-bench.mjs [N=50] [seed=1] [resolution=0] [speed=4]
import { call, lua, admin } from './lib.mjs';

const N = Number(process.argv[2] || 50), SEED = Number(process.argv[3] || 1), RES = Number(process.argv[4] || 0), SPEED = Number(process.argv[5] || 4);
const TOKEN = 't-b1';

// Точки — свободные места вплотную к случайным постройкам команды (плотная часть базы).
const points = await lua(`
  local s = game.surfaces.nauvis
  local seed = A.seed
  local function rnd() seed = (seed * 1103515245 + 12345) % 2147483648 return seed / 2147483648 end
  local all = s.find_entities_filtered{force = 'player'}
  local list = {}
  for _, e in pairs(all) do if e.type ~= 'character' and e.unit_number and e.type ~= 'entity-ghost' then list[#list + 1] = e end end
  table.sort(list, function(a, b) return a.unit_number < b.unit_number end)
  local out = {}
  local guard = 0
  while #out < A.n and guard < 20000 do
    guard = guard + 1
    local e = list[math.floor(rnd() * #list) + 1]
    local b = e.bounding_box
    local side = math.floor(rnd() * 4)
    local t = rnd()
    local m = 0.4 + rnd() * 1.2
    local x, y
    if side == 0 then x, y = b.left_top.x + (b.right_bottom.x - b.left_top.x) * t, b.left_top.y - m
    elseif side == 1 then x, y = b.left_top.x + (b.right_bottom.x - b.left_top.x) * t, b.right_bottom.y + m
    elseif side == 2 then x, y = b.left_top.x - m, b.left_top.y + (b.right_bottom.y - b.left_top.y) * t
    else x, y = b.right_bottom.x + m, b.left_top.y + (b.right_bottom.y - b.left_top.y) * t end
    x, y = math.floor(x * 4 + 0.5) / 4, math.floor(y * 4 + 0.5) / 4
    if not s.entity_prototype_collides('character', {x, y}, false) then out[#out + 1] = {x = x, y = y, near = e.name} end
  end
  return {points = out, entities = #list}
`, { n: N + 1, seed: SEED });
console.log(`построек команды: ${points.entities}, точек: ${points.points.length}, resolution ${RES}, скорость игры ×${SPEED}`);

await admin.command(`/silent-command game.speed = ${SPEED}`);
const P = points.points;
// Встать в первую точку (не считается).
let r = await call(TOKEN, 'walk_to', { x: P[0].x, y: P[0].y, wait_s: 110, resolution: RES, stop_on_damage: false });
console.log('старт:', JSON.stringify(r).slice(0, 200));
const rows = [];
for (let i = 1; i < P.length; i++) {
  const st = await call(TOKEN, 'status');
  const from = st.position;
  r = await call(TOKEN, 'walk_to', { x: P[i].x, y: P[i].y, wait_s: 110, resolution: RES, stop_on_damage: false });
  while (r.running) r = (await call(TOKEN, 'wait_action', { action_id: r.action_id, wait_s: 110 })).actions[0], r = r.state === 'running' ? { running: true, action_id: r.action_id } : (r.state === 'done' ? { ok: true, ...r.result } : { ok: false, error: r.error });
  const d = r.ok ? r : r.error.data || {};
  const straight = Math.hypot(P[i].x - from.x, P[i].y - from.y);
  rows.push({ i, ok: r.ok, code: r.ok ? '' : r.error.code, from, to: P[i], straight, path: d.path_length, walked: d.walked, left: d.left });
  console.log(`${String(i).padStart(2)} ${r.ok ? 'дошёл ' : ('НЕТ ' + r.error.code).padEnd(6)} (${from.x.toFixed(1)}, ${from.y.toFixed(1)}) → (${P[i].x}, ${P[i].y}) у ${P[i].near}: прямая ${straight.toFixed(1)}, путь ${d.path_length ?? '—'}, пройдено ${d.walked ?? '—'}${r.ok ? '' : ', осталось ' + d.left}`);
}
await admin.command('/silent-command game.speed = 1');
const ok = rows.filter((x) => x.ok);
const ratioPath = ok.filter((x) => x.straight > 3).map((x) => x.path / x.straight);
const ratioWalk = ok.filter((x) => x.straight > 3).map((x) => x.walked / x.straight);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sum = (k) => ok.reduce((s, x) => s + x[k], 0);
console.log(`\nИтог: дошёл ${ok.length} из ${rows.length} (${(100 * ok.length / rows.length).toFixed(0)}%)`);
console.log(`длина найденного пути / прямая: среднее по переходам ${mean(ratioPath).toFixed(3)}, по сумме ${(sum('path') / sum('straight')).toFixed(3)}, худшее ${Math.max(...ratioPath).toFixed(2)}`);
console.log(`пройдено / прямая: среднее ${mean(ratioWalk).toFixed(3)}, по сумме ${(sum('walked') / sum('straight')).toFixed(3)}`);
const fails = {};
for (const x of rows) if (!x.ok) fails[x.code] = (fails[x.code] || 0) + 1;
console.log('отказы:', JSON.stringify(fails));
console.log(`критерий 4.4: ${ok.length / rows.length >= 0.95 && mean(ratioPath) <= 1.3 ? 'ВЫПОЛНЕН' : 'НЕ ВЫПОЛНЕН'}`);
admin.close();
