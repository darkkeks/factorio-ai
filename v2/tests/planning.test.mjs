#!/usr/bin/env node
// Планирование: призраки, чертежи, пометки на снос и замену, проверка без постановки, перенос, контрольная задача.
import { call, lua, admin, sleep } from './lib.mjs';
import { test, ok, eq, run } from './harness.mjs';

const A = 't-b4', NAME = 'bench-4', B = 't-b5';
const O = await lua(`
  local s = game.surfaces.nauvis
  for r = 3, 40 do for _, c in pairs{{r, -r}, {-r, -r}, {0, -r}, {r, 0}, {-r, 0}, {r, r}, {-r, r}, {0, r}} do
    local x, y = c[1] * 16, c[2] * 16
    local area = {{x - 2, y - 2}, {x + 62, y + 32}}
    if s.count_entities_filtered{area = area, type = 'character', invert = true} == 0 and s.count_tiles_filtered{area = area, collision_mask = 'player'} == 0
      and game.forces.player.is_chunk_charted(s, {math.floor(x / 32), math.floor(y / 32)}) then
      return {x = x, y = y}
    end
  end end
  error('нет чистой площадки')`);
await call(A, 'status'); await call(B, 'status');
const reset = (items = {}, dx = 30.5, dy = 15.5) => lua(`
  local s = game.surfaces.nauvis
  local e = storage.agent.agents[A.name].entity
  for _, x in pairs(s.find_entities_filtered{area = {{A.x - 2, A.y - 2}, {A.x + 62, A.y + 32}}}) do
    if x ~= e and x.type ~= 'character' then x.destroy() end
  end
  e.teleport({A.x + A.dx, A.y + A.dy})
  e.clear_items_inside()
  for name, n in pairs(A.items) do e.insert{name = name, count = n} end
  return true`, { name: NAME, x: O.x, y: O.y, dx, dy, items });
const P = (dx, dy) => ({ x: O.x + dx, y: O.y + dy });
const world = (code, args = {}) => lua(code, { ...args, ox: O.x, oy: O.y });
const count = (filter) => world(`local f = A.f f.area = {{A.ox - 2, A.oy - 2}, {A.ox + 62, A.oy + 32}} return {n = game.surfaces.nauvis.count_entities_filtered(f)}`, { f: filter }).then((r) => r.n);

test('ghost_place списком: призраки с именем плана, стоимость и нехватка; досягаемость не нужна', async () => {
  await reset({ 'stone-furnace': 1 }, 2.5, 2.5);
  const r = await call(A, 'ghost_place', { plan: 't-plan', items: [
    { name: 'stone-furnace', ...P(50, 20) }, { name: 'stone-furnace', ...P(52, 20) }, { item: 'inserter', ...P(50.5, 21.5), direction: 'north' },
  ] });
  ok(r.ok && r.placed === 3 && r.cost['stone-furnace'] === 2 && r.missing['stone-furnace'] === 1 && r.missing.inserter === 1, JSON.stringify(r));
  eq(await count({ type: 'entity-ghost' }), 3);
  const g = await call(A, 'ghosts', { plan: 't-plan' });
  ok(g.ok && g.ghosts === 3 && g.items.length === 3 && g.items.every((i) => i.plan === 't-plan'), JSON.stringify(g));
  const list = await call(A, 'ghosts');
  ok(list.plans.some((p) => p.name === 't-plan' && p.left === 3 && p.by === NAME), JSON.stringify(list));
});

test('чужой план менять нельзя, строить можно; ghost_clear убирает свой план', async () => {
  let r = await call(B, 'ghost_place', { plan: 't-plan', items: [{ name: 'wooden-chest', ...P(40.5, 5.5) }] });
  ok(!r.ok && r.error.code === 'not_allowed', JSON.stringify(r));
  r = await call(B, 'ghost_clear', { plan: 't-plan' });
  ok(!r.ok && r.error.code === 'not_allowed', JSON.stringify(r));
  r = await call(A, 'ghost_clear', { plan: 't-plan' });
  ok(r.ok && r.removed === 3, JSON.stringify(r));
  eq(await count({ type: 'entity-ghost' }), 0);
});

