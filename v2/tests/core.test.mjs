#!/usr/bin/env node
// Каркас, очередь, ходьба, события, повтор запросов, перезапуск сервера на хосте.
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, lua, admin, sleep } from './lib.mjs';
import { test, ok, eq, run } from './harness.mjs';

const TOOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const A = 't-b1', B = 't-b2';
// Тестовая подготовка (только тестовый экземпляр): поставить персонажа в точку.
const put = (name, x, y) => lua(`local e = storage.agent.agents[A.n].entity local p = e.surface.find_non_colliding_position('character', {A.x, A.y}, 10, 0.25) e.teleport(p) return p`, { n: name, x, y });
// Открытое место без построек, воды и скал: прямоугольник 60×30 клеток, ищется на карте.
const open = await lua(`
  local s = game.surfaces.nauvis
  for r = 2, 30 do for _, c in pairs{{-r, r}, {r, r}, {-r, 0}, {r, 0}, {0, r}, {-r, -r}, {r, -r}, {0, -r}} do
    local x, y = c[1] * 16, c[2] * 16
    local area = {{x - 2, y - 2}, {x + 62, y + 32}}
    if (s.count_entities_filtered{area = area, collision_mask = 'player'} - s.count_entities_filtered{area = area, type = 'character'}) == 0 and s.count_tiles_filtered{area = area, collision_mask = 'player'} == 0
      and game.forces.player.is_chunk_charted(s, {math.floor(x / 32), math.floor(y / 32)}) then
      return {x = x + 0.5, y = y + 0.5}
    end
  end end
  error('нет открытого места')`);
const ready = async () => { for (let i = 0; i < 100; i++) { try { const r = await call(A, 'ping'); if (r.ok) return; } catch { /* ещё не слушает */ } await sleep(100); } throw new Error('сервер ботов не поднялся'); };

test('ping: версия мода и список операций', async () => {
  const r = await call(A, 'ping');
  ok(r.ok && r.api === 2 && r.ops.includes('act') && r.actions.some((a) => a.name === 'walk_to'), JSON.stringify(r).slice(0, 200));
});

test('help: описаны все операции и действия мода', async () => {
  const h = await (await fetch(`${process.env.V2_API || 'http://127.0.0.1:8790'}/v2/help`)).json();
  const p = await call('t-admin', 'ping');
  const missing = [...p.ops, ...p.actions.map((a) => a.name)].filter((n) => !h.operations[n] && !['journal', 'touch', 'pause_if_idle', 'announce', 'show', 'legacy_report'].includes(n));
  eq(missing, [], 'в help нет операций');
});

test('доступ: без токена 401, чужая админская операция 403, неизвестная операция 404', async () => {
  eq((await call('no-such-token', 'status')).http, 401);
  eq((await call(A, 'metrics')).http, 403);
  eq((await call(A, 'nope')).http, 404);
  eq((await call(A, 'walk_to', { x: 'a' })).http, 400);
});

test('status: позиция, инвентарь, очередь', async () => {
  const r = await call(A, 'status');
  ok(r.ok && typeof r.position.x === 'number' && typeof r.inventory === 'object' && Array.isArray(r.queue) && r.reach.build === 10, JSON.stringify(r).slice(0, 300));
});

test('ходьба: дошёл, отчёт с пройденным, прямой и длиной пути', async () => {
  await put('bench-1', open.x, open.y);
  const r = await call(A, 'walk_to', { x: open.x + 12, y: open.y + 5 });
  ok(r.ok && r.left <= 0.3 && r.walked > 12 && r.straight > 12.9 && r.path_length > 12, JSON.stringify(r));
});

test('ходьба в занятую точку: no_path сразу', async () => {
  const b = await lua(`local e = game.surfaces.nauvis.find_entities_filtered{type = 'assembling-machine', limit = 1}[1] return e.position`);
  const r = await call(A, 'walk_to', { x: b.x, y: b.y });
  ok(!r.ok && r.error.code === 'no_path' && r.ms < 300, JSON.stringify(r));
});

test('очередь: несколько действий одним запросом, итог по каждому', async () => {
  await put('bench-1', open.x, open.y);
  const r = await call(A, 'act', { actions: [{ type: 'walk_to', x: open.x + 4, y: open.y }, { type: 'wait', ticks: 30 }, { type: 'say', text: 'тест очереди' }] });
  ok(r.ok && !r.running, JSON.stringify(r));
  eq(r.actions.map((a) => a.state), ['done', 'done', 'done']);
  ok(r.actions[1].result.waited === 30);
});

