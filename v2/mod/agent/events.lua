-- События игры → журнал. Обработчики регистрируются при загрузке сценария, одинаково у сервера и клиентов.
local U = require('agent.util')
local J = require('agent.journal')
local Q = require('agent.queue')
local S = require('agent.state')
local Fog = require('agent.fog')
local Gui = require('agent.gui')
local Trig = require('agent.triggers')
local Shoot = require('agent.actions.shoot')
local Throw = require('agent.actions.throw')

local E = {handlers = {}, nth = {}}

local DAMAGE_EVERY = 300 -- повторный урон по тому же объекту — не чаще раза в 5 секунд

-- Трупы персонажей ботов: ключ — место (у трупа нет номера), значение — {agent, tick, by — кто последним забирал}.
local function corpse_key(pos) return math.floor(pos.x * 256 + 0.5) .. ',' .. math.floor(pos.y * 256 + 0.5) end
E.corpse_key = corpse_key

local CARRIED = {defines.inventory.character_main, defines.inventory.character_guns, defines.inventory.character_ammo,
  defines.inventory.character_armor, defines.inventory.character_trash}

-- Всё, что было при персонаже: оно остаётся в трупе. К событию гибели игра уже переложила вещи в труп,
-- поэтому читаем его; если трупа ещё нет — то, что осталось при персонаже.
local function carried(e)
  local out = {}
  for _, c in pairs(e.surface.find_entities_filtered{type = 'character-corpse', position = e.position, radius = 0.5}) do
    if c.character_corpse_tick_of_death == game.tick then
      for k, n in pairs(U.contents(c.get_inventory(defines.inventory.character_corpse))) do out[k] = (out[k] or 0) + n end
    end
  end
  for _, id in ipairs(CARRIED) do
    for k, n in pairs(U.contents(e.get_inventory(id))) do out[k] = (out[k] or 0) + n end
  end
  return out
end

local function corpse_gone(corpse, reason, by)
  local corpses = storage.agent.corpses
  local key = corpse_key(corpse.position)
  local rec = corpses[key]
  if not rec then return end
  corpses[key] = nil
  local left = U.contents(corpse.get_inventory(defines.inventory.character_corpse))
  J.add('corpse_gone', rec.agent, {position = U.pos(corpse.position), reason = reason, by = by or rec.by,
    died_tick = rec.tick, items_left = next(left) and left or nil})
end

local function who(cause)
  if not (cause and cause.valid) then return nil end
  local name = storage.agent.by_unit[cause.unit_number or 0]
  if name then return name end
  if cause.type == 'character' and cause.player then return cause.player.name end
  return cause.name
end

local HEALTH_MARKS = {25, 50, 75} -- от нижнего: одно попадание через несколько порогов даёт одно событие

E.handlers[defines.events.on_entity_damaged] = function(ev)
  local e = ev.entity
  if not e.valid or e.force.name ~= 'player' then return end
  local unit = e.unit_number
  if not unit then return end
  local st = storage.agent
  local name = st.by_unit[unit]
  if name then
    -- Здоровье упало через порог 75 / 50 / 25 %: событие сразу, мимо ограничения частоты — по нему бот решает отступать.
    local max = e.max_health
    local before = ev.final_health + ev.final_damage_amount
    for _, t in ipairs(HEALTH_MARKS) do
      if ev.final_health > 0 and ev.final_health <= max * t / 100 and before > max * t / 100 then
        J.add('agent_health', name, {health = U.r2(ev.final_health), max_health = max, threshold = t,
          by = who(ev.cause), position = U.pos(e.position)})
        break
      end
    end
    if J.due('a' .. unit, DAMAGE_EVERY) then
      J.add('agent_damaged', name, {health = U.r2(ev.final_health), damage = U.r2(ev.final_damage_amount),
        by = who(ev.cause), position = U.pos(e.position)})
    end
  elseif e.type ~= 'character' then
    if J.due('e' .. unit, DAMAGE_EVERY) then
      J.add('entity_damaged', nil, {name = e.name, unit = unit, position = U.pos(e.position),
        health = U.r2(ev.final_health), max_health = e.max_health, by = who(ev.cause)})
    end
  end
end

