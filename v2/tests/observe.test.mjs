#!/usr/bin/env node
// Наблюдение и события: окно объекта, карта области, поиск, туман войны и память карты, события мира.
import { call, lua, admin, sleep } from './lib.mjs';
import { test, ok, eq, run } from './harness.mjs';

const A = 't-b6', NAME = 'bench-6', B = 't-b7';
await call(A, 'status'); await call(B, 'status');
// Чанк, открытый на карте, но без обзора (далеко от радаров, людей и ботов), с местом под постройки.
const F = await lua(`
  local s, f = game.surfaces.nauvis, game.forces.player
  local bots = {}
  for _, a in pairs(storage.agent.agents) do if a.entity and a.entity.valid then bots[#bots + 1] = a.entity.position end end
  for c in s.get_chunks() do
    if f.is_chunk_charted(s, c) and not f.is_chunk_visible(s, c) then
      local far = true
      for _, p in pairs(bots) do if math.abs(math.floor(p.x / 32) - c.x) <= 3 and math.abs(math.floor(p.y / 32) - c.y) <= 3 then far = false end end
      local area = {{c.x * 32 + 4, c.y * 32 + 4}, {c.x * 32 + 28, c.y * 32 + 28}}
      if far and s.count_entities_filtered{area = area, type = 'character', invert = true} == 0 and s.count_tiles_filtered{area = area, collision_mask = 'player'} == 0 then
        return {cx = c.x, cy = c.y, x = c.x * 32 + 16, y = c.y * 32 + 16}
      end
    end
  end
  error('нет открытого чанка без обзора')`);
const put = (x, y) => lua(`local e = storage.agent.agents[A.n].entity e.teleport(e.surface.find_non_colliding_position('character', {A.x, A.y}, 10, 0.5)) return true`, { n: NAME, x, y });

test('inspect: окно объекта со слотами; пустое место — found: false', async () => {
  const f = await lua(`
    local s = game.surfaces.nauvis
    for _, e in pairs(s.find_entities_filtered{type = 'furnace', force = 'player'}) do
      if game.forces.player.is_chunk_visible(s, {math.floor(e.position.x / 32), math.floor(e.position.y / 32)}) and not e.get_fuel_inventory().is_empty() then return {x = e.position.x, y = e.position.y, unit = e.unit_number} end
    end`);
  const r = await call(A, 'inspect', { target: { x: f.x, y: f.y, unit: f.unit } });
  ok((await call(A, 'inspect', { target: { x: f.x, y: f.y, unit: f.unit + 1 } })).found === false, 'номер не совпал — объект не тот');
  ok(r.ok && r.found && r.type === 'furnace' && r.inventory && r.inventory.fuel && r.status && typeof r.distance === 'number', JSON.stringify(r));
  const many = await call(A, 'inspect', { targets: [{ x: f.x, y: f.y }, { x: F.x + 5.5, y: F.y + 5.5 }] });
  ok(many.objects[0].found && many.objects[1].found === false, JSON.stringify(many));
});