test('on_fail: stop отменяет остаток очереди, continue — нет', async () => {
  const b = await lua(`local e = game.surfaces.nauvis.find_entities_filtered{type = 'assembling-machine', limit = 1}[1] return e.position`);
  let r = await call(A, 'act', { actions: [{ type: 'walk_to', x: b.x, y: b.y }, { type: 'say', text: 'не должно прийти' }] });
  eq(r.actions.map((a) => a.state), ['failed', 'cancelled']);
  r = await call(A, 'act', { actions: [{ type: 'walk_to', x: b.x, y: b.y, on_fail: 'continue' }, { type: 'wait', ticks: 1 }] });
  eq(r.actions.map((a) => a.state), ['failed', 'done']);
});

test('wait: false возвращает номер сразу, wait_action дожидается; отмена срабатывает сразу', async () => {
  await put('bench-1', open.x, open.y);
  const r = await call(A, 'walk_to', { x: open.x + 30, y: open.y, wait: false });
  ok(r.ok && r.running && r.action_id > 0 && r.ms < 200, JSON.stringify(r));
  const q = await call(A, 'queue');
  ok(q.queue.length === 1 && q.queue[0].state === 'running', JSON.stringify(q));
  const c = await call(A, 'cancel');
  eq(c.cancelled, r.action_id);
  const w = await call(A, 'wait_action', { action_id: r.action_id, wait_s: 5 });
  eq(w.actions[0].state, 'cancelled', JSON.stringify(w));
  const s = await call(A, 'status');
  ok(!s.walking && s.queue.length === 0, 'после отмены персонаж должен стоять');
});

test('задержки: replace отвечает за считаные тики, одновременные запросы одного бота не ждут друг друга', async () => {
  await call(A, 'status');
  await put('bench-1', open.x, open.y);
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  const fmt = (a) => a.map((x) => x.toFixed(0)).join(' ');
  // Перехват тела: идёт walk_to другого запроса, replace ставит короткое действие — оба ответа приходят сразу,
  // а не через период опроса журнала (на стенде он 100 мс).
  const rep = [], walk = [];
  for (let i = 0; i < 8; i++) {
    const w = call(A, 'walk_to', { x: open.x + 30, y: open.y, wait_s: 20 });
    await sleep(150);
    const t0 = performance.now();
    const r = await call(A, 'act', { replace: true, actions: [{ type: 'wait', ticks: 1 }] });
    const c = await w;
    walk.push(performance.now() - t0);
    ok(r.ok && r.actions[0].state === 'done' && !c.ok && c.error.code === 'cancelled', JSON.stringify([r, c]));
    rep.push(r.ms);
  }
  ok(med(rep) < 90, `replace с действием на 1 тик: ${fmt(rep)} мс`);
  ok(med(walk) < 90, `отменённый walk_to узнал об отмене через ${fmt(walk)} мс`);
  const par = [];
  for (let i = 0; i < 15; i++) {
    const t0 = performance.now();
    const rs = await Promise.all([call(A, 'status'), call(A, 'status'), call(A, 'queue')]);
    par.push(performance.now() - t0);
    ok(rs.every((r) => r.ok));
    await sleep(40);
  }
  ok(med(par) < 30 && par.filter((x) => x >= 40).length <= 2, `три запроса разом: ${fmt(par)} мс`);
});

test('повтор запроса с тем же id не исполняет действие дважды; разные id — оба', async () => {
  const count = async () => (await lua(`local n = 0 for _, m in pairs(storage.vb_chat.items) do if m.text == A.t then n = n + 1 end end return {n = n}`, { t: text })).n;
  const text = 'повтор-' + Date.now();
  const r1 = await call(A, 'say', { text, id: 'same-' + text });
  const r2 = await call(A, 'say', { text, id: 'same-' + text });
  ok(r1.ok && r2.ok && r1.action_id === r2.action_id, JSON.stringify([r1, r2]));
  eq(await count(), 1, 'сообщение должно быть одно');
  await call(A, 'say', { text, id: 'x-' + text });
  await call(A, 'say', { text });
  eq(await count(), 3, 'запросы с разными id и без id исполняются каждый');
});