E.handlers[defines.events.on_entity_died] = function(ev)
  local e = ev.entity
  if not e.valid then return end
  local st = storage.agent
  -- Убитое выстрелом бота идёт в итог его стрельбы.
  local cause = ev.cause
  if cause and cause.valid and cause.unit_number and st.by_unit[cause.unit_number] then
    Shoot.kill(st.agents[st.by_unit[cause.unit_number]], e)
  end
  if e.force.name ~= 'player' then return end
  local unit = e.unit_number
  local name = unit and st.by_unit[unit]
  if name then
    local A = st.agents[name]
    A.deaths = A.deaths + 1
    local where = U.pos(e.position)
    local lost = carried(e)
    st.corpses[corpse_key(e.position)] = {agent = name, tick = game.tick}
    -- Очередь погибшего обрывается; новый персонаж появляется у точки возрождения с пустым инвентарём.
    for _, act in ipairs(A.queue) do act.on_fail = 'stop' end
    if A.queue[1] then
      local q = A.queue
      A.queue = {}
      for _, act in ipairs(q) do
        J.add('action_done', name, {action_id = act.id, action = act.type, ok = false,
          error = {code = 'dead', message = 'персонаж погиб', data = {position = where}}})
      end
      st.active[name] = nil
    end
    st.crafting[name] = nil
    Shoot.stop(A, 'died')
    Throw.stop(A, 'died')
    Trig.forget(name)
    st.by_unit[unit] = nil
    A.unit, A.entity = nil, nil
    local ok, err = pcall(S.spawn, A)
    J.add('agent_died', name, {position = where, by = who(ev.cause), respawned = ok,
      respawn_position = ok and U.pos(A.entity.position) or nil, lost = lost})
  elseif unit and e.type ~= 'character' then
    J.add('entity_died', nil, {name = e.name, unit = unit, position = U.pos(e.position), by = who(ev.cause),
      by_force = ev.force and ev.force.name or nil})
  end
end

-- Труп исчезает, когда из него забрали всё (или по сроку, если он задан); человек может ещё и снять его добычей.
E.handlers[defines.events.on_character_corpse_expired] = function(ev)
  local c = ev.corpse
  if not (c and c.valid) then return end
  local inv = c.get_inventory(defines.inventory.character_corpse)
  corpse_gone(c, (not inv or inv.is_empty()) and 'emptied' or 'expired')
end
E.handlers[defines.events.on_pre_player_mined_item] = function(ev)
  local c = ev.entity
  if not (c and c.valid) or c.type ~= 'character-corpse' then return end
  local p = game.get_player(ev.player_index)
  corpse_gone(c, 'mined', p and p.name or nil)
end

-- Постройки ставят и снимают пачками: в журнал идёт сводка раз в секунду на автора, а не событие на каждую.
local function tally(kind, by, e)
  if not (e and e.valid) or e.force.name ~= 'player' or e.type == 'entity-ghost' or e.type == 'tile-ghost' then return end
  local buf = storage.agent.tally
  local k = kind .. '|' .. by
  local t = buf[k]
  if not t then
    t = {kind = kind, by = by, count = 0, names = {}, x1 = e.position.x, y1 = e.position.y, x2 = e.position.x, y2 = e.position.y}
    buf[k] = t
  end
  t.count = t.count + 1
  t.names[e.name] = (t.names[e.name] or 0) + 1
  t.x1, t.y1 = math.min(t.x1, e.position.x), math.min(t.y1, e.position.y)
  t.x2, t.y2 = math.max(t.x2, e.position.x), math.max(t.y2, e.position.y)
end
E.tally = tally

local function flush_tally()
  local buf = storage.agent.tally
  for k, t in pairs(buf) do
    J.add(t.kind, nil, {by = t.by, count = t.count, names = t.names, area = {x1 = t.x1, y1 = t.y1, x2 = t.x2, y2 = t.y2}})
    buf[k] = nil
  end
end

E.handlers[defines.events.on_built_entity] = function(ev)
  local p = game.get_player(ev.player_index)
  tally('entities_built', p and p.name or '?', ev.entity)
end
E.handlers[defines.events.on_player_mined_entity] = function(ev)
  local p = game.get_player(ev.player_index)
  tally('entities_removed', p and p.name or '?', ev.entity)
end
E.handlers[defines.events.on_robot_built_entity] = function(ev) tally('entities_built', 'robots', ev.entity) end
E.handlers[defines.events.on_robot_mined_entity] = function(ev) tally('entities_removed', 'robots', ev.entity) end

