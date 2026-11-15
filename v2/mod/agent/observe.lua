-- Наблюдение: то, что игрок видит на экране и на карте. Чтение не занимает тело и не ждёт действий.
-- Туман войны (fog.lua): в видимой зоне — полные данные; в открытой, но невидимой — только вид и место постройки
-- по памяти карты (memory = true), без содержимого, состояния и врагов; в неоткрытой — ничего.
local U = require('agent.util')
local T = require('agent.target')
local O = require('agent.ops')
local Fog = require('agent.fog')
local Plans = require('agent.plans')
local B = require('agent.actions.build')
local Inv = require('agent.inv')

local Obs = {}

local STATUS = {}
for name, v in pairs(defines.entity_status) do STATUS[v] = name end

local BELT = {['transport-belt'] = true, ['underground-belt'] = true, splitter = true, ['lane-splitter'] = true, loader = true, ['loader-1x1'] = true}
local HIDDEN = {corpse = true, smoke = true, explosion = true, ['smoke-with-trigger'] = true, particle = true, projectile = true,
  beam = true, sticker = true, ['highlight-box'] = true, ['speech-bubble'] = true, fire = true, stream = true,
  ['artillery-flare'] = true, ['particle-source'] = true, ['item-request-proxy'] = true, ['character-corpse'] = false,
  ['lightning'] = true, ['entity-ghost'] = false}

local function is_enemy(e, force)
  local f = e.force
  return f ~= force and f.name ~= 'neutral' and not f.get_friend(force) and not force.get_cease_fire(f)
end

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

--- Короткое описание объекта (для списков).
local function brief(e, force)
  local r = {name = e.name, type = e.type, x = U.r2(e.position.x), y = U.r2(e.position.y)}
  if e.unit_number then r.unit = e.unit_number end
  if e.type == 'entity-ghost' or e.type == 'tile-ghost' then
    r.ghost = e.ghost_name
    r.plan = Plans.of(e)
  end
  if e.supports_direction then r.direction = U.dirname(e.direction) end
  if e.type == 'resource' then r.amount = e.amount end
  if force and is_enemy(e, force) then r.enemy = true end
  return r
end
Obs.brief = brief

