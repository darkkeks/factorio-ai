-- Чертежи без игрока: предмет-чертёж живёт в служебном инвентаре сценария.
-- Хранение: storage.agent.blueprints[владелец][имя] = {string, by, tick, w, h, entities, tiles}; владелец — имя бота
-- или '*' (общие для команды). Строка — формат игры: чертежами можно обмениваться с людьми.
-- Внутри чертёж приведён к виду «северо-западный угол в (0, 0)»: при постановке бот называет клетку этого угла.
local U = require('agent.util')

local BP = {}
BP.TEAM = '*'
BP.MAX_ENTITIES = 5000

function BP.init(st)
  st.blueprints = st.blueprints or {}
end

--- Выполнить fn(stack) над чистым предметом-чертежом; kind — 'blueprint' или 'blueprint-book'.
function BP.with(fn, kind)
  local st = storage.agent
  if not (st.bp_inv and st.bp_inv.valid) then st.bp_inv = game.create_inventory(4) end
  local inv = st.bp_inv
  inv.clear()
  inv.insert{name = kind or 'blueprint', count = 1}
  local ok, a, b, c = pcall(fn, inv[1], inv)
  inv.clear()
  if not ok then error(a, 0) end
  return a, b, c
end

-- Размер постройки в клетках с учётом поворота.
local function footprint(name, dir)
  local p = prototypes.entity[name]
  if not p then return 1, 1 end
  local w, h = p.tile_width, p.tile_height
  if dir and dir % 8 == 4 then w, h = h, w end
  return w, h
end
BP.footprint = footprint

local function rot_vec(v, k)
  if not v then return v end
  local x, y = v.x or v[1], v.y or v[2]
  for _ = 1, k do x, y = -y, x end
  return {x = x, y = y}
end

local SWAP = {left = 'right', right = 'left'}
local CRAFTERS = {['assembling-machine'] = true, furnace = true, ['rocket-silo'] = true}

--- Поворот (rot — четверти по часовой, 0…3) и отражение ('h' — слева направо, 'v' — сверху вниз) списков чертежа.
function BP.transform(ents, tiles, rot, flip)
  rot = rot or 0
  local out, tout = {}, {}
  for i, e in ipairs(ents or {}) do
    local c = {}
    for k, v in pairs(e) do c[k] = v end
    local x, y = e.position.x or e.position[1], e.position.y or e.position[2]
    local dir = e.direction or 0
    local proto = prototypes.entity[e.name]
    if flip then
      -- Отражение сверху вниз — это отражение слева направо плюс поворот на 180°.
      x = -x
      dir = (16 - dir) % 16
      if c.pickup_position then local v = rot_vec(c.pickup_position, 0) c.pickup_position = {x = -v.x, y = v.y} end
      if c.drop_position then local v = rot_vec(c.drop_position, 0) c.drop_position = {x = -v.x, y = v.y} end
      if c.input_priority then c.input_priority = SWAP[c.input_priority] or c.input_priority end
      if c.output_priority then c.output_priority = SWAP[c.output_priority] or c.output_priority end
      if proto and CRAFTERS[proto.type] then c.mirror = not c.mirror or nil end
    end
    local k = (rot + (flip == 'v' and 2 or 0)) % 4
    for _ = 1, k do x, y = -y, x end
    dir = (dir + 4 * k) % 16
    c.pickup_position, c.drop_position = rot_vec(c.pickup_position, k), rot_vec(c.drop_position, k)
    c.position = {x = x, y = y}
    if (proto and proto.supports_direction) or e.direction then c.direction = dir end
    out[i] = c
  end
  for i, t in ipairs(tiles or {}) do
    local x, y = t.position.x or t.position[1], t.position.y or t.position[2]
    if flip then x = -x - 1 end
    local k = (rot + (flip == 'v' and 2 or 0)) % 4
    for _ = 1, k do x, y = -y - 1, x end
    tout[i] = {name = t.name, position = {x = x, y = y}}
  end
  return out, tout
end

