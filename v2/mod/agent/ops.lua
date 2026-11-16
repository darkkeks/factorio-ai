-- Реестр операций. Операция: {fn(A, params, req) → результат, agent = нужен персонаж, write = меняет мир
-- (ответ запоминается по идентификатору запроса), admin = только администратору}.
local U = require('agent.util')
local J = require('agent.journal')
local Q = require('agent.queue')
local S = require('agent.state')
local Gui = require('agent.gui')
local BUILD = require('agent.build')

local O = {list = {}}

function O.register(name, def) O.list[name] = def end

O.register('ping', {fn = function()
  local ops, actions = {}, {}
  for name, def in pairs(O.list) do ops[#ops + 1] = name end
  for name, def in pairs(Q.actions) do actions[#actions + 1] = {name = name, instant = def.instant or false} end
  table.sort(ops)
  table.sort(actions, function(a, b) return a.name < b.name end)
  return {mod = 'agent', version = S.VERSION, build = BUILD, api = 2, tick = game.tick, paused = game.tick_paused, ops = ops, actions = actions}
end})

-- Что перенесено со старой системы при первом запуске (для проверки переноса).
O.register('legacy_report', {admin = true, fn = function() return storage.agent.legacy_report or {} end})

O.register('journal', {admin = true, fn = function(_, p)
  local items, seq, first = J.read(p.since or 0, math.min(p.limit or 500, 2000))
  return {events = U.list(items), seq = seq, first = first}
end})

-- Занят ли кто-нибудь: очередь действий или очередь ручного крафта (для правила паузы). Бот, от которого давно нет
-- запросов, отключённым считается и игру не держит: его очередь остаётся и продолжится, когда игра пойдёт
-- (вернулся он сам или играет кто-то ещё). Подключённый бот опрашивает события не реже раза в минуту.
local SILENT = 5 * 60 * 60 -- тиков без запросов, после которых бот считается отключённым
local function busy_count()
  local st, n, silent = storage.agent, 0, 0
  local function count(name)
    local A = st.agents[name]
    if A and game.tick - (A.seen or 0) > SILENT then silent = silent + 1 else n = n + 1 end
  end
  for name in pairs(st.active) do count(name) end
  for name in pairs(st.crafting) do if not st.active[name] then count(name) end end
  return n, silent
end
O.busy_count = busy_count

O.register('busy', {fn = function() return {busy = (busy_count()), paused = game.tick_paused} end})

-- Правило паузы одним неделимым шагом: игра идёт, пока в ней есть люди или у подключённого бота непустая очередь.
-- Вызывает сторож паузы. hold — внешняя причина не ставить паузу (прежнее имя параметра — voice).
O.register('pause_if_idle', {admin = true, fn = function(_, p)
  local ignore = {}
  for _, n in pairs(p.ignore or {}) do ignore[n] = true end
  local humans = 0
  for _, pl in pairs(game.connected_players) do if not ignore[pl.name] then humans = humans + 1 end end
  local busy, silent = busy_count()
  local want = humans == 0 and not p.voice and not p.hold and busy == 0
  local changed = game.tick_paused ~= want
  game.tick_paused = want
  return {paused = want, changed = changed, humans = humans, busy = busy, silent = silent}
end})

O.register('agents', {fn = function()
  local out = {}
  for name, A in pairs(storage.agent.agents) do
    local e = A.entity
    local r = {name = name, alive = (e and e.valid) or false, queue = #A.queue}
    if e and e.valid then
      r.position = U.pos(e.position)
      r.health = U.r2(e.health)
      r.action = A.queue[1] and A.queue[1].type or nil
    end
    out[#out + 1] = r
  end
  table.sort(out, function(a, b) return a.name < b.name end)
  return {agents = U.list(out)}
end})

O.register('status', {agent = true, fn = function(A)
  local e = A.entity
  local main = e.get_main_inventory()
  local crafting = {}
  for i, c in pairs(e.crafting_queue or {}) do crafting[i] = {recipe = c.recipe, count = c.count} end
  return {
    name = A.name,
    position = U.pos(e.position),
    surface = e.surface.name,
    health = U.r2(e.health),
    max_health = e.max_health,
    walking = e.walking_state.walking,
    mining = e.mining_state.mining,
    inventory = U.contents(main),
    free_slots = main.count_empty_stacks(),
    guns = U.contents(e.get_inventory(defines.inventory.character_guns)),
    ammo = U.contents(e.get_inventory(defines.inventory.character_ammo)),
    armor = U.contents(e.get_inventory(defines.inventory.character_armor)),
    crafting = U.list(crafting),
    queue = U.list(Q.view(A)),
    reach = {build = e.build_distance, interact = e.reach_distance, resource = e.resource_reach_distance},
    tick = game.tick,
    paused = game.tick_paused,
    deaths = A.deaths,
  }
end})

O.register('queue', {agent = true, fn = function(A)
  return {queue = U.list(Q.view(A))}
end})

-- Поставить действия в очередь. Игру на паузе будит только непустая очередь.
O.register('act', {agent = true, write = true,
  compact = function(res) return {actions = res.actions, finished = U.EMPTY, replayed = true} end,
  fn = function(A, p)
  if type(p.actions) ~= 'table' or #p.actions == 0 then U.fail('bad_request', 'actions: непустой список действий') end
  if p.replace then Q.clear(A, 'очередь заменена новым запросом') end
  local queued, finished = Q.enqueue(A, p.actions)
  if A.queue[1] and game.tick_paused then game.tick_paused = false end
  return {actions = queued, finished = U.list(finished), running = A.queue[1] and A.queue[1].id or nil, queue_length = #A.queue}
end})

O.register('cancel', {agent = true, write = true, fn = function(A, p)
  local id = Q.cancel(A, p.action_id)
  return {cancelled = id, queue_length = #A.queue}
end})

O.register('clear', {agent = true, write = true, fn = function(A)
  return {cancelled = Q.clear(A)}
end})

-- Открыть человеку список ботов, окно-камеру или слежение — то же, что его собственные нажатия.
O.register('show', {admin = true, fn = function(_, p)
  local player = game.get_player(p.player or '')
  if not player then U.fail('not_found', 'нет такого игрока') end
  local A = p.agent and storage.agent.agents[p.agent]
  if (p.what == 'camera' or p.what == 'follow') and not (A and A.entity and A.entity.valid) then U.fail('not_found', 'нет такого бота') end
  Gui.show(player, p.what, A)
  return {shown = p.what}
end})

-- Объявление в игровой чат не от бота (ответы разработчиков на заявки, сообщения об обновлениях): его видят люди
-- в игре, оно попадает в историю чата и приходит ботам событием chat, как любое сообщение.
O.register('announce', {admin = true, fn = function(_, p)
  U.arg(p.text, 'string', 'text')
  local from = type(p.from) == 'string' and p.from or 'разработчики'
  storage.vb_chat = storage.vb_chat or {seq = 0, items = {}}
  local c = storage.vb_chat
  c.seq = c.seq + 1
  c.items[#c.items + 1] = {seq = c.seq, from = from, text = p.text}
  if #c.items > 50 then table.remove(c.items, 1) end
  game.print('[color=0.6,0.8,1]' .. from .. ':[/color] ' .. p.text)
  J.chat(from, p.text)
  return {sent = true}
end})

-- Бот жив: сервер на хосте шлёт это, когда запросы бота до мода не доходят (чтение буфера событий).
O.register('touch', {agent = true, fn = function() return {} end})

return O
