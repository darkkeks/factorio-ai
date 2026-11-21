-- Реестр операций. Операция: {fn(A, params, req) → результат, agent = нужен персонаж, write = меняет мир
-- (ответ запоминается по идентификатору запроса), admin = только администратору}.
local U = require('agent.util')
local J = require('agent.journal')
local Q = require('agent.queue')
local S = require('agent.state')
local Gui = require('agent.gui')
local BUILD = require('agent.build')
local Equip = require('agent.actions.equip')
local Shoot = require('agent.actions.shoot')
local Throw = require('agent.actions.throw')

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
-- Молчание меряется по настоящим часам: их при каждом вызове сообщает сторож паузы (now, секунды), запрос бота
-- запоминает текущее значение. Так бот не «подключён» вечно, пока игра стоит и тики не идут. Бот без отметки
-- (не обращался с тех пор, как появилось правило) отключён. Пока часов нет (сторож не работает) — по тикам игры.
local SILENT_S = 5 * 60
local function busy_count()
  local st, n, silent = storage.agent, 0, 0
  local now = st.now
  local function count(name)
    local A = st.agents[name]
    local gone
    if not A then gone = false
    elseif now then gone = A.seen_at == nil or now - A.seen_at > SILENT_S
    else gone = game.tick - (A.seen or 0) > SILENT_S * 60 end
    if gone then silent = silent + 1 else n = n + 1 end
  end
  for name in pairs(st.active) do count(name) end
  for name in pairs(st.crafting) do if not st.active[name] then count(name) end end
  for name in pairs(st.firing) do if not st.active[name] and not st.crafting[name] then count(name) end end
  for name in pairs(st.throwing) do if not st.active[name] and not st.crafting[name] and not st.firing[name] then count(name) end end
  -- Погибший ждёт возрождения: время до него должно идти (очередь, крафт и огонь у него уже сняты).
  for name in pairs(st.dead) do count(name) end
  return n, silent
end
O.busy_count = busy_count

O.register('busy', {fn = function() return {busy = (busy_count()), paused = game.tick_paused} end})

-- Правило паузы одним неделимым шагом: игра идёт, пока в ней есть люди или у подключённого бота непустая очередь.
-- Вызывает сторож паузы раз в несколько секунд. now — настоящее время в секундах; keep — паузу не ставить
-- (внешняя причина; прежнее имя — voice); bots_off — режим ожидания: боты игру не держат.
O.register('pause_if_idle', {admin = true, fn = function(_, p)
  if type(p.now) == 'number' then storage.agent.now = p.now end
  local ignore = {}
  for _, n in pairs(p.ignore or {}) do ignore[n] = true end
  local humans = 0
  for _, pl in pairs(game.connected_players) do if not ignore[pl.name] then humans = humans + 1 end end
  local busy, silent = busy_count()
  local want = humans == 0 and not p.voice and not p.keep and (busy == 0 or p.bots_off == true)
  local changed = game.tick_paused ~= want
  game.tick_paused = want
  return {paused = want, changed = changed, humans = humans, busy = busy, silent = silent}
end})

