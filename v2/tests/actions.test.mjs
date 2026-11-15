#!/usr/bin/env node
// Действия первого выпуска: постройка, перенос, добыча, крафт, настройки, исследования, пакеты с подходом.
import { call, lua, admin, sleep } from './lib.mjs';
import { test, ok, eq, run } from './harness.mjs';

const A = 't-b3', NAME = 'bench-3';
// Чистая площадка 60×30 клеток без построек, воды и скал.
const O = await lua(`
  local s = game.surfaces.nauvis
  for r = 3, 40 do for _, c in pairs{{r, r}, {-r, r}, {-r, 0}, {r, 0}, {0, r}, {-r, -r}, {r, -r}, {0, -r}} do
    local x, y = c[1] * 16, c[2] * 16
    local area = {{x - 2, y - 2}, {x + 62, y + 32}}
    if s.count_entities_filtered{area = area, type = 'character', invert = true} == 0 and s.count_tiles_filtered{area = area, collision_mask = 'player'} == 0
      and game.forces.player.is_chunk_charted(s, {math.floor(x / 32), math.floor(y / 32)}) then
      return {x = x, y = y}
    end
  end end
  error('нет чистой площадки')`);
await call(A, 'status'); // создать персонажа, если его ещё нет

// Подготовка (только тестовый экземпляр): очистить площадку, поставить персонажа, выдать предметы.
const reset = (items = {}, dx = 30.5, dy = 15.5) => lua(`
  local s = game.surfaces.nauvis
  local A_ = storage.agent.agents[A.name]
  local e = A_.entity
  for _, x in pairs(s.find_entities_filtered{area = {{A.x - 2, A.y - 2}, {A.x + 62, A.y + 32}}}) do
    if x.valid and x ~= e and x.type ~= 'character' then x.destroy() end
  end
  e.teleport({A.x + A.dx, A.y + A.dy})
  e.clear_items_inside()
  while e.crafting_queue_size > 0 do e.cancel_crafting{index = 1, count = e.crafting_queue[1].count} end
  e.clear_items_inside()
  for name, n in pairs(A.items) do e.insert{name = name, count = n} end
  return true`, { name: NAME, x: O.x, y: O.y, dx, dy, items });
const P = (dx, dy) => ({ x: O.x + dx, y: O.y + dy });
const world = (code, args = {}) => lua(code, { ...args, ox: O.x, oy: O.y });
const count = (name) => world(`return {n = game.surfaces.nauvis.count_entities_filtered{area = {{A.ox - 2, A.oy - 2}, {A.ox + 62, A.oy + 32}}, name = A.name}}`, { name }).then((r) => r.n);
const inv = async () => (await call(A, 'status')).inventory;

test('place: одна постройка в досягаемости, предмет тратится', async () => {
  await reset({ 'wooden-chest': 3 });
  const r = await call(A, 'place', { item: 'wooden-chest', ...P(33.5, 15.5) });
  ok(r.ok && r.name === 'wooden-chest' && r.unit > 0, JSON.stringify(r));
  eq((await inv())['wooden-chest'], 2);
  const again = await call(A, 'place', { item: 'wooden-chest', ...P(33.5, 15.5) });
  ok(again.ok && again.already, 'повтор в ту же точку: already, предмет не тратится');
  eq((await inv())['wooden-chest'], 2);
});

test('place: вне досягаемости без approach — out_of_reach; нет предмета — no_item; занято — blocked', async () => {
  await reset({ 'wooden-chest': 2 });
  let r = await call(A, 'place', { item: 'wooden-chest', ...P(45.5, 15.5) });
  ok(!r.ok && r.error.code === 'out_of_reach', JSON.stringify(r));
  r = await call(A, 'place', { item: 'iron-chest', ...P(33.5, 15.5) });
  ok(!r.ok && r.error.code === 'no_item', JSON.stringify(r));
  await call(A, 'place', { item: 'wooden-chest', ...P(33.5, 15.5) });
  r = await call(A, 'place', { item: 'wooden-chest', ...P(33.5, 15.5), quality: 'normal', direction: 'east' });
  ok(r.ok && r.already, JSON.stringify(r));
  await world(`game.surfaces.nauvis.create_entity{name = 'stone-furnace', position = {A.ox + 36, A.oy + 16}, force = 'player'} return true`);
  r = await call(A, 'place', { item: 'wooden-chest', ...P(35.5, 15.5) });
  ok(!r.ok && r.error.code === 'blocked', JSON.stringify(r));
  eq((await call(A, 'place', { item: 'нет-такого', x: 1, y: 1 })).http, 400);
});