test('события: свои действия и чат приходят ожидающему запросу', async () => {
  const s0 = (await call(B, 'events')).seq;
  const waiting = call(B, 'events', { since: s0, wait_s: 10, types: ['chat'] });
  await sleep(300);
  const t0 = Date.now();
  await call(A, 'say', { text: 'привет, второй' });
  const ev = await waiting;
  const dt = Date.now() - t0;
  ok(ev.events.length === 1 && ev.events[0].from === 'bench-1' && ev.events[0].text === 'привет, второй', JSON.stringify(ev));
  ok(dt < 1000, `задержка события ${dt} мс`);
  const mine = await call(A, 'events', { since: s0 });
  ok(mine.events.some((e) => e.type === 'action_done' && e.action === 'say'), 'своё action_done');
  ok(!mine.events.some((e) => e.type === 'chat' && e.from === 'bench-1'), 'свой чат себе не приходит');
  const other = await call(B, 'events', { since: s0 });
  ok(!other.events.some((e) => e.type === 'action_done'), 'чужие action_done не приходят');
});

test('два персонажа идут одновременно и опрашивают мир без взаимных задержек', async () => {
  await put('bench-1', open.x, open.y);
  await put('bench-2', open.x, open.y + 6);
  if (process.env.DEBUG) console.log('до старта:', JSON.stringify((await call(A, 'agents')).agents.filter((a) => /bench-[12]|tester/.test(a.name))), JSON.stringify(await lua(`local t = {} for _, p in pairs(game.connected_players) do t[#t+1] = {p.name, p.position, p.character and p.character.position} end return t`)));
  const w = [call(A, 'walk_to', { x: open.x + 40, y: open.y }), call(B, 'walk_to', { x: open.x + 40, y: open.y + 6 })];
  const lat = [];
  for (let i = 0; i < 40; i++) { const r = await call(i % 2 ? A : B, 'status'); ok(r.ok); lat.push(r.ms); }
  const [ra, rb] = await Promise.all(w);
  ok(ra.ok && rb.ok, JSON.stringify([ra, rb]));
  ok(ra.walked < 60 && rb.walked < 60, 'оба дошли без больших крюков: ' + JSON.stringify([ra.walked, rb.walked]));
  ok(Math.max(...lat) < 300, `самый долгий status ${Math.max(...lat).toFixed(0)} мс`);
});

test('тупик: ходьба завершается с причиной не позже секунды после остановки', async () => {
  // Загон из стен с «дверью», которая закрывается после того, как путь найден.
  const pen = await lua(`
    local s = game.surfaces.nauvis
    local x0, y0 = A.x, A.y
    local walls = {}
    for dx = -3, 3 do for dy = -3, 3 do
      if (math.abs(dx) == 3 or math.abs(dy) == 3) and not (dx == 3 and dy == 0) then
        walls[#walls + 1] = s.create_entity{name = 'stone-wall', position = {x0 + dx + 0.5, y0 + dy + 0.5}, force = 'player'}
      end
    end end
    storage.test_walls = walls
    local e = storage.agent.agents['bench-1'].entity
    e.teleport({x0 + 0.5, y0 + 0.5})
    return {door = {x = x0 + 3.5, y = y0 + 0.5}}`, { x: Math.floor(open.x) + 10, y: Math.floor(open.y) + 15 });
  const s0 = (await call(A, 'events')).seq;
  const r0 = await call(A, 'walk_to', { x: pen.door.x + 15, y: pen.door.y, wait: false });
  await sleep(150); // путь найден, персонаж пошёл к двери
  const closeTick = (await lua(`local w = game.surfaces.nauvis.create_entity{name = 'stone-wall', position = {A.x, A.y}, force = 'player'} table.insert(storage.test_walls, w) return {tick = game.tick}`, pen.door)).tick;
  const w = await call(A, 'wait_action', { action_id: r0.action_id, wait_s: 10 });
  const ev = (await call(A, 'events', { since: s0, types: ['action_done'] })).events.filter((e) => e.action_id === r0.action_id)[0];
  await lua(`for _, w in pairs(storage.test_walls) do if w.valid then w.destroy() end end storage.test_walls = nil return true`);
  eq(w.actions[0].state, 'failed');
  ok(['stuck', 'no_path'].includes(w.actions[0].error.code), JSON.stringify(w.actions[0].error));
  // до двери 3 клетки ≈ 20 тиков ходьбы, плюс не больше 60 тиков на обнаружение
  ok(ev.tick - closeTick <= 60 + 30, `тиков от закрытия двери до отказа: ${ev.tick - closeTick}`);
});