O.register('agents', {fn = function()
  local out = {}
  for name, A in pairs(storage.agent.agents) do
    local e = A.entity
    local r = {name = name, alive = (e and e.valid) or false, queue = #A.queue, offline = A.offline and true or nil}
    if e and e.valid then
      r.position = U.pos(e.position)
      r.health = U.r2(e.health)
      r.action = A.queue[1] and A.queue[1].type or nil
    elseif A.dead then
      r.dead = true
      r.respawn_in = U.r2(S.respawn_in(A) / 60)
    end
    out[#out + 1] = r
  end
  table.sort(out, function(a, b) return a.name < b.name end)
  return {agents = U.list(out)}
end})

O.register('status', {agent = true, dead = true, fn = function(A)
  if A.dead then
    -- Между гибелью и возрождением персонажа нет: только сколько осталось ждать и где он погиб.
    return {name = A.name, dead = true, respawn_in = U.r2(S.respawn_in(A) / 60), respawn_tick = A.dead.respawn_tick,
      died_position = A.dead.position, respawn_position = U.pos(game.forces.player.get_spawn_position(game.surfaces.nauvis)),
      queue = U.list({}), tick = game.tick, paused = game.tick_paused, deaths = A.deaths}
  end
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
    weapons = U.list(Equip.weapons(e)),
    shooting = Shoot.view(A),
    throwing = Throw.view(A),
    crafting = U.list(crafting),
    queue = U.list(Q.view(A)),
    reach = {build = e.build_distance, interact = e.reach_distance, resource = e.resource_reach_distance},
    tick = game.tick,
    paused = game.tick_paused,
    deaths = A.deaths,
  }
end})

O.register('queue', {agent = true, dead = true, fn = function(A)
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

O.register('cancel', {agent = true, write = true, dead = true, fn = function(A, p)
  local id = Q.cancel(A, p.action_id)
  return {cancelled = id, queue_length = #A.queue}
end})

O.register('clear', {agent = true, write = true, dead = true, fn = function(A)
  return {cancelled = Q.clear(A)}
end})

-- Открыть человеку список ботов, окно-камеру или слежение — то же, что его собственные нажатия.
O.register('show', {admin = true, fn = function(_, p)
  local player = game.get_player(p.player or '')
  if not player then U.fail('not_found', 'нет такого игрока') end
  local A = p.agent and storage.agent.agents[p.agent]
  if (p.what == 'camera' or p.what == 'follow') and not (A and A.entity and A.entity.valid) then U.fail('not_found', 'нет такого бота') end
  local given = Gui.show(player, p.what, A, p)
  return {shown = p.what, given = given}
end})

-- Выход из игры и возвращение — как у человека, который отключился от сервера: персонаж исчезает из мира со всем,
-- что на нём, и появляется там же, когда хозяин вернулся. Пока его нет, его нельзя ни убить, ни обобрать, и он ничего
-- не делает: очередь действий отменяется, ручной крафт замирает. Персонаж не уничтожается, а целиком переносится
-- на скрытую пустую поверхность и выключается — так сохраняется всё (броня с модулями, качество, очередь крафта).
local LIMBO = 'agent-offline'
local function limbo()
  local s = game.surfaces[LIMBO]
  if not s then
    s = game.create_surface(LIMBO, {width = 64, height = 64, default_enable_all_autoplace_controls = false,
      peaceful_mode = true, no_enemies_mode = true})
    s.generate_with_lab_tiles = true
    for _, f in pairs(game.forces) do f.set_surface_hidden(s, true) end
  end
  return s
end

O.register('logout', {agent = true, write = true, offline = true, fn = function(A)
  if A.offline then return {offline = true, already = true} end
  local st, e = storage.agent, A.entity
  local cancelled = Q.clear(A, 'бот вышел из игры')
  Shoot.stop(A, 'logout')
  Throw.stop(A, 'logout')
  if e.driving then e.driving = false end
  e.walking_state = {walking = false, direction = e.walking_state.direction}
  e.mining_state = {mining = false}
  local pos, surface = e.position, e.surface
  st.offline_n = ((st.offline_n or 0) + 1) % 24
  if not e.teleport({x = -24 + 2 * st.offline_n + 0.5, y = 0.5}, limbo()) then U.fail('internal', 'не удалось убрать персонажа из мира') end
  e.disabled_by_script = true
  A.offline = {entity = e, surface = surface.index, position = {x = pos.x, y = pos.y}, tick = game.tick}
  A.entity = nil
  st.crafting[A.name] = nil
  if storage.vb then storage.vb[A.name] = nil end
  game.print('[color=0.7,0.7,0.7]' .. A.name .. ' вышел из игры[/color]')
  J.add('agent_logout', nil, {name = A.name})
  return {offline = true, position = U.pos(pos), surface = surface.name, cancelled = cancelled, crafting_paused = e.crafting_queue_size}
end})

O.register('login', {agent = true, write = true, offline = true, fn = function(A)
  local off = A.offline
  if not off then return {offline = false, already = true, position = U.pos(A.entity.position)} end
  local e = off.entity
  A.offline = nil
  if not (e and e.valid) then
    -- Персонажа на скрытой поверхности нет (её удалили): как после гибели — новый у точки возрождения.
    e = S.spawn(A)
    return {offline = false, respawned = true, position = U.pos(e.position)}
  end
  local surface = game.get_surface(off.surface) or game.surfaces.nauvis
  -- Место могли занять, пока бота не было: тогда ближайшее свободное, как при входе игрока.
  local pos = surface.find_non_colliding_position('character', off.position, 32, 0.25) or off.position
  e.disabled_by_script = false
  if not e.teleport(pos, surface) then
    e.disabled_by_script = true
    A.offline = off
    U.fail('blocked', 'не удалось вернуть персонажа в мир: место занято')
  end
  S.attach(A, e)
  if e.crafting_queue_size > 0 then storage.agent.crafting[A.name] = true end
  game.print('[color=0.7,0.7,0.7]' .. A.name .. ' вернулся в игру[/color]')
  J.add('agent_login', nil, {name = A.name})
  return {offline = false, position = U.pos(e.position), surface = surface.name, moved = (pos.x ~= off.position.x or pos.y ~= off.position.y) or nil,
    crafting = e.crafting_queue_size}
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
O.register('touch', {agent = true, offline = true, dead = true, fn = function() return {} end})

return O