test('place: 200 построек одним запросом за один тик', async () => {
  await reset({ 'transport-belt': 200 });
  const items = [];
  for (let dy = -7; dy <= 7 && items.length < 200; dy++) for (let dx = -7; dx <= 7 && items.length < 200; dx++) {
    if (Math.hypot(dx, dy) <= 9.5) items.push({ item: 'transport-belt', x: O.x + 30.5 + dx, y: O.y + 15.5 + dy, direction: 'east' });
  }
  eq(items.length, 200);
  const s0 = (await call(A, 'events')).seq;
  const r = await call(A, 'place', { items });
  ok(r.ok && r.done === 200 && r.skipped === 0, JSON.stringify(r).slice(0, 300));
  eq(await count('transport-belt'), 200);
  const ev = (await call(A, 'events', { since: s0, types: ['action_done'] })).events[0];
  eq(ev.ticks, 0, 'всё в одном тике');
  ok(r.ms < 300, `ответ за ${r.ms.toFixed(0)} мс`);
});

test('place с approach: ряд вне досягаемости, персонаж обходит сам; поэлементный отчёт', async () => {
  await reset({ 'transport-belt': 30, 'stone-furnace': 1 }, 5.5, 15.5);
  const items = [];
  for (let i = 0; i < 30; i++) items.push({ item: 'transport-belt', ...P(20.5 + i, 10.5), direction: 'east' });
  items.push({ item: 'stone-furnace', ...P(30, 20) });
  items.push({ item: 'iron-chest', ...P(31.5, 25.5) }); // предмета нет — в отчёт
  const r = await call(A, 'place', { items, approach: true, wait_s: 60 });
  ok(r.ok && r.done === 31 && r.skipped === 1 && r.walked > 10, JSON.stringify(r).slice(0, 400));
  eq(r.items[31].code, 'no_item');
  eq(await count('transport-belt'), 30);
});

test('быстрая замена на месте: старая постройка возвращается в инвентарь', async () => {
  await reset({ 'transport-belt': 1, 'fast-transport-belt': 1 });
  await call(A, 'place', { item: 'transport-belt', ...P(32.5, 15.5), direction: 'east' });
  const r = await call(A, 'place', { item: 'fast-transport-belt', ...P(32.5, 15.5), direction: 'east' });
  ok(r.ok && r.replaced === 'transport-belt', JSON.stringify(r));
  const i = await inv();
  ok(i['transport-belt'] === 1 && !i['fast-transport-belt'], JSON.stringify(i));
});

test('transfer: положить и забрать, выбор слота, отчёт по списку', async () => {
  await reset({ coal: 20, 'iron-ore': 30, 'stone-furnace': 1, 'wooden-chest': 1 });
  await call(A, 'place', { item: 'stone-furnace', ...P(33, 15) });
  await call(A, 'place', { item: 'wooden-chest', ...P(33.5, 18.5) });
  const f = P(33, 15), c = P(33.5, 18.5);
  const r = await call(A, 'transfer', { items: [
    { target: f, direction: 'put', item: 'coal', count: 5 },
    { target: f, direction: 'put', item: 'iron-ore', count: 10 },
    { target: c, direction: 'put', item: 'iron-ore' },
    { target: c, direction: 'put', item: 'copper-ore', count: 1 },
    { target: P(50.5, 5.5), direction: 'take' },
  ] });
  ok(r.ok && r.done === 3 && r.skipped === 2, JSON.stringify(r));
  eq(r.items[2].moved, 20);
  eq(r.items[3].code, 'no_item');
  eq(r.items[4].code, 'not_found');
  const st = await world(`local s = game.surfaces.nauvis local f = s.find_entity('stone-furnace', {A.ox + 33, A.oy + 15}) return {fuel = f.get_fuel_inventory().get_item_count('coal'), ore = f.get_inventory(defines.inventory.crafter_input).get_item_count('iron-ore')}`);
  ok((st.fuel === 5 || st.fuel === 4) && (st.ore === 10 || st.ore === 9), JSON.stringify(st)); // печь могла уже начать плавку
  const t = await call(A, 'transfer', { target: c, direction: 'take', item: 'iron-ore', count: 7 });
  ok(t.ok && t.moved === 7, JSON.stringify(t));
  const all = await call(A, 'transfer', { target: c, direction: 'take' });
  ok(all.ok && all.moved === 13 && all.items['iron-ore'] === 13, JSON.stringify(all));
  const none = await call(A, 'transfer', { target: c, direction: 'take' });
  ok(!none.ok && none.error.code === 'no_item', JSON.stringify(none));
  const out = await call(A, 'transfer', { target: f, direction: 'put', item: 'coal', inventory: 'output' });
  ok(!out.ok && out.error.code === 'not_allowed', JSON.stringify(out));
});