test('200 клеток одним вызовом', async () => {
  await lua(`game.speed = 4 return true`);
  await put('bench-1', -43.5, 90.5);
  const r = await call(A, 'walk_to', { x: -17.5, y: -105.5, wait_s: 110, stop_on_damage: false });
  await lua(`game.speed = 1 return true`);
  ok(r.ok && r.straight > 195, JSON.stringify(r));
});

test('перезапуск сервера на хосте во время ходьбы: персонаж доходит, событие получено после перезапуска', async () => {
  await put('bench-1', open.x, open.y);
  const s0 = (await call(A, 'events')).seq;
  const r = await call(A, 'walk_to', { x: open.x + 45, y: open.y, wait: false });
  ok(r.running);
  execSync(`${TOOLS}/test-api.sh stop`);
  await sleep(500);
  execSync(`${TOOLS}/test-api.sh start`);
  await ready();
  const ev = await call(A, 'events', { since: s0, wait_s: 15, types: ['action_done'] });
  const done = ev.events.find((e) => e.action_id === r.action_id);
  ok(done && done.ok && done.result.left <= 0.3, JSON.stringify(ev).slice(0, 400));
});

test('сторож cancel_if_silent_s отменяет действие, когда бот молчит', async () => {
  const r = await call(A, 'act', { actions: [{ type: 'wait', ticks: 3600, cancel_if_silent_s: 1 }], wait: false });
  const id = r.actions[0].action_id;
  await sleep(2500); // молчим (ожидание не через запросы бота)
  const ev = await lua(`local j = storage.agent.journal for s = j.seq, j.first, -1 do local e = j.items[s] if e.type == 'action_done' and e.agent == 'bench-1' and e.action_id == A.id then return e end end return {none = true}`, { id });
  ok(ev.ok === false && ev.error.code === 'cancelled' && ev.error.data.silent, JSON.stringify(ev));
});

test('пауза: чтение не будит игру, действие будит; pause_if_idle не ставит паузу при занятом боте', async () => {
  let r = await call('t-admin', 'pause_if_idle', { voice: false, ignore: ['tester', 'camera'] });
  ok(r.ok && r.paused === true, JSON.stringify(r));
  await call(A, 'status');
  ok((await call(A, 'busy')).paused === true, 'чтение не должно снимать паузу');
  const w = await call(A, 'wait', { ticks: 120, wait: false });
  ok((await call(A, 'busy')).paused === false, 'действие должно снять паузу');
  r = await call('t-admin', 'pause_if_idle', { voice: false, ignore: ['tester', 'camera'] });
  ok(r.paused === false && r.busy === 1, JSON.stringify(r));
  await call(A, 'wait_action', { action_id: w.action_id, wait_s: 5 });
  r = await call('t-admin', 'pause_if_idle', { voice: true, ignore: ['tester', 'camera'] });
  ok(r.paused === false, 'люди в голосовом канале — игра идёт');
});

test('пауза: бот, от которого давно нет запросов, игру не держит; первый же его запрос это возвращает', async () => {
  const ignore = ['tester', 'camera'];
  const now = Math.floor(Date.now() / 1000);
  await call('t-admin', 'pause_if_idle', { ignore, now });
  await call(A, 'wait', { ticks: 600, wait: false });
  let r = await call('t-admin', 'pause_if_idle', { ignore, now: now + 200 });
  ok(r.paused === false && r.busy === 1 && r.silent === 0, JSON.stringify(r));
  r = await call('t-admin', 'pause_if_idle', { ignore, now: now + 301 }); // игра могла бы и стоять: молчание — по часам, не по тикам
  ok(r.paused === true && r.busy === 0 && r.silent === 1, JSON.stringify(r));
  await call(A, 'status'); // бот вернулся: чтение паузу не снимает, но сторож теперь видит его занятым
  r = await call('t-admin', 'pause_if_idle', { ignore, now: now + 305 });
  ok(r.paused === false && r.busy === 1 && r.silent === 0, JSON.stringify(r));
  r = await call('t-admin', 'pause_if_idle', { ignore, now: now + 306, bots_off: true });
  ok(r.paused === true && r.busy === 1, 'режим ожидания: боты игру не держат ' + JSON.stringify(r));
  await call(A, 'cancel');
  r = await call('t-admin', 'pause_if_idle', { ignore, now: now + 307, keep: true });
  ok(r.paused === false, 'keep: паузу не ставить');
});