--- Сдвинуть так, чтобы северо-западный угол занятых клеток был в (0, 0). Возвращает списки, ширину, высоту и сдвиг.
function BP.normalize(ents, tiles)
  local minx, miny, maxx, maxy = math.huge, math.huge, -math.huge, -math.huge
  for _, e in ipairs(ents) do
    local w, h = footprint(e.name, e.direction)
    local x, y = e.position.x, e.position.y
    minx, maxx = math.min(minx, math.floor(x - w / 2 + 0.01)), math.max(maxx, math.ceil(x + w / 2 - 0.01))
    miny, maxy = math.min(miny, math.floor(y - h / 2 + 0.01)), math.max(maxy, math.ceil(y + h / 2 - 0.01))
  end
  for _, t in ipairs(tiles) do
    minx, maxx = math.min(minx, t.position.x), math.max(maxx, t.position.x + 1)
    miny, maxy = math.min(miny, t.position.y), math.max(maxy, t.position.y + 1)
  end
  if minx == math.huge then return ents, tiles, 0, 0, 0, 0 end
  for _, e in ipairs(ents) do e.position = {x = e.position.x - minx, y = e.position.y - miny} end
  for _, t in ipairs(tiles) do t.position = {x = t.position.x - minx, y = t.position.y - miny} end
  return ents, tiles, maxx - minx, maxy - miny, minx, miny
end

local function pos_table(p)
  return {x = p.x or p[1], y = p.y or p[2]}
end

--- Списки из предмета-чертежа (позиции — таблицы {x, y}).
function BP.read(stack)
  local ents = stack.get_blueprint_entities() or {}
  local tiles = stack.get_blueprint_tiles() or {}
  for _, e in ipairs(ents) do e.position = pos_table(e.position) end
  for _, t in ipairs(tiles) do t.position = pos_table(t.position) end
  return ents, tiles
end

--- Записать списки в предмет-чертёж без пересчёта позиций движком.
function BP.write(stack, ents, tiles)
  stack.clear_blueprint()
  if #ents > 0 then stack.set_blueprint_entities(ents, false) end
  if #tiles > 0 then stack.set_blueprint_tiles(tiles) end
end

local function cost_of(stack)
  local cost = {}
  for _, c in pairs(stack.cost_to_build or {}) do
    local k = U.item_key(c.name, c.quality)
    cost[k] = (cost[k] or 0) + c.count
  end
  return cost
end
BP.cost_of = cost_of

--- Привести чертёж в предмете к хранимому виду и вернуть запись для хранения.
function BP.record(stack, by)
  if not stack.is_blueprint or not stack.is_blueprint_setup() then U.fail('bad_request', 'чертёж пуст') end
  local ents, tiles = BP.read(stack)
  if #ents > BP.MAX_ENTITIES then U.fail('bad_request', 'в чертеже больше ' .. BP.MAX_ENTITIES .. ' построек') end
  local w, h
  ents, tiles, w, h = BP.normalize(ents, tiles)
  BP.write(stack, ents, tiles)
  stack.blueprint_snap_to_grid = nil
  return {string = stack.export_stack(), by = by, tick = game.tick, w = w, h = h, entities = #ents, tiles = #tiles,
    cost = cost_of(stack), label = stack.label}
end

local function shelf(owner, create)
  local all = storage.agent.blueprints
  if not all[owner] and create then all[owner] = {} end
  return all[owner]
end

--- Найти чертёж по имени: сначала свои, потом общие. Возвращает запись и владельца.
function BP.find(A, name)
  local mine = shelf(A.name)
  if mine and mine[name] then return mine[name], A.name end
  local team = shelf(BP.TEAM)
  if team and team[name] then return team[name], BP.TEAM end
  U.fail('not_found', 'нет чертежа ' .. tostring(name) .. ' (список — blueprint_list)')
end

function BP.store(A, name, rec, team)
  local owner = team and BP.TEAM or A.name
  local s = shelf(owner, true)
  local old = s[name]
  if old and team and old.by ~= A.name then U.fail('not_allowed', 'общий чертёж ' .. name .. ' сохранил ' .. tostring(old.by) .. ': заменить его может только автор') end
  s[name] = rec
  return owner
end