test('transfer: вне досягаемости без approach — out_of_reach, с approach — подходит', async () => {
  await reset({ coal: 10 }, 5.5, 15.5);
  await world(`game.surfaces.nauvis.create_entity{name = 'wooden-chest', position = {A.ox + 40.5, A.oy + 15.5}, force = 'player'} return true`);
  let r = await call(A, 'transfer', { target: P(40.5, 15.5), direction: 'put', item: 'coal', count: 3 });
  ok(!r.ok && r.error.code === 'out_of_reach', JSON.stringify(r));
  r = await call(A, 'transfer', { target: P(40.5, 15.5), direction: 'put', item: 'coal', count: 3, approach: true });
  ok(r.ok && r.moved === 3 && r.walked > 20, JSON.stringify(r));
});

test('craft: очередь ручного крафта, wait craft_empty, событие craft_done', async () => {
  await reset({ 'iron-plate': 20 });
  const s0 = (await call(A, 'events')).seq;
  const r = await call(A, 'act', { actions: [{ type: 'craft', item: 'iron-gear-wheel', count: 4 }, { type: 'wait', until: 'craft_empty', max_ticks: 1200 }] });
  ok(r.ok && r.actions[0].result.queued === 4 && r.actions[1].state === 'done', JSON.stringify(r));
  eq((await inv())['iron-gear-wheel'], 4);
  const ev = await call(A, 'events', { since: s0, wait_s: 3, types: ['craft_done'] });
  ok(ev.events.length === 1, 'событие craft_done');
  const no = await call(A, 'craft', { item: 'electronic-circuit', count: 1 });
  ok(!no.ok && no.error.code === 'no_item' && no.error.data.ingredients, JSON.stringify(no));
  const part = await call(A, 'craft', { item: 'iron-gear-wheel', count: 50 });
  ok(part.ok && part.queued === 6 && part.requested === 50, JSON.stringify(part));
  const c = await call(A, 'cancel_craft', {});
  ok(c.ok && c.queue_size === 0, JSON.stringify(c));
  eq((await inv())['iron-plate'], 12);
});

test('wait: предел ожидания условия — max_ticks или ticks, ошибка timeout', async () => {
  await reset({});
  for (const lim of [{ max_ticks: 30 }, { ticks: 30 }]) {
    const r = await call(A, 'wait', { until: 'has_item', item: 'iron-gear-wheel', ...lim });
    ok(!r.ok && r.error.code === 'timeout' && r.error.data.waited >= 30 && r.error.data.waited < 90, JSON.stringify(r));
  }
  const bad = await call(A, 'wait', { until: 'craft_empty', ticks: 'x' });
  ok(!bad.ok && bad.error.code === 'bad_request', JSON.stringify(bad));
});