test('build_ghosts по плану с подходом; настройки призрака (рецепт) сохраняются', async () => {
  await reset({ 'assembling-machine-1': 1, inserter: 2, 'transport-belt': 6 }, 2.5, 2.5);
  const items = [{ name: 'assembling-machine-1', ...P(40.5, 15.5), recipe: 'iron-gear-wheel' }, { name: 'inserter', ...P(38.5, 15.5), direction: 'west' }, { name: 'inserter', ...P(42.5, 15.5), direction: 'west' }];
  for (let i = 0; i < 6; i++) items.push({ name: 'transport-belt', ...P(37.5, 13.5 + i), direction: 'south' });
  await call(A, 'ghost_place', { plan: 'asm', items });
  const r = await call(A, 'build_ghosts', { plan: 'asm', approach: true, wait_s: 60 });
  ok(r.ok && r.done === 9 && r.skipped === 0, JSON.stringify(r).slice(0, 500));
  const m = await world(`local m = game.surfaces.nauvis.find_entity('assembling-machine-1', {A.ox + 40.5, A.oy + 15.5}) return {r = m and m.get_recipe() and m.get_recipe().name}`);
  eq(m.r, 'iron-gear-wheel');
  const list = await call(A, 'ghosts', { plan: 'asm' });
  eq(list.total, 0);
});

test('чертёж: сохранить из списка, получить, повернуть, проверить без постановки, поставить', async () => {
  await reset({}, 2.5, 2.5);
  const s = await call(A, 'blueprint_save', { name: 'pair', entities: [{ name: 'stone-furnace', x: 101, y: 51 }, { name: 'inserter', x: 102.5, y: 50.5, direction: 'east' }, { name: 'wooden-chest', x: 103.5, y: 50.5 }] });
  ok(s.ok && s.w === 4 && s.h === 2 && s.entities === 3 && s.cost['stone-furnace'] === 1, JSON.stringify(s));
  const g = await call(A, 'blueprint_get', { name: 'pair' });
  eq(g.items.map((i) => [i.name, i.x, i.y]), [['stone-furnace', 1, 1], ['inserter', 2.5, 0.5], ['wooden-chest', 3.5, 0.5]]);
  const g90 = await call(A, 'blueprint_get', { name: 'pair', rotation: 90 });
  ok(g90.w === 2 && g90.h === 4, JSON.stringify(g90));
  eq(g90.items.find((i) => i.name === 'inserter').direction, 'south');
  const chk = await call(A, 'blueprint_check', { blueprint: 'pair', ...P(20, 10) });
  ok(chk.ok && chk.will_place === 3 && chk.blocked === 0 && chk.missing['stone-furnace'] === 1, JSON.stringify(chk));
  eq(await count({ type: 'entity-ghost' }), 0, 'проверка ничего не ставит');
  const r = await call(A, 'ghost_place', { blueprint: 'pair', ...P(20, 10), plan: 'bp-1' });
  ok(r.ok && r.placed === 3, JSON.stringify(r));
  const at = await world(`local t = {} for _, g in pairs(game.surfaces.nauvis.find_entities_filtered{type = 'entity-ghost', area = {{A.ox + 19, A.oy + 9}, {A.ox + 26, A.oy + 14}}}) do t[#t + 1] = g.ghost_name .. '@' .. (g.position.x - A.ox) .. ',' .. (g.position.y - A.oy) end table.sort(t) return t`);
  eq(at, ['inserter@22.5,10.5', 'stone-furnace@21,11', 'wooden-chest@23.5,10.5'], 'северо-западный угол чертежа встал в заданную клетку');
  const r2 = await call(A, 'ghost_place', { blueprint: 'pair', ...P(30, 10), rotation: 90, flip: 'h' });
  ok(r2.ok && r2.placed === 3 && r2.size.w === 2 && r2.size.h === 4, JSON.stringify(r2));
});

test('строка чертежа: экспорт, импорт под другим именем, книга', async () => {
  const e = await call(A, 'blueprint_export', { name: 'pair' });
  ok(e.ok && e.string.startsWith('0'), JSON.stringify(e).slice(0, 100));
  const i = await call(A, 'blueprint_import', { name: 'pair-copy', string: e.string, team: true });
  ok(i.ok && i.saved[0].entities === 3 && i.saved[0].owner === 'team', JSON.stringify(i));
  const seen = await call(B, 'blueprint_list');
  ok(seen.blueprints.some((b) => b.name === 'pair-copy' && b.owner === 'team') && !seen.blueprints.some((b) => b.name === 'pair'), 'общий виден другому боту, личный — нет');
  const book = await call(A, 'blueprint_export', { names: ['pair', 'pair-copy'], book: 'тест' });
  ok(book.ok && book.blueprints === 2);
  const bi = await call(A, 'blueprint_import', { name: 'book', string: book.string });
  eq(bi.saved.map((s) => s.name).sort(), ['book/pair', 'book/pair-copy']);
  eq((await call(B, 'blueprint_delete', { name: 'pair-copy' })).error.code, 'not_allowed');
  ok((await call(A, 'blueprint_delete', { name: 'pair-copy' })).ok);
});