test('inspect: жидкости у бака, трубы и НПЗ (fb-063)', async () => {
  const p = await lua(`
    local a = storage.agent.agents[A.n].entity
    local s = a.surface
    local o = s.find_non_colliding_position('oil-refinery', a.position, 40, 1, true)
    local made = {}
    local tank = s.create_entity{name = 'storage-tank', position = {o.x, o.y}, force = 'player'}
    tank.insert_fluid{name = 'water', amount = 5000}
    made[#made + 1] = tank
    local pp = s.find_non_colliding_position('pipe', {o.x + 6, o.y}, 20, 1, true)
    local pipe = s.create_entity{name = 'pipe', position = pp, force = 'player'}
    pipe.insert_fluid{name = 'crude-oil', amount = 40}
    made[#made + 1] = pipe
    local rp = s.find_non_colliding_position('oil-refinery', {o.x, o.y + 10}, 40, 1, true)
    local ref = s.create_entity{name = 'oil-refinery', position = rp, force = 'player'}
    ref.set_recipe('basic-oil-processing')
    ref.insert_fluid{name = 'crude-oil', amount = 70}
    made[#made + 1] = ref
    storage.test_fluids = made
    return {tank = tank.position, pipe = pipe.position, ref = ref.position}`, { n: NAME });
  try {
    const r = await call(A, 'inspect', { targets: [p.tank, p.pipe, p.ref] });
    const [tank, pipe, ref] = r.objects;
    ok(tank.fluids && tank.fluids[0].name === 'water' && tank.fluids[0].amount === 5000 && tank.fluids[0].capacity === 25000, JSON.stringify(tank));
    const pf = pipe.fluids && pipe.fluids[0];
    ok(pf && pf.name === 'crude-oil' && (pf.amount === 40 || (pf.segment && pf.segment.amount === 40)), JSON.stringify(pipe));
    const crude = ref.fluids && ref.fluids.find((f) => f.name === 'crude-oil');
    ok(crude && crude.amount === 70 && crude.capacity > 0, JSON.stringify(ref));
  } finally {
    await lua(`for _, e in pairs(storage.test_fluids or {}) do if e.valid then e.destroy() end end storage.test_fluids = nil return true`);
  }
});

test('туман войны: объект вне обзора — по памяти карты, без содержимого; построенное после снимка не видно; враги не показываются', async () => {
  // Сундук появляется, потом карта чанка обновляется (как после прохода радара) — он попадает «на карту».
  await lua(`
    local s, f = game.surfaces.nauvis, game.forces.player
    local c = s.create_entity{name = 'wooden-chest', position = {A.x + 0.5, A.y + 0.5}, force = 'player', raise_built = true}
    c.insert{name = 'iron-plate', count = 50}
    storage.test_fog = {old = c}
    f.chart(s, {{A.x - 2, A.y - 2}, {A.x + 2, A.y + 2}})
    return true`, F);
  // После обновления карты чанк ещё около 10 секунд виден вживую; ждём, пока обзор кончится.
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const v = await lua(`return {v = game.forces.player.is_chunk_visible(game.surfaces.nauvis, {A.cx, A.cy})}`, F);
    if (!v.v) break;
  }
  await lua(`
    local s = game.surfaces.nauvis
    storage.test_fog.new = s.create_entity{name = 'iron-chest', position = {A.x + 4.5, A.y + 0.5}, force = 'player', raise_built = true}
    storage.test_fog.biter = s.create_entity{name = 'small-biter', position = {A.x + 8, A.y + 8}, force = 'enemy'}
    storage.test_fog.nest = s.create_entity{name = 'biter-spawner', position = {A.x - 8, A.y - 8}, force = 'enemy'}
    return true`, F);
  const vis = await lua(`local f, s = game.forces.player, game.surfaces.nauvis return {v = f.is_chunk_visible(s, {A.cx, A.cy}), c = f.is_chunk_charted(s, {A.cx, A.cy})}`, F);
  eq(vis, { v: false, c: true }, 'чанк открыт, но не виден');
  const old = await call(A, 'inspect', { target: { x: F.x + 0.5, y: F.y + 0.5 } });
  ok(old.found && old.memory === true && old.name === 'wooden-chest' && !old.inventory && !old.status, JSON.stringify(old));
  const fresh = await call(A, 'inspect', { target: { x: F.x + 4.5, y: F.y + 0.5 } });
  ok(fresh.found === false, 'построенное после снимка карты не видно: ' + JSON.stringify(fresh));
  const biter = await call(A, 'inspect', { target: { x: F.x + 8, y: F.y + 8 } });
  ok(biter.found === false, 'враг вне обзора не виден: ' + JSON.stringify(biter));
  const en = await call(A, 'enemies', { x: F.x, y: F.y, radius: 20 });
  ok(en.units_total === 0 && en.nests.length === 1 && en.nests[0].memory === true, JSON.stringify(en));
  const found = await call(A, 'find', { names: ['wooden-chest', 'iron-chest', 'small-biter'], x: F.x, y: F.y, radius: 20 });
  ok(found.total === 1 && found.objects[0].memory && found.objects[0].name === 'wooden-chest', JSON.stringify(found));
  const ar = await call(A, 'area', { area: { x1: F.x - 2, y1: F.y - 2, x2: F.x + 10, y2: F.y + 10 }, objects: true });
  ok(ar.fog_rows && ar.fog_rows[0][0] === 'm' && ar.objects.length === 1 && ar.objects[0].memory, JSON.stringify(ar).slice(0, 600));
  // Сундук разрушен без свидетелей: на карте он по-прежнему значится.
  await lua(`storage.test_fog.old.die() return true`);
  const gone = await call(A, 'inspect', { target: { x: F.x + 0.5, y: F.y + 0.5 } });
  ok(gone.found && gone.memory && gone.name === 'wooden-chest', 'разрушенное без свидетелей остаётся в памяти карты: ' + JSON.stringify(gone));
});

