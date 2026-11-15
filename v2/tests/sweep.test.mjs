#!/usr/bin/env node
// Сплошной прогон по видам построек: ни один запрос и ни одно действие не должны кончаться внутренней ошибкой
// (обращение к полю, которого у этого вида построек нет).
import { call, lua, admin } from './lib.mjs';
import { test, ok, eq, run } from './harness.mjs';

const A = 't-b8', NAME = 'bench-8';
await call(A, 'status');
const O = await lua(`
  local s = game.surfaces.nauvis
  for r = 3, 40 do for _, c in pairs{{-r, r}, {r, r}, {0, r}, {-r, 0}, {r, 0}, {-r, -r}, {r, -r}, {0, -r}} do
    local x, y = c[1] * 16, c[2] * 16
    local area = {{x - 2, y - 2}, {x + 62, y + 32}}
    if s.count_entities_filtered{area = area} == 0 and s.count_tiles_filtered{area = area, collision_mask = 'player'} == 0
      and game.forces.player.is_chunk_charted(s, {math.floor(x / 32), math.floor(y / 32)}) then
      return {x = x, y = y}
    end
  end end
  error('нет чистой площадки')`);
const internal = (r) => JSON.stringify(r).includes('"internal"');

// Все предметы, которые ставятся как постройка 1…5 клеток: по одной постройке каждого вида на площадке.
const placed = await lua(`
  local s = game.surfaces.nauvis
  local e = storage.agent.agents[A.name].entity
  for _, x in pairs(s.find_entities_filtered{area = {{A.x - 2, A.y - 2}, {A.x + 62, A.y + 32}}}) do if x ~= e and x.type ~= 'character' then x.destroy() end end
  e.teleport({A.x + 30.5, A.y + 31.5})
  e.clear_items_inside()
  local out, col, row = {}, 0, 0
  local names = {}
  for name, ip in pairs(prototypes.item) do
    local pr = ip.place_result
    if pr and not ip.hidden and pr.tile_width <= 5 and pr.tile_height <= 5 and pr.type ~= 'character' then names[#names + 1] = name end
  end
  table.sort(names)
  for _, name in ipairs(names) do
    local pr = prototypes.item[name].place_result
    local x, y = A.x + 2 + col * 6 + pr.tile_width / 2, A.y + 2 + row * 6 + pr.tile_height / 2
    local okc, ent = pcall(s.create_entity, {name = pr.name, position = {x, y}, force = 'player', raise_built = true})
    if okc and ent and ent.valid then
      out[#out + 1] = {item = name, name = ent.name, type = ent.type, x = ent.position.x, y = ent.position.y}
      col = col + 1
      if col >= 9 then col, row = 0, row + 1 end
      if row >= 5 then break end
    end
  end
  return out`, { name: NAME, x: O.x, y: O.y });
console.log(`  на площадке ${placed.length} видов построек`);

test('inspect и area с подробностями: все виды построек без внутренних ошибок', async () => {
  const bad = [];
  for (const p of placed) {
    const r = await call(A, 'inspect', { target: { x: p.x, y: p.y } });
    if (!r.ok || !r.found) bad.push(`${p.name}: ${JSON.stringify(r).slice(0, 200)}`);
  }
  eq(bad, [], 'inspect');
  for (let i = 0; i < 2; i++) {
    const r = await call(A, 'area', { area: { x1: O.x, y1: O.y + i * 16, x2: O.x + 60, y2: O.y + 16 + i * 16 }, objects: true, details: true, limit: 2000 });
    ok(r.ok && !internal(r), JSON.stringify(r).slice(0, 300));
  }
  const f = await call(A, 'find', { names: placed.map((p) => p.name), radius: 80 });
  ok(f.ok && f.total >= placed.length, JSON.stringify(f).slice(0, 200));
});

test('inspect: по одной постройке каждого вида на всей базе и вокруг', async () => {
  const all = await lua(`
    local s = game.surfaces.nauvis
    local seen, out = {}, {}
    for _, e in pairs(s.find_entities_filtered{area = {{-250, -250}, {250, 250}}}) do
      if not seen[e.name] then
        seen[e.name] = true
        out[#out + 1] = {x = e.position.x, y = e.position.y, name = e.name}
      end
    end
    return out`);
  const bad = [];
  for (let i = 0; i < all.length; i += 100) {
    const r = await call(A, 'inspect', { targets: all.slice(i, i + 100) });
    if (!r.ok) bad.push(JSON.stringify(r).slice(0, 300));
  }
  eq(bad, []);
  console.log(`      (видов объектов на базе: ${all.length})`);
});

test('transfer и configure на каждом виде построек: отказ допустим, внутренняя ошибка — нет', async () => {
  await lua(`local e = storage.agent.agents[A.name].entity e.clear_items_inside() for _, n in pairs{'coal', 'iron-plate', 'firearm-magazine', 'automation-science-pack', 'speed-module', 'iron-ore'} do e.insert{name = n, count = 50} end return true`, { name: NAME });
  const bad = [];
  for (const p of placed) {
    const t = { x: p.x, y: p.y };
    const calls = [
      ['transfer', { target: t, direction: 'put', item: 'coal', count: 1, approach: true }],
      ['transfer', { target: t, direction: 'put', item: 'iron-plate', count: 1 }],
      ['transfer', { target: t, direction: 'put', item: 'firearm-magazine', count: 1, inventory: 'ammo' }],
      ['transfer', { target: t, direction: 'put', item: 'speed-module', count: 1, inventory: 'modules' }],
      ['transfer', { target: t, direction: 'take' }],
      ['transfer', { target: t, direction: 'take', inventory: 'fuel' }],
      ['configure', { target: t, direction: 'east' }],
      ['configure', { target: t, rotate: true }],
      ['configure', { target: t, filters: ['iron-plate'] }],
      ['configure', { target: t, bar: 3 }],
      ['configure', { target: t, recipe: 'iron-gear-wheel' }],
      ['configure', { target: t, control: { circuit_enable_disable: true } }],
      ['inspect', { target: t }],
    ];
    for (const [op, body] of calls) {
      const r = await call(A, op, body);
      if (internal(r)) bad.push(`${p.name} ${op} ${JSON.stringify(body).slice(0, 80)}: ${r.error?.message}`);
    }
  }
  eq(bad, []);
});