test('mine: ресурс по счёту, постройка с содержимым, вне досягаемости', async () => {
  await reset({});
  await world(`
    local s = game.surfaces.nauvis
    s.create_entity{name = 'iron-ore', position = {A.ox + 31.5, A.oy + 15.5}, amount = 500}
    local c = s.create_entity{name = 'wooden-chest', position = {A.ox + 33.5, A.oy + 15.5}, force = 'player'}
    c.insert{name = 'coal', count = 9}
    s.create_entity{name = 'iron-ore', position = {A.ox + 36.5, A.oy + 15.5}, amount = 500}
    return true`);
  let r = await call(A, 'mine', { target: P(31.5, 15.5), count: 3 });
  ok(r.ok && r.gained === 3 && r.amount_left === 497, JSON.stringify(r));
  r = await call(A, 'mine', { target: P(33.5, 15.5) });
  ok(r.ok && r.gone, JSON.stringify(r));
  const i = await inv();
  ok(i['wooden-chest'] === 1 && i.coal === 9 && i['iron-ore'] === 3, JSON.stringify(i));
  r = await call(A, 'mine', { target: P(36.5, 15.5), count: 1 });
  ok(!r.ok && r.error.code === 'out_of_reach', 'ресурс дальше 2,7 клетки: ' + JSON.stringify(r));
  r = await call(A, 'mine', { target: P(36.5, 15.5), count: 1, approach: true });
  ok(r.ok && r.gained === 1, JSON.stringify(r));
});

test('mine: деревья и камни — вплотную; помеченные на снос деревья с подходом', async () => {
  await reset({}, 10.5, 15.5);
  await world(`local s = game.surfaces.nauvis for i = 0, 2 do s.create_entity{name = 'tree-01', position = {A.ox + 40.5 + i * 3, A.oy + 15.5}} end s.create_entity{name = 'big-rock', position = {A.ox + 30.5, A.oy + 20.5}} return true`);
  const near = await call(A, 'mine', { target: P(40.5, 15.5) });
  ok(!near.ok && near.error.code === 'out_of_reach', 'дерево издалека не срубить: ' + JSON.stringify(near));
  const area = { x1: O.x + 28, y1: O.y + 13, x2: O.x + 50, y2: O.y + 23 };
  const mk = await call(A, 'mark_deconstruct', { area, nature: true, plan: 'trees' });
  eq(mk.marked, 4);
  const r = await call(A, 'mine', { marked: true, plan: 'trees', approach: true, wait_s: 90 });
  ok(r.ok && r.done === 4 && r.skipped === 0, JSON.stringify(r).slice(0, 500));
  const i = await inv();
  ok(i.wood >= 12 && i.stone > 0, JSON.stringify(i));
});

test('mine: отмена во время пакета возвращает отчёт о сделанном', async () => {
  await reset({});
  await world(`local s = game.surfaces.nauvis for i = 0, 5 do s.create_entity{name = 'iron-ore', position = {A.ox + 31.5, A.oy + 13.5 + i}, amount = 500} end return true`);
  const targets = [0, 1, 2].map((i) => ({ ...P(31.5, 14.5 + i), count: 3 }));
  const r = await call(A, 'mine', { targets, wait: false });
  ok(r.running);
  await sleep(1500);
  await call(A, 'cancel');
  const w = await call(A, 'wait_action', { action_id: r.action_id });
  const a = w.actions[0];
  ok(a.state === 'cancelled' && a.error.data.report && a.error.data.report.total === 3, JSON.stringify(a));
  const st = await call(A, 'status');
  ok(!st.mining, 'после отмены добыча остановлена');
});

