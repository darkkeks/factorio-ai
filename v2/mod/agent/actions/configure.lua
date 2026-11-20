-- configure: настройки постройки, которые игрок меняет в её окне или клавишами: рецепт, поворот, фильтры,
-- настройки логики, провода, имя станции, копирование настроек. Нужна досягаемость, как у игрока.
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')
local Tour = require('agent.actions.tour')
local B = require('agent.actions.build')
local Inv = require('agent.inv')
local O = require('agent.ops')
local Fog = require('agent.fog')

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

local SILO_STATUS = {}
for name, v in pairs(defines.rocket_silo_status) do SILO_STATUS[v] = name end

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

-- Заявка на предметы для стоящей постройки (то же, что игрок делает призраком предмета по слоту в её окне): игра
-- создаёт заявку, строительные роботы везут предметы из сети. Слоты выбираются по порядку: свободные или с тем же предметом.
local function request_list(v)
  if type(v) ~= 'table' then U.fail('bad_request', 'request_items: {предмет: количество}, список {item, count, inventory?, quality?} или false — снять заявку') end
  local list = {}
  if v[1] ~= nil then
    for i, r in ipairs(v) do list[i] = r end
  elseif v.item ~= nil then
    list[1] = v
  else
    local names = {}
    for name in pairs(v) do names[#names + 1] = name end
    table.sort(names, function(a, b) return tostring(a) < tostring(b) end)
    for i, name in ipairs(names) do list[i] = {item = name, count = v[name]} end
  end
  if #list == 0 or #list > 20 then U.fail('bad_request', 'request_items: от 1 до 20 предметов') end
  return list
end

local function request_items(e, ent, v)
  if ent.type == 'entity-ghost' or ent.type == 'tile-ghost' then
    U.fail('bad_request', 'request_items: цель — стоящая постройка; призраку предметы задаются при постановке (ghost_place, items)')
  end
  local proxy = ent.item_request_proxy
  if v == false then
    if proxy then proxy.destroy() end
    return false
  end
  local plan, taken, total = {}, {}, {}
  for i, r in ipairs(request_list(v)) do
    local where = 'request_items[' .. i .. ']'
    local proto = type(r) == 'table' and type(r.item) == 'string' and prototypes.item[r.item]
    if not proto then U.fail('bad_request', where .. ': нужен item — имя предмета') end
    if type(r.count) ~= 'number' or r.count < 1 or r.count > 10000 then U.fail('bad_request', where .. ': count — от 1 до 10000') end
    local quality = r.quality or 'normal'
    if not prototypes.quality[quality] then U.fail('bad_request', where .. ': нет такого качества: ' .. tostring(quality)) end
    local iname = r.inventory
    if iname == nil then
      if proto.type == 'ammo' then iname = 'ammo'
      elseif proto.type == 'module' then iname = 'modules'
      elseif proto.fuel_value > 0 and ent.get_fuel_inventory() then iname = 'fuel'
      elseif Inv.named(ent, 'main') then iname = 'main'
      else U.fail('bad_request', where .. ': укажи inventory — fuel, input, modules, ammo, main, robots') end
    end
    local inv = type(iname) == 'string' and Inv.named(ent, iname)
    local id = inv and inv.index
    if not id then U.fail('bad_request', where .. ': у ' .. ent.name .. ' нет слотов ' .. tostring(iname)) end
    if not inv.can_insert{name = proto.name, count = 1, quality = quality} then
      U.fail('no_space', where .. ': ' .. proto.name .. ' не помещается в слоты ' .. iname .. ' у ' .. ent.name)
    end
    local left, stack_size, slots = math.floor(r.count), proto.stack_size, {}
    local filtered = inv.supports_filters()
    taken[id] = taken[id] or {}
    for s = 1, math.min(#inv, 400) do
      if left <= 0 then break end
      if not taken[id][s] then
        local st, room = inv[s], 0
        if st.valid_for_read then
          if st.name == proto.name and st.quality.name == quality then room = stack_size - st.count end
        else
          local f = filtered and inv.get_filter(s)
          local fname = f and (type(f) == 'table' and f.name or f)
          if not fname or fname == proto.name then room = stack_size end
        end
        if room > 0 then
          local n = math.min(room, left)
          slots[#slots + 1] = {inventory = id, stack = s - 1, count = n}
          taken[id][s] = true
          left = left - n
        end
      end
    end
    if left > 0 then
      U.fail('no_space', where .. ': в слотах ' .. iname .. ' у ' .. ent.name .. ' место только под ' .. (math.floor(r.count) - left) .. ' ' .. proto.name,
        {fits = math.floor(r.count) - left})
    end
    plan[#plan + 1] = {id = {name = proto.name, quality = quality}, items = {in_inventory = slots}}
    local k = U.item_key(proto.name, quality)
    total[k] = (total[k] or 0) + math.floor(r.count)
  end
  try('request_items', function()
    if proxy then
      proxy.insert_plan = plan
    else
      proxy = ent.surface.create_entity{name = 'item-request-proxy', position = ent.position, force = ent.force, target = ent, modules = plan}
      if not proxy then error('игра не приняла заявку для ' .. ent.name) end
    end
  end)
  return total, #ent.surface.find_logistic_networks_by_construction_area(ent.position, ent.force) > 0
end

local function configure_one(A, it)
  local e, ent = A.entity, it.entity
  if not ent.valid then U.fail('not_found', 'объекта уже нет') end
  if ent.force ~= e.force then U.fail('not_allowed', 'это объект чужой команды') end
  local p = it.p
  local done = {}

  if p.request_items ~= nil then
    local total, covered = request_items(e, ent, p.request_items)
    done.request_items = total
    if total then done.robots_in_range = covered end
    if not e.can_reach_entity(ent) then done.remote = true end
  end

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

  -- Ракетная шахта: галочка автозапросов для платформ и кнопка запуска готовой ракеты. Груз кладётся transfer-ом
  -- (inventory: rocket); куда полетит груз, решает игра, как при нажатии кнопки в окне шахты.
  if p.platform_requests ~= nil or p.launch ~= nil then
    if ent.type ~= 'rocket-silo' then U.fail('bad_request', 'launch, platform_requests: цель — ракетная шахта') end
    if p.platform_requests ~= nil then
      if type(p.platform_requests) ~= 'boolean' then U.fail('bad_request', 'platform_requests: true | false') end
      try('platform_requests', function() ent.use_transitional_requests = p.platform_requests end)
    end
    if p.launch ~= nil then
      if p.launch ~= true then U.fail('bad_request', 'launch: true') end
      local st = ent.rocket_silo_status
      if st ~= defines.rocket_silo_status.rocket_ready then
        U.fail('not_allowed','ракета не готова к запуску: ' .. (SILO_STATUS[st] or tostring(st))
          .. ', деталей ракеты ' .. ent.rocket_parts .. '/' .. ent.prototype.rocket_parts_required, {rocket = SILO_STATUS[st]})
      end
      local cargo = ent.get_inventory(defines.inventory.rocket_silo_rocket)
      local items = cargo and U.contents(cargo) or {}
      -- Стартовый набор платформы: как при запуске из окна шахты, он летит к платформе, ждущей такой набор на орбите
      -- этой планеты, а если такой нет — становится новой платформой. Без этого адреса игра вернула бы набор на землю.
      local dest, platform, created
      local planet = ent.surface.planet
      local pack
      for _, s in pairs(cargo and cargo.get_contents() or {}) do
        if prototypes.item[s.name].type == 'space-platform-starter-pack' then pack = s end
      end
      if pack and planet then
        for _, pl in pairs(e.force.platforms) do
          local sp, loc = pl.starter_pack, pl.space_location
          if not platform and pl.state == defines.space_platform_state.waiting_for_starter_pack and loc and loc.name == planet.name
            and sp and sp.name.name == pack.name and sp.quality.name == (pack.quality or 'normal') then
            platform = pl
          end
        end
        if not platform then
          try('launch', function()
            platform = e.force.create_space_platform{planet = planet.name, starter_pack = {name = pack.name, quality = pack.quality}}
          end)
          created = platform ~= nil
        end
        if platform then dest = {type = defines.cargo_destination.space_platform, space_platform = platform} end
      end
      local okl, err = pcall(function() if dest then ent.launch_rocket(dest) else ent.launch_rocket() end end)
      if not okl or ent.rocket_silo_status == defines.rocket_silo_status.rocket_ready then
        if created then platform.destroy(1) end
        U.fail('blocked', 'игра не дала запустить ракету' .. (okl and '' or ': ' .. tostring(err)), {rocket = SILO_STATUS[ent.rocket_silo_status]})
      end
      done.launched = true
      if platform then done.platform = {name = platform.name, created = created or nil} end
      done.cargo = U.list(items)
    end
    done.rocket = SILO_STATUS[ent.rocket_silo_status]
    done.platform_requests = ent.use_transitional_requests
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

-- Личные логистические запросы персонажа — вкладка логистики в окне персонажа: предмет, минимум (роботы довезут)
-- и максимум (лишнее уйдёт в мусорные слоты). Доступно после исследования логистики персонажа, как у игрока.
local function personal_view(e, point)
  local out = {}
  for _, sec in pairs(point.sections) do
    if sec.is_manual then
      for i = 1, sec.filters_count do
        local f = sec.get_slot(i)
        local v = f and f.value
        if v and v.name and #out < 200 then
          out[#out + 1] = {item = v.name, quality = (v.quality and v.quality ~= 'normal') and v.quality or nil, min = f.min or 0, max = f.max,
            have = e.get_item_count{name = v.name, quality = v.quality or 'normal'}, paused = (not sec.active) or nil}
        end
      end
    end
  end
  return out
end

O.register('logistic_requests', {agent = true, write = true, fn = function(A, p)
  local e = A.entity
  local point = e.force.character_logistic_requests and e.get_requester_point()
  if not point then
    if p.set == nil and p.clear == nil and p.enabled == nil then return {available = false, requests = U.EMPTY} end
    U.fail('not_allowed', 'личные логистические запросы ещё не исследованы (технология logistic-robotics)')
  end
  if p.enabled ~= nil then
    if type(p.enabled) ~= 'boolean' then U.fail('bad_request', 'enabled: true | false') end
    point.enabled = p.enabled
  end
  local function manual(create)
    for _, sec in pairs(point.sections) do if sec.is_manual then return sec end end
    return create and point.add_section() or nil
  end
  local function find(name, quality)
    for _, sec in pairs(point.sections) do
      if sec.is_manual then
        for i = 1, sec.filters_count do
          local f = sec.get_slot(i)
          local v = f and f.value
          if v and v.name == name and (v.quality or 'normal') == quality then return sec, i end
        end
      end
    end
  end
  if p.clear ~= nil then
    if p.clear == true then
      for _, sec in pairs(point.sections) do
        if sec.is_manual then for i = sec.filters_count, 1, -1 do sec.clear_slot(i) end end
      end
    elseif type(p.clear) == 'table' then
      if #p.clear > 100 then U.fail('bad_request', 'clear: не больше 100 предметов') end
      for _, c in ipairs(p.clear) do
        local name = type(c) == 'table' and c.item or c
        local sec, i = find(name, type(c) == 'table' and c.quality or 'normal')
        if sec then sec.clear_slot(i) end
      end
    else
      U.fail('bad_request', 'clear: true — снять все запросы, или список предметов')
    end
  end
  if p.set ~= nil then
    if type(p.set) ~= 'table' then U.fail('bad_request', 'set: список {item, min, max?, quality?}') end
    local list = p.set.item ~= nil and {p.set} or p.set
    if #list == 0 or #list > 100 then U.fail('bad_request', 'set: от 1 до 100 запросов {item, min, max?, quality?}') end
    for i, r in ipairs(list) do
      local where = 'set[' .. i .. ']'
      if type(r) ~= 'table' or type(r.item) ~= 'string' or not prototypes.item[r.item] then U.fail('bad_request', where .. ': нужен item — имя предмета') end
      local min, max = r.min or 0, r.max
      if type(min) ~= 'number' or min < 0 or min > 1000000 then U.fail('bad_request', where .. ': min — число от 0') end
      if max ~= nil and (type(max) ~= 'number' or max < min or max > 1000000) then U.fail('bad_request', where .. ': max — число не меньше min') end
      if r.quality ~= nil and not prototypes.quality[r.quality] then U.fail('bad_request', where .. ': нет такого качества: ' .. tostring(r.quality)) end
    end
    for i, r in ipairs(list) do
      local quality = r.quality or 'normal'
      local sec, slot = find(r.item, quality)
      if not sec then
        sec = manual(true)
        if not sec then U.fail('blocked', 'игра не дала добавить раздел запросов') end
        slot = sec.filters_count + 1
        for k = 1, sec.filters_count do
          local f = sec.get_slot(k)
          if not (f and f.value) then slot = k break end
        end
      end
      try('set[' .. i .. ']', function()
        sec.set_slot(slot, {value = {type = 'item', name = r.item, quality = quality, comparator = '='},
          min = math.floor(r.min or 0), max = r.max and math.floor(r.max) or nil})
      end)
    end
  end
  local net = e.logistic_network
  return {available = true, enabled = point.enabled, in_network = net ~= nil,
    trash_slots = #(e.get_inventory(defines.inventory.character_trash) or {}),
    trash = U.contents(e.get_inventory(defines.inventory.character_trash)),
    requests = U.list(personal_view(e, point))}
end})

local SETTINGS = {'copy_from', 'recipe', 'recipe_quality', 'direction', 'rotate', 'filters', 'filter_mode', 'input_priority',
  'output_priority', 'stack_size', 'bar', 'station', 'trains_limit', 'schedule', 'manual_mode', 'platform_requests', 'launch', 'control', 'wire',
  'request_items'}

local function remote_only(p)
  if p.request_items == nil then return false end
  for _, k in ipairs(SETTINGS) do
    if k ~= 'request_items' and p[k] ~= nil then return false end
  end
  return true
end

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
  -- Заявка роботам (request_items) без других настроек не требует досягаемости тела: игрок ставит её с карты
  -- (удалённый вид) на любую свою постройку, которую видит вживую. Остальные настройки — только в досягаемости.
  in_reach = function(A, it)
    local e, ent = A.entity, it.entity
    if e.can_reach_entity(ent) then return true end
    if not remote_only(it.p) or ent.force ~= e.force then return false end
    return Fog.state(ent.surface, e.force, ent.position.x, ent.position.y) == 'visible'
  end,
  exec = configure_one,
  brief = function(it) return {x = it.target.x, y = it.target.y, unit = it.target.unit} end,
})