test('провода и копирование настроек между постройками', async () => {
  const poles = placed.filter((p) => p.type === 'electric-pole').slice(0, 2);
  const ins = placed.filter((p) => p.type === 'inserter').slice(0, 2);
  const chests = placed.filter((p) => p.type === 'container').slice(0, 2);
  const tries = [];
  if (ins.length === 2) tries.push(['configure', { target: ins[0], wire: { to: ins[1], type: 'red' } }], ['configure', { target: ins[0], copy_from: ins[1] }], ['configure', { target: ins[0], wire: { to: ins[1], type: 'red', disconnect: true } }]);
  if (poles.length === 2) tries.push(['configure', { target: poles[0], wire: { to: poles[1], type: 'copper' } }]);
  if (chests.length === 2) tries.push(['configure', { target: chests[0], wire: { to: chests[1], type: 'green' } }]);
  const bad = [];
  for (const [op, body] of tries) {
    const b = { ...body, target: { x: body.target.x, y: body.target.y }, approach: true };
    if (b.wire) b.wire = { ...b.wire, to: { x: body.wire.to.x, y: body.wire.to.y } };
    if (b.copy_from) b.copy_from = { x: body.copy_from.x, y: body.copy_from.y };
    const r = await call(A, op, b);
    if (internal(r)) bad.push(`${op} ${JSON.stringify(b).slice(0, 120)}: ${r.error?.message}`);
  }
  eq(bad, []);
});

test('mine и place каждого вида построек: снять в инвентарь и поставить обратно', async () => {
  const bad = [];
  let done = 0;
  for (const p of placed) {
    await lua(`storage.agent.agents[A.name].entity.clear_items_inside() return true`, { name: NAME });
    const m = await call(A, 'mine', { target: { x: p.x, y: p.y }, approach: true, wait_s: 40 });
    if (internal(m)) { bad.push(`mine ${p.name}: ${m.error?.message}`); continue; }
    if (!m.ok) continue; // не снимается руками — допустимо
    const r = await call(A, 'place', { item: p.item, x: p.x, y: p.y, approach: true, wait_s: 40 });
    if (internal(r)) bad.push(`place ${p.item}: ${r.error?.message}`);
    else if (r.ok) done++;
  }
  eq(bad, []);
  console.log(`      (снято и поставлено обратно: ${done} из ${placed.length})`);
  ok(done > placed.length * 0.6, 'большинство построек снимается и ставится');
});

test('подземные конвейеры и трубы: пара, осмотр, чертёж', async () => {
  await lua(`local e = storage.agent.agents[A.name].entity e.clear_items_inside() e.insert{name = 'underground-belt', count = 4} e.insert{name = 'pipe-to-ground', count = 2} e.insert{name = 'splitter', count = 1} e.teleport({A.x + 30.5, A.y + 29.5}) return true`, { name: NAME, x: O.x, y: O.y });
  const y = O.y + 31.5;
  const r = await call(A, 'place', { items: [
    { item: 'underground-belt', x: O.x + 26.5, y, direction: 'east' }, { item: 'underground-belt', x: O.x + 30.5, y, direction: 'east' },
    { item: 'pipe-to-ground', x: O.x + 34.5, y, direction: 'west' }, { item: 'pipe-to-ground', x: O.x + 38.5, y, direction: 'east' },
    { item: 'splitter', x: O.x + 36, y: y - 2, direction: 'north' },
  ] });
  ok(r.ok && r.done === 5 && !internal(r), JSON.stringify(r));
  ok(r.items[0].underground === 'input' && r.items[1].underground === 'output' && r.items[1].paired_with, JSON.stringify(r.items.slice(0, 2)));
  const i = await call(A, 'inspect', { targets: r.items.map((p) => ({ x: p.x, y: p.y })) });
  ok(i.ok && i.objects.every((o) => o.found) && i.objects[0].paired_with, JSON.stringify(i).slice(0, 400));
  const cap = await call(A, 'blueprint_capture', { name: 'sweep-ug', area: { x1: O.x + 25, y1: O.y + 28, x2: O.x + 43, y2: O.y + 33 } });
  ok(cap.ok && cap.entities === 5, JSON.stringify(cap));
  const chk = await call(A, 'blueprint_check', { blueprint: 'sweep-ug', x: O.x + 2, y: O.y + 2, rotation: 90, flip: 'h' });
  ok(chk.ok && !internal(chk), JSON.stringify(chk).slice(0, 300));
  await call(A, 'blueprint_delete', { name: 'sweep-ug' });
});

run(async () => {
  await lua(`local s = game.surfaces.nauvis for _, x in pairs(s.find_entities_filtered{area = {{A.x - 2, A.y - 2}, {A.x + 62, A.y + 34}}}) do if x.type ~= 'character' then x.destroy() end end return true`, O);
  admin.close();
});
