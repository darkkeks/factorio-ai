#!/usr/bin/env node
// Перезапуск сервера игры (обновление мода) прозрачен для ботов: очереди действий продолжаются с того же места,
// ожидающие запросы дожидаются итога, запросы во время простоя не отклоняются, а исполняются после запуска.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { call, lua, admin, sleep } from './lib.mjs';
import { test, ok, eq, run } from './harness.mjs';

const TOOLS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const A = 't-b1', B = 't-b2';
await call(A, 'status'); await call(B, 'status');
const O = await lua(`
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
const put = (name, x, y, items = {}) => lua(`local e = storage.agent.agents[A.n].entity e.teleport({A.x, A.y}) e.clear_items_inside() for k, v in pairs(A.items) do e.insert{name = k, count = v} end return true`, { n: name, x, y, items });
const restartGame = () => new Promise((resolve, reject) => {
  const t0 = Date.now();
  const p = spawn(`${TOOLS}/reload.sh`, [], { stdio: 'ignore' });
  p.on('exit', (code) => (code === 0 ? resolve(Date.now() - t0) : reject(new Error(`reload.sh: код ${code}`))));
});

test('перезапуск игры посреди очереди: действия продолжаются, ожидающие запросы получают итог, запросы во время простоя исполняются', async () => {
  await put('bench-1', O.x, O.y, { 'wooden-chest': 2 });
  await put('bench-2', O.x, O.y + 10, { 'iron-ore': 5 });
  await lua(`local s = game.surfaces.nauvis for i = 0, 3 do s.create_entity{name = 'iron-ore', position = {A.x + 1.5, A.y + 9.5 + i}, amount = 500} end return true`, O);
  const s0 = (await call(A, 'events')).seq;
  // Бот 1: три перехода туда-обратно (≈19 с), затем постройка и реплика. Бот 2: добыча по счёту.
  const q = await call(A, 'act', { wait: false, actions: [
    { type: 'walk_to', x: O.x + 55, y: O.y },
    { type: 'walk_to', x: O.x, y: O.y + 4 },
    { type: 'walk_to', x: O.x + 55, y: O.y },
    { type: 'place', item: 'wooden-chest', x: O.x + 57, y: O.y },
    { type: 'say', text: 'дошёл после перезапуска' },
  ] });
  const ids = q.actions.map((a) => a.action_id);
  const m = await call(B, 'mine', { target: { x: O.x + 1.5, y: O.y + 9.5, name: 'iron-ore' }, count: 12, wait: false });
  // Запросы, которые будут ждать итога через перезапуск.
  const waiting = call(A, 'wait_action', { action_ids: ids, wait_s: 100 });
  const mining = call(B, 'wait_action', { action_id: m.action_id, wait_s: 100 });
  const watching = call(A, 'events', { since: s0, wait_s: 60, types: ['queue_empty'] });
  await sleep(2500);
  const before = (await call(A, 'status')).position;
  const down = restartGame();
  await sleep(700); // сервер игры уже остановлен
  // Запросы во время простоя: чтение и действие.
  const t0 = Date.now();
  const [st, placed] = await Promise.all([call(B, 'status'), call(A, 'place', { item: 'wooden-chest', x: before.x + 12, y: before.y + 3, immediate: true })]);
  const held = Date.now() - t0;
  const downMs = await down;
  ok(st.ok && st.http === 200, 'чтение во время простоя: ' + JSON.stringify(st).slice(0, 200));
  ok(placed.ok || placed.error?.code !== 'game_unavailable', 'действие во время простоя не отклонено: ' + JSON.stringify(placed).slice(0, 200));
  const w = await waiting;
  eq(w.actions.map((a) => a.state), ['done', 'done', 'done', 'done', 'done'], JSON.stringify(w).slice(0, 600));
  ok(w.actions[2].result.left <= 0.3 && w.actions[2].result.walked > 50, JSON.stringify(w.actions[2]));
  const mw = await mining;
  ok(mw.actions[0].state === 'done' && mw.actions[0].result.gained === 12, JSON.stringify(mw));
  const ev = await watching;
  ok(ev.events.length === 1, 'событие о конце очереди дошло до ожидающего запроса');
  const said = await lua(`local n = 0 for _, m in pairs(storage.agent.chat.items) do if m.text == 'дошёл после перезапуска' and m.tick > A.t then n = n + 1 end end return {n = n}`, { t: 0 });
  ok(said.n >= 1);
  console.log(`      (перезапуск игры занял ${(downMs / 1000).toFixed(1)} с; запросы во время простоя ждали ${(held / 1000).toFixed(1)} с и исполнились)`);
});

test('ответ поисковика пути потерян (сохранение и загрузка посреди поиска): ходьба спрашивает путь заново', async () => {
  await put('bench-1', O.x, O.y);
  const r = await call(A, 'walk_to', { x: O.x + 20, y: O.y, wait: false });
  // Имитация: путь ещё не получен, а запрос к поисковику пропал.
  await lua(`local act = storage.agent.agents['bench-1'].queue[1] local w = act.st.w w.path = nil w.req = 987654321 w.req_tick = game.tick - 290 storage.agent.agents['bench-1'].entity.walking_state = {walking = false, direction = 0} return true`);
  const w = await call(A, 'wait_action', { action_id: r.action_id, wait_s: 30 });
  ok(w.actions[0].state === 'done' && w.actions[0].result.left <= 0.3, JSON.stringify(w));
});

run(async () => { admin.close(); });
