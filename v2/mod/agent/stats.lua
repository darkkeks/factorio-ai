-- Окна игры: производство, электросеть, исследования, тревоги, загрязнение, враги, логистика, поезда, справочник, чат.
local U = require('agent.util')
local T = require('agent.target')
local O = require('agent.ops')
local Fog = require('agent.fog')
local Obs = require('agent.observe')
local Trig = require('agent.triggers')

local STATUS = {}
for name, v in pairs(defines.entity_status) do STATUS[v] = name end

local WINDOWS = {['5s'] = 'five_seconds', ['1m'] = 'one_minute', ['10m'] = 'ten_minutes', ['1h'] = 'one_hour', ['10h'] = 'ten_hours',
  ['50h'] = 'fifty_hours', ['250h'] = 'two_hundred_fifty_hours', ['1000h'] = 'one_thousand_hours'}
local MINUTES = {['5s'] = 1 / 12, ['1m'] = 1, ['10m'] = 10, ['1h'] = 60, ['10h'] = 600, ['50h'] = 3000, ['250h'] = 15000, ['1000h'] = 60000}

-- ── production: окно производства ──
O.register('production', {agent = true, fn = function(A, p)
  local e = A.entity
  local window = p.window or '10m'
  if not WINDOWS[window] then U.fail('bad_request', 'window: 5s, 1m, 10m, 1h, 10h, 50h, 250h, 1000h') end
  local idx = defines.flow_precision_index[WINDOWS[window]]
  local minutes = MINUTES[window]
  local want
  if p.items then
    want = {}
    for _, n in ipairs(type(p.items) == 'table' and p.items or {p.items}) do want[n] = true end
  end
  local limit = math.min(p.limit or 40, 500)
  local function stat(st)
    local made, used = st.input_counts, st.output_counts
    local names = {}
    for n in pairs(made) do names[n] = true end
    for n in pairs(used) do names[n] = true end
    local list = {}
    for n in pairs(names) do
      if not want or want[n] then
        local pr = st.get_flow_count{name = n, category = 'input', precision_index = idx, count = true}
        local c = st.get_flow_count{name = n, category = 'output', precision_index = idx, count = true}
        if want or pr > 0 or c > 0 then
          list[#list + 1] = {name = n, produced_per_min = U.r2(pr / minutes), consumed_per_min = U.r2(c / minutes),
            produced_total = math.floor(made[n] or 0), consumed_total = math.floor(used[n] or 0)}
        end
      end
    end
    table.sort(list, function(a, b)
      if a.produced_per_min ~= b.produced_per_min then return a.produced_per_min > b.produced_per_min end
      if a.consumed_per_min ~= b.consumed_per_min then return a.consumed_per_min > b.consumed_per_min end
      return a.name < b.name
    end)
    local out = {}
    for i = 1, math.min(#list, limit) do out[i] = list[i] end
    return out, #list
  end
  local r = {window = window}
  local n
  r.items, n = stat(e.force.get_item_production_statistics(e.surface))
  r.items_total = n
  r.items = U.list(r.items)
  r.fluids, n = stat(e.force.get_fluid_production_statistics(e.surface))
  r.fluids_total = n
  r.fluids = U.list(r.fluids)
  return r
end})

local POWERED = {'accumulator', 'assembling-machine', 'furnace', 'mining-drill', 'lab', 'radar', 'pump', 'beacon', 'roboport',
  'electric-turret', 'rocket-silo', 'lamp'}

local GENERATORS = {'generator', 'burner-generator', 'solar-panel', 'fusion-generator', 'lightning-attractor'}

-- ── power: окно электросети ──
O.register('power', {agent = true, fn = function(A, p)
  local e = A.entity
  local pole
  if p.target then
    pole = T.get(e.surface, p.target)
    if pole.type ~= 'electric-pole' then U.fail('bad_request', 'цель — не столб, а ' .. pole.name) end
  else
    local bd
    for _, c in pairs(e.surface.find_entities_filtered{type = 'electric-pole', position = e.position, radius = 80, force = e.force}) do
      local d = U.dist(c.position, e.position)
      if not bd or d < bd then pole, bd = c, d end
    end
    if not pole then
      -- Сети рядом нет — обычный ответ с нулями: планировщику не нужно разбирать ошибку.
      return {pole = nil, network = nil, window = '5s', production = U.list({}), production_kw = 0, consumption = U.list({}), consumption_kw = 0,
        generators = U.list({}), capacity_kw = 0, machines = {ok = 0, low_power = 0, no_power = 0, radius = 0}, satisfied = false,
        problems = U.list({}), note = 'в радиусе 80 клеток нет ни одного столба; укажи target'}
    end
  end
  if Fog.state(e.surface, e.force, pole.position.x, pole.position.y) ~= 'visible' then U.fail('not_visible', 'столб вне обзора') end
  local st = pole.electric_network_statistics
  local idx = defines.flow_precision_index.five_seconds
  local function flows(counts, cat)
    local list, total = {}, 0
    for name in pairs(counts) do
      local w = st.get_flow_count{name = name, category = cat, precision_index = idx} * 60
      if w > 0 then
        list[#list + 1] = {name = name, kw = U.r2(w / 1000)}
        total = total + w
      end
    end
    table.sort(list, function(a, b) return a.kw > b.kw end)
    local out = {}
    for i = 1, math.min(#list, 20) do out[i] = list[i] end
    return U.list(out), U.r2(total / 1000)
  end
  local r = {pole = Obs.brief(pole), network = pole.electric_network_id, window = '5s'}
  r.production, r.production_kw = flows(st.output_counts, 'output')
  r.consumption, r.consumption_kw = flows(st.input_counts, 'input')
  -- Аккумуляторы и машины без питания — рядом со столбом (по состоянию машин, как значки над ними).
  local radius = math.min(p.radius or 48, 150)
  local acc, cap, ok, low, none = 0, 0, 0, 0, 0
  local problems = {}
  local NO, LOW = defines.entity_status.no_power, defines.entity_status.low_power
  for _, c in pairs(e.surface.find_entities_filtered{position = pole.position, radius = radius, force = e.force, type = POWERED}) do
    if c.type == 'accumulator' then
      acc, cap = acc + c.energy, cap + c.electric_buffer_size
    else
      local status = c.status
      if status == NO then
        none = none + 1
        if #problems < 40 then problems[#problems + 1] = {name = c.name, x = c.position.x, y = c.position.y, status = 'no_power'} end
      elseif status == LOW then
        low = low + 1
        if #problems < 40 then problems[#problems + 1] = {name = c.name, x = c.position.x, y = c.position.y, status = 'low_power'} end
      else
        ok = ok + 1
      end
    end
  end
  if cap > 0 then r.accumulators = {charge = U.r2(acc / cap), capacity_mj = U.r2(cap / 1e6), charge_mj = U.r2(acc / 1e6)} end
  -- Установленная мощность: генераторы этой сети в том же радиусе, максимум по прототипу (как полоса в окне сети).
  local net = pole.electric_network_id
  local gens, by_name, capacity = {}, {}, 0
  local solar = e.surface.solar_power_multiplier
  for _, c in pairs(e.surface.find_entities_filtered{position = pole.position, radius = radius, force = e.force, type = GENERATORS}) do
    if c.electric_network_id == net then
      local w = c.prototype.get_max_energy_production(c.quality) * 60
      if c.type == 'solar-panel' then w = w * solar end
      local g = by_name[c.name]
      if not g then
        g = {name = c.name, count = 0, w = 0}
        by_name[c.name] = g
        gens[#gens + 1] = g
      end
      g.count, g.w = g.count + 1, g.w + w
      capacity = capacity + w
    end
  end
  table.sort(gens, function(a, b) return a.w > b.w end)
  for _, g in ipairs(gens) do g.max_kw, g.w = U.r2(g.w / 1000), nil end
  r.generators = U.list(gens)
  r.capacity_kw = U.r2(capacity / 1000)
  r.machines = {ok = ok, low_power = low, no_power = none, radius = radius}
  r.satisfied = low == 0 and none == 0
  r.problems = U.list(problems)
  return r
end})

-- ── research_info: окно исследований ──
local function tech_info(t, force)
  local ing = {}
  for _, i in pairs(t.research_unit_ingredients) do ing[i.name] = i.amount end
  local pre = {}
  for name, pr in pairs(t.prerequisites) do if not pr.researched then pre[#pre + 1] = name end end
  return {name = t.name, level = t.level, units = t.research_unit_count, seconds_per_unit = U.r2(t.research_unit_energy / 60),
    ingredients = ing, missing_prerequisites = #pre > 0 and pre or nil, trigger = Trig.describe(t)}
end

O.register('research_info', {agent = true, fn = function(A, p)
  local force = A.entity.force
  local r = {}
  local cur = force.current_research
  if cur then
    r.current = tech_info(cur, force)
    r.current.progress = U.r2(force.research_progress)
  end
  local q = {}
  for i, t in ipairs(force.research_queue) do q[i] = tech_info(t, force) end
  r.queue = U.list(q)
  if p.name then
    local t = force.technologies[p.name]
    if not t then U.fail('not_found', 'нет такой технологии: ' .. tostring(p.name)) end
    local info = tech_info(t, force)
    info.researched, info.enabled = t.researched, t.enabled
    local unlocks = {}
    for _, m in pairs(t.prototype.effects or {}) do if m.type == 'unlock-recipe' then unlocks[#unlocks + 1] = m.recipe end end
    info.unlocks = U.list(unlocks)
    r.technology = info
    return r
  end
  if p.researched then
    -- Изученное, как в окне исследований: у бесконечной технологии — сколько уровней уже пройдено.
    local done = {}
    for name, t in pairs(force.technologies) do
      if t.researched then
        done[#done + 1] = {name = name, level = t.level}
      elseif t.level > t.prototype.level then
        done[#done + 1] = {name = name, level = t.level - 1, infinite = true}
      end
    end
    table.sort(done, function(a, b) return a.name < b.name end)
    r.researched = U.list(done)
    r.researched_total = #done
  end
  -- Доступные: предпосылки исследованы, сама ещё нет.
  local avail = {}
  for name, t in pairs(force.technologies) do
    if t.enabled and not t.researched then
      local ready = true
      for _, pr in pairs(t.prerequisites) do if not pr.researched then ready = false break end end
      if ready then avail[#avail + 1] = tech_info(t, force) end
    end
  end
  table.sort(avail, function(a, b) return a.units < b.units end)
  local limit = math.min(p.limit or 30, 300)
  local out = {}
  for i = 1, math.min(#avail, limit) do out[i] = avail[i] end
  r.available = U.list(out)
  r.available_total = #avail
  return r
end})

-- ── alerts: что на базе встало — как значки над машинами и тревоги игрока ──
local PROBLEM = {no_fuel = true, no_power = true, low_power = true, no_ammo = true, missing_required_fluid = true,
  no_minable_resources = true, output_full = false, full_output = false, no_ingredients = false, item_ingredient_shortage = false,
  fluid_ingredient_shortage = false, no_recipe = false, waiting_for_source_items = false, waiting_for_space_in_destination = false,
  disabled_by_script = false, marked_for_deconstruction = false, frozen = true, broken = true}
local WATCHED = {'assembling-machine', 'furnace', 'mining-drill', 'lab', 'boiler', 'generator', 'inserter', 'ammo-turret',
  'electric-turret', 'radar', 'pump', 'offshore-pump', 'roboport', 'beacon', 'rocket-silo', 'reactor', 'burner-generator'}

O.register('alerts', {agent = true, fn = function(A, p)
  local e = A.entity
  local surface, force = e.surface, e.force
  local visible = Fog.viewer(surface, force)
  local radius = math.min(p.radius or 150, 600)
  local c = (p.x and p.y) and {x = p.x, y = p.y} or e.position
  local all = p.all and true or false -- и «мягкие» состояния: нет сырья, выход забит
  local by_status, list, hidden = {}, {}, 0
  local limit = math.min(p.limit or 100, 1000)
  for _, x in pairs(surface.find_entities_filtered{type = WATCHED, force = force, position = c, radius = radius}) do
    local status = STATUS[x.status]
    local hard = status and PROBLEM[status]
    if hard or (all and status and PROBLEM[status] == false) then
      if visible(math.floor(x.position.x / 32), math.floor(x.position.y / 32)) then
        local key = status
        by_status[key] = (by_status[key] or 0) + 1
        if #list < limit then list[#list + 1] = {status = status, name = x.name, x = x.position.x, y = x.position.y, unit = x.unit_number} end
      else
        hidden = hidden + 1
      end
    end
  end
  -- Тревоги игрока (разрушено, под атакой, не хватает материалов роботам): есть только у игроков-людей.
  local player_alerts = {}
  for _, pl in pairs(force.players) do
    local ok, alerts = pcall(pl.get_alerts, {surface = surface})
    if ok and alerts then
      for _, per_surface in pairs(alerts) do
        for kind, arr in pairs(per_surface) do
          local kname
          for n, v in pairs(defines.alert_type) do if v == kind then kname = n end end
          for _, al in pairs(arr) do
            if #player_alerts < 60 then
              player_alerts[#player_alerts + 1] = {alert = kname, x = al.position and al.position.x, y = al.position and al.position.y,
                name = al.target and al.target.valid and al.target.name or nil, tick = al.tick}
            end
          end
        end
      end
      break
    end
  end
  return {center = U.pos(c), radius = radius, by_status = by_status, problems = U.list(list), not_visible = hidden > 0 and hidden or nil,
    player_alerts = U.list(player_alerts)}
end})

-- ── pollution: слой загрязнения ──
O.register('pollution', {agent = true, fn = function(A, p)
  local e = A.entity
  local surface, force = e.surface, e.force
  local c = (p.x and p.y) and {x = p.x, y = p.y} or e.position
  local rc = math.min(math.ceil((p.radius or 160) / 32), 12)
  local cx0, cy0 = math.floor(c.x / 32), math.floor(c.y / 32)
  local rows, max, total = {}, 0, 0
  local maxpos
  for cy = cy0 - rc, cy0 + rc do
    local row = {}
    for cx = cx0 - rc, cx0 + rc do
      if force.is_chunk_charted(surface, {cx, cy}) then
        local v = surface.get_pollution({cx * 32 + 16, cy * 32 + 16})
        row[#row + 1] = math.floor(v + 0.5)
        total = total + v
        if v > max then max, maxpos = v, {x = cx * 32 + 16, y = cy * 32 + 16} end
      else
        row[#row + 1] = -1
      end
    end
    rows[#rows + 1] = row
  end
  return {here = math.floor(surface.get_pollution(c) + 0.5), max = math.floor(max + 0.5), max_at = maxpos, total = math.floor(total),
    chunk_x1 = cx0 - rc, chunk_y1 = cy0 - rc, rows = rows,
    note = 'rows[j][i] — загрязнение чанка (chunk_x1 + i, chunk_y1 + j), чанк — 32×32 клетки; -1 — чанк не открыт'}
end})

-- ── enemies: слой врагов на карте ──
O.register('enemies', {agent = true, fn = function(A, p)
  local e = A.entity
  local surface, force = e.surface, e.force
  local c = (p.x and p.y) and {x = p.x, y = p.y} or e.position
  local radius = math.min(p.radius or 150, 500)
  local visible = Fog.viewer(surface, force)
  local nests, units, worms = {}, {}, {}
  local unit_count, nearest
  local hidden_chunks = false
  for _, x in pairs(surface.find_entities_filtered{position = c, radius = radius, force = 'enemy', type = {'unit-spawner', 'turret', 'unit', 'spider-unit', 'segmented-unit'}}) do
    local cx, cy = math.floor(x.position.x / 32), math.floor(x.position.y / 32)
    local d = U.r2(U.dist(c, x.position))
    if x.type == 'unit-spawner' or x.type == 'turret' then
      -- Гнёзда и черви видны на открытой карте, как у игрока; отряды — только в видимой зоне.
      if visible(cx, cy) or force.is_chunk_charted(surface, {cx, cy}) then
        local t = x.type == 'unit-spawner' and nests or worms
        if #t < 100 then t[#t + 1] = {name = x.name, x = x.position.x, y = x.position.y, distance = d, memory = (not visible(cx, cy)) or nil} end
      end
    elseif visible(cx, cy) then
      unit_count = (unit_count or 0) + 1
      units[x.name] = (units[x.name] or 0) + 1
      if not nearest or d < nearest.distance then nearest = {name = x.name, x = U.r2(x.position.x), y = U.r2(x.position.y), distance = d} end
    end
  end
  table.sort(nests, function(a, b) return a.distance < b.distance end)
  table.sort(worms, function(a, b) return a.distance < b.distance end)
  -- Разбивка эволюции — то же, что игроку пишет команда /evolution: доли времени, загрязнения и уничтоженных гнёзд.
  local enemy = game.forces.enemy
  local bt, bp, bk = enemy.get_evolution_factor_by_time(surface), enemy.get_evolution_factor_by_pollution(surface),
    enemy.get_evolution_factor_by_killing_spawners(surface)
  local sum = bt + bp + bk
  local function share(v) return sum > 0 and math.floor(v / sum * 100 + 0.5) or 0 end
  return {center = U.pos(c), radius = radius, evolution = U.r2(enemy.get_evolution_factor(surface)),
    evolution_percent = math.floor(enemy.get_evolution_factor(surface) * 10000 + 0.5) / 100,
    evolution_by = {time = share(bt), pollution = share(bp), kills = share(bk)},
    nests = U.list(nests), worms = U.list(worms), units = units, units_total = unit_count or 0, nearest_unit = nearest,
    view = Fog.coverage(surface, force, c, radius, visible)}
end})

-- ── logistics: окно логистической сети ──
O.register('logistics', {agent = true, fn = function(A, p)
  local e = A.entity
  local c = (p.x and p.y) and {x = p.x, y = p.y} or e.position
  local net = e.force.find_logistic_network_by_position(c, e.surface)
  if not net then
    local nets = {}
    for _, n in pairs(e.force.logistic_networks[e.surface.name] or {}) do
      local cell = n.cells[1]
      if cell and cell.owner.valid and #nets < 20 then
        nets[#nets + 1] = {x = cell.owner.position.x, y = cell.owner.position.y, roboports = #n.cells, robots = n.all_logistic_robots + n.all_construction_robots}
      end
    end
    return {in_network = false, networks = U.list(nets)}
  end
  local items = {}
  for _, s in pairs(net.get_contents()) do
    local k = U.item_key(s.name, s.quality)
    items[k] = (items[k] or 0) + s.count
  end
  return {in_network = true, roboports = #net.cells,
    logistic_robots = {total = net.all_logistic_robots, available = net.available_logistic_robots},
    construction_robots = {total = net.all_construction_robots, available = net.available_construction_robots},
    robot_limit = net.robot_limit, items = items, requesters = #net.requesters, providers = #net.providers, storages = #net.storages}
end})

-- ── trains: обзор поездов и станций ──
local TRAIN_STATE = {}
for name, v in pairs(defines.train_state) do TRAIN_STATE[v] = name end

O.register('trains', {agent = true, fn = function(A, p)
  local e = A.entity
  local trains = {}
  for _, t in pairs(game.train_manager.get_trains{force = e.force, surface = e.surface}) do
    local front = t.front_stock
    local r = {id = t.id, state = TRAIN_STATE[t.state], speed = U.r2(t.speed * 216), manual = t.manual_mode,
      locomotives = #t.locomotives.front_movers + #t.locomotives.back_movers, wagons = #t.cargo_wagons + #t.fluid_wagons}
    if front and front.valid then r.x, r.y = U.r2(front.position.x), U.r2(front.position.y) end
    if t.station and t.station.valid then r.at_station = t.station.backer_name end
    if t.path_end_stop and t.path_end_stop.valid then r.going_to = t.path_end_stop.backer_name end
    local sch = t.schedule
    if sch then
      r.schedule = {}
      for i, rec in ipairs(sch.records) do r.schedule[i] = rec.station or (rec.rail and 'rail') or '?' end
      r.schedule_current = sch.current
      if #trains < 50 then r.stops = U.list(U.schedule(t)) end
    end
    local cargo = {}
    for _, s in pairs(t.get_contents()) do cargo[U.item_key(s.name, s.quality)] = s.count end
    if next(cargo) then r.cargo = cargo end
    if #trains < 200 then trains[#trains + 1] = r end
  end
  local stops = {}
  for _, s in pairs(game.train_manager.get_train_stops{force = e.force, surface = e.surface}) do
    if #stops < 300 then
      stops[#stops + 1] = {station = s.backer_name, x = s.position.x, y = s.position.y, unit = s.unit_number,
        trains_count = s.trains_count, trains_limit = s.trains_limit, status = STATUS[s.status]}
    end
  end
  return {trains = U.list(trains), stations = U.list(stops)}
end})

-- ── recipes и prototypes: справочник ──
local function recipe_info(rc)
  local ing, prod = {}, {}
  for _, i in pairs(rc.ingredients) do ing[i.name] = i.amount end
  for _, pr in pairs(rc.products) do prod[pr.name] = pr.amount or ((pr.amount_min + pr.amount_max) / 2) end
  local cats = {}
  for _, c in pairs(rc.prototype.categories or {}) do cats[#cats + 1] = type(c) == 'string' and c or c.name end
  return {recipe = rc.name, ingredients = ing, products = prod, seconds = rc.energy, unlocked = rc.enabled, categories = cats}
end

O.register('recipes', {agent = true, fn = function(A, p)
  local e = A.entity
  local force = e.force
  local hand = function(rc)
    for cat in pairs(e.prototype.crafting_categories or {}) do if rc.has_category(cat) then return true end end
    return false
  end
  local out = {}
  local function add(rc)
    local r = recipe_info(rc)
    r.by_hand = hand(rc)
    if not rc.enabled then
      -- Какая технология открывает рецепт.
      for name, t in pairs(force.technologies) do
        for _, m in pairs(t.prototype.effects or {}) do
          if m.type == 'unlock-recipe' and m.recipe == rc.name then r.unlocked_by = name end
        end
      end
    end
    out[#out + 1] = r
  end
  if p.name then
    local rc = force.recipes[p.name]
    if rc then add(rc) end
    for name, r in pairs(force.recipes) do
      if name ~= p.name then
        for _, pr in pairs(r.products) do if pr.name == p.name and #out < 12 then add(r) break end end
      end
    end
    if #out == 0 then U.fail('not_found', 'нет рецепта или предмета ' .. p.name .. ' (нужно внутреннее имя, например iron-gear-wheel)') end
  elseif p.uses then
    for name, r in pairs(force.recipes) do
      for _, ing in pairs(r.ingredients) do if ing.name == p.uses and #out < 60 then add(r) break end end
    end
  else
    U.fail('bad_request', 'нужно name (рецепт или предмет, который он даёт) или uses (предмет-ингредиент)')
  end
  return {recipes = U.list(out)}
end})

O.register('prototypes', {agent = true, fn = function(A, p)
  U.arg(p.name, 'string', 'name')
  local r = {name = p.name}
  local ip = prototypes.item[p.name]
  local ep = prototypes.entity[p.name]
  if ip then
    local it = {stack_size = ip.stack_size, type = ip.type}
    local function try(k, fn) local ok, v = pcall(fn) if ok and v ~= nil then it[k] = v end end
    try('places', function() return ip.place_result and ip.place_result.name end)
    try('places_tile', function() return ip.place_as_tile_result and ip.place_as_tile_result.result.name end)
    try('fuel_mj', function() return ip.fuel_value and ip.fuel_value > 0 and U.r2(ip.fuel_value / 1e6) or nil end)
    try('fuel_category', function() return ip.fuel_category end)
    r.item = it
    if not ep and ip.place_result then ep = ip.place_result end
  end
  local fp = prototypes.fluid[p.name]
  if fp then r.fluid = {default_temperature = fp.default_temperature, max_temperature = fp.max_temperature} end
  if ep then
    local box = ep.collision_box
    local en = {name = ep.name, type = ep.type, width = ep.tile_width, height = ep.tile_height,
      collision_box = {U.r2(box.left_top.x), U.r2(box.left_top.y), U.r2(box.right_bottom.x), U.r2(box.right_bottom.y)},
      max_health = ep.get_max_health and ep.get_max_health() or nil, supports_direction = ep.supports_direction}
    local items = {}
    for _, s in pairs(ep.items_to_place_this or {}) do items[s.name] = s.count or 1 end
    en.built_from = next(items) and items or nil
    local function try(k, fn) local ok, v = pcall(fn) if ok and v ~= nil then en[k] = v end end
    try('crafting_speed', function() return ep.get_crafting_speed() end)
    try('crafting_categories', function() local c = {} for n in pairs(ep.crafting_categories) do c[#c + 1] = n end return c end)
    try('mining_speed', function() return ep.mining_speed end)
    try('resource_categories', function() local c = {} for n in pairs(ep.resource_categories) do c[#c + 1] = n end return c end)
    try('belt_speed_items_per_s', function() return U.r2(ep.belt_speed * 480) end)
    try('max_underground_distance', function() return ep.max_underground_distance end)
    try('inserter_rotation_speed', function() return ep.get_inserter_rotation_speed() end)
    try('energy_usage_kw', function() local v = ep.get_max_energy_usage() return v and v > 0 and U.r2(v * 60 / 1000) or nil end)
    try('electric', function() return ep.electric_energy_source_prototype and true or nil end)
    try('burner', function() return ep.burner_prototype and true or nil end)
    try('supply_area', function() return ep.get_supply_area_distance() > 0 and ep.get_supply_area_distance() or nil end)
    try('wire_reach', function() return ep.get_max_wire_distance() > 0 and ep.get_max_wire_distance() or nil end)
    try('module_slots', function() return ep.module_inventory_size and ep.module_inventory_size > 0 and ep.module_inventory_size or nil end)
    try('inventory_slots', function() return ep.get_inventory_size(defines.inventory.chest) end)
    try('mineable_seconds', function() return ep.mineable_properties.minable and ep.mineable_properties.mining_time or nil end)
    try('fast_replaceable_group', function() return ep.fast_replaceable_group end)
    try('next_upgrade', function() return ep.next_upgrade and ep.next_upgrade.name end)
    r.entity = en
  end
  local tp = prototypes.tile[p.name]
  if tp then r.tile = {walking_speed_modifier = tp.walking_speed_modifier, collides_with_player = tp.collision_mask.layers.player and true or false} end
  if not (r.item or r.entity or r.fluid or r.tile) then U.fail('not_found', 'нет предмета, постройки, жидкости или плитки с именем ' .. p.name) end
  return r
end})

-- ── chat: игровой чат (люди и боты) ──
O.register('chat', {agent = true, dead = true, fn = function(A, p)
  local c = storage.agent.chat
  local since = p.since or 0
  local out = {}
  for _, m in ipairs(c.items) do
    if m.seq > since then out[#out + 1] = m end
  end
  local limit = math.min(p.limit or 50, 200)
  while #out > limit do table.remove(out, 1) end
  return {messages = U.list(out), seq = c.seq}
end})
