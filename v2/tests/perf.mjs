#!/usr/bin/env node
// Цифры раздела 9 ТЗ: скорость ответа при 4 активных ботах, независимость ботов, нагрузка на игру при 8 персонажах.
//   node perf.mjs [speed|independence|ups|all]
import { call, lua, admin, sleep, pct } from './lib.mjs';

const what = process.argv[2] || 'all';
const T = (i) => `t-b${i}`;
const fmt = (a) => `медиана ${pct(a, 0.5).toFixed(1)} мс, p95 ${pct(a, 0.95).toFixed(1)} мс, макс ${Math.max(...a).toFixed(1)} мс (n=${a.length})`;

// Точки для прогулок: свободные места вокруг точки возрождения.
const spots = await lua(`
  local s = game.surfaces.nauvis
  local out = {}
  local seed = 7
  local function rnd() seed = (seed * 1103515245 + 12345) % 2147483648 return seed / 2147483648 end
  while #out < 40 do
    local x, y = math.floor(rnd() * 120 - 60) + 0.5, math.floor(rnd() * 120 - 20) + 0.5
    if not s.entity_prototype_collides('character', {x, y}, false) then out[#out + 1] = {x = x, y = y} end
  end
  return out`);

let walking = true;
async function wander(i) { // бот ходит по кругу точек, пока идёт замер
  let k = i * 5;
  while (walking) {
    const p = spots[k++ % spots.length];
    const r = await call(T(i), 'walk_to', { ...p, wait_s: 20, stop_on_damage: false });
    if (r.running) await call(T(i), 'clear');
  }
}

async function measure(token, op, body, n, gapMs = 0) {
  const ms = [];
  for (let i = 0; i < n; i++) {
    const r = await call(token, op, body);
    if (r.http !== 200) throw new Error(`${op}: ${JSON.stringify(r)}`);
    ms.push(r.ms);
    if (gapMs) await sleep(gapMs);
  }
  return ms;
}

await admin.command('/silent-command game.speed = 1');
const result = {};

if (what === 'speed' || what === 'all') {
  console.log('── Скорость: 4 бота ходят, каждый параллельно шлёт справочные запросы ──');
  walking = true;
  const walkers = [1, 2, 3, 4].map(wander);
  await sleep(1000);
  const all = (await Promise.all([1, 2, 3, 4].map((i) => measure(T(i), 'status', {}, 150, 20)))).flat();
  console.log('status при 4 активных ботах:', fmt(all));
  const inst = (await Promise.all([5, 6].map((i) => measure(T(i), 'say', { text: 'замер' }, 30, 30)))).flat();
  console.log('мгновенное действие (say):   ', fmt(inst));
  result.speed = { p50: pct(all, 0.5), p95: pct(all, 0.95), ok: pct(all, 0.5) <= 100 && pct(all, 0.95) <= 300 };
  walking = false;
  await Promise.all(walkers);
}

if (what === 'independence' || what === 'all') {
  console.log('── Независимость: 500 справочных запросов бота 1 против бота 2 ──');
  const before = await measure(T(2), 'status', {}, 100, 10);
  // ходьба бота 2 без нагрузки
  const a = spots[3], b = spots[11];
  await call(T(2), 'walk_to', { ...a, wait_s: 100, stop_on_damage: false });
  const w0 = await call(T(2), 'walk_to', { ...b, wait_s: 100, stop_on_damage: false });
  await call(T(2), 'walk_to', { ...a, wait_s: 100, stop_on_damage: false });
  // серия: 500 запросов бота 1 без пауз (и ещё 4 потока параллельно — хуже, чем в требовании)
  let flood = true;
  const floodMs = [];
  const flooder = async () => { while (flood) { const r = await call(T(1), 'status'); floodMs.push(r.ms); } };
  const fl = [flooder(), flooder(), flooder(), flooder()];
  const during = await measure(T(2), 'status', {}, 100, 10);
  const w1 = await call(T(2), 'walk_to', { ...b, wait_s: 100, stop_on_damage: false });
  flood = false;
  await Promise.all(fl);
  console.log(`бот 2 без нагрузки:        ${fmt(before)}`);
  console.log(`бот 2 во время серии:      ${fmt(during)}`);
  console.log(`серия бота 1: ${floodMs.length} запросов, ${fmt(floodMs)}`);
  const stat = await call('t-admin', 'metrics');
  console.log(`ходьба бота 2: без нагрузки пройдено ${w0.walked} (ok=${w0.ok}), под нагрузкой ${w1.walked} (ok=${w1.ok})`);
  result.independence = { ratio: pct(during, 0.5) / pct(before, 0.5), walk_same: w0.ok && w1.ok && Math.abs(w0.walked - w1.walked) < 1 };
  console.log(`медиана выросла в ${result.independence.ratio.toFixed(2)} раза (допустимо не больше 2)`);
}

if (what === 'ups' || what === 'all') {
  console.log('── Нагрузка на игру: 8 персонажей ходят одновременно ──');
  const tick = async () => (await lua('return {tick = game.tick}')).tick;
  let t0 = await tick(), w0 = Date.now();
  await sleep(5000);
  let t1 = await tick(), w1 = Date.now();
  const idle = (t1 - t0) / ((w1 - w0) / 1000);
  walking = true;
  const walkers = [1, 2, 3, 4, 5, 6, 7, 8].map(wander);
  await sleep(1000);
  t0 = await tick(); w0 = Date.now();
  await sleep(10000);
  t1 = await tick(); w1 = Date.now();
  const busy = (t1 - t0) / ((w1 - w0) / 1000);
  walking = false;
  await Promise.all(walkers);
  console.log(`обновлений в секунду: без действий ${idle.toFixed(1)}, при 8 идущих ботах ${busy.toFixed(1)}`);
  result.ups = { idle, busy, ok: busy >= 59.5 };
}
console.log(JSON.stringify(result));
admin.close();
