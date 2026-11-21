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

test('transfer: робопорт — роботы в слоты роботов, ремкомплекты в свои', async () => {
  await reset({ 'construction-robot': 10, 'repair-pack': 10 });
  const rp = P(34, 16);
  await world(`game.surfaces.nauvis.create_entity{name = 'roboport', position = {A.ox + 34, A.oy + 16}, force = 'player'} return true`);
  let r = await call(A, 'transfer', { target: rp, direction: 'put', item: 'construction-robot', count: 2 });
  ok(r.ok && r.moved === 2, JSON.stringify(r));
  r = await call(A, 'transfer', { target: rp, direction: 'put', item: 'construction-robot', count: 3, inventory: 'robots' });
  ok(r.ok && r.moved === 3, JSON.stringify(r));
  r = await call(A, 'transfer', { target: rp, direction: 'put', item: 'construction-robot', count: 1, inventory: 'main' });
  ok(!r.ok && r.error.code === 'no_space' && /robots/.test(r.error.message), JSON.stringify(r));
  r = await call(A, 'transfer', { target: rp, direction: 'put', item: 'repair-pack', count: 4, inventory: 'main' });
  ok(r.ok && r.moved === 4, JSON.stringify(r));
  const i = await call(A, 'inspect', { target: rp });
  ok(i.inventory.robots['construction-robot'] === 5 && i.inventory.main['repair-pack'] === 4, JSON.stringify(i));
  ok(i.robot_slots === 7 && i.free_robot_slots === 6 && i.slots === 7 && i.free_slots === 6, JSON.stringify(i));
  r = await call(A, 'transfer', { target: rp, direction: 'take' });
  ok(r.ok && r.moved === 9, JSON.stringify(r));
  const mine = await inv();
  ok(mine['construction-robot'] === 10 && mine['repair-pack'] === 10, JSON.stringify(mine));
});

test('transfer: вне досягаемости без approach — out_of_reach, с approach — подходит', async () => {
  await reset({ coal: 10 }, 5.5, 15.5);
  await world(`game.surfaces.nauvis.create_entity{name = 'wooden-chest', position = {A.ox + 40.5, A.oy + 15.5}, force = 'player'} return true`);
  let r = await call(A, 'transfer', { target: P(40.5, 15.5), direction: 'put', item: 'coal', count: 3 });
  ok(!r.ok && r.error.code === 'out_of_reach', JSON.stringify(r));
  r = await call(A, 'transfer', { target: P(40.5, 15.5), direction: 'put', item: 'coal', count: 3, approach: true });
  ok(r.ok && r.moved === 3 && r.walked > 20, JSON.stringify(r));
});

