-- События игры → журнал. Обработчики регистрируются при загрузке сценария, одинаково у сервера и клиентов.
local U = require('agent.util')
local J = require('agent.journal')
local Q = require('agent.queue')
local S = require('agent.state')

local E = {handlers = {}, nth = {}}

local DAMAGE_EVERY = 300 -- повторный урон по тому же объекту — не чаще раза в 5 секунд

local function who(cause)
  if not (cause and cause.valid) then return nil end
  local name = storage.agent.by_unit[cause.unit_number or 0]
  if name then return name end
  if cause.type == 'character' and cause.player then return cause.player.name end
  return cause.name
end

E.handlers[defines.events.on_entity_damaged] = function(ev)
  local e = ev.entity
  if not e.valid or e.force.name ~= 'player' then return end
  local unit = e.unit_number
  if not unit then return end
  local st = storage.agent
  local name = st.by_unit[unit]
  if name then
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
  if not e.valid or e.force.name ~= 'player' then return end
  local st = storage.agent
  local unit = e.unit_number
  local name = unit and st.by_unit[unit]
  if name then
    local A = st.agents[name]
    A.deaths = A.deaths + 1
    local where = U.pos(e.position)
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
    st.by_unit[unit] = nil
    A.unit, A.entity = nil, nil
    local ok, err = pcall(S.spawn, A)
    J.add('agent_died', name, {position = where, by = who(ev.cause), respawned = ok,
      respawn_position = ok and U.pos(A.entity.position) or nil})
  elseif unit and e.type ~= 'character' then
    J.add('entity_died', nil, {name = e.name, unit = unit, position = U.pos(e.position), by = who(ev.cause),
      by_force = ev.force and ev.force.name or nil})
  end
end

E.handlers[defines.events.on_research_finished] = function(ev)
  local t = ev.research
  if t.force.name ~= 'player' then return end
  J.add('research_finished', nil, {name = t.name, level = t.level})
end

E.handlers[defines.events.on_console_chat] = function(ev)
  if not ev.player_index then return end
  local p = game.get_player(ev.player_index)
  J.add('chat', nil, {from = p and p.name or '?', text = ev.message})
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
  if ev.tick % 6 == 0 then
    -- Конец ручного крафта: у персонажа без игрока событий крафта нет, поэтому сверяем очередь.
    for name in pairs(st.crafting) do
      local A = st.agents[name]
      local e = A.entity
      if not (e and e.valid) or e.crafting_queue_size == 0 then
        st.crafting[name] = nil
        if e and e.valid then J.add('craft_done', name, {}) end
      end
    end
  end
  if ev.tick % 3600 == 0 then J.prune_throttle(DAMAGE_EVERY) end
end

return E