test('проверка без постановки показывает, что во что упирается; superforced помечает мешающее на снос', async () => {
  await reset({}, 2.5, 2.5);
  await world(`local s = game.surfaces.nauvis s.create_entity{name = 'wooden-chest', position = {A.ox + 21.5, A.oy + 10.5}, force = 'player'} s.create_entity{name = 'tree-01', position = {A.ox + 23.5, A.oy + 10.5}} return true`);
  const chk = await call(A, 'blueprint_check', { blueprint: 'pair', ...P(20, 10) });
  ok(chk.blocked === 2 && chk.blocked_items.some((b) => b.by.includes('wooden-chest')) && chk.blocked_items.some((b) => b.nature), JSON.stringify(chk));
  const n = await call(A, 'ghost_place', { blueprint: 'pair', ...P(20, 10), mode: 'normal' });
  ok(!n.ok && n.error.code === 'blocked', JSON.stringify(n));
  const r = await call(A, 'ghost_place', { blueprint: 'pair', ...P(20, 10), mode: 'superforced', plan: 'sf' });
  ok(r.ok && r.placed === 3 && r.marked_deconstruct === 2, JSON.stringify(r));
  const g = await call(A, 'ghosts', { plan: 'sf' });
  ok(g.ghosts === 3 && g.deconstruct === 2, JSON.stringify(g));
});

test('пометка на снос и снос помеченного; пометка на замену и замена на месте', async () => {
  await reset({ 'fast-transport-belt': 5 }, 22.5, 12.5);
  await world(`local s = game.surfaces.nauvis for i = 0, 4 do s.create_entity{name = 'transport-belt', position = {A.ox + 20.5 + i, A.oy + 10.5}, direction = defines.direction.east, force = 'player'} end for i = 0, 2 do s.create_entity{name = 'wooden-chest', position = {A.ox + 20.5 + i, A.oy + 14.5}, force = 'player'} end s.create_entity{name = 'tree-01', position = {A.ox + 25.5, A.oy + 14.5}} return true`);
  const area = { x1: O.x + 19, y1: O.y + 9, x2: O.x + 27, y2: O.y + 16 };
  let r = await call(A, 'mark_upgrade', { area, from: 'transport-belt', to: 'fast-transport-belt', plan: 'up' });
  ok(r.ok && r.marked === 5, JSON.stringify(r));
  r = await call(A, 'mark_deconstruct', { area, names: ['wooden-chest', 'tree'], plan: 'down' });
  ok(r.ok && r.marked === 4 && r.by_name['wooden-chest'] === 3, JSON.stringify(r));
  const un = await call(A, 'mark_deconstruct', { targets: [P(25.5, 14.5)], cancel: true, names: ['tree'] });
  eq(un.unmarked, 1);
  r = await call(A, 'build_ghosts', { area });
  ok(r.ok && r.done === 5 && r.items.every((i) => i.upgrade && i.replaced === 'transport-belt'), JSON.stringify(r).slice(0, 300));
  r = await call(A, 'mine', { marked: true, plan: 'down', approach: true });
  ok(r.ok && r.done === 3, JSON.stringify(r));
  const st = await call(A, 'status');
  ok(st.inventory['transport-belt'] === 5 && st.inventory['wooden-chest'] === 3 && !st.inventory['fast-transport-belt'], JSON.stringify(st.inventory));
  eq(await count({ name: 'tree-01' }), 1, 'дерево со снятой пометкой осталось');
});