--- Полное описание объекта — окно объекта в игре.
local function full(e, force)
  local r = brief(e, force)
  if e.type == 'resource' then return r end
  if e.health then
    r.health = U.r2(e.health)
    r.max_health = e.max_health
  end
  if e.type == 'entity-ghost' or e.type == 'tile-ghost' then
    local items = {}
    for _, s in pairs(e.ghost_prototype.items_to_place_this or {}) do items[s.name] = s.count or 1 end
    r.needs = items
    r.recipe = try(function() local rc = e.get_recipe() return rc and rc.name end)
    return r
  end
  if e.type == 'character-corpse' then
    r.items = U.contents(e.get_inventory(defines.inventory.character_corpse))
    return r
  end
  if e.type == 'character' then
    r.player = e.player and e.player.name or nil
    r.bot = storage.agent.by_unit[e.unit_number or 0]
    return r
  end
  if r.enemy then return r end
  r.status = STATUS[e.status] or nil
  if e.to_be_deconstructed() then r.marked_deconstruct = true end
  if e.to_be_upgraded() then
    local t = e.get_upgrade_target()
    r.marked_upgrade = t and t.name or true
  end
  local plan = Plans.of(e)
  if plan then r.plan = plan end
  r.recipe = try(function() local rc = e.get_recipe() return rc and rc.name end)
  if e.type == 'assembling-machine' or e.type == 'furnace' or e.type == 'rocket-silo' then
    r.crafting_progress = try(function() return U.r2(e.crafting_progress) end)
    r.products_finished = try(function() return e.products_finished end)
  end
  if e.type == 'mining-drill' then
    r.mining_target = try(function() return e.mining_target and e.mining_target.name end)
    r.mining_progress = try(function() return U.r2(e.mining_progress) end)
  end
  if e.type == 'lab' then r.researching = e.force.current_research and e.force.current_research.name or nil end
  -- Содержимое по слотам окна.
  local inv = {}
  for name, i in pairs(Inv.all(e)) do
    if not i.is_empty() then inv[name] = U.contents(i) end
    if name == 'main' then
      r.slots = #i
      r.free_slots = i.count_empty_stacks()
      if i.supports_bar() and i.get_bar() <= #i then r.bar = i.get_bar() - 1 end
    end
  end
  if next(inv) then r.inventory = inv end
  if e.burner then
    r.fuel_burning = try(function() local b = e.burner.currently_burning return b and b.name.name end)
    r.fuel_left = e.burner.remaining_burning_fuel > 0 or (inv.fuel ~= nil)
  end
  local fluids = try(function()
    local out = {}
    for i = 1, #e.fluidbox do
      local f = e.fluidbox[i]
      if f then out[#out + 1] = {name = f.name, amount = U.r2(f.amount), temperature = f.temperature and U.r2(f.temperature) or nil} end
    end
    return out
  end)
  if fluids and #fluids > 0 then r.fluids = fluids end
  if e.type == 'inserter' then
    r.takes_from, r.puts_to = U.pos(e.pickup_position), U.pos(e.drop_position)
    r.pickup_target = e.pickup_target and e.pickup_target.name or nil
    r.drop_target = e.drop_target and e.drop_target.name or nil
    if e.held_stack.valid_for_read then r.holding = e.held_stack.name end
    if e.use_filters then
      local f = {}
      for i = 1, e.filter_slot_count do
        local x = e.get_filter(i)
        if x then f[#f + 1] = x.name end
      end
      r.filters = U.list(f)
      r.filter_mode = e.inserter_filter_mode
    end
  end
  if BELT[e.type] then
    local lanes = {left = {}, right = {}}
    for i = 1, e.get_max_transport_line_index() do
      local side = i % 2 == 1 and lanes.left or lanes.right
      for k, v in pairs(U.contents(e.get_transport_line(i))) do side[k] = (side[k] or 0) + v end
    end
    r.lanes = lanes
    if e.type == 'underground-belt' then
      r.underground = e.belt_to_ground_type
      local o = e.underground_belt_neighbour
      r.paired_with = o and U.pos(o.position) or nil
    end
    if e.type == 'splitter' then
      r.input_priority, r.output_priority = e.splitter_input_priority, e.splitter_output_priority
      r.filter = e.splitter_filter and e.splitter_filter.name or nil
    end
  end
  if e.type == 'electric-pole' then
    r.network = e.electric_network_id
  end
  if e.type == 'train-stop' then
    r.station = e.backer_name
    r.trains_limit = e.trains_limit
    r.trains_count = e.trains_count
  end
  if e.type == 'accumulator' then r.charge = U.r2(e.energy / math.max(e.electric_buffer_size, 1)) end
  if e.prototype.electric_energy_source_prototype then
    r.electric_network = try(function() return e.electric_network_id end)
  end
  -- Соединения: провода логической и электрической сети.
  local wires = try(function()
    local out = {}
    for id, c in pairs(e.get_wire_connectors(false)) do
      local kind = id == defines.wire_connector_id.pole_copper and 'copper'
        or (c.wire_type == defines.wire_type.red and 'red') or (c.wire_type == defines.wire_type.green and 'green') or nil
      if kind then
        for _, conn in pairs(c.connections) do
          local o = conn.target.owner
          if o and o.valid and #out < 24 then out[#out + 1] = {wire = kind, name = o.name, unit = o.unit_number, x = U.r2(o.position.x), y = U.r2(o.position.y)} end
        end
      end
    end
    return out
  end)
  if wires and #wires > 0 then r.wires = wires end
  local cb = try(function() return e.get_control_behavior() end)
  if cb then
    local c = {}
    c.circuit_enable_disable = try(function() return cb.circuit_enable_disable end)
    c.circuit_condition = try(function() return cb.circuit_condition end)
    c.disabled = try(function() return cb.disabled end)
    if next(c) then r.control = c end
  end
  return r
end
Obs.full = full

-- Объект «по памяти карты»: только вид и место.
local function remembered(e)
  local r = {name = e.name, type = e.type, x = U.r2(e.position.x), y = U.r2(e.position.y), memory = true}
  if e.supports_direction then r.direction = U.dirname(e.direction) end
  return r
end

--- Как бот видит объект e: полное описание, память карты или nil (скрыт туманом, враг вне обзора, построен после снимка).
function Obs.see(e, force, visible, detailed)
  local cx, cy = math.floor(e.position.x / 32), math.floor(e.position.y / 32)
  if visible(cx, cy) then
    return detailed and full(e, force) or brief(e, force)
  end
  if not force.is_chunk_charted(e.surface, {cx, cy}) then return nil end
  if is_enemy(e, force) or e.type == 'character' or e.type == 'unit' then return nil end
  if e.type == 'item-entity' or e.type == 'character-corpse' then return nil end
  local m = Fog.memory(e.surface, cx, cy)
  if m and e.unit_number and m.added[e.unit_number] then return nil end
  return remembered(e)
end

-- Исчезнувшие без свидетелей постройки, которые ещё значатся на карте.
local function ghosts_of_memory(surface, force, area, visible, out, match)
  for cx = math.floor(area[1][1] / 32), math.floor(area[2][1] / 32) do
    for cy = math.floor(area[1][2] / 32), math.floor(area[2][2] / 32) do
      if not visible(cx, cy) then
        local m = Fog.memory(surface, cx, cy)
        if m then
          for _, r in ipairs(m.removed) do
            if r.x >= area[1][1] and r.x <= area[2][1] and r.y >= area[1][2] and r.y <= area[2][2] and (not match or match(r)) then
              out[#out + 1] = {name = r.name, type = r.type, x = r.x, y = r.y, memory = true,
                direction = r.direction and U.dirname(r.direction) or nil}
            end
          end
        end
      end
    end
  end
end

-- ── inspect ──
local function inspect_one(A, ref, visible)
  local e = A.entity
  local surface, force = e.surface, e.force
  local found = T.find(surface, ref)
  local x, y = ref.x, ref.y
  if found then x, y = found.position.x, found.position.y end
  if type(x) ~= 'number' then return {found = false} end
  local state = Fog.state(surface, force, x, y, visible)
  if state == 'unknown' then return {found = false, visibility = 'unknown', x = ref.x, y = ref.y} end
  if found then
    local r = Obs.see(found, force, visible, true)
    if r then
      r.found = true
      r.distance = U.r2(U.dist(e.position, found.position))
      if state == 'visible' and found.type ~= 'resource' then r.in_reach = e.can_reach_entity(found) end
      return r
    end
  end
  if state == 'charted' then
    local out = {}
    ghosts_of_memory(surface, force, {{x - 0.5, y - 0.5}, {x + 0.5, y + 0.5}}, visible, out)
    if out[1] then
      out[1].found = true
      return out[1]
    end
  end
  local tile = surface.get_tile(math.floor(x), math.floor(y))
  return {found = false, x = ref.x, y = ref.y, tile = tile.valid and tile.name or nil, visibility = state == 'charted' and 'memory' or nil}
end

O.register('inspect', {agent = true, fn = function(A, p)
  local visible = Fog.viewer(A.entity.surface, A.entity.force)
  if p.targets ~= nil then
    if type(p.targets) ~= 'table' then U.fail('bad_request', 'targets: список целей') end
    if #p.targets > 200 then U.fail('bad_request', 'не больше 200 целей за запрос') end
    local out = {}
    for i, ref in ipairs(p.targets) do out[i] = inspect_one(A, ref, visible) end
    return {objects = U.list(out)}
  end
  if type(p.target) ~= 'table' then U.fail('bad_request', 'нужен target ({unit} или {x, y, name?}) или targets') end
  return inspect_one(A, p.target, visible)
end})

-- Вид и размер постройки по имени (чтобы не спрашивать у каждой сущности): {type, w, h, square}.
local PROTO = {}
local function proto_of(name)
  local c = PROTO[name]
  if not c then
    local p = prototypes.entity[name]
    c = {type = p.type, w = math.max(p.tile_width, 1), h = math.max(p.tile_height, 1)}
    c.square = c.w == c.h
    PROTO[name] = c
  end
  return c
end

-- ── area ──
local SYMBOLS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&*+=<>^!/|{}[]();:'

local function rect(A, p)
  local x1, y1, x2, y2
  if p.area then
    local a = B.area_of(p)
    x1, y1, x2, y2 = a[1][1], a[1][2], a[2][1], a[2][2]
  elseif p.radius then
    local c = (p.x and p.y) and {x = p.x, y = p.y} or A.entity.position
    x1, y1, x2, y2 = c.x - p.radius, c.y - p.radius, c.x + p.radius, c.y + p.radius
  else
    U.fail('bad_request', 'нужна area {x1, y1, x2, y2} или radius (вокруг x, y или вокруг персонажа)')
  end
  return math.floor(x1), math.floor(y1), math.ceil(x2), math.ceil(y2)
end

O.register('area', {agent = true, fn = function(A, p)
  local e = A.entity
  local surface, force = e.surface, e.force
  local x1, y1, x2, y2 = rect(A, p)
  local w, h = x2 - x1, y2 - y1
  if w < 1 or h < 1 then U.fail('bad_request', 'пустая область') end
  if w * h > 1024 then U.fail('bad_request', 'область больше 1024 клеток (32×32) за один запрос к игре; сервер сам делит большие области на части') end
  local visible = Fog.viewer(surface, force)
  local legend, by_name, next_symbol = {}, {}, 1
  local function symbol(label)
    local s = by_name[label]
    if not s then
      s = next_symbol <= #SYMBOLS and SYMBOLS:sub(next_symbol, next_symbol) or '?'
      next_symbol = next_symbol + 1
      by_name[label] = s
      legend[s] = label
    end
    return s
  end
  -- Сетка: '.' — свободная земля, '~' — вода или непроходимая плитка, ' ' — не открыто.
  local grid = {}
  for j = 1, h do
    local row = {}
    for i = 1, w do row[i] = '.' end
    grid[j] = row
  end
  -- Туман считается по чанкам: 'v' — видно вживую, 'm' — по памяти карты, '?' — не открыто.
  local fog, any_fog = {}, false
  for cx = math.floor(x1 / 32), math.floor((x2 - 1) / 32) do
    for cy = math.floor(y1 / 32), math.floor((y2 - 1) / 32) do
      local s = visible(cx, cy) and 'v' or (force.is_chunk_charted(surface, {cx, cy}) and 'm' or '?')
      fog[cx * 65536 + cy] = s
      if s ~= 'v' then
        any_fog = true
        if s == '?' then
          for yy = math.max(cy * 32, y1), math.min(cy * 32 + 31, y2 - 1) do
            local row = grid[yy - y1 + 1]
            for xx = math.max(cx * 32, x1), math.min(cx * 32 + 31, x2 - 1) do row[xx - x1 + 1] = ' ' end
          end
        end
      end
    end
  end
  for _, t in pairs(surface.find_tiles_filtered{area = {{x1, y1}, {x2, y2}}, collision_mask = 'player'}) do
    local tp = t.position
    local row = grid[tp.y - y1 + 1]
    if row and row[tp.x - x1 + 1] == '.' then row[tp.x - x1 + 1] = '~' end
  end
  local objects, total = {}, 0
  local limit, offset = math.min(p.limit or 300, 2000), p.offset or 0
  local want_objects = p.objects and true or false
  local function paint(s, px, py, bw, bh, over)
    local cx1, cy1 = math.floor(px - bw / 2 + 0.01), math.floor(py - bh / 2 + 0.01)
    for yy = cy1, cy1 + bh - 1 do
      local row = grid[yy - y1 + 1]
      if row then
        for xx = cx1, cx1 + bw - 1 do
          local i = xx - x1 + 1
          if i >= 1 and i <= w then
            local cur = row[i]
            if cur ~= ' ' and (over or cur == '.' or cur == '~') then row[i] = s end
          end
        end
      end
    end
  end
  local SMALL = {character = true, unit = true, tree = true, ['item-entity'] = true, fish = true, ['simple-entity'] = true}
  local NATURE = {tree = true, fish = true, ['simple-entity'] = true}
  local res_total, resources = {}, {}
  local my_unit = e.unit_number
  for _, c in pairs(surface.find_entities_filtered{area = {{x1, y1}, {x2, y2}}}) do
    local name = c.name
    local pr = proto_of(name)
    local ctype = pr.type
    if not HIDDEN[ctype] and not (ctype == 'character' and c.unit_number == my_unit) then
      local pos = c.position
      local st = fog[math.floor(pos.x / 32) * 65536 + math.floor(pos.y / 32)]
      local shown = st == 'v'
      local memory = false
      if st == 'm' then
        -- По памяти карты: постройки и природа, без врагов, персонажей и построенного после снимка.
        if not (ctype == 'character' or ctype == 'unit' or ctype == 'item-entity' or ctype == 'character-corpse') and not is_enemy(c, force) then
          local m = c.unit_number and Fog.memory(surface, math.floor(pos.x / 32), math.floor(pos.y / 32))
          if not (m and m.added[c.unit_number]) then shown, memory = true, true end
        end
      end
      if shown then
        if ctype == 'resource' then
          resources[#resources + 1] = {name, pos.x, pos.y}
          local t = res_total[name]
          if not t then
            t = {tiles = 0, amount = 0}
            res_total[name] = t
          end
          t.tiles = t.tiles + 1
          if not memory then t.amount = t.amount + c.amount end
        else
          local label = name
          local bw, bh = pr.w, pr.h
          if ctype == 'entity-ghost' or ctype == 'tile-ghost' then
            local gn = c.ghost_name
            label = 'ghost:' .. gn
            if ctype == 'entity-ghost' then
              local gp = proto_of(gn)
              bw, bh = gp.w, gp.h
              if not gp.square and c.direction % 8 == 4 then bw, bh = bh, bw end
            end
          elseif (ctype == 'unit' or ctype == 'unit-spawner' or ctype == 'turret') and is_enemy(c, force) then
            label = 'enemy:' .. name
          elseif not pr.square and c.direction % 8 == 4 then
            bw, bh = bh, bw
          end
          if SMALL[ctype] then paint(symbol(label), pos.x, pos.y, 1, 1, true)
          else paint(symbol(label), pos.x, pos.y, bw, bh, ctype ~= 'tile-ghost') end
          if not NATURE[ctype] or p.nature then
            total = total + 1
            if want_objects and total > offset and #objects < limit then
              objects[#objects + 1] = memory and remembered(c) or (p.details and full(c, force) or brief(c, force))
            end
          end
        end
      end
    end
  end
  -- Ресурсы видны там, где над ними ничего не стоит.
  for _, r in ipairs(resources) do paint(symbol(r[1]), r[2], r[3], 1, 1, false) end
  local gone = {}
  if any_fog then ghosts_of_memory(surface, force, {{x1, y1}, {x2, y2}}, visible, gone) end
  for _, r in ipairs(gone) do
    paint(symbol(r.name), r.x, r.y, 1, 1, true)
    total = total + 1
    if want_objects and #objects < limit then objects[#objects + 1] = r end
  end
  local me = e.position
  if me.x >= x1 and me.x < x2 and me.y >= y1 and me.y < y2 then grid[math.floor(me.y) - y1 + 1][math.floor(me.x) - x1 + 1] = '@' end
  local rows = {}
  for j = 1, h do rows[j] = table.concat(grid[j]) end
  local out = {x1 = x1, y1 = y1, x2 = x2, y2 = y2, width = w, height = h, rows = rows, legend = legend,
    note = "rows[j][i] — клетка с углом (x1 + i, y1 + j), считая с нуля; '.' — свободно, '~' — вода или обрыв, ' ' — не открыто, '@' — ты",
    objects_total = total, resources = next(res_total) and res_total or nil}
  if any_fog then
    local frows = {}
    for j = 1, h do
      local fr = {}
      local cy = math.floor((y1 + j - 1) / 32)
      for i = 1, w do fr[i] = fog[math.floor((x1 + i - 1) / 32) * 65536 + cy] end
      frows[j] = table.concat(fr)
    end
    out.fog_rows = frows
  end
  if want_objects then
    out.objects = U.list(objects)
    out.more = (total > offset + #objects) or nil
  end
  return out
end})

-- ── find ──
O.register('find', {agent = true, fn = function(A, p)
  local e = A.entity
  local surface, force = e.surface, e.force
  if p.name == nil and p.type == nil and p.names == nil then U.fail('bad_request', 'нужно name, names или type') end
  local c = (p.x and p.y) and {x = p.x, y = p.y} or e.position
  local radius = math.min(p.radius or 60, 300)
  local limit = math.min(p.limit or 30, 500)
  -- Квадрат вместо круга: так движок ищет заметно быстрее; круг отсекаем сами.
  local filter = {area = {{c.x - radius, c.y - radius}, {c.x + radius, c.y + radius}}}
  if p.names or p.name then filter.name = p.names or p.name end
  if p.type then filter.type = p.type end
  if p.ghost then
    filter.name, filter.type = nil, 'entity-ghost'
    filter.ghost_name = p.names or p.name
  end
  local ok, list = pcall(surface.find_entities_filtered, filter)
  if not ok then U.fail('bad_request', 'нет такого имени или типа: ' .. tostring(list)) end
  local visible = Fog.viewer(surface, force)
  -- Когда ищут одно имя, вид у всех один: имя у каждой сущности не спрашиваем (это главная цена запроса).
  local one = (type(p.name) == 'string' and not p.names and not p.ghost and prototypes.entity[p.name]) and p.name or nil
  local one_type = one and prototypes.entity[one].type or nil
  local my_unit = e.unit_number
  local r2 = radius * radius
  local groups, n = {}, 0
  local top, top_n, worst = {}, 0, math.huge -- ближайшие limit объектов: {d2, сущность, по памяти}
  for i = 1, #list do
    local x = list[i]
    local name = one or x.name
    local xt = one_type or proto_of(name).type
    if not HIDDEN[xt] and not (xt == 'character' and x.unit_number == my_unit) then
      local pos = x.position
      local dx, dy = pos.x - c.x, pos.y - c.y
      local d2 = dx * dx + dy * dy
      if d2 <= r2 then
        local cx, cy = math.floor(pos.x / 32), math.floor(pos.y / 32)
        local memory = false
        local shown = visible(cx, cy)
        if not shown and force.is_chunk_charted(surface, {cx, cy}) then
          if not (xt == 'character' or xt == 'unit' or xt == 'item-entity' or xt == 'character-corpse') and not is_enemy(x, force) then
            local m = x.unit_number and Fog.memory(surface, cx, cy)
            if not (m and m.added[x.unit_number]) then shown, memory = true, true end
          end
        end
        if shown then
          n = n + 1
          local g = groups[name]
          if not g then
            g = {count = 0, d2 = d2, x = pos.x, y = pos.y}
            groups[name] = g
          end
          g.count = g.count + 1
          if d2 < g.d2 then g.d2, g.x, g.y = d2, pos.x, pos.y end
          if xt == 'resource' and not memory then g.amount = (g.amount or 0) + x.amount end
          if top_n < limit then
            top_n = top_n + 1
            top[top_n] = {d2, x, memory}
            if top_n == limit then
              table.sort(top, function(a, b) return a[1] < b[1] end)
              worst = top[top_n][1]
            end
          elseif d2 < worst then
            -- Вставка в отсортированный список ближайших.
            local j = top_n
            while j > 1 and top[j - 1][1] > d2 do
              top[j] = top[j - 1]
              j = j - 1
            end
            top[j] = {d2, x, memory}
            worst = top[top_n][1]
          end
        end
      end
    end
  end
  if top_n < limit then table.sort(top, function(a, b) return a[1] < b[1] end) end
  local out = {}
  for i = 1, top_n do
    local f = top[i]
    local r = f[3] and remembered(f[2]) or brief(f[2], force)
    r.distance = U.r2(math.sqrt(f[1]))
    out[i] = r
  end
  for _, g in pairs(groups) do
    g.nearest = U.r2(math.sqrt(g.d2))
    g.d2 = nil
  end
  return {center = U.pos(c), radius = radius, total = n, by_name = groups, objects = U.list(out), more = (n > limit) or nil}
end})

return Obs