test('гибель: agent_died с перечнем потерянного, труп в inspect, corpse_gone, когда его опустошили', async () => {
  await reset({ coal: 10, 'iron-plate': 5 }, 20.5, 15.5);
  await world(`local e = storage.agent.agents[A.name].entity
    e.get_inventory(defines.inventory.character_guns).insert{name = 'pistol', count = 1}
    e.die() return true`, { name: NAME });
  const s0 = (await call(A, 'events')).seq;
  const died = (await call(A, 'events', { since: s0 - 20, types: ['agent_died'] })).events.pop();
  ok(died && died.lost.coal === 10 && died.lost['iron-plate'] === 5 && died.lost.pistol === 1, JSON.stringify(died));
  await world(`storage.agent.agents[A.name].entity.teleport({A.ox + 22.5, A.oy + 15.5}) return true`, { name: NAME });
  const target = { ...P(20.5, 15.5), name: 'character-corpse' };
  const i = await call(A, 'inspect', { target });
  ok(i.ok && i.found && i.items.coal === 10 && i.bot === NAME && i.died_tick > 0, JSON.stringify(i));
  let r = await call(A, 'transfer', { target, direction: 'take', item: 'coal' });
  ok(r.ok && r.moved === 10, JSON.stringify(r));
  let ev = await call(A, 'events', { since: s0, types: ['corpse_gone'] });
  eq(ev.events.length, 0);
  r = await call(A, 'transfer', { target, direction: 'take' });
  ok(r.ok && r.moved === 6, JSON.stringify(r));
  ev = await call(A, 'events', { since: s0, wait_s: 3, types: ['corpse_gone'] });
  const gone = ev.events[0];
  ok(gone && gone.reason === 'emptied' && gone.by === NAME && !gone.items_left, JSON.stringify(ev));
  ok(!(await call(A, 'inspect', { target })).found, 'трупа больше нет');
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

test('технология-триггер: ручной крафт бота открывает технологию, отменённый — нет (fb-085)', async () => {
  const T = 'automation-science-pack';
  const tech = (code, args = {}) => lua(`local f = game.forces.player local t = f.technologies[A.t] ${code}`, { ...args, t: T });
  const saved = await tech(`local pre = {} for n, p in pairs(t.prerequisites) do pre[n] = p.researched p.researched = true end
    local was = t.researched t.researched = false storage.agent.trig.progress[A.t] = nil return {pre = pre, was = was}`);
  const lab = { 'electronic-circuit': 10, 'iron-gear-wheel': 10, 'transport-belt': 4 };
  try {
    await reset(lab);
    const info = await call(A, 'research_info', { name: T });
    const tr = info.technology.trigger;
    ok(tr && tr.type === 'craft-item' && tr.item === 'lab' && tr.count === 1, 'trigger в research_info: ' + JSON.stringify(info.technology));
    const add = await call(A, 'research', { add: T });
    ok(add.ok && add.skipped.length === 1 && /триггер/.test(add.skipped[0].reason), JSON.stringify(add));
    // Отменённый крафт не считается.
    const q = await call(A, 'craft', { item: 'lab' });
    ok(q.ok && q.queued === 1, JSON.stringify(q));
    await call(A, 'cancel_craft', {});
    await call(A, 'wait', { ticks: 20 });
    ok(!(await tech('return {r = t.researched}')).r, 'отменённый крафт не открыл технологию');
    // Предпосылки есть: скрафченная руками лаба открывает технологию.
    await reset(lab);
    const s0 = (await call(A, 'events')).seq;
    const r = await call(A, 'act', { actions: [{ type: 'craft', item: 'lab' }, { type: 'wait', until: 'craft_empty', max_ticks: 600 }] });
    ok(r.ok && r.actions[1].state === 'done', JSON.stringify(r));
    const ev = await call(A, 'events', { since: s0, wait_s: 3, types: ['research_finished'] });
    ok(ev.events.some((e) => e.name === T || (e.data && e.data.name === T)), 'событие research_finished: ' + JSON.stringify(ev.events));
    ok((await tech('return {r = t.researched}')).r, 'технология открыта');
    eq((await inv()).lab, 1);
  } finally {
    await tech('t.researched = A.was for n, p in pairs(t.prerequisites) do p.researched = A.pre[n] == true end return true', saved);
  }
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

test('mine: огромный камень добывается дольше предела простоя (fb-088)', async () => {
  await reset({}, 30.5, 15.5);
  await world(`game.surfaces.nauvis.create_entity{name = 'huge-rock', position = {A.ox + 32.5, A.oy + 15.5}} return true`);
  const r = await call(A, 'mine', { target: { ...P(32.5, 15.5), name: 'huge-rock' }, wait_s: 30 });
  ok(r.ok && r.gone && r.gained >= 48, JSON.stringify(r));
  const i = await inv();
  ok(i.stone >= 24 && i.coal >= 24, JSON.stringify(i));
});

test('transfer put: патроны берутся из инвентаря, при нехватке — из слотов патронов, keep оставляет надетое (fb-093)', async () => {
  await reset({ 'gun-turret': 1, 'submachine-gun': 1, 'wooden-chest': 1 });
  const t = P(33, 15), c = P(36.5, 15.5);
  await call(A, 'place', { item: 'gun-turret', ...t });
  await call(A, 'place', { item: 'wooden-chest', ...c });
  // Магазины игра сама надевает в слот патронов.
  await world(`local e = storage.agent.agents[A.name].entity e.insert{name = 'firearm-magazine', count = 30} return true`, { name: NAME });
  let st = await call(A, 'status');
  eq([st.ammo['firearm-magazine'], st.inventory['firearm-magazine'] || 0], [30, 0], 'магазины надеты');
  let r = await call(A, 'transfer', { target: t, direction: 'put', item: 'firearm-magazine', count: 10, keep: 30 });
  ok(!r.ok && r.error.code === 'no_item' && /keep/.test(r.error.message), JSON.stringify(r));
  r = await call(A, 'transfer', { target: t, direction: 'put', item: 'firearm-magazine', count: 10 });
  ok(r.ok && r.moved === 10 && r.from_ammo === 10, JSON.stringify(r));
  // В инвентаре 5, просим 8: 5 из инвентаря и 3 из слотов.
  await world(`local e = storage.agent.agents[A.name].entity e.get_main_inventory().insert{name = 'firearm-magazine', count = 5} return true`, { name: NAME });
  r = await call(A, 'transfer', { target: c, direction: 'put', item: 'firearm-magazine', count: 8 });
  ok(r.ok && r.moved === 8 && r.from_ammo === 3, JSON.stringify(r));
  // Без count при непустом инвентаре надетое не трогается.
  await world(`local e = storage.agent.agents[A.name].entity e.get_main_inventory().insert{name = 'firearm-magazine', count = 2} return true`, { name: NAME });
  r = await call(A, 'transfer', { target: c, direction: 'put', item: 'firearm-magazine' });
  ok(r.ok && r.moved === 2 && r.from_ammo === undefined, JSON.stringify(r));
  // keep: из 17 надетых отдать можно только 12.
  r = await call(A, 'transfer', { target: c, direction: 'put', item: 'firearm-magazine', count: 50, keep: 5 });
  ok(r.ok && r.moved === 12 && r.from_ammo === 12, JSON.stringify(r));
  st = await call(A, 'status');
  eq(st.ammo['firearm-magazine'], 5);
  const w = await world(`local s = game.surfaces.nauvis
    return {turret = s.find_entity('gun-turret', {A.ox + 33, A.oy + 15}).get_item_count('firearm-magazine'),
      chest = s.find_entity('wooden-chest', {A.ox + 36.5, A.oy + 15.5}).get_item_count('firearm-magazine')}`);
  eq(w, { turret: 10, chest: 22 });
  // Не патроны из слотов не берутся и работают как раньше.
  r = await call(A, 'transfer', { target: c, direction: 'put', item: 'coal' });
  ok(!r.ok && r.error.code === 'no_item', JSON.stringify(r));
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

test('equip / unequip: оружие, патроны и броня между инвентарём и слотами; совместимость и место проверяются', async () => {
  await reset();
  // В основной инвентарь напрямую: e.insert сам разложил бы оружие и броню по слотам.
  const give = (items) => world(`local m = storage.agent.agents[A.name].entity.get_main_inventory()
    for n, c in pairs(A.items) do m.insert{name = n, count = c} end return true`, { name: NAME, items });
  await give({ pistol: 1, shotgun: 1, 'firearm-magazine': 30, 'shotgun-shell': 20, 'light-armor': 1, 'modular-armor': 1 });
  let st = await call(A, 'status');
  ok(st.weapons.length === 3 && !st.weapons[0].gun && st.inventory.pistol === 1, JSON.stringify(st.weapons));
  // Оружие — в первый свободный слот; патроны — только подходящие оружию в слоте.
  let r = await call(A, 'equip', { item: 'pistol' });
  ok(r.ok && r.kind === 'gun' && r.slot === 1 && r.weapons[0].gun === 'pistol', JSON.stringify(r));
  r = await call(A, 'equip', { item: 'shotgun-shell', slot: 1 });
  ok(!r.ok && r.error.code === 'no_space', JSON.stringify(r));
  r = await call(A, 'equip', { item: 'firearm-magazine', count: 7 });
  ok(r.ok && r.slot === 1 && r.moved === 7 && r.weapons[0].ammo === 'firearm-magazine' && r.weapons[0].count === 7, JSON.stringify(r));
  r = await call(A, 'equip', { item: 'firearm-magazine', slot: 1 });
  ok(r.ok && r.moved === 23 && r.weapons[0].count === 30, JSON.stringify(r));
  r = await call(A, 'equip', { item: 'firearm-magazine' });
  ok(!r.ok && r.error.code === 'no_item', JSON.stringify(r));
  // Оружие в занятый слот с чужими патронами не встаёт; в свободный — встаёт.
  r = await call(A, 'equip', { item: 'shotgun', slot: 1 });
  ok(!r.ok && r.error.code === 'not_allowed', JSON.stringify(r));
  r = await call(A, 'equip', { item: 'shotgun' });
  ok(r.ok && r.slot === 2, JSON.stringify(r));
  r = await call(A, 'equip', { item: 'shotgun-shell' });
  ok(r.ok && r.slot === 2 && r.moved === 20, JSON.stringify(r));
  st = await call(A, 'status');
  ok(st.guns.pistol === 1 && st.guns.shotgun === 1 && st.ammo['firearm-magazine'] === 30 && st.ammo['shotgun-shell'] === 20
    && !st.inventory.pistol && !st.inventory['firearm-magazine'], JSON.stringify(st));
  // Снять: патроны частично и целиком, оружие.
  r = await call(A, 'unequip', { item: 'firearm-magazine', count: 10 });
  ok(r.ok && r.moved === 10 && r.weapons[0].count === 20, JSON.stringify(r));
  r = await call(A, 'unequip', { item: 'firearm-magazine' });
  ok(r.ok && r.moved === 20 && !r.weapons[0].ammo, JSON.stringify(r));
  r = await call(A, 'unequip', { item: 'pistol' });
  ok(r.ok && r.slot === 1 && !r.weapons[0].gun, JSON.stringify(r));
  r = await call(A, 'unequip', { item: 'pistol' });
  ok(!r.ok && r.error.code === 'no_item', JSON.stringify(r));
  let mine = await inv();
  ok(mine.pistol === 1 && mine['firearm-magazine'] === 30, JSON.stringify(mine));
  // Броня: надеть, поменять местами, снять; инвентарь растёт и сжимается без потерь.
  r = await call(A, 'equip', { item: 'modular-armor' });
  ok(r.ok && r.kind === 'armor' && r.inventory_slots === 90, JSON.stringify(r));
  r = await call(A, 'equip', { item: 'modular-armor' });
  ok(!r.ok && r.error.code === 'no_item', JSON.stringify(r));
  r = await call(A, 'equip', { item: 'light-armor' });
  ok(r.ok && r.replaced === 'modular-armor' && r.inventory_slots === 80, JSON.stringify(r));
  r = await call(A, 'equip', { item: 'modular-armor' });
  ok(r.ok && r.replaced === 'light-armor' && r.inventory_slots === 90, JSON.stringify(r));
  // Инвентарь забит: ни снять броню с запасом слотов, ни сменить на меньшую — предметы на землю не сыплются.
  await give({ 'iron-plate': 100000 });
  r = await call(A, 'unequip', { item: 'modular-armor' });
  ok(!r.ok && r.error.code === 'no_space', JSON.stringify(r));
  r = await call(A, 'equip', { item: 'light-armor' });
  ok(!r.ok && r.error.code === 'no_space', JSON.stringify(r));
  eq(await world(`return {n = game.surfaces.nauvis.count_entities_filtered{area = {{A.ox - 2, A.oy - 2}, {A.ox + 62, A.oy + 32}}, type = 'item-entity'}}`).then((x) => x.n), 0);
  await world(`storage.agent.agents[A.name].entity.get_main_inventory().remove{name = 'iron-plate', count = 100000} return true`, { name: NAME });
  r = await call(A, 'unequip', { item: 'modular-armor' });
  ok(r.ok && r.inventory_slots === 80, JSON.stringify(r));
  st = await call(A, 'status');
  ok(st.inventory['modular-armor'] === 1 && st.inventory['light-armor'] === 1 && !st.armor['modular-armor'], JSON.stringify(st));
  eq((await call(A, 'equip', { item: 'iron-plate' })).http, 400);
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

// Сеть роботов рядом с персонажем: робопорт с питанием, роботы, сундук-поставщик с запасом.
const robots = (stock) => world(`
  local s, f = game.surfaces.nauvis, game.forces.player
  local rp = s.create_entity{name = 'roboport', position = {A.ox + 30, A.oy + 24}, force = f}
  s.create_entity{name = 'electric-energy-interface', position = {A.ox + 35, A.oy + 24}, force = f}
  s.create_entity{name = 'substation', position = {A.ox + 33, A.oy + 27}, force = f}
  rp.insert{name = 'logistic-robot', count = 10}
  rp.insert{name = 'construction-robot', count = 10}
  local c = s.create_entity{name = 'passive-provider-chest', position = {A.ox + 26.5, A.oy + 20.5}, force = f}
  for name, n in pairs(A.stock) do c.insert{name = name, count = n} end
  return true`, { stock });

test('configure request_items: заявка роботам на предметы для стоящей постройки', async () => {
  await reset({});
  await robots({ 'piercing-rounds-magazine': 100, coal: 50 });
  await world(`local s = game.surfaces.nauvis
    s.create_entity{name = 'gun-turret', position = {A.ox + 34, A.oy + 16}, force = 'player'}
    s.create_entity{name = 'stone-furnace', position = {A.ox + 34, A.oy + 19}, force = 'player'}
    return true`);
  const turret = { ...P(34, 16), name: 'gun-turret' }, furnace = { ...P(34, 19), name: 'stone-furnace' };
  let r = await call(A, 'configure', { target: turret, request_items: { 'piercing-rounds-magazine': 12 } });
  ok(r.ok && r.request_items['piercing-rounds-magazine'] === 12 && r.robots_in_range === true, JSON.stringify(r));
  let ins = await call(A, 'inspect', { target: turret });
  ok(ins.requests && ins.requests['piercing-rounds-magazine'] === 12, 'заявка видна в inspect: ' + JSON.stringify(ins));
  r = await call(A, 'configure', { target: furnace, request_items: [{ item: 'coal', count: 5 }] });
  ok(r.ok && r.request_items.coal === 5, JSON.stringify(r));
  r = await call(A, 'configure', { target: turret, request_items: { 'piercing-rounds-magazine': 5000 } });
  ok(!r.ok && r.error.code === 'no_space', JSON.stringify(r));
  r = await call(A, 'configure', { target: turret, request_items: { 'iron-plate': 5 } });
  ok(!r.ok && r.error.code === 'bad_request', 'турели некуда класть пластины: ' + JSON.stringify(r));
  r = await call(A, 'configure', { target: turret, request_items: { 'нет-такого': 5 } });
  ok(!r.ok && r.error.code === 'bad_request', JSON.stringify(r));
  let got;
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    got = await world(`local s = game.surfaces.nauvis
      local t = s.find_entity('gun-turret', {A.ox + 34, A.oy + 16}) local fu = s.find_entity('stone-furnace', {A.ox + 34, A.oy + 19})
      return {ammo = t.get_item_count('piercing-rounds-magazine'), coal = fu.get_item_count('coal')}`);
    if (got.ammo === 12 && got.coal === 5) break;
  }
  ok(got.ammo === 12 && got.coal === 5, 'роботы привезли ровно заказанное: ' + JSON.stringify(got));
  ins = await call(A, 'inspect', { target: turret });
  ok(!ins.requests, 'заявка исполнена: ' + JSON.stringify(ins.requests));
  // Снятие заявки: роботы ничего не везут.
  r = await call(A, 'configure', { target: turret, request_items: { 'piercing-rounds-magazine': 20 } });
  ok(r.ok, JSON.stringify(r));
  r = await call(A, 'configure', { target: turret, request_items: false });
  ok(r.ok && r.request_items === false, JSON.stringify(r));
  ins = await call(A, 'inspect', { target: turret });
  ok(!ins.requests, 'заявка снята: ' + JSON.stringify(ins.requests));
});

test('configure request_items издалека: видимая постройка — без досягаемости, прочие настройки и туман — out_of_reach', async () => {
  await reset({});
  // Турель в 25 клетках: вне досягаемости, но в обзоре бота. Вторая — в открытом на карте, но не видимом чанке.
  const far = await world(`local s, f = game.surfaces.nauvis, game.forces.player
    s.create_entity{name = 'gun-turret', position = {A.ox + 55, A.oy + 5}, force = f}
    local bots = {}
    for _, a in pairs(storage.agent.agents) do if a.entity and a.entity.valid then bots[#bots + 1] = a.entity.position end end
    for c in s.get_chunks() do
      if f.is_chunk_charted(s, c) and not f.is_chunk_visible(s, c) then
        local ok = true
        for _, p in pairs(bots) do if math.abs(math.floor(p.x / 32) - c.x) <= 3 and math.abs(math.floor(p.y / 32) - c.y) <= 3 then ok = false end end
        local pos = ok and s.find_non_colliding_position('gun-turret', {c.x * 32 + 16, c.y * 32 + 16}, 8, 1)
        if pos then
          local t = s.create_entity{name = 'gun-turret', position = pos, force = f}
          return {x = t.position.x, y = t.position.y}
        end
      end
    end
    error('нет открытого чанка без обзора')`);
  const turret = { ...P(55, 5), name: 'gun-turret' };
  let ins = await call(A, 'inspect', { target: turret });
  ok(ins.found && ins.in_reach === false, 'турель видна, но вне досягаемости: ' + JSON.stringify(ins));
  let r = await call(A, 'configure', { target: turret, request_items: { 'piercing-rounds-magazine': 10 } });
  ok(r.ok && r.remote === true && r.request_items['piercing-rounds-magazine'] === 10, JSON.stringify(r));
  ins = await call(A, 'inspect', { target: turret });
  ok(ins.requests && ins.requests['piercing-rounds-magazine'] === 10, 'заявка видна в inspect: ' + JSON.stringify(ins));
  r = await call(A, 'configure', { target: turret, request_items: false });
  ok(r.ok && r.request_items === false && r.remote === true, JSON.stringify(r));
  // Заявка вместе с другой настройкой и другая настройка сама по себе — как раньше, нужна досягаемость.
  r = await call(A, 'configure', { target: turret, request_items: { 'piercing-rounds-magazine': 10 }, direction: 'east' });
  ok(!r.ok && r.error.code === 'out_of_reach', JSON.stringify(r));
  r = await call(A, 'configure', { target: turret, direction: 'east' });
  ok(!r.ok && r.error.code === 'out_of_reach', JSON.stringify(r));
  ins = await call(A, 'inspect', { target: turret });
  ok(!ins.requests, 'отказ ничего не оставил: ' + JSON.stringify(ins.requests));
  // Список: далёкая заявка исполняется, далёкий поворот — нет.
  r = await call(A, 'configure', { items: [{ target: turret, request_items: { 'firearm-magazine': 5 } }, { target: turret, rotate: true }] });
  ok(r.ok && r.done === 1 && r.skipped === 1 && r.items[0].ok && r.items[0].remote === true && r.items[1].code === 'out_of_reach', JSON.stringify(r));
  // Вне обзора заявку не поставить.
  r = await call(A, 'configure', { target: { x: far.x, y: far.y, name: 'gun-turret' }, request_items: { 'firearm-magazine': 5 } });
  ok(!r.ok && r.error.code === 'out_of_reach', JSON.stringify(r));
  const left = await world(`local t = game.surfaces.nauvis.find_entity('gun-turret', {A.x, A.y})
    local had = t.item_request_proxy ~= nil
    t.destroy()
    return {had = had}`, { x: far.x, y: far.y });
  ok(left.had === false, 'на турели вне обзора заявки нет');
});

test('logistic_requests: личные запросы персонажа, роботы довозят до min', async () => {
  await reset({});
  const was = await world(`local f = game.forces.player local was = f.character_logistic_requests f.character_logistic_requests = false return {was = was}`);
  try {
    let r = await call(A, 'logistic_requests', {});
    ok(r.ok && r.available === false, 'не исследовано: ' + JSON.stringify(r));
    r = await call(A, 'logistic_requests', { set: [{ item: 'iron-plate', min: 10 }] });
    ok(!r.ok && r.error.code === 'not_allowed', JSON.stringify(r));
    await world(`game.forces.player.character_logistic_requests = true return true`);
    await call(A, 'logistic_requests', { clear: true });
    await robots({ 'iron-plate': 200, 'copper-plate': 100 });
    r = await call(A, 'logistic_requests', { set: [{ item: 'iron-plate', min: 30, max: 60 }, { item: 'copper-plate', min: 10 }] });
    ok(r.ok && r.available && r.enabled && r.requests.length === 2, JSON.stringify(r));
    const iron = r.requests.find((x) => x.item === 'iron-plate');
    ok(iron.min === 30 && iron.max === 60 && iron.have === 0, JSON.stringify(r));
    r = await call(A, 'logistic_requests', { set: [{ item: 'iron-plate', min: 40 }], clear: ['copper-plate'] });
    ok(r.ok && r.requests.length === 1 && r.requests[0].min === 40 && r.in_network === true, 'изменение и снятие одного: ' + JSON.stringify(r));
    r = await call(A, 'logistic_requests', { set: [{ item: 'iron-plate', min: 50, max: 10 }] });
    ok(!r.ok && r.error.code === 'bad_request', JSON.stringify(r));
    let have = 0;
    for (let i = 0; i < 40 && have < 40; i++) { await sleep(500); have = (await inv())['iron-plate'] || 0; }
    ok(have === 40, 'роботы привезли 40 пластин: ' + have);
    eq((await inv())['copper-plate'], undefined);
    r = await call(A, 'logistic_requests', { clear: true });
    ok(r.ok && r.requests.length === 0, JSON.stringify(r));
  } finally {
    await world(`local e = storage.agent.agents[A.name].entity local p = e.get_requester_point()
      if p then for _, sec in pairs(p.sections) do if sec.is_manual then for i = sec.filters_count, 1, -1 do sec.clear_slot(i) end end end end
      game.forces.player.character_logistic_requests = A.was return true`, { name: NAME, was: was.was });
  }
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

test('say, craft и research тело не занимают: исполняются сразу, пока персонаж занят, а в списке act идут по порядку', async () => {
  await reset({ 'iron-plate': 10 });
  const w = await call(A, 'wait', { ticks: 600, wait: false });
  const s = await call(A, 'say', { text: 'говорю на ходу' });
  ok(s.ok && s.sent && s.ms < 300, 'say не ждёт очереди: ' + JSON.stringify(s));
  const c = await call(A, 'craft', { item: 'iron-gear-wheel', count: 2 });
  ok(c.ok && c.queued === 2 && c.ms < 300, 'craft не ждёт очереди: ' + JSON.stringify(c));
  const r = await call(A, 'research', { add: [] });
  ok(r.ok && r.ms < 300, 'research не ждёт очереди: ' + JSON.stringify(r));
  eq((await call(A, 'queue')).queue.length, 1, 'ожидание продолжает стоять в очереди одно');
  // В общем списке с действием тела — по порядку: реплика после ожидания.
  const m = await call(A, 'act', { actions: [{ type: 'wait', ticks: 30 }, { type: 'say', text: 'после ожидания' }], wait: false });
  eq((await call(A, 'queue')).queue.length, 3);
  await call(A, 'clear');
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

// --- стрельба ---
// Враги для проверок: заморожены (не кусаются и не убегают), если не сказано иное. Возвращает число созданных.
const enemies = (name, list, frozen = true) => world(`
  local s, n = game.surfaces.nauvis, 0
  storage.test_enemies = {}
  for _, d in pairs(A.list) do
    local b = s.create_entity{name = A.enemy, position = {A.ox + d[1], A.oy + d[2]}, force = 'enemy'}
    if b then n = n + 1 b.disabled_by_script = A.frozen storage.test_enemies[#storage.test_enemies + 1] = b end
  end
  return {n = n}`, { enemy: name, list, frozen }).then((r) => r.n);
// Образцовая карта живая: дикие кусаки приходят на выстрелы и портят счёт. Перед проверкой стрельбы убираем врагов в округе.
const calm = () => world(`for _, x in pairs(game.surfaces.nauvis.find_entities_filtered{force = 'enemy', position = {A.ox + 30, A.oy + 15}, radius = 250}) do x.destroy() end return true`);
const alive = () => world(`local n, hp = 0, 0 for _, b in pairs(storage.test_enemies or {}) do if b.valid then n = n + 1 hp = hp + b.health end end return {n = n, hp = hp}`);
// Оружие и патроны прямо в слоты (подготовка): [[оружие, патроны, сколько], …].
const arm = (slots) => world(`local e = storage.agent.agents[A.name].entity
  local g, a = e.get_inventory(defines.inventory.character_guns), e.get_inventory(defines.inventory.character_ammo)
  g.clear() a.clear()
  for i, s in pairs(A.slots) do g[i].set_stack{name = s[1], count = 1} if s[2] then a[i].set_stack{name = s[2], count = s[3]} end end
  e.selected_gun_index = 1 return true`, { name: NAME, slots });
const until = async (fn, ms = 6000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(100); } };
const shotEvent = async (since, id) => until(async () => (await call(A, 'events', { since, types: ['shooting_done'] })).events.find((e) => e.action_id === id));

test('shoot: огонь по ближайшим врагам в дальности, итог — убитые и остаток патронов; без оружия — отказ', async () => {
  await reset();
  await calm();
  let r = await call(A, 'shoot', {});
  ok(!r.ok && r.error.code === 'no_item' && r.error.data.weapons.length === 3, JSON.stringify(r));
  await arm([['submachine-gun', 'firearm-magazine', 10]]);
  eq(await enemies('small-biter', [[38.5, 15.5], [40.5, 13.5], [40.5, 18.5]]), 3);
  const s0 = (await call(A, 'events')).seq;
  r = await call(A, 'shoot', { duration_s: 30 });
  ok(r.ok && r.shooting && r.mode === 'enemies' && r.gun === 'submachine-gun' && r.range === 18 && r.enemies_in_range === 3 && r.ammo_count === 10, JSON.stringify(r));
  ok(r.ms < 100, `shoot отвечает сразу: ${r.ms} мс`);
  await until(async () => (await alive()).n === 0);
  const st = await call(A, 'status');
  ok(st.shooting && st.shooting.killed === 3 && st.shooting.mode === 'enemies' && st.shooting.seconds_left > 20, JSON.stringify([st.shooting, await alive()]));
  eq((await alive()).n, 0);
  // Огонь зажат и без врагов: патроны не тратятся, игра на паузу не встаёт.
  const busy = await call('t-admin', 'pause_if_idle', { ignore: ['tester', 'camera'] });
  ok(busy.paused === false && busy.busy >= 1, 'зажатый огонь держит игру ' + JSON.stringify(busy));
  r = await call(A, 'stop_shooting');
  ok(r.ok && r.shooting === false && r.reason === 'stopped' && r.killed === 3 && r.kills['small-biter'] === 3 && r.ammo_left['firearm-magazine'] >= 8, JSON.stringify(r));
  const ev = await shotEvent(s0, r.action_id);
  ok(ev && ev.reason === 'stopped' && ev.killed === 3, JSON.stringify(ev));
  ok((await call(A, 'stop_shooting')).already === true, 'повторный stop_shooting');
  ok((await call(A, 'status')).shooting === undefined, 'status без shooting');
});

test('shoot target: вне дальности выстрелов нет, огонь начинается на ходу; цель убита — конец; по своим и деревьям нельзя', async () => {
  await reset({}, 5.5, 15.5);
  await calm();
  await arm([['submachine-gun', 'firearm-magazine', 10]]);
  eq(await enemies('small-biter', [[35.5, 15.5]]), 1); // 30 клеток при дальности 18
  await world(`game.surfaces.nauvis.create_entity{name = 'wooden-chest', position = {A.ox + 8.5, A.oy + 15.5}, force = 'player'} return true`);
  let r = await call(A, 'shoot', { target: P(8.5, 15.5) });
  ok(!r.ok && r.error.code === 'not_allowed', JSON.stringify(r));
  r = await call(A, 'shoot', { target: P(50.5, 2.5) });
  ok(!r.ok && r.error.code === 'not_found', JSON.stringify(r));
  const s0 = (await call(A, 'events')).seq;
  r = await call(A, 'shoot', { target: { ...P(35.5, 15.5), name: 'small-biter' }, duration_s: 60 });
  ok(r.ok && r.mode === 'target' && r.in_range === false && Math.abs(r.distance - 30) < 0.1 && r.target.name === 'small-biter', JSON.stringify(r));
  await sleep(700);
  eq((await alive()).n, 1); // далеко: жив и цел
  ok((await alive()).hp === 15, 'цель вне дальности не задета');
  // Идём к цели, не отпуская огня: ходьба — в очереди действий, огонь — мимо неё.
  const w = await call(A, 'walk_to', { ...P(25.5, 17.5), wait: false });
  ok(w.ok, JSON.stringify(w));
  const ev = await shotEvent(s0, r.action_id);
  ok(ev && ev.reason === 'target_dead' && ev.killed === 1, JSON.stringify(ev));
  const st = await call(A, 'status');
  ok(st.walking === true || st.queue.length > 0 || Math.abs(st.position.x - (O.x + 25.5)) < 1, 'ходьба продолжается: ' + JSON.stringify(st.position));
  await call(A, 'clear');
});

test('shoot: прицел в точку, гнёзда — тоже цель; патроны кончились — следующее оружие, потом no_ammo; срок вышел — duration', async () => {
  await reset({}, 20.5, 15.5);
  await calm();
  await arm([['pistol', 'firearm-magazine', 1], ['submachine-gun', 'firearm-magazine', 1]]);
  eq(await enemies('biter-spawner', [[30.5, 15.5]]), 1);
  const full = (await alive()).hp;
  let s0 = (await call(A, 'events')).seq;
  let r = await call(A, 'shoot', { at: P(30.5, 15.5), duration_s: 60 });
  ok(r.ok && r.mode === 'enemies' && r.slot === 1 && r.gun === 'pistol' && r.enemies_in_range === 1, JSON.stringify(r));
  let ev = await shotEvent(s0, r.action_id);
  ok(ev && ev.reason === 'no_ammo' && Object.keys(ev.ammo_left).length === 0, JSON.stringify(ev));
  ok((await alive()).hp < full, 'гнездо получило урон');
  ok((await call(A, 'status')).weapons.every((w) => !w.ammo), 'оба слота пусты: стрелял и автомат');
  // Нет врагов и короткий срок: огонь отпускается сам, патроны целы.
  await reset();
  await arm([['submachine-gun', 'firearm-magazine', 5]]);
  s0 = (await call(A, 'events')).seq;
  r = await call(A, 'shoot', { duration_s: 0.5 });
  ev = await shotEvent(s0, r.action_id);
  ok(ev && ev.reason === 'duration' && ev.killed === 0 && ev.ammo_left['firearm-magazine'] === 5, JSON.stringify(ev));
  r = await call(A, 'shoot', { duration_s: 500 });
  ok(!r.ok && r.error.code === 'bad_request', JSON.stringify(r));
  // Повторный shoot сменяет прежний и продлевает огонь.
  s0 = (await call(A, 'events')).seq;
  const first = await call(A, 'shoot', { duration_s: 5 });
  const second = await call(A, 'shoot', { duration_s: 5, slot: 1 });
  ev = await shotEvent(s0, first.action_id);
  ok(ev && ev.reason === 'replaced' && second.ok, JSON.stringify(ev));
  await call(A, 'stop_shooting');
});

test('shoot: стая живых кусак нападает — бот отстреливается и остаётся жив; команда исполняется, пока тело занято', async () => {
  await reset({ 'iron-plate': 10 }, 10.5, 15.5);
  await calm();
  await arm([['submachine-gun', 'firearm-magazine', 20]]);
  // Тело занято долгим действием: огонь должен открыться сразу, а не после него.
  const w = await call(A, 'wait', { ticks: 1200, wait: false });
  eq(await enemies('small-biter', [[30.5, 12.5], [30.5, 14.5], [30.5, 16.5], [30.5, 18.5], [32.5, 15.5], [33.5, 13.5]], false), 6);
  const s0 = (await call(A, 'events')).seq;
  const r = await call(A, 'shoot', { duration_s: 60 });
  ok(r.ok && r.ms < 100, JSON.stringify(r));
  await world(`for _, b in pairs(storage.test_enemies) do if b.valid then b.commandable.set_command{type = defines.command.attack, target = storage.agent.agents[A.name].entity} end end return true`, { name: NAME });
  const gone = await until(async () => (await alive()).n === 0, 15000);
  ok(gone, 'кусаки убиты: осталось ' + JSON.stringify(await alive()));
  const st = await call(A, 'status');
  ok(st.deaths === (await call(A, 'status')).deaths && st.health > 0 && st.shooting.killed === 6, JSON.stringify([st.health, st.shooting]));
  ok(st.queue.length === 1 && st.queue[0].action_id === w.action_id, 'действие тела не прервано огнём');
  const end = await call(A, 'stop_shooting');
  ok(end.killed === 6 && end.kills['small-biter'] === 6, JSON.stringify(end));
  ok(await shotEvent(s0, r.action_id), 'событие shooting_done');
  await call(A, 'clear');
});

const throwEvent = async (since, id) => until(async () => (await call(A, 'events', { since, types: ['throw_done'] })).events.find((e) => e.action_id === id));

test('throw: граната летит в точку и убивает; дальность и перезарядка — по капсуле; не капсула и нет предмета — отказ', async () => {
  await reset({ grenade: 5, 'iron-plate': 5 }, 20.5, 15.5);
  await calm();
  let r = await call(A, 'throw', { item: 'iron-plate', at: P(30.5, 15.5) });
  ok(!r.ok && r.error.code === 'bad_request', JSON.stringify(r));
  r = await call(A, 'throw', { item: 'poison-capsule', at: P(30.5, 15.5) });
  ok(!r.ok && r.error.code === 'no_item', JSON.stringify(r));
  r = await call(A, 'throw', { item: 'grenade' });
  ok(!r.ok && r.error.code === 'bad_request', JSON.stringify(r));
  r = await call(A, 'throw', { item: 'grenade', at: P(40.5, 15.5) }); // 20 клеток при дальности 15
  ok(!r.ok && r.error.code === 'out_of_range' && r.error.data.range === 15 && r.error.data.distance === 20, JSON.stringify(r));
  eq((await inv()).grenade, 5);
  eq(await enemies('small-biter', [[30.5, 15.5], [31.5, 15.5], [30.5, 16.5]]), 3);
  // Тело занято: бросок всё равно исполняется сразу.
  const w = await call(A, 'wait', { ticks: 600, wait: false });
  r = await call(A, 'throw', { item: 'grenade', at: P(30.5, 15.5) });
  ok(r.ok && r.thrown === 1 && r.done === true && r.reason === 'done' && r.left === 4 && r.range === 15 && r.cooldown_ticks === 30 && r.distance === 10 && r.kind === 'throw', JSON.stringify(r));
  ok(r.ms < 100, `throw отвечает сразу: ${r.ms} мс`);
  // Второй бросок сразу следом: не отказ, а ожидание перезарядки; предмет тратится только при броске.
  const s0 = (await call(A, 'events')).seq;
  const r2 = await call(A, 'throw', { item: 'grenade', at: P(30.5, 15.5) });
  ok(r2.ok && r2.thrown === 0 && r2.done === false && r2.next_in_ticks > 0 && r2.next_in_ticks <= 30 && r2.left === 4, JSON.stringify(r2));
  const ev = await throwEvent(s0, r2.action_id);
  ok(ev && ev.reason === 'done' && ev.thrown === 1 && ev.left === 3, JSON.stringify(ev));
  ok(await until(async () => (await alive()).n === 0), 'кусаки убиты гранатами: ' + JSON.stringify(await alive()));
  const st = await call(A, 'status');
  ok(st.throwing === undefined && st.queue.length === 1 && st.queue[0].action_id === w.action_id, 'действие тела не прервано: ' + JSON.stringify(st.queue));
  await call(A, 'clear');
});

test('throw count: серия по одной за перезарядку в цель; цель погибла — конец; stop_throwing и замена серии', async () => {
  await reset({ grenade: 10 }, 20.5, 15.5);
  await calm();
  await call(A, 'stop_throwing');
  await sleep(700); // перезарядка после прошлой проверки
  eq(await enemies('biter-spawner', [[31.5, 15.5]]), 1);
  const full = (await alive()).hp;
  let s0 = (await call(A, 'events')).seq;
  const t0 = (await call(A, 'status')).tick;
  let r = await call(A, 'throw', { item: 'grenade', target: { ...P(31.5, 15.5), name: 'biter-spawner' }, count: 4 });
  ok(r.ok && r.thrown === 1 && r.done === false && r.count === 4 && r.target.name === 'biter-spawner' && r.left === 9, JSON.stringify(r));
  let st = await call(A, 'status');
  ok(st.throwing && st.throwing.count === 4 && st.throwing.item === 'grenade', JSON.stringify(st.throwing));
  let ev = await throwEvent(s0, r.action_id);
  ok(ev && ev.reason === 'done' && ev.thrown === 4 && ev.left === 6, JSON.stringify(ev));
  const t1 = (await call(A, 'events', { since: s0, types: ['throw_done'] })).events.find((e) => e.action_id === r.action_id).tick;
  ok(t1 - t0 >= 90, `три перезарядки по 30 тиков: прошло ${t1 - t0}`);
  ok(await until(async () => (await alive()).hp < full - 50), 'гнездо получило урон: ' + JSON.stringify(await alive()));
  // Серия прерывается stop_throwing, новая команда сменяет прежнюю.
  s0 = (await call(A, 'events')).seq;
  r = await call(A, 'throw', { item: 'grenade', at: P(30.5, 15.5), count: 6 });
  const r2 = await call(A, 'throw', { item: 'grenade', at: P(30.5, 14.5), count: 6 });
  ok(r2.ok && r2.replaced === r.action_id, JSON.stringify(r2));
  ev = await throwEvent(s0, r.action_id);
  ok(ev && ev.reason === 'replaced', JSON.stringify(ev));
  const stop = await call(A, 'stop_throwing');
  ok(stop.ok && stop.throwing === false && stop.reason === 'stopped' && stop.thrown < 6 && stop.left >= 3, JSON.stringify(stop));
  ok((await call(A, 'stop_throwing')).already === true, 'повторный stop_throwing');
  // Цель должна быть видна и существовать.
  r = await call(A, 'throw', { item: 'grenade', target: P(50.5, 2.5) });
  ok(!r.ok && r.error.code === 'not_found', JSON.stringify(r));
});

test('throw: рыба лечит (при полном здоровье — отказ), дрон-защитник летит за персонажем, взрывчатка сносит скалу', async () => {
  await reset({ 'raw-fish': 3, 'defender-capsule': 2, 'cliff-explosives': 2 }, 20.5, 15.5);
  await calm();
  await call(A, 'stop_throwing');
  await sleep(700);
  let r = await call(A, 'throw', { item: 'raw-fish' });
  ok(!r.ok && r.error.code === 'not_allowed', JSON.stringify(r));
  eq((await inv())['raw-fish'], 3);
  await world(`storage.agent.agents[A.name].entity.health = 100 return true`, { name: NAME });
  r = await call(A, 'throw', { item: 'raw-fish' });
  ok(r.ok && r.kind === 'use-on-self' && r.thrown === 1 && r.done && r.left === 2 && r.health > 150, JSON.stringify(r));
  await sleep(700);
  r = await call(A, 'throw', { item: 'defender-capsule', at: P(25.5, 15.5) });
  ok(r.ok && r.thrown === 1 && r.range === 20 && r.left === 1, JSON.stringify(r));
  const robot = await until(() => world(`local e = storage.agent.agents[A.name].entity
    for _, x in pairs(e.surface.find_entities_filtered{type = 'combat-robot', position = e.position, radius = 15}) do
      if x.combat_robot_owner == e then return {name = x.name} end
    end return false`, { name: NAME }));
  ok(robot && robot.name === 'defender', 'дрон следует за персонажем: ' + JSON.stringify(robot));
  // Взрывчатка: без скалы — отказ и предмет цел, со скалой — скалы нет.
  r = await call(A, 'throw', { item: 'cliff-explosives', at: P(26.5, 15.5) });
  ok(!r.ok && r.error.code === 'not_found', JSON.stringify(r));
  eq((await inv())['cliff-explosives'], 2);
  const cliff = await world(`local c = game.surfaces.nauvis.create_entity{name = 'cliff', position = {A.ox + 26, A.oy + 16}, cliff_orientation = 'west-to-east'} return {x = c.position.x, y = c.position.y}`);
  eq(await count('cliff'), 1);
  await sleep(700);
  r = await call(A, 'throw', { item: 'cliff-explosives', at: cliff });
  ok(r.ok && r.kind === 'destroy-cliffs' && r.thrown === 1 && r.left === 1 && r.range === 10, JSON.stringify(r));
  ok(await until(async () => (await count('cliff')) === 0), 'скала снесена');
});

test('события боя: enemies_near при появлении и при росте числа врагов; agent_health на порогах 75 / 50 / 25 %', async () => {
  await reset({}, 20.5, 15.5);
  await calm();
  await sleep(2600); // врагов нет: прошлое «рядом» забыто
  const evs = async (since, type) => (await call(A, 'events', { since, types: [type] })).events;
  let s0 = (await call(A, 'events')).seq;
  eq(await enemies('small-biter', [[35.5, 15.5], [36.5, 15.5]]), 2);
  let ev = await until(async () => (await evs(s0, 'enemies_near'))[0], 3000);
  ok(ev && ev.count === 2 && ev.prev_count === undefined && ev.nearest.name === 'small-biter', JSON.stringify(ev));
  // Подошла вторая группа: событие приходит через секунду-другую, а не через 10.
  await world(`for i = 1, 4 do local b = game.surfaces.nauvis.create_entity{name = 'small-biter', position = {A.ox + 30.5 + i, A.oy + 20.5}, force = 'enemy'} b.disabled_by_script = true end return true`);
  const grown = await until(async () => (await evs(s0, 'enemies_near'))[1], 4000);
  ok(grown && grown.count === 6 && grown.prev_count === 2, JSON.stringify(grown));
  await sleep(1500);
  eq((await evs(s0, 'enemies_near')).length, 2, 'без роста событие не повторяется сразу');
  // Здоровье: 250 → 180 (порог 75), → 170 (без события), → 50 (пороги 50 и 25 разом — одно событие с нижним).
  s0 = (await call(A, 'events')).seq;
  const hit = (n) => world(`local e = storage.agent.agents[A.name].entity e.damage(A.n, 'enemy', 'impact') return {health = e.health}`, { name: NAME, n });
  await world(`local e = storage.agent.agents[A.name].entity e.health = e.max_health return true`, { name: NAME });
  const h1 = (await hit(70)).health;
  await hit(10);
  const h3 = (await hit(120)).health;
  const hs = await evs(s0, 'agent_health');
  ok(hs.length === 2 && hs[0].threshold === 75 && hs[0].max_health === 250 && Math.abs(hs[0].health - h1) < 0.01 && hs[1].threshold === 25 && Math.abs(hs[1].health - h3) < 0.01,
    JSON.stringify([hs, h1, h3]));
  await calm();
});

run(async () => { admin.close(); });
