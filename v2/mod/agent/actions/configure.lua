-- configure: настройки постройки, которые игрок меняет в её окне или клавишами: рецепт, поворот, фильтры,
-- настройки логики, провода, имя станции, копирование настроек. Нужна досягаемость, как у игрока.
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')
local Tour = require('agent.actions.tour')
local B = require('agent.actions.build')

local WIRE = {
  red = defines.wire_connector_id.circuit_red,
  green = defines.wire_connector_id.circuit_green,
  copper = defines.wire_connector_id.pole_copper,
}

local function give_back(e, items)
  for _, s in pairs(items or {}) do
    local n = e.insert(s)
    if n < s.count then
      e.surface.spill_item_stack{position = e.position, stack = {name = s.name, count = s.count - n, quality = s.quality}}
    end
  end
end

local function try(what, fn)
  local ok, err = pcall(fn)
  if not ok then U.fail('bad_request', what .. ': ' .. tostring(err)) end
end

local function configure_one(A, it)
  local e, ent = A.entity, it.entity
  if not ent.valid then U.fail('not_found', 'объекта уже нет') end
  if ent.force ~= e.force then U.fail('not_allowed', 'это объект чужой команды') end
  local p = it.p
  local done = {}

  if p.copy_from ~= nil then
    local src = T.get(e.surface, p.copy_from)
    if not e.can_reach_entity(src) then U.fail('out_of_reach', 'источник настроек вне досягаемости') end
    give_back(e, ent.copy_settings(src))
    done.copied_from = src.name
  end

  if p.recipe ~= nil then
    if ent.type ~= 'assembling-machine' and ent.type ~= 'rocket-silo' and ent.type ~= 'furnace' then
      U.fail('bad_request', ent.name .. ' не принимает рецепт')
    end
    if p.recipe == false then
      give_back(e, ent.set_recipe(nil))
      done.recipe = false
    else
      local rc = e.force.recipes[p.recipe]
      if not rc then U.fail('bad_request', 'нет такого рецепта: ' .. tostring(p.recipe)) end
      if not rc.enabled then U.fail('not_allowed', 'рецепт ' .. rc.name .. ' ещё не исследован') end
      local fits = false
      for cat in pairs(ent.prototype.crafting_categories or {}) do
        if rc.has_category(cat) then fits = true end
      end
      if not fits then U.fail('not_allowed', ent.name .. ' не делает рецепт ' .. rc.name) end
      give_back(e, ent.set_recipe(rc, p.recipe_quality))
      done.recipe = rc.name
    end
  end

  if p.direction ~= nil then
    if not ent.supports_direction then U.fail('bad_request', ent.name .. ' не поворачивается') end
    ent.direction = U.dir(p.direction)
  end
  if p.rotate then
    if not ent.rotate{reverse = p.rotate == 'reverse'} then U.fail('blocked', 'повернуть не удалось: мешают соседние постройки') end
  end

  if p.filters ~= nil then
    if ent.type == 'inserter' or ent.type == 'loader' or ent.type == 'loader-1x1' then
      try('filters', function()
        for i = 1, ent.filter_slot_count do
          local f = p.filters[i]
          ent.set_filter(i, f and (type(f) == 'table' and f or {name = f}) or nil)
        end
        if ent.type == 'inserter' then ent.use_filters = #p.filters > 0 end
      end)
    elseif ent.type == 'splitter' or ent.type == 'lane-splitter' then
      try('filters', function() ent.splitter_filter = p.filters[1] and {name = p.filters[1]} or nil end)
    else
      U.fail('bad_request', ent.name .. ' не имеет фильтров')
    end
  end
  if p.filter_mode ~= nil then try('filter_mode', function() ent.inserter_filter_mode = p.filter_mode end) end
  if p.input_priority ~= nil then try('input_priority', function() ent.splitter_input_priority = p.input_priority end) end
  if p.output_priority ~= nil then try('output_priority', function() ent.splitter_output_priority = p.output_priority end) end
  if p.stack_size ~= nil then try('stack_size', function() ent.inserter_stack_size_override = p.stack_size end) end
  if p.bar ~= nil then
    try('bar', function()
      local inv = ent.get_inventory(defines.inventory.chest) or ent.get_inventory(defines.inventory.cargo_wagon)
      if not inv or not inv.supports_bar() then error('у объекта нет ограничителя слотов') end
      if p.bar == false then inv.set_bar() else inv.set_bar(p.bar + 1) end
    end)
  end
  if p.station ~= nil then
    if ent.type ~= 'train-stop' then U.fail('bad_request', 'station: только для станции') end
    ent.backer_name = p.station
  end
  if p.trains_limit ~= nil then try('trains_limit', function() ent.trains_limit = p.trains_limit == false and nil or p.trains_limit end) end

  -- Настройки логики: поля управляющего поведения постройки (то, что игрок задаёт в её окне логической сети).
  if p.control ~= nil then
    if type(p.control) ~= 'table' then U.fail('bad_request', 'control: объект с полями управляющего поведения') end
    local cb = ent.get_or_create_control_behavior()
    if not cb then U.fail('bad_request', ent.name .. ' не имеет настроек логики') end
    for k, v in pairs(p.control) do
      try('control.' .. k, function() cb[k] = v end)
    end
  end

  -- Провод: {to: цель, type: red | green | copper, disconnect?}. Оба конца в досягаемости, длина — по правилам игры.
  if p.wire ~= nil then
    local wire = p.wire
    if type(wire) ~= 'table' or not WIRE[wire.type or ''] then U.fail('bad_request', 'wire: {to, type: red | green | copper, disconnect?}') end
    local other = T.get(e.surface, wire.to)
    if not e.can_reach_entity(other) then U.fail('out_of_reach', 'второй конец провода вне досягаемости') end
    local a = ent.get_wire_connector(WIRE[wire.type], true)
    local b = other.get_wire_connector(WIRE[wire.type], true)
    if not a or not b then U.fail('bad_request', 'к этим объектам такой провод не подключается') end
    if wire.disconnect then
      a.disconnect_from(b)
      done.wire = 'disconnected'
    else
      if not a.can_wire_reach(b) then U.fail('out_of_reach', 'провод не дотягивается между объектами') end
      a.connect_to(b, false)
      done.wire = 'connected'
    end
  end

  return B.describe(ent, done)