test('бот открывает карту вокруг себя, как игрок: вблизи всё видно вживую', async () => {
  await put(F.x - 3, F.y + 3);
  await sleep(1300);
  const fresh = await call(A, 'inspect', { target: { x: F.x + 4.5, y: F.y + 0.5 } });
  ok(fresh.found && !fresh.memory && fresh.name === 'iron-chest' && fresh.in_reach === true, JSON.stringify(fresh));
  const gone = await call(A, 'inspect', { target: { x: F.x + 0.5, y: F.y + 0.5 } });
  ok(gone.found === false, 'рядом видно, что сундука уже нет: ' + JSON.stringify(gone));
  const en = await call(A, 'enemies', { radius: 30 });
  ok(en.units_total >= 1 && en.nests.length === 1 && !en.nests[0].memory, JSON.stringify(en));
  const ar = await call(A, 'area', { radius: 10 });
  ok(!ar.fog_rows && ar.rows.some((r) => r.includes('@')) && Object.values(ar.legend).includes('enemy:small-biter'), JSON.stringify(ar.legend));
  const far = await call(A, 'inspect', { target: { x: F.x + 2000.5, y: F.y + 2000.5 } });
  ok(far.found === false && far.visibility === 'unknown', JSON.stringify(far));
  await lua(`for _, e in pairs(storage.test_fog) do if e.valid then e.destroy() end end storage.test_fog = nil return true`);
});

test('событие: разрушение постройки приходит ожидающему запросу быстрее секунды', async () => {
  await lua(`storage.test_t = game.surfaces.nauvis.create_entity{name = 'wooden-chest', position = {A.x + 6.5, A.y + 6.5}, force = 'player', raise_built = true} return true`, F);
  const s0 = (await call(B, 'events')).seq;
  const waiting = call(B, 'events', { since: s0, wait_s: 10, types: ['entity_died'] });
  await sleep(300);
  const t0 = Date.now();
  await lua(`local b = game.surfaces.nauvis.create_entity{name = 'small-biter', position = {A.x + 9, A.y + 9}, force = 'enemy'} storage.test_t.die('enemy', b) b.destroy() return true`, F);
  const ev = await waiting;
  const dt = Date.now() - t0;
  ok(ev.events.length === 1 && ev.events[0].name === 'wooden-chest' && ev.events[0].by === 'small-biter' && ev.events[0].by_force === 'enemy', JSON.stringify(ev));
  ok(dt < 1000, `задержка ${dt} мс`);
  console.log(`      (событие дошло за ${dt} мс)`);
});