-- Угрозы: отряд врагов собрался в атаку; враги построили новую базу на открытой карте.
E.handlers[defines.events.on_unit_group_finished_gathering] = function(ev)
  local g = ev.group
  if not (g and g.valid) or g.force.name ~= 'enemy' then return end
  local force = game.forces.player
  local pos = g.position
  if not force.is_chunk_charted(g.surface, {math.floor(pos.x / 32), math.floor(pos.y / 32)}) then return end
  if J.due('group', 600) then J.add('attack_group', nil, {size = #g.members, position = U.pos(pos)}) end
end
E.handlers[defines.events.on_biter_base_built] = function(ev)
  local e = ev.entity
  if not (e and e.valid) then return end
  if game.forces.player.is_chunk_charted(e.surface, {math.floor(e.position.x / 32), math.floor(e.position.y / 32)}) then
    J.add('enemy_base_built', nil, {name = e.name, position = U.pos(e.position)})
  end
end

-- Дважды в секунду: враги рядом с персонажем бота (в пределах экрана) — чтобы бот успел ответить огнём.
local function scan_threats()
  local st = storage.agent
  for name, A in pairs(st.agents) do
    local e = A.entity
    if e and e.valid then
      local units = e.surface.find_enemy_units(e.position, 32, e.force)
      -- Событие: враги появились (не чаще раза в 2 секунды), их стало заметно больше, чем в прошлом событии
      -- (в полтора раза и хотя бы на 2; не чаще раза в секунду), или прошло 10 секунд, а они всё ещё рядом.
      local n, last, age = #units, A.near_n, game.tick - (A.near_tick or -600)
      if n == 0 then
        A.near_n = nil
      elseif age >= 600 or (not last and age >= 120) or (last and age >= 60 and n >= last + math.max(2, math.ceil(last / 2))) then
        A.near_n, A.near_tick = n, game.tick
        local best, bd
        for _, u in pairs(units) do
          local d = U.dist(u.position, e.position)
          if not bd or d < bd then best, bd = u, d end
        end
        J.add('enemies_near', name, {count = n, prev_count = last, nearest = {name = best.name, x = U.r2(best.position.x), y = U.r2(best.position.y), distance = U.r2(bd)}})
      end
    end
  end
end

-- Раз в 5 секунд: турели без патронов.
local function scan_turrets()
  for _, t in pairs(game.surfaces.nauvis.find_entities_filtered{type = 'ammo-turret', force = 'player'}) do
    local inv = t.get_inventory(defines.inventory.turret_ammo)
    if inv and inv.is_empty() and J.due('ammo' .. t.unit_number, 3600) then
      J.add('turret_no_ammo', nil, {name = t.name, unit = t.unit_number, position = U.pos(t.position)})
    end
  end
end

-- Тревоги при появлении: машины, у которых кончилось топливо или пропала энергия. Список машин обходится порциями,
-- в журнал идёт сводка по состоянию за проход, а не событие на каждую машину.
local WATCHED = {'assembling-machine', 'furnace', 'mining-drill', 'lab', 'boiler', 'generator', 'burner-generator', 'reactor', 'rocket-silo'}
local ALERT = {[defines.entity_status.no_fuel] = 'no_fuel', [defines.entity_status.no_power] = 'no_power'}
local SLICE = 300

local function scan_alerts()
  local w = storage.agent.watch
  if not w.list or w.i > #w.list then
    -- Проход закончен: сводка и новый список.
    for status, t in pairs(w.pending or {}) do
      J.add('alert', nil, {status = status, count = t.count, examples = t.examples})
    end
    w.pending = {}
    w.list = game.surfaces.nauvis.find_entities_filtered{type = WATCHED, force = 'player'}
    w.i = 1
    for unit in pairs(w.bad) do w.bad[unit] = w.bad[unit] == 2 and 1 or nil end -- 2 — виден в этом проходе
    return
  end
  local last = math.min(w.i + SLICE - 1, #w.list)
  for i = w.i, last do
    local e = w.list[i]
    if e.valid then
      local status = ALERT[e.status]
      local unit = e.unit_number
      if status then
        if not w.bad[unit] then
          local t = w.pending[status]
          if not t then
            t = {count = 0, examples = {}}
            w.pending[status] = t
          end
          t.count = t.count + 1
          if #t.examples < 5 then t.examples[#t.examples + 1] = {name = e.name, unit = unit, x = e.position.x, y = e.position.y} end
        end
        w.bad[unit] = 2
      end
    end
  end
  w.i = last + 1
end

E.handlers[defines.events.on_research_finished] = function(ev)
  local t = ev.research
  if t.force.name ~= 'player' then return end
  J.add('research_finished', nil, {name = t.name, level = t.level})
end

E.handlers[defines.events.on_console_chat] = function(ev)
  if not ev.player_index then return end
  local p = game.get_player(ev.player_index)
  J.chat(p and p.name or '?', ev.message)
end

E.handlers[defines.events.on_player_joined_game] = function(ev)
  local p = game.get_player(ev.player_index)
  J.add('player_joined', nil, {name = p.name})
end

E.handlers[defines.events.on_player_left_game] = function(ev)
  local p = game.get_player(ev.player_index)
  J.add('player_left', nil, {name = p.name})
end

E.handlers[defines.events.on_tick] = function(ev)
  local st = storage.agent
  for name in pairs(st.active) do
    Q.pump(st.agents[name])
  end
  for name in pairs(st.firing) do
    Shoot.tick(st.agents[name])
  end
  for name in pairs(st.throwing) do
    Throw.tick(st.agents[name])
  end
  if ev.tick % 6 == 0 then
    -- Конец ручного крафта: у персонажа без игрока событий крафта нет, поэтому сверяем очередь.
    for name in pairs(st.crafting) do
      local A = st.agents[name]
      local e = A.entity
      Trig.sync(A) -- скрафченное руками идёт в счёт технологий-триггеров
      if not (e and e.valid) or e.crafting_queue_size == 0 then
        st.crafting[name] = nil
        if e and e.valid then J.add('craft_done', name, {}) end
      end
    end
  end
  if ev.tick % 60 == 0 then
    Fog.tick(ev.tick)
    flush_tally()
    scan_alerts()
  end
  if ev.tick % 30 == 3 then Gui.tick(ev.tick - 3) end
  if ev.tick % 30 == 7 then scan_threats() end
  if ev.tick % 300 == 13 then scan_turrets() end
  if ev.tick % 3600 == 0 then J.prune_throttle(DAMAGE_EVERY) end
end

return E