test('repair: чинит в темпе игры, тратит ресурс ремкомплекта; цела — already; нет комплекта — no_item', async () => {
  await reset({ 'repair-pack': 1 });
  await world(`
    local s = game.surfaces.nauvis
    local t = s.create_entity{name = 'gun-turret', position = {A.ox + 34, A.oy + 16}, force = 'player'}
    t.health = 300
    local w = s.create_entity{name = 'stone-wall', position = {A.ox + 33.5, A.oy + 12.5}, force = 'player'}
    w.health = 152
    return true`);
  const hp = (name) => world(`local e = game.surfaces.nauvis.find_entities_filtered{area = {{A.ox, A.oy}, {A.ox + 60, A.oy + 30}}, name = A.name}[1] return {hp = e.health}`, { name }).then((r) => r.hp);
  // Турель: 100 единиц при 2 за тик — 50 тиков и 50 единиц ресурса комплекта.
  let r = await call(A, 'repair', { target: P(34, 16) });
  ok(r.ok && r.name === 'gun-turret' && r.health === 400 && r.repaired === 100 && r.ticks === 50 && r.tools_left === 1, JSON.stringify(r));
  eq(await hp('gun-turret'), 400);
  let dur = await world(`return {d = storage.agent.agents[A.name].entity.get_main_inventory().find_item_stack('repair-pack').durability}`, { name: NAME });
  eq(dur.d, 250);
  r = await call(A, 'repair', { target: P(34, 16) });
  ok(r.ok && r.already && r.repaired === 0, JSON.stringify(r));
  // Стена чинится вдвое быстрее (множитель ремонта 2): 198 единиц за 50 тиков.
  r = await call(A, 'repair', { target: P(33.5, 12.5) });
  ok(r.ok && r.health === 350 && r.repaired === 198 && r.ticks === 50, JSON.stringify(r));
  // Комплект кончается посреди ремонта: починено ровно на остаток ресурса (200 тиков × 2), дальше no_item.
  await world(`local e = game.surfaces.nauvis.find_entities_filtered{area = {{A.ox, A.oy}, {A.ox + 60, A.oy + 30}}, name = 'gun-turret'}[1] e.health = 1 return true`);
  r = await call(A, 'repair', { target: P(34, 16), wait_s: 30 });
  ok(!r.ok && r.error.code === 'no_item' && r.error.data.repaired === 399 || (r.ok && r.repaired === 399), JSON.stringify(r));
  eq((await inv())['repair-pack'], undefined, 'комплект израсходован');
  await world(`local e = game.surfaces.nauvis.find_entities_filtered{area = {{A.ox, A.oy}, {A.ox + 60, A.oy + 30}}, name = 'gun-turret'}[1] e.health = 100 return true`);
  r = await call(A, 'repair', { target: P(34, 16) });
  ok(!r.ok && r.error.code === 'no_item', JSON.stringify(r));
  eq(await hp('gun-turret'), 100, 'без комплекта прочность не растёт');
  eq((await call(A, 'repair', { target: P(34, 16), item: 'iron-plate' })).http, 400);
});

test('repair: область с подходом — только повреждённое своей команды; без подхода — out_of_reach', async () => {
  await reset({ 'repair-pack': 2 });
  await world(`
    local s = game.surfaces.nauvis
    for i = 0, 2 do
      local w = s.create_entity{name = 'stone-wall', position = {A.ox + 50.5, A.oy + 14.5 + i}, force = 'player'}
      if i < 2 then w.health = 310 end
    end
    local en = s.create_entity{name = 'stone-wall', position = {A.ox + 50.5, A.oy + 18.5}, force = 'enemy'}
    en.health = 100
    return true`);
  const area = { x1: O.x + 48, y1: O.y + 12, x2: O.x + 53, y2: O.y + 20 };
  let r = await call(A, 'repair', { area });
  ok(r.ok && r.total === 2 && r.done === 0 && r.skipped === 2 && r.items[0].code === 'out_of_reach', JSON.stringify(r));
  r = await call(A, 'repair', { area, approach: true, wait_s: 60 });
  ok(r.ok && r.total === 2 && r.done === 2 && r.walked > 5 && r.items.every((x) => x.health === 350 && x.repaired === 40 && x.ticks === 10), JSON.stringify(r));
  const left = await world(`
    local n, enemy = 0, 0
    for _, e in pairs(game.surfaces.nauvis.find_entities_filtered{area = {{A.ox + 48, A.oy + 12}, {A.ox + 53, A.oy + 20}}, name = 'stone-wall'}) do
      if e.force.name == 'enemy' then enemy = math.floor(e.health + 0.5) elseif e.health < e.max_health then n = n + 1 end
    end
    return {n = n, enemy = enemy}`);
  eq(left, { n: 0, enemy: 100 });
  r = await call(A, 'repair', { target: P(50.5, 18.5) });
  ok(!r.ok && r.error.code === 'not_allowed', 'чужое не чинится: ' + JSON.stringify(r));
});