test('перенос блока из 20 построек: захват, пометка на снос, постановка и исполнение — не больше 6 вызовов', async () => {
  await reset({}, 10.5, 12.5);
  await world(`
    local s = game.surfaces.nauvis
    for i = 0, 3 do
      local m = s.create_entity{name = 'assembling-machine-1', position = {A.ox + 6.5 + i * 4, A.oy + 8.5}, force = 'player'}
      m.set_recipe('iron-gear-wheel')
      s.create_entity{name = 'inserter', position = {A.ox + 6.5 + i * 4, A.oy + 10.5}, direction = defines.direction.south, force = 'player'}
      s.create_entity{name = 'transport-belt', position = {A.ox + 5.5 + i * 4, A.oy + 11.5}, direction = defines.direction.east, force = 'player'}
      s.create_entity{name = 'transport-belt', position = {A.ox + 6.5 + i * 4, A.oy + 11.5}, direction = defines.direction.east, force = 'player'}
      s.create_entity{name = 'small-electric-pole', position = {A.ox + 8.5 + i * 4, A.oy + 10.5}, force = 'player'}
    end
    return true`);
  const area = { x1: O.x + 4, y1: O.y + 6, x2: O.x + 22, y2: O.y + 13 };
  let calls = 0;
  const c = async (op, body) => { calls++; const r = await call(A, op, body); ok(r.ok, `${op}: ${JSON.stringify(r).slice(0, 300)}`); return r; };
  const cap = await c('blueprint_capture', { name: 'move', area });
  eq(cap.entities, 20);
  await c('mark_deconstruct', { area, plan: 'move-old' });
  const dst = { x: cap.origin.x + 30, y: cap.origin.y + 10 };
  await c('ghost_place', { blueprint: 'move', ...dst, plan: 'move-new' });
  const m = await c('mine', { marked: true, plan: 'move-old', approach: true, wait_s: 100 });
  eq(m.done, 20);
  const b = await c('build_ghosts', { plan: 'move-new', approach: true, wait_s: 100 });
  eq(b.done, 20);
  ok(calls <= 6, `вызовов: ${calls}`);
  const check = await world(`local s = game.surfaces.nauvis local n, rec = 0, 0 for _, m in pairs(s.find_entities_filtered{name = 'assembling-machine-1', area = {{A.x, A.y}, {A.x + 20, A.y + 8}}}) do n = n + 1 if m.get_recipe() and m.get_recipe().name == 'iron-gear-wheel' then rec = rec + 1 end end return {n = n, rec = rec, old = s.count_entities_filtered{area = {{A.ox + 4, A.oy + 6}, {A.ox + 22, A.oy + 13}}, force = 'player', type = {'assembling-machine', 'inserter', 'transport-belt', 'electric-pole'}}}`, dst);
  eq(check, { n: 4, rec: 4, old: 0 }, 'блок стоит на новом месте с рецептами, на старом пусто');
});

test('контрольная задача: блок из 8 печей с лентами и манипуляторами по готовому плану — не больше 3 вызовов и 60 секунд', async () => {
  const items = [];
  for (let i = 0; i < 8; i++) {
    const x = 10 + i * 3;
    items.push({ name: 'stone-furnace', ...P(x, 14) });
    items.push({ name: 'inserter', ...P(x - 0.5, 12.5), direction: 'north' }); // с верхней ленты в печь
    items.push({ name: 'inserter', ...P(x - 0.5, 15.5), direction: 'north' }); // из печи на нижнюю ленту
  }
  for (let x = 8; x < 34; x++) {
    items.push({ name: 'transport-belt', ...P(x + 0.5, 11.5), direction: 'east' });
    items.push({ name: 'transport-belt', ...P(x + 0.5, 16.5), direction: 'east' });
  }
  await reset({ 'stone-furnace': 8, inserter: 16, 'transport-belt': 52 }, 2.5, 14.5);
  // Готовый план призраков — условие задачи (его ставит планировщик заранее).
  const plan = await call(A, 'ghost_place', { plan: 'smelter', items });
  eq(plan.placed, 76);
  const t0 = Date.now();
  let calls = 0;
  calls++; const cost = await call(A, 'ghosts', { plan: 'smelter' });
  ok(Object.keys(cost.missing).length === 0, 'всё нужное есть в инвентаре: ' + JSON.stringify(cost.missing));
  calls++; const r = await call(A, 'build_ghosts', { plan: 'smelter', approach: true, wait_s: 60 });
  const sec = (Date.now() - t0) / 1000;
  ok(r.ok && r.done === 76 && r.skipped === 0, JSON.stringify(r).slice(0, 400));
  ok(calls <= 3 && sec <= 60, `вызовов ${calls}, секунд ${sec.toFixed(1)}`);
  eq(await count({ name: 'stone-furnace' }), 8);
  eq(await count({ type: 'entity-ghost' }), 0);
  console.log(`      (контрольная задача: ${calls} вызова, ${sec.toFixed(1)} с, пройдено ${r.walked} клеток)`);
});

test('плитка: призраки плитки через ghost_place и build_ghosts', async () => {
  await reset({ 'stone-brick': 6 }, 22.5, 12.5);
  const tiles = [];
  for (let i = 0; i < 6; i++) tiles.push({ name: 'stone-path', ...P(20 + i, 10) });
  const g = await call(A, 'ghost_place', { plan: 'path', tiles });
  ok(g.ok && g.placed_tiles === 6, JSON.stringify(g));
  const r = await call(A, 'build_ghosts', { plan: 'path' });
  ok(r.ok && r.done === 6, JSON.stringify(r));
  const t = await world(`return {n = game.surfaces.nauvis.count_tiles_filtered{area = {{A.ox + 20, A.oy + 10}, {A.ox + 26, A.oy + 11}}, name = 'stone-path'}}`);
  eq(t.n, 6);
});

run(async () => { admin.close(); });