test('announce: объявление разработчиков попадает в ленту чата и в события ботов', async () => {
  const before = (await call(A, 'chat')).seq;
  const text = 'проверка объявления ' + Date.now();
  ok((await call('t-admin', 'announce', { text })).sent === true);
  const m = (await call(A, 'chat', { since: before })).messages;
  ok(m.length === 1 && m[0].text === text && m[0].from === 'разработчики' && !m[0].bot, JSON.stringify(m));
  ok((await call(A, 'announce', { text })).error.code === 'forbidden', 'боту объявления недоступны');
});

test('logout и login: персонаж исчезает из мира и возвращается на место с инвентарём и очередью крафта', async () => {
  const B = 't-b3';
  await call(B, 'login'); // если прошлый запуск оборвался на вышедшем боте
  await lua(`local e = storage.agent.agents['bench-3'].entity e.insert{name = 'iron-plate', count = 40} return {}`);
  const before = await call(B, 'status');
  ok((await call(B, 'craft', { recipe: 'iron-gear-wheel', count: 15 })).ok);
  const w = await call(B, 'wait', { ticks: 6000, wait: false });
  const out = await call(B, 'logout');
  ok(out.offline === true && out.cancelled === 1 && out.crafting_paused >= 1, JSON.stringify(out));
  const world = await lua(`local A = storage.agent.agents['bench-3'] local e = A.offline.entity
    return {gone = A.entity == nil, surface = e.surface.name, active = e.active, q = e.crafting_queue_size, progress = e.crafting_queue_progress,
      near = game.surfaces.nauvis.count_entities_filtered{name = 'character', position = A.offline.position, radius = 0.5}, vb = storage.vb['bench-3'] == nil}`);
  ok(world.gone && world.surface === 'agent-offline' && world.active === false && world.near === 0 && world.vb, JSON.stringify(world));
  const st = await call(B, 'status');
  ok(st.error?.code === 'offline', JSON.stringify(st));
  ok((await call(B, 'walk_to', { x: 0, y: 0 })).error?.code === 'offline', 'действие вне игры');
  ok((await call(B, 'logout')).already === true, 'повторный logout');
  const done = await call(B, 'wait_action', { action_id: w.action_id, wait_s: 2 });
  ok(done.actions?.[0]?.state === 'cancelled', JSON.stringify(done));
  const busy = await call('t-admin', 'pause_if_idle', { ignore: ['tester', 'camera'], keep: true });
  ok(busy.busy === 0, 'вышедший бот игру не держит ' + JSON.stringify(busy));
  await sleep(1500); // игра идёт (keep): крафт вышедшего стоит
  const frozen = await lua(`local e = storage.agent.agents['bench-3'].offline.entity return {q = e.crafting_queue_size, progress = e.crafting_queue_progress}`);
  ok(frozen.q === world.q && frozen.progress === world.progress, JSON.stringify([world, frozen]));
  ok((await call(A, 'agents')).agents.find((a) => a.name === 'bench-3').offline === true, 'agents: offline');
  const back = await call(B, 'login');
  ok(back.offline === false && Math.abs(back.position.x - before.position.x) < 0.01 && Math.abs(back.position.y - before.position.y) < 0.01, JSON.stringify([before.position, back]));
  const after = await call(B, 'status');
  ok(after.ok && after.surface === 'nauvis' && after.health === before.health, JSON.stringify(after).slice(0, 200));
  ok((await call(B, 'login')).already === true, 'повторный login');
  await call(B, 'cancel_craft', {});
  const end = await call(B, 'status');
  ok(end.inventory['iron-plate'] + 2 * (end.inventory['iron-gear-wheel'] || 0) >= before.inventory['iron-plate'], 'пластины не пропали: ' + JSON.stringify(end.inventory));
});

run(async () => { admin.close(); });