test('событие: стройка другого бота приходит сводкой, своя — нет', async () => {
  await lua(`local e = storage.agent.agents[A.n].entity e.clear_items_inside() e.insert{name = 'wooden-chest', count = 5} return true`, { n: NAME });
  const sa = (await call(A, 'events')).seq, sb = (await call(B, 'events')).seq;
  const me = (await call(A, 'status')).position;
  const items = [0, 1, 2].map((i) => ({ item: 'wooden-chest', x: Math.floor(me.x) + 2.5 + i, y: Math.floor(me.y) + 2.5 }));
  const r = await call(A, 'place', { items });
  eq(r.done, 3);
  const evb = await call(B, 'events', { since: sb, wait_s: 3, types: ['entities_built'] });
  ok(evb.events.length === 1 && evb.events[0].by === NAME && evb.events[0].count === 3 && evb.events[0].names['wooden-chest'] === 3, JSON.stringify(evb));
  const eva = await call(A, 'events', { since: sa, types: ['entities_built'] });
  eq(eva.events.length, 0, 'своя стройка себе не приходит');
  await call(A, 'mine', { targets: items.map((i) => ({ x: i.x, y: i.y })) });
});

test('окна игры: производство, энергия, исследования, справочник, тревоги, загрязнение', async () => {
  const pr = await call(A, 'production', { window: '10m' });
  ok(pr.ok && Array.isArray(pr.items) && pr.items.length > 0 && 'produced_per_min' in pr.items[0], JSON.stringify(pr).slice(0, 200));
  const base = await lua(`local p = game.surfaces.nauvis.find_entities_filtered{type = 'electric-pole', force = 'player', position = {0, 0}, radius = 100, limit = 1}[1] return {x = p.position.x, y = p.position.y}`);
  const pw = await call(A, 'power', { target: base });
  ok(pw.ok && pw.production_kw >= 0 && Array.isArray(pw.consumption) && pw.machines, JSON.stringify(pw).slice(0, 200));
  const rs = await call(A, 'research_info');
  ok(rs.ok && Array.isArray(rs.queue) && Array.isArray(rs.available), JSON.stringify(rs).slice(0, 200));
  const rc = await call(A, 'recipes', { name: 'electronic-circuit' });
  ok(rc.recipes[0].ingredients['copper-cable'] === 3 && rc.recipes[0].by_hand === true, JSON.stringify(rc));
  const pt = await call(A, 'prototypes', { name: 'stone-furnace' });
  ok(pt.entity.width === 2 && pt.entity.height === 2 && pt.item.stack_size === 50, JSON.stringify(pt));
  const al = await call(A, 'alerts', { x: 0, y: 0, radius: 300 });
  ok(al.ok && typeof al.by_status === 'object', JSON.stringify(al).slice(0, 200));
  const po = await call(A, 'pollution', { x: 0, y: 0 });
  ok(po.ok && po.rows.length > 0, JSON.stringify(po).slice(0, 100));
  for (const op of ['logistics', 'trains', 'chat', 'agents', 'busy']) ok((await call(A, op)).ok, op);
  eq((await call(A, 'recipes', { name: 'нет-такого' })).error.code, 'not_found');
});

test('скорость тяжёлых запросов: карта 64×64 и поиск по базе', async () => {
  const t = [];
  for (let i = 0; i < 5; i++) t.push((await call(A, 'area', { area: { x1: -60, y1: 20, x2: 4, y2: 84 }, objects: true })).ms);
  const f = [];
  for (let i = 0; i < 5; i++) f.push((await call(A, 'find', { type: 'transport-belt', x: -20, y: 40, radius: 150 })).ms);
  console.log(`      (area 64×64 с объектами: ${Math.min(...t).toFixed(0)}–${Math.max(...t).toFixed(0)} мс; find по базе: ${Math.min(...f).toFixed(0)}–${Math.max(...f).toFixed(0)} мс)`);
  ok(Math.max(...t) < 300 && Math.max(...f) < 300);
});

run(async () => { admin.close(); });