test('configure: расписание и режим поезда', async () => {
  await reset();
  const made = await world(`
    local s = game.surfaces.nauvis
    for i = 0, 9 do s.create_entity{name = 'straight-rail', position = {A.ox + 21 + i * 2, A.oy + 19}, direction = defines.direction.east, force = 'player'} end
    local loco = s.create_entity{name = 'locomotive', position = {A.ox + 30, A.oy + 19}, direction = defines.direction.east, force = 'player'}
    local a = s.create_entity{name = 'train-stop', position = {A.ox + 39, A.oy + 21}, direction = defines.direction.east, force = 'player'}
    local b = s.create_entity{name = 'train-stop', position = {A.ox + 21, A.oy + 17}, direction = defines.direction.west, force = 'player'}
    a.backer_name = 'T-sched-A'
    b.backer_name = 'T-sched-B'
    return {x = loco.position.x, y = loco.position.y, manual = loco.train.manual_mode}`);
  const loco = { x: made.x, y: made.y, name: 'locomotive' };
  let r = await call(A, 'configure', { target: loco, schedule: [
    { station: 'T-sched-A', wait: [{ type: 'full' }, { type: 'inactivity', seconds: 5, compare: 'or' }] },
    { station: 'T-sched-B', wait: [{ type: 'item_count', item: 'iron-plate', comparator: '<', count: 10 }, { type: 'time', ticks: 600 }] },
  ] });
  ok(r.ok && r.train && r.train.schedule.length === 2, JSON.stringify(r));
  eq(r.train.schedule[0].station, 'T-sched-A');
  eq(r.train.schedule[0].wait[1].ticks, 300);
  eq(r.train.schedule[0].wait[1].compare, 'or');
  eq(r.train.schedule[1].wait[0].item, 'iron-plate');
  eq(r.train.schedule[1].wait[0].count, 10);
  eq(r.train.manual, true);
  const tr = (await call(A, 'trains')).trains.find((t) => t.id === r.train.id);
  ok(tr && tr.stops.length === 2 && tr.stops[1].wait[1].type === 'time', JSON.stringify(tr));
  r = await call(A, 'configure', { target: loco, manual_mode: false });
  ok(r.ok && r.train.manual === false, JSON.stringify(r));
  r = await call(A, 'configure', { target: loco, manual_mode: true });
  ok(r.ok && r.train.manual === true, JSON.stringify(r));
  r = await call(A, 'configure', { target: loco, schedule: [{ station: 'T-нет-такой' }] });
  ok(!r.ok && r.error.code === 'not_found', JSON.stringify(r));
  r = await call(A, 'configure', { target: loco, schedule: [{ station: 'T-sched-A', wait: [{ type: 'circuit' }] }] });
  ok(!r.ok && r.error.code === 'bad_request', JSON.stringify(r));
  r = await call(A, 'configure', { target: P(39, 21), schedule: [{ station: 'T-sched-A' }] });
  ok(!r.ok && r.error.code === 'bad_request', 'не поезд: ' + JSON.stringify(r));
  r = await call(A, 'configure', { target: loco, schedule: false });
  ok(r.ok && r.train.schedule.length === 0, JSON.stringify(r));
  await reset({}, 30.5, 2.5);
  await world(`local s = game.surfaces.nauvis
    for i = 0, 9 do s.create_entity{name = 'straight-rail', position = {A.ox + 21 + i * 2, A.oy + 19}, direction = defines.direction.east, force = 'player'} end
    s.create_entity{name = 'locomotive', position = {A.ox + 30, A.oy + 19}, direction = defines.direction.east, force = 'player'}
    return true`);
  r = await call(A, 'configure', { target: loco, manual_mode: false });
  ok(!r.ok && r.error.code === 'out_of_reach', 'далеко: ' + JSON.stringify(r));
});