end

local SETTINGS = {'copy_from', 'recipe', 'recipe_quality', 'direction', 'rotate', 'filters', 'filter_mode', 'input_priority',
  'output_priority', 'stack_size', 'bar', 'station', 'trains_limit', 'control', 'wire'}

local function check_one(it, where)
  if type(it) ~= 'table' or type(it.target) ~= 'table' then U.fail('bad_request', where .. ': нужен target — {unit} или {x, y, name?}') end
  local any = false
  for _, k in ipairs(SETTINGS) do if it[k] ~= nil then any = true end end
  if not any then U.fail('bad_request', where .. ': не задано ни одной настройки (' .. table.concat(SETTINGS, ', ') .. ')') end
  U.dir(it.direction, where .. '.direction')
  if it.filters ~= nil and type(it.filters) ~= 'table' then U.fail('bad_request', where .. '.filters: список имён предметов') end
end

Q.register('configure', Tour.action{
  check = function(p)
    if p.items ~= nil then
      if type(p.items) ~= 'table' then U.fail('bad_request', 'items: список {target, …настройки}') end
      for i, it in ipairs(p.items) do check_one(it, 'items[' .. i .. ']') end
    else
      check_one(p, 'configure')
    end
  end,
  items = function(A, p)
    if p.items == nil then return {{target = p.target, p = p}}, true end
    local list = {}
    for i, it in ipairs(p.items) do list[i] = {target = it.target, p = it} end
    return list, false
  end,
  point = function(A, it)
    if not it.entity then it.entity = T.get(A.entity.surface, it.target) end
    if not it.entity.valid then U.fail('not_found', 'объекта уже нет') end
    return it.entity.position, A.entity.reach_distance
  end,
  in_reach = function(A, it) return A.entity.can_reach_entity(it.entity) end,
  exec = configure_one,
  brief = function(it) return {x = it.target.x, y = it.target.y, unit = it.target.unit} end,
})
