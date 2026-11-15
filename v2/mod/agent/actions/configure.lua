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

-- Расписание поезда: то, что игрок набирает в окне поезда. Станции — только существующие у своей команды (как в списке
-- окна), условия ожидания — простые: по времени, простою, заполненности и количеству груза.
local RAIL_STOCK = {locomotive = true, ['cargo-wagon'] = true, ['fluid-wagon'] = true, ['artillery-wagon'] = true}
local WAIT_PLAIN = {full = true, empty = true, not_empty = true, fuel_full = true, passenger_present = true, passenger_not_present = true}
local WAIT_TICKS = {time = true, inactivity = true}
local WAIT_COUNT = {item_count = 'item', fluid_count = 'fluid'}
local COMPARATORS = {['<'] = true, ['>'] = true, ['='] = true, ['>='] = true, ['<='] = true, ['!='] = true}
local WAIT_HELP = 'time | inactivity (ticks или seconds), full, empty, not_empty, fuel_full, passenger_present, passenger_not_present, item_count | fluid_count (item | fluid, comparator, count)'
local TRAIN_STATE = {}
for name, v in pairs(defines.train_state) do TRAIN_STATE[v] = name end

local function schedule_records(e, list)
  if type(list) ~= 'table' then U.fail('bad_request', 'schedule: список {station, wait: [...]} или false — очистить') end
  if #list > 50 then U.fail('bad_request', 'schedule: не больше 50 остановок') end
  local records = {}
  for i, rec in ipairs(list) do
    local where = 'schedule[' .. i .. ']'
    if type(rec) ~= 'table' or type(rec.station) ~= 'string' then U.fail('bad_request', where .. ': нужен station — имя станции') end
    if #game.train_manager.get_train_stops{force = e.force, surface = e.surface, station_name = rec.station} == 0 then
      U.fail('not_found', where .. ': у команды нет станции с именем ' .. rec.station .. ' (список — trains)')
    end
    local waits = rec.wait or {}
    if type(waits) ~= 'table' then U.fail('bad_request', where .. '.wait: список условий') end
    if waits.type ~= nil then waits = {waits} end
    if #waits > 10 then U.fail('bad_request', where .. '.wait: не больше 10 условий') end
    local conds = {}
    for j, w in ipairs(waits) do
      local ww = where .. '.wait[' .. j .. ']'
      if type(w) == 'string' then w = {type = w} end
      if type(w) ~= 'table' then U.fail('bad_request', ww .. ': {type, …}; type: ' .. WAIT_HELP) end
      local c = {type = w.type, compare_type = w.compare or 'and'}
      if c.compare_type ~= 'and' and c.compare_type ~= 'or' then U.fail('bad_request', ww .. '.compare: and | or') end
      if WAIT_TICKS[w.type] then
        local ticks = w.ticks or (type(w.seconds) == 'number' and w.seconds * 60)
        if type(ticks) ~= 'number' or ticks < 1 or ticks > 4000000 then U.fail('bad_request', ww .. ': нужно ticks или seconds (от 1 тика)') end
        c.ticks = math.floor(ticks)
      elseif WAIT_COUNT[w.type] then
        local kind = WAIT_COUNT[w.type]
        local name = w[kind]
        local proto = type(name) == 'string' and (kind == 'item' and prototypes.item[name] or kind == 'fluid' and prototypes.fluid[name])
        if not proto then U.fail('bad_request', ww .. ': нужен ' .. kind .. ' — имя ' .. (kind == 'item' and 'предмета' or 'жидкости')) end
        local cmp = w.comparator or '>='
        if not COMPARATORS[cmp] then U.fail('bad_request', ww .. '.comparator: <, >, =, >=, <=, !=') end
        if type(w.count) ~= 'number' then U.fail('bad_request', ww .. ': нужен count — число') end
        c.condition = {first_signal = {type = kind, name = name}, comparator = cmp, constant = math.floor(w.count)}
      elseif not WAIT_PLAIN[w.type] then
        U.fail('bad_request', ww .. '.type: ' .. WAIT_HELP)
      end
      conds[j] = c
    end
    records[i] = {station = rec.station, wait_conditions = conds}
  end
  return records
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

  -- Поезд: расписание и ручной/автоматический режим — окно поезда, открытое у локомотива или вагона в досягаемости.
  if p.schedule ~= nil or p.manual_mode ~= nil then
    local train = RAIL_STOCK[ent.type] and ent.train
    if not train then U.fail('bad_request', 'schedule, manual_mode: цель — локомотив или вагон поезда') end
    if p.schedule ~= nil then
      local records = p.schedule == false and {} or schedule_records(e, p.schedule)
      try('schedule', function()
        if #records == 0 then
          train.schedule = nil
        else
          local old = train.schedule
          local cur = old and old.current or 1
          train.schedule = {current = cur <= #records and cur or 1, records = records}
        end
      end)
    end
    if p.manual_mode ~= nil then
      if type(p.manual_mode) ~= 'boolean' then U.fail('bad_request', 'manual_mode: true | false') end
      try('manual_mode', function() train.manual_mode = p.manual_mode end)
    end
    done.train = {id = train.id, manual = train.manual_mode, state = TRAIN_STATE[train.state], schedule = U.list(U.schedule(train))}
  end

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
  'output_priority', 'stack_size', 'bar', 'station', 'trains_limit', 'schedule', 'manual_mode', 'control', 'wire'}

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