test('configure: рецепт, поворот, копирование настроек, фильтр', async () => {
  await reset({ 'assembling-machine-1': 2, inserter: 1, 'iron-plate': 10 });
  await call(A, 'place', { items: [{ item: 'assembling-machine-1', ...P(34.5, 15.5) }, { item: 'assembling-machine-1', ...P(34.5, 19.5) }, { item: 'inserter', ...P(32.5, 15.5), direction: 'north' }] });
  let r = await call(A, 'configure', { target: P(34.5, 15.5), recipe: 'iron-gear-wheel' });
  ok(r.ok && r.recipe === 'iron-gear-wheel', JSON.stringify(r));
  r = await call(A, 'configure', { target: P(34.5, 19.5), copy_from: P(34.5, 15.5) });
  ok(r.ok, JSON.stringify(r));
  const rec = await world(`local m = game.surfaces.nauvis.find_entity('assembling-machine-1', {A.ox + 34.5, A.oy + 19.5}) return {r = m.get_recipe() and m.get_recipe().name}`);
  eq(rec.r, 'iron-gear-wheel');
  r = await call(A, 'configure', { target: P(32.5, 15.5), direction: 'east' });
  ok(r.ok && r.direction === 'east', JSON.stringify(r));
  r = await call(A, 'configure', { target: P(34.5, 15.5), recipe: 'rocket-part' });
  ok(!r.ok && r.error.code === 'not_allowed', JSON.stringify(r));
  r = await call(A, 'configure', { target: P(34.5, 15.5), recipe: false });
  ok(r.ok, JSON.stringify(r));
});

test('configure: ракетная шахта — груз в ракету, запуск, автозапросы', async () => {
  await reset({ 'space-platform-starter-pack': 1, 'wooden-chest': 1 });
  const silo = { ...P(38.5, 15.5), name: 'rocket-silo' };
  await world(`for _, p in pairs(game.forces.player.platforms) do p.destroy(1) end
    local s = game.surfaces.nauvis.create_entity{name = 'rocket-silo', position = {A.ox + 38.5, A.oy + 15.5}, force = 'player'}
    s.rocket_parts = s.prototype.rocket_parts_required
    s.surface.create_entity{name = 'medium-electric-pole', position = {A.ox + 33.5, A.oy + 12.5}, force = 'player'}
    s.surface.create_entity{name = 'electric-energy-interface', position = {A.ox + 32, A.oy + 11}, force = 'player'}
    return true`);
  let r = await call(A, 'configure', { target: silo, launch: true });
  ok(!r.ok && r.error.code === 'not_allowed', 'ракета не готова: ' + JSON.stringify(r));
  r = await call(A, 'configure', { target: silo, platform_requests: true });
  ok(r.ok && r.rocket && r.platform_requests === true, JSON.stringify(r));
  r = await call(A, 'configure', { target: silo, platform_requests: false });
  ok(r.ok && r.platform_requests === false, JSON.stringify(r));
  let info;
  for (let i = 0; i < 90; i++) {
    info = (await call(A, 'inspect', { target: silo }));
    if (info.rocket?.status === 'rocket_ready') break;
    await sleep(1000);
  }
  eq(info.rocket.status, 'rocket_ready', JSON.stringify(info));
  eq(info.rocket.parts_required, 50);
  r = await call(A, 'transfer', { target: silo, direction: 'put', item: 'space-platform-starter-pack', inventory: 'rocket' });
  ok(r.ok && r.moved === 1, JSON.stringify(r));
  info = await call(A, 'inspect', { target: silo });
  eq(info.inventory.rocket['space-platform-starter-pack'], 1, JSON.stringify(info));
  ok(info.rocket.cargo_weight > 0 && info.rocket.cargo_max_weight >= info.rocket.cargo_weight, JSON.stringify(info.rocket));
  r = await call(A, 'transfer', { target: silo, direction: 'take', inventory: 'rocket' });
  ok(r.ok && r.moved === 1, 'груз можно забрать обратно: ' + JSON.stringify(r));
  await call(A, 'transfer', { target: silo, direction: 'put', item: 'space-platform-starter-pack', inventory: 'rocket' });
  r = await call(A, 'configure', { target: silo, launch: true });
  ok(r.ok && r.launched && r.cargo['space-platform-starter-pack'] === 1 && r.rocket !== 'rocket_ready', JSON.stringify(r));
  ok(r.platform && r.platform.created && r.platform.name, 'стартовый набор становится новой платформой: ' + JSON.stringify(r));
  const pl = await world(`for _, p in pairs(game.forces.player.platforms) do if p.name == A.pname then
      local on_way = p.state == defines.space_platform_state.starter_pack_on_the_way p.destroy(1) return {on_way = on_way} end end return {}`, { pname: r.platform.name });
  ok(pl.on_way, 'набор летит к платформе: ' + JSON.stringify(pl));
  // Вторая ракета: платформа, созданная человеком и ждущая набор, получает его — новая не создаётся.
  await world(`game.forces.player.create_space_platform{name = 't-wait', planet = 'nauvis', starter_pack = 'space-platform-starter-pack'}
    A_ = storage.agent.agents[A.bot].entity.insert{name = 'space-platform-starter-pack', count = 1} return true`, { bot: NAME });
  const seen = [];
  let refilled = false;
  for (let i = 0; i < 120; i++) {
    info = await call(A, 'inspect', { target: silo });
    if (seen[seen.length - 1] !== info.rocket?.status) seen.push(info.rocket?.status);
    if (info.rocket?.status === 'building_rocket' && !refilled) {
      refilled = true;
      await world(`local s = game.surfaces.nauvis.find_entity('rocket-silo', {A.ox + 38.5, A.oy + 15.5}) s.rocket_parts = 50 return true`);
    }
    if (refilled && info.rocket?.status === 'rocket_ready') break;
    await sleep(1000);
  }
  eq(info.rocket.status, 'rocket_ready', JSON.stringify(info));
  // Игра сама запускает ракету, как только в неё положен набор, которого ждёт платформа: кнопка не нужна.
  r = await call(A, 'transfer', { target: silo, direction: 'put', item: 'space-platform-starter-pack', inventory: 'rocket' });
  ok(r.ok && r.moved === 1, JSON.stringify(r));
  let st;
  for (let i = 0; i < 20; i++) {
    st = await world(`for _, p in pairs(game.forces.player.platforms) do if p.name == 't-wait' then
      return {on_way = p.state == defines.space_platform_state.starter_pack_on_the_way, n = table_size(game.forces.player.platforms)} end end return {}`);
    if (st.on_way) break;
    await sleep(500);
  }
  ok(st.on_way && st.n === 1, 'набор ушёл к ждущей платформе, новая не создана: ' + JSON.stringify(st) + ' ' + seen.join(','));
  await world(`for _, p in pairs(game.forces.player.platforms) do p.destroy(1) end return true`);
  r = await call(A, 'configure', { target: silo, launch: true });
  ok(!r.ok && r.error.code === 'not_allowed', 'повторный запуск: ' + JSON.stringify(r));
  await call(A, 'place', { item: 'wooden-chest', ...P(30.5, 18.5) });
  r = await call(A, 'configure', { target: P(30.5, 18.5), launch: true });
  ok(!r.ok && r.error.code === 'bad_request', 'не шахта: ' + JSON.stringify(r));
});