--- Загрузить запись в предмет-чертёж, применить поворот и отражение. Возвращает списки и размер.
function BP.load(stack, rec, rot, flip)
  if stack.import_stack(rec.string) > 0 then U.fail('internal', 'чертёж не читается') end
  local ents, tiles = BP.read(stack)
  local w, h = rec.w, rec.h
  if (rot and rot % 4 ~= 0) or flip then
    ents, tiles = BP.transform(ents, tiles, rot or 0, flip)
    ents, tiles, w, h = BP.normalize(ents, tiles)
    BP.write(stack, ents, tiles)
  end
  return ents, tiles, w, h
end

--- Собрать чертёж из списка бота: entities — {name | item, x, y, direction?, recipe?, …поля чертежа игры}, tiles — {name, x, y}.
function BP.from_list(stack, entities, tiles)
  local ents, tl = {}, {}
  for i, e in ipairs(entities or {}) do
    if type(e) ~= 'table' then U.fail('bad_request', 'entities[' .. i .. ']: ожидается объект') end
    local name = e.name
    if not name and e.item then
      local ip = prototypes.item[e.item]
      name = ip and ip.place_result and ip.place_result.name
    end
    if not name or not prototypes.entity[name] then U.fail('bad_request', 'entities[' .. i .. ']: нет такой постройки: ' .. tostring(e.name or e.item)) end
    if type(e.x) ~= 'number' or type(e.y) ~= 'number' then U.fail('bad_request', 'entities[' .. i .. ']: нужны x и y') end
    local c = {}
    for k, v in pairs(e) do
      if k ~= 'x' and k ~= 'y' and k ~= 'item' and k ~= 'underground' then c[k] = v end
    end
    c.name = name
    c.entity_number = i
    c.position = {x = e.x, y = e.y}
    c.direction = U.dir(e.direction, 'entities[' .. i .. '].direction')
    if e.underground then c.type = e.underground end
    ents[i] = c
  end
  for i, t in ipairs(tiles or {}) do
    if type(t) ~= 'table' or not prototypes.tile[t.name or ''] then U.fail('bad_request', 'tiles[' .. i .. ']: нет такой плитки: ' .. tostring(type(t) == 'table' and t.name)) end
    if type(t.x) ~= 'number' or type(t.y) ~= 'number' then U.fail('bad_request', 'tiles[' .. i .. ']: нужны x и y') end
    tl[i] = {name = t.name, position = {x = math.floor(t.x), y = math.floor(t.y)}}
  end
  if #ents == 0 and #tl == 0 then U.fail('bad_request', 'пустой список построек') end
  if #ents > BP.MAX_ENTITIES then U.fail('bad_request', 'больше ' .. BP.MAX_ENTITIES .. ' построек за раз') end
  local w, h, minx, miny
  ents, tl, w, h, minx, miny = BP.normalize(ents, tl)
  local ok, err = pcall(BP.write, stack, ents, tl)
  if not ok then U.fail('bad_request', 'игра не приняла список построек: ' .. tostring(err)) end
  return ents, tl, w, h, minx, miny
end

--- Поставить чертёж из предмета призраками так, чтобы его северо-западный угол встал в клетку (ox, oy).
function BP.build(stack, surface, force, ox, oy, w, h, mode)
  w, h = math.max(w, 1), math.max(h, 1)
  -- Привязка к абсолютной сетке размером с чертёж: ячейка сетки, в которую попадает точка постановки, и есть место чертежа.
  stack.blueprint_snap_to_grid = {x = w, y = h}
  stack.blueprint_absolute_snapping = true
  -- С рельсами в чертеже игра сама округляет сетку до чётной: дальше считаем от той сетки, что получилась на деле,
  -- иначе чертёж уезжает на клетку-две.
  local grid = stack.blueprint_snap_to_grid
  if grid then w, h = grid.x or grid[1] or w, grid.y or grid[2] or h end
  stack.blueprint_position_relative_to_grid = {x = ox % w, y = oy % h}
  return stack.build_blueprint{surface = surface, force = force, position = {ox + w / 2, oy + h / 2},
    build_mode = defines.build_mode[mode or 'forced'], skip_fog_of_war = false, raise_built = true}
end

return BP