test('research: добавить в очередь и убрать', async () => {
  const before = await call(A, 'research', { add: [] });
  const cand = await lua(`for name, t in pairs(game.forces.player.technologies) do if t.enabled and not t.researched then local okp = true for _, pr in pairs(t.prerequisites) do if not pr.researched then okp = false end end local inq = false for _, q in pairs(game.forces.player.research_queue) do if q.name == name then inq = true end end if okp and not inq then return {name = name} end end end return {}`);
  if (!cand.name) return;
  let r = await call(A, 'research', { add: cand.name });
  ok(r.ok && r.queue.includes(cand.name), JSON.stringify(r));
  r = await call(A, 'research', { remove: cand.name });
  ok(r.ok && !r.queue.includes(cand.name), JSON.stringify(r));
  eq(r.queue, before.queue);
});

test('immediate: мгновенное действие исполняется, пока тело занято', async () => {
  await reset({ 'wooden-chest': 1 });
  const w = await call(A, 'wait', { ticks: 600, wait: false });
  const r = await call(A, 'act', { actions: [{ type: 'place', item: 'wooden-chest', ...P(32.5, 15.5), immediate: true }] });
  eq(r.actions[0].state, 'done');
  const q = await call(A, 'queue');
  eq(q.queue.length, 1, 'ожидание продолжает стоять в очереди');
  await call(A, 'clear');
});

run(async () => { admin.close(); });
