-- Живой граф фабрики: локальная топология построек команды для внешнего графа (fgraph на хосте).
-- Мод отдаёт только записи построек (запись зависит от самой постройки и соседей в пределах нескольких клеток);
-- полосы, сегменты, сети труб и столбов, поток предметов считает клиент.
--
-- Операции (все — чтение, без персонажа):
--   graph_snapshot — постраничный полный снимок поверхности (обход по чанкам, предел записей на вызов);
--   graph_changes  — что изменилось после ревизии since: перезаписанные клетки (upsert) и снесённые постройки (remove);
--   graph_contents — предметы и жидкости в постройках по номерам и позициям (по запросу, в топологию не входят);
--   graph_sample   — статус и счётчик готовой продукции машин постранично + статистика производства команды;
--   graph_protos   — сведения о прототипах построек и рецептах по именам.
--
-- Журнал изменений. Обработчики событий ничего не сериализуют: они только записывают в кольцевой журнал
-- storage.agent.graph «клетка 8×8 грязная» (область постройки с запасом на соседей) и «постройка u снесена».
-- Номер записи журнала — ревизия (rev). graph_changes{since} читает записи после since по порядку и пересобирает
-- грязные клетки по текущему состоянию мира (каждую клетку один раз). Клетка, помеченная повторно, в журнале
-- переезжает на последнюю ревизию (last[клетка]); старые записи о ней пропускаются. Пока клиентам ещё не выдана
-- ревизия, покрывающая последнюю отметку клетки (served), повторная отметка новой записи не создаёт: отметка
-- и так будет прочитана, а клетка пересоберётся по текущему состоянию.
-- Журнал ограничен (MAX_LOG записей): since старше начала журнала или новее его конца → reset (нужен новый снимок).
-- Ответ graph_changes перечисляет пересобранные клетки (cells): клиент удаляет у себя постройки этих клеток,
-- которых нет в upsert, — так видны и исчезновения без события (быстрая замена на месте, снос скриптом без raise).
--
-- Всё состояние — в storage (команды RCON исполняются у всех участников сетевой игры одинаково). В модуле хранятся
-- только постоянные таблицы, одинаковые у всех.
local U = require('agent.util')
local O = require('agent.ops')
local Inv = require('agent.inv')

local G = {handlers = {}}

local CELL = 8              -- сторона клетки грязной области
local MAX_LOG = 20000       -- записей в кольцевом журнале
local MARGIN = 3            -- запас вокруг постройки по умолчанию (манипуляторы, буры, стыки лент)
local SNAPS = 3             -- сколько незаконченных снимков помнить одновременно
local PAGE_CHUNKS = 256     -- предел чанков за одну страницу снимка (пустой чанк — один поиск, ~10–20 мкс)
local MAX_LIMIT = 10000
local FORCE = 'player'

local floor = math.floor
local r2 = U.r2

-- Какие постройки сериализуются и как. Остальные постройки команды (стены, рельсы, сигналы, фонари, комбинаторы,
-- роботы, транспорт, призраки) в топологию не входят, но считаются в counts снимка.
local TYPES = {
  ['assembling-machine'] = 'crafter', furnace = 'crafter', ['rocket-silo'] = 'crafter',
  lab = 'lab',
  ['mining-drill'] = 'drill',
  inserter = 'inserter',
  ['transport-belt'] = 'belt', ['underground-belt'] = 'underground', splitter = 'splitter',
  loader = 'loader', ['loader-1x1'] = 'loader', ['linked-belt'] = 'linked', ['lane-splitter'] = 'lane',
  container = 'container', ['logistic-container'] = 'container', ['infinity-container'] = 'container', ['linked-container'] = 'container',
  ['electric-pole'] = 'pole',
  beacon = 'beacon',
  pipe = 'plain', ['pipe-to-ground'] = 'plain', pump = 'plain', ['offshore-pump'] = 'plain', ['storage-tank'] = 'plain',
  boiler = 'plain', generator = 'plain', ['fusion-reactor'] = 'plain', ['fusion-generator'] = 'plain', ['infinity-pipe'] = 'plain',
  valve = 'plain', thruster = 'plain', ['burner-generator'] = 'plain',
  ['ammo-turret'] = 'turret', ['electric-turret'] = 'turret', ['fluid-turret'] = 'turret', ['artillery-turret'] = 'turret',
  roboport = 'plain', ['train-stop'] = 'plain', accumulator = 'plain', ['solar-panel'] = 'plain', reactor = 'plain',
  ['heat-pipe'] = 'plain', ['heat-interface'] = 'plain', radar = 'plain', ['lightning-attractor'] = 'plain',
  ['agricultural-tower'] = 'plain', ['asteroid-collector'] = 'plain', ['cargo-landing-pad'] = 'plain', ['cargo-bay'] = 'plain',
  ['space-platform-hub'] = 'plain', ['electric-energy-interface'] = 'plain', ['power-switch'] = 'plain',
}
G.TYPES = TYPES
local TYPE_LIST = {}
for t in pairs(TYPES) do TYPE_LIST[#TYPE_LIST + 1] = t end
table.sort(TYPE_LIST)

-- Машины для graph_sample: их список копится при снимке и пересборке клеток.
local MACHINE = {['assembling-machine'] = true, furnace = true, ['rocket-silo'] = true, lab = true, ['mining-drill'] = true}
local CRAFTER = {['assembling-machine'] = true, furnace = true, ['rocket-silo'] = true}
local BELTLIKE = {belt = true, underground = true, splitter = true, loader = true, linked = true, lane = true}

local STATUS = {}
for name, v in pairs(defines.entity_status) do STATUS[v] = name end

-- ── Состояние ──

-- Лениво: при замене сценария в существующем сохранении on_init не вызывается (см. state.lua).
function G.st()
  local st = storage.agent
  local g = st.graph
  if not g then
    g = {
      rev = 0, first = 1,  -- журнал: записи first..rev
      ls = {}, lv = {},    -- запись rev: ls — номер поверхности, lv — ключ клетки (>0) или −unit снесённой постройки
      last = {},           -- [поверхность][ключ клетки] = ревизия последней отметки
      served = 0,          -- наибольшая ревизия, выданная клиентам (снимком или graph_changes)
      snaps = {}, snap_id = 0,
      machines = {},       -- [поверхность] = {list = {сущности}, units = {номера}, set = {номер → true}}
    }
    st.graph = g
  end
  return g
end

local KX = 2097152 -- 2^21: ключ клетки — одно число (cx + 2^20) · 2^21 + (cy + 2^20)
local OFF = 1048576
local function cell_key(cx, cy) return (cx + OFF) * KX + (cy + OFF) end
local function cell_xy(k) return floor(k / KX) - OFF, k % KX - OFF end

local function push(g, si, v)
  local rev = g.rev + 1
  g.rev = rev
  g.ls[rev], g.lv[rev] = si, v
  while rev - g.first >= MAX_LOG do
    local r = g.first
    local old = g.lv[r]
    if old > 0 then
      local l = g.last[g.ls[r]]
      if l and l[old] == r then l[old] = nil end
    end
    g.ls[r], g.lv[r] = nil, nil
    g.first = r + 1
  end
end

local function mark_box(g, si, x1, y1, x2, y2)
  local last = g.last[si]
  if not last then
    last = {}
    g.last[si] = last
  end
  local served = g.served
  for cx = floor(x1 / CELL), floor((x2 - 0.001) / CELL) do
    for cy = floor(y1 / CELL), floor((y2 - 0.001) / CELL) do
      local k = cell_key(cx, cy)
      local r = last[k]
      if not (r and r > served) then
        push(g, si, k)
        last[k] = g.rev
      end
    end
  end
end

local NS = {[defines.direction.north] = true, [defines.direction.south] = true}

-- Пометить область постройки с запасом на соседей, чьи записи от неё зависят.
local function mark_entity(g, e)
  local b = e.bounding_box
  local lt, rb = b.left_top, b.right_bottom
  local t = e.type
  local mx, my = MARGIN, MARGIN
  if t == 'underground-belt' or t == 'pipe-to-ground' then
    -- Пара подземки — до max_underground_distance клеток по оси; новая подземка может разорвать чужую пару.
    local d = (e.prototype.max_underground_distance or 10) + 1
    if NS[e.direction] then my = math.max(my, d) else mx = math.max(mx, d) end
  elseif t == 'beacon' then
    -- Маяк меняет скорость машин в зоне действия (плюс половина самой крупной машины).
    local sa = e.prototype.get_supply_area_distance(e.quality) or 3
    mx = sa + 5
    my = mx
  end
  local si = e.surface.index
  mark_box(g, si, lt.x - mx, lt.y - my, rb.x + mx, rb.y + my)
  if t == 'electric-pole' then
    -- Соседи по медному проводу: у них меняется список cw. Провод тянется дальше запаса, поэтому — их клетки.
    local c = e.get_wire_connector(defines.wire_connector_id.pole_copper, false)
    if c then
      for _, w in pairs(c.real_connections) do
        local o = w.target.owner
        if o.valid then
          local p = o.position
          mark_box(g, si, p.x - 0.5, p.y - 0.5, p.x + 0.5, p.y + 0.5)
        end
      end
    end
  end
end

local function ours(e)
  return e and e.valid and TYPES[e.type] and e.force.name == FORCE
end

--- Постройка изменилась без события игры (настройки ботом: рецепт, фильтры, приоритеты, поворот, модули).
function G.touch(e)
  if not ours(e) then return end
  mark_entity(G.st(), e)
end

--- Сведения о постройке, нужные, чтобы отметить её снос позже, когда сущности уже нет (снос персонажем-ботом).
function G.info(e)
  if not ours(e) or not e.unit_number then return nil end
  local b = e.bounding_box
  return {u = e.unit_number, s = e.surface.index, x1 = b.left_top.x, y1 = b.left_top.y, x2 = b.right_bottom.x, y2 = b.right_bottom.y}
end

--- Постройка, о которой запомнено G.info, исчезла.
function G.gone(info)
  if not info then return end
  local g = G.st()
  push(g, info.s, -info.u)
  mark_box(g, info.s, info.x1 - MARGIN, info.y1 - MARGIN, info.x2 + MARGIN, info.y2 + MARGIN)
end

local function removed(e)
  if not ours(e) or not e.unit_number then return end
  local g = G.st()
  push(g, e.surface.index, -e.unit_number)
  mark_entity(g, e)
end

-- ── События: только отметки, без сериализации ──

local function on_entity(ev) G.touch(ev.entity) end
local function on_removed(ev) removed(ev.entity) end
local ev = defines.events
for _, id in pairs{ev.on_built_entity, ev.on_robot_built_entity, ev.on_space_platform_built_entity, ev.script_raised_built,
    ev.script_raised_revive, ev.on_player_rotated_entity, ev.on_player_flipped_entity, ev.on_blueprint_settings_pasted,
    ev.on_player_fast_transferred} do
  G.handlers[id] = on_entity
end
for _, id in pairs{ev.on_player_mined_entity, ev.on_robot_mined_entity, ev.on_space_platform_mined_entity, ev.on_entity_died,
    ev.script_raised_destroy} do
  G.handlers[id] = on_removed
end
G.handlers[ev.on_entity_cloned] = function(e) G.touch(e.destination) end
G.handlers[ev.on_entity_settings_pasted] = function(e) G.touch(e.destination) end
G.handlers[ev.on_gui_closed] = function(e) if e.entity then G.touch(e.entity) end end

-- ── Кодирование в JSON ──
-- В Lua игры дороги как раз те операции, из которых состоит обычное кодирование: helpers.table_to_json тратит ~4 мкс
-- на каждое число, string.format и tostring — ~0,5–1,5 мкс на вызов, вставка в таблицу — ~0,3 мкс (таблицы игры
-- помнят порядок вставки). Дёшево только склеивание строк. Поэтому запись постройки сразу собирается строкой JSON
-- склейкой, числа переводятся в строку через таблицы готовых строк (0…999), а страница — table.concat записей.
-- Таблицы ниже постоянные и одинаковые у всех участников.

local fmt, concat = string.format, table.concat
local T, P = {}, {} -- T[i] = '17', P[i] = '017' (i = 0…999)
for i = 0, 999 do
  T[i] = fmt('%d', i)
  P[i] = fmt('%03d', i)
end
local FRAC = {}     -- FRAC[k] = '.05', '.5', '.25' (k = 1…99 сотых)
for k = 1, 99 do FRAC[k] = ('.' .. fmt('%02d', k)):gsub('0$', '') end
local ESC = {['"'] = '\\"', ['\\'] = '\\\\', ['\n'] = '\\n', ['\r'] = '\\r', ['\t'] = '\\t'}

--- Целое неотрицательное → строка.
local function itos(v)
  if v < 1000 then return T[v] end
  if v < 1000000 then return T[floor(v / 1000)] .. P[v % 1000] end
  if v < 1000000000 then return T[floor(v / 1000000)] .. P[floor(v / 1000) % 1000] .. P[v % 1000] end
  return fmt('%d', v)
end

--- Число → строка JSON: целые и числа с двумя знаками после запятой — без string.format.
local function num(v)
  local a = v < 0 and -v or v
  if a ~= a or a == math.huge then return 'null' end
  local i = floor(a)
  local s
  if i == a then
    s = itos(i)
  else
    local f = (a - i) * 100
    local fi = floor(f + 0.5)
    if fi > 0 and fi < 100 and math.abs(f - fi) < 1e-6 then
      s = itos(i) .. FRAC[fi]
    else
      return fmt('%.10g', v)
    end
  end
  return v < 0 and ('-' .. s) or s
end

-- Закодированные строки (имена построек, рецептов, жидкостей, ключи) повторяются в каждой записи: кодируем один раз.
-- Это только ускоряет кодирование: результат не зависит от того, что уже лежит в таблице.
local QUOTED = {}
local QUOTED_N = 0
local function str(s)
  local q = QUOTED[s]
  if q then return q end
  q = s
  if q:find('[%c"\\]') then q = q:gsub('[%c"\\]', function(c) return ESC[c] or fmt('\\u%04x', c:byte()) end) end
  q = '"' .. q .. '"'
  if #s <= 64 and QUOTED_N < 20000 then
    QUOTED_N = QUOTED_N + 1
    QUOTED[s] = q
  end
  return q
end

local RAWV = {} -- {[RAWV] = строка JSON} — готовый фрагмент, вставляется как есть

--- Общий кодировщик для небольших частей ответа. Список — таблица с [1]; U.EMPTY — []; пустая таблица — {}.
local function J(v)
  local t = type(v)
  if t == 'number' then return num(v) end
  if t == 'string' then return v == U.EMPTY and '[]' or str(v) end
  if t == 'boolean' then return v and 'true' or 'false' end
  if t ~= 'table' then return 'null' end
  local raw = v[RAWV]
  if raw then return raw end
  local n = #v
  local parts = {}
  if n > 0 then
    for i = 1, n do parts[i] = J(v[i]) end
    return '[' .. concat(parts, ',') .. ']'
  end
  for k, x in pairs(v) do parts[#parts + 1] = str(tostring(k)) .. ':' .. J(x) end
  return '{' .. concat(parts, ',') .. '}'
end
G.json = J

--- Результат операции, закодированный здесь (см. U.raw в util.lua).
local function raw(v) return U.raw(J(v)) end
--- Список готовых строк JSON → фрагмент-список.
local function rawlist(list) return {[RAWV] = '[' .. concat(list, ',') .. ']'} end

-- ── Запись постройки (сразу строкой JSON) ──

local function unit_of(o) return o and o.valid and o.unit_number or nil end

-- Список номеров построек: '[u1,u2]' или nil.
local function ulist(list)
  local s
  for _, o in pairs(list) do
    local u = o.valid and o.unit_number
    if u then s = s and (s .. ',' .. itos(u)) or ('[' .. itos(u)) end
  end
  return s and (s .. ']')
end

local function xy(p) return '[' .. num(r2(p.x)) .. ',' .. num(r2(p.y)) .. ']' end

local function modules(e)
  local inv = e.get_module_inventory()
  if not inv or inv.is_empty() then return nil end
  local s
  for i = 1, #inv do
    local st = inv[i]
    if st.valid_for_read then
      local q = st.quality.name
      local k = str(q == 'normal' and st.name or (st.name .. '@' .. q))
      s = s and (s .. ',' .. k) or ('[' .. k)
    end
  end
  return s and (s .. ']')
end

-- Ёмкости жидкости: [{i, f — жидкость (фильтр, текущая или жидкость сегмента трубы), c — номера соединённых построек}].
-- Номер сегмента не берём: он меняется при постройке вдали.
local function fluids(e)
  local n = e.fluids_count
  if n == 0 then return nil end
  local s
  for i = 1, n do
    local name
    local flt = e.get_fluid_filter(i)
    if flt then name = flt.name end
    if not name then
      local f = e.get_fluid(i)
      if not f then
        -- Пустая ёмкость трубы: жидкость её сегмента (у ёмкостей вне сегментов вызов может упасть).
        local ok, sf = pcall(e.get_fluid_segment_fluid, i)
        if ok then f = sf end
      end
      name = f and f.name
    end
    local c
    for _, nb in pairs(e.get_fluid_box_neighbours(i) or {}) do
      local u = unit_of(nb.entity)
      if u then c = c and (c .. ',' .. itos(u)) or ('[' .. itos(u)) end
    end
    local r = '{"i":' .. T[i]
    if name then r = r .. ',"f":' .. str(name) end
    if c then r = r .. ',"c":' .. c .. ']' end
    r = r .. '}'
    s = s and (s .. ',' .. r) or ('[' .. r)
  end
  return s .. ']'
end

local function filter_name(f)
  local n = f and f.name
  if n == nil then return nil end
  return type(n) == 'string' and n or n.name
end

--- Запись постройки строкой JSON; вторым и третьим значением — имя и рецепт (для сведений о прототипах).
local function ser(e)
  local t = e.type
  local p = e.position
  local name = e.name
  local s = '{"u":' .. itos(e.unit_number) .. ',"n":' .. str(name) .. ',"t":' .. str(t) .. ',"x":' .. num(r2(p.x)) .. ',"y":' .. num(r2(p.y))
  if e.supports_direction then s = s .. ',"d":' .. T[e.direction] end
  if e.mirroring then s = s .. ',"mi":true' end
  local q = e.quality.name
  if q ~= 'normal' then s = s .. ',"q":' .. str(q) end
  local k = TYPES[t]
  local rcname
  if k == 'crafter' then
    local rc = e.get_recipe()
    if rc then
      rcname = rc.name
    elseif t == 'furnace' then
      local pr = e.previous_recipe
      if pr then rcname = filter_name(pr) end
    end
    if rcname then s = s .. ',"rc":' .. str(rcname) end
    s = s .. ',"cs":' .. num(e.crafting_speed)
    local pb = e.productivity_bonus
    if pb ~= 0 then s = s .. ',"pb":' .. num(pb) end
    s = s .. ',"w":' .. T[e.tile_width] .. ',"h":' .. T[e.tile_height]
    if e.burner then s = s .. ',"bu":true' end
    local m = modules(e)
    if m then s = s .. ',"mod":' .. m end
    local f = fluids(e)
    if f then s = s .. ',"fb":' .. f end
  elseif k == 'lab' then
    s = s .. ',"w":' .. T[e.tile_width] .. ',"h":' .. T[e.tile_height]
    if e.burner then s = s .. ',"bu":true' end
    local m = modules(e)
    if m then s = s .. ',"mod":' .. m end
  elseif k == 'drill' then
    local dt = unit_of(e.drop_target)
    if dt then s = s .. ',"dt":' .. itos(dt) end
    s = s .. ',"dp":' .. xy(e.drop_position)
    -- Клетки ресурса в зоне добычи на момент записи.
    local res, order = {}, {}
    for _, o in pairs(e.surface.find_entities_filtered{area = e.mining_area, type = 'resource'}) do
      local n = o.name
      if not res[n] then order[#order + 1] = n end
      res[n] = (res[n] or 0) + 1
    end
    if order[1] then
      local r
      for _, n in ipairs(order) do r = (r and (r .. ',') or '{') .. str(n) .. ':' .. itos(res[n]) end
      s = s .. ',"res":' .. r .. '}'
    end
    s = s .. ',"w":' .. T[e.tile_width] .. ',"h":' .. T[e.tile_height]
    if e.burner then s = s .. ',"bu":true' end
    local m = modules(e)
    if m then s = s .. ',"mod":' .. m end
    local f = fluids(e)
    if f then s = s .. ',"fb":' .. f end
  elseif k == 'inserter' then
    local pt, dt = unit_of(e.pickup_target), unit_of(e.drop_target)
    if pt then s = s .. ',"pt":' .. itos(pt) end
    if dt then s = s .. ',"dt":' .. itos(dt) end
    s = s .. ',"pp":' .. xy(e.pickup_position) .. ',"dp":' .. xy(e.drop_position)
    if e.use_filters then
      local fl
      for i = 1, e.filter_slot_count do
        local n = filter_name(e.get_filter(i))
        if n then fl = (fl and (fl .. ',') or '[') .. str(n) end
      end
      s = s .. ',"fl":' .. (fl and (fl .. ']') or '[]') .. ',"fm":' .. str(e.inserter_filter_mode or 'whitelist')
    end
    if e.burner then s = s .. ',"bu":true' end
  elseif BELTLIKE[k] then
    local nb = e.belt_neighbours
    local bo, bi = ulist(nb.outputs), ulist(nb.inputs)
    if bo then s = s .. ',"bo":' .. bo end
    if bi then s = s .. ',"bi":' .. bi end
    if k == 'belt' then
      s = s .. ',"bs":' .. str(e.belt_shape)
    elseif k == 'underground' then
      s = s .. ',"ug":' .. str(e.belt_to_ground_type)
      local un = unit_of(e.underground_belt_neighbour)
      if un then s = s .. ',"un":' .. itos(un) end
    elseif k == 'splitter' then
      local sf = filter_name(e.splitter_filter)
      if sf then s = s .. ',"sf":' .. str(sf) end
      local ip, op = e.splitter_input_priority, e.splitter_output_priority
      if ip ~= 'none' then s = s .. ',"sip":' .. str(ip) end
      if op ~= 'none' then s = s .. ',"sop":' .. str(op) end
    elseif k == 'loader' then
      s = s .. ',"lt":' .. str(e.loader_type)
      local lc = unit_of(e.loader_container)
      if lc then s = s .. ',"lc":' .. itos(lc) end
    elseif k == 'linked' then
      local lk = unit_of(e.linked_belt_neighbour)
      if lk then s = s .. ',"lk":' .. itos(lk) end
      s = s .. ',"lt":' .. str(e.linked_belt_type)
    end
  elseif k == 'container' then
    if t == 'logistic-container' then
      local lm = e.prototype.logistic_mode
      if lm then s = s .. ',"lm":' .. str(lm) end
    end
    local inv = e.get_inventory(t == 'linked-container' and defines.inventory.linked_container_main or defines.inventory.chest)
    if inv then s = s .. ',"sz":' .. itos(#inv) end
  elseif k == 'pole' then
    local c = e.get_wire_connector(defines.wire_connector_id.pole_copper, false)
    if c and c.real_connection_count > 0 then
      local cw
      for _, w in pairs(c.real_connections) do
        local u = unit_of(w.target.owner)
        if u then cw = cw and (cw .. ',' .. itos(u)) or ('[' .. itos(u)) end
      end
      if cw then s = s .. ',"cw":' .. cw .. ']' end
    end
  elseif k == 'beacon' then
    s = s .. ',"w":' .. T[e.tile_width] .. ',"h":' .. T[e.tile_height]
    local m = modules(e)
    if m then s = s .. ',"mod":' .. m end
  elseif k == 'plain' then
    local f = fluids(e)
    if f then s = s .. ',"fb":' .. f end
  end
  return s .. '}', name, rcname
end

-- Ошибка обращения к полю у одной постройки не должна срывать всю страницу: запись с полем err.
local function ser_safe(e)
  local ok, s, name, rc = pcall(ser, e)
  if ok then return s, name, rc end
  local p = e.position
  return '{"u":' .. itos(e.unit_number) .. ',"n":' .. str(e.name) .. ',"t":' .. str(e.type) .. ',"x":' .. num(r2(p.x)) .. ',"y":' .. num(r2(p.y)) ..
    ',"err":' .. str(tostring(s):sub(1, 200)) .. '}', e.name, nil
end
G.ser = ser_safe

-- Машины для graph_sample: запоминаем встреченные при снимке и пересборке клеток.
local function remember_machine(g, si, e)
  local m = g.machines[si]
  if not m then
    m = {list = {}, units = {}, set = {}}
    g.machines[si] = m
  end
  local u = e.unit_number
  if m.set[u] then return end
  m.set[u] = true
  local n = #m.list + 1
  m.list[n], m.units[n] = e, u
end

-- ── Прототипы и рецепты ──

local function proto_info(name)
  local pr = prototypes.entity[name]
  if not pr then return nil end
  local t = pr.type
  local r = {t = t, w = pr.tile_width, h = pr.tile_height}
  local function opt(key, fn)
    local ok, v = pcall(fn)
    if ok and v ~= nil then r[key] = v end
  end
  if pr.belt_speed then r.bs = pr.belt_speed * 480 end -- предметов в секунду на ленту (обе полосы)
  if t == 'underground-belt' or t == 'pipe-to-ground' then r.ug = pr.max_underground_distance end
  if t == 'inserter' then
    opt('rot', function() return pr.get_inserter_rotation_speed() end)
    opt('ex', function() return pr.get_inserter_extension_speed() end)
    if pr.bulk then r.bk = true end
  end
  if t == 'mining-drill' then r.ms = pr.mining_speed end
  if CRAFTER[t] then opt('cs', function() return pr.get_crafting_speed() end) end
  if t == 'lab' then opt('rs', function() return pr.get_researching_speed() end) end
  if t == 'beacon' or t == 'electric-pole' then opt('sa', function() return pr.get_supply_area_distance() end) end
  if t == 'beacon' then opt('de', function() return pr.distribution_effectivity end) end
  if t == 'electric-pole' then opt('wd', function() return pr.get_max_wire_distance() end) end
  if t == 'pump' or t == 'offshore-pump' then opt('ps', function() return pr.get_pumping_speed() end) end
  return r
end

-- Ожидаемое количество продукта за крафт (с вероятностями).
local function amount(x)
  local a = x.amount or ((x.amount_min + x.amount_max) / 2)
  local p = x.independent_probability or x.probability or 1
  local sp = x.shared_probability
  if sp then p = p * (sp.max - sp.min) end
  return a * p + (x.extra_count_fraction or 0)
end

local function recipe_info(force, name)
  local rc = force.recipes[name]
  if not rc then return nil end
  local ing, prod = {}, {}
  for i, x in ipairs(rc.ingredients) do ing[i] = {n = x.name, a = x.amount, t = x.type == 'fluid' and 'f' or nil} end
  for i, x in ipairs(rc.products) do prod[i] = {n = x.name, a = amount(x), t = x.type == 'fluid' and 'f' or nil} end
  -- В 2.1 у рецепта может быть несколько категорий (cat — список).
  return {e = rc.energy, ing = U.list(ing), prod = U.list(prod), cat = U.list(rc.categories)}
end

-- Сведения о ещё не виденных в этом снимке именах построек и рецептов → в ответ страницы.
local function note_proto(out, seen, name)
  if seen[name] then return end
  seen[name] = true
  local pi = proto_info(name)
  if pi then
    out.protos = out.protos or {}
    out.protos[name] = pi
  end
end
local function note_recipe(out, seenr, force, rc)
  if not rc or seenr[rc] then return end
  seenr[rc] = true
  local ri = recipe_info(force, rc)
  if ri then
    out.recipes = out.recipes or {}
    out.recipes[rc] = ri
  end
end

-- ── Операции ──

local function surface_of(p)
  local name = p.surface or 'nauvis'
  local s = game.get_surface(name)
  if not s then U.fail('not_found', 'нет поверхности ' .. tostring(name)) end
  return s
end

local function limit_of(p, default)
  local l = p.limit or default
  if type(l) ~= 'number' or l < 1 then U.fail('bad_request', 'limit: целое от 1') end
  return math.min(floor(l), MAX_LIMIT)
end

local function force_bonus(f)
  return {inserter_stack = f.inserter_stack_size_bonus, bulk_inserter_stack = f.bulk_inserter_capacity_bonus,
    belt_stack = f.belt_stack_size_bonus, mining_productivity = f.mining_drill_productivity_bonus}
end

local function new_snapshot(g, s)
  g.snap_id = g.snap_id + 1
  -- Чанки берутся из итератора игры по мере обхода: список чанков не строится целиком за один вызов. Итератор лежит
  -- в storage (сохраняется вместе с картой и продолжает обход после загрузки).
  local snap = {id = g.snap_id, s = s.index, rev0 = g.rev, it = s.get_chunks(), i = 0, counts = {}, seen = {}, seenr = {}, total = 0}
  g.snaps[snap.id] = snap
  for id in pairs(g.snaps) do
    if id <= snap.id - SNAPS then g.snaps[id] = nil end
  end
  if g.rev > g.served then g.served = g.rev end
  return snap
end

-- Снимок: первый вызов без cursor запоминает ревизию начала (rev0); каждый вызов берёт следующие чанки поверхности,
-- пока не наберёт limit записей (или PAGE_CHUNKS чанков, или 4·limit построек любых видов). Чанк не делится между
-- страницами. Пустой чанк стоит один поиск построек (~10–20 мкс). После снимка — graph_changes{since = rev0}.
O.register('graph_snapshot', {fn = function(_, p)
  local g = G.st()
  local limit = limit_of(p, 2000)
  local out = {}
  local snap, s
  if p.cursor == nil then
    s = surface_of(p)
    snap = new_snapshot(g, s)
    out.header = {tick = game.tick, rev = g.rev, surface = s.name, cell = CELL, force_bonus = force_bonus(game.forces[FORCE])}
  else
    local id, i = tostring(p.cursor):match('^(%d+):(%d+)$')
    snap = id and g.snaps[tonumber(id)]
    if not snap or snap.i ~= tonumber(i) then
      U.fail('bad_request', 'cursor устарел или неверен: начни снимок заново (без cursor)')
    end
    s = game.get_surface(snap.s)
    if not s then U.fail('not_found', 'поверхности снимка больше нет') end
  end
  local force = game.forces[FORCE]
  local list, nl, counts, seen, seenr = {}, 0, snap.counts, snap.seen, snap.seenr
  local scanned, visited, finished = 0, 0, true
  local lt, rb = {0, 0}, {0, 0}
  local filter = {area = {lt, rb}, force = force}
  if nl < limit then
    for c in snap.it do
      local x0, y0 = c.x * 32, c.y * 32
      local x1, y1 = x0 + 32, y0 + 32
      lt[1], lt[2], rb[1], rb[2] = x0, y0, x1, y1
      for _, e in pairs(s.find_entities_filtered(filter)) do
        local pos = e.position
        -- Постройка на стыке чанков попадает в выборку обоих: берём её только в чанке её центра.
        local x, y = pos.x, pos.y
        if x >= x0 and x < x1 and y >= y0 and y < y1 then
          scanned = scanned + 1
          local name = e.name
          counts[name] = (counts[name] or 0) + 1
          local t = e.type
          if TYPES[t] then
            local js, _, rc = ser_safe(e)
            nl = nl + 1
            list[nl] = js
            if not seen[name] then note_proto(out, seen, name) end
            if rc and not seenr[rc] then note_recipe(out, seenr, force, rc) end
            if MACHINE[t] then remember_machine(g, snap.s, e) end
          end
        end
      end
      visited = visited + 1
      if nl >= limit or scanned >= limit * 4 or visited >= PAGE_CHUNKS then
        finished = false
        break
      end
    end
  end
  snap.i = snap.i + visited
  snap.total = snap.total + nl
  out.rev0 = snap.rev0
  out.entities = nl > 0 and rawlist(list) or U.EMPTY
  out.chunks = snap.i
  if finished then
    out.counts = counts
    out.total = snap.total
    g.snaps[snap.id] = nil
  else
    out.cursor = snap.id .. ':' .. snap.i
  end
  return raw(out)
end})

-- Пересобрать клетку: все сериализуемые постройки, чей центр в клетке.
local function resync_cell(g, s, force, si, k, list, nl)
  local cx, cy = cell_xy(k)
  local x0, y0 = cx * CELL, cy * CELL
  local x1, y1 = x0 + CELL, y0 + CELL
  for _, e in pairs(s.find_entities_filtered{area = {{x0, y0}, {x1, y1}}, force = force, type = TYPE_LIST}) do
    local pos = e.position
    if pos.x >= x0 and pos.x < x1 and pos.y >= y0 and pos.y < y1 then
      nl = nl + 1
      list[nl] = ser_safe(e)
      if MACHINE[e.type] then remember_machine(g, si, e) end
    end
  end
  return nl, x0, y0
end

-- Изменения после ревизии since. upsert — записи всех построек пересобранных клеток (cells — левые верхние углы
-- клеток CELL×CELL): постройки клиента в этих клетках, которых нет в upsert, исчезли. remove — номера снесённых.
-- more — журнал прочитан не до конца (предел limit): следующий вызов с since = rev.
O.register('graph_changes', {fn = function(_, p)
  local g = G.st()
  local s = surface_of(p)
  local since = p.since
  if type(since) ~= 'number' then U.fail('bad_request', 'since: ревизия (rev0 снимка или rev прошлого ответа)') end
  local limit = limit_of(p, 2000)
  if since > g.rev or since < g.first - 1 then
    return raw({rev = g.rev, reset = true, more = false, upsert = U.EMPTY, remove = U.EMPTY, cells = U.EMPTY, cell = CELL})
  end
  local si = s.index
  local force = game.forces[FORCE]
  local last = g.last[si] or {}
  local ls, lv = g.ls, g.lv
  local up, nu, rm, cells, done = {}, 0, {}, {}, {}
  local r = since
  local stop = g.rev
  while r < stop and nu < limit do
    r = r + 1
    if ls[r] == si then
      local v = lv[r]
      if v < 0 then
        rm[#rm + 1] = -v
      elseif last[v] == r and not done[v] then
        done[v] = true
        local x0, y0
        nu, x0, y0 = resync_cell(g, s, force, si, v, up, nu)
        cells[#cells + 1] = {x0, y0}
      end
    end
  end
  if r > g.served then g.served = r end
  return raw({rev = r, reset = false, more = r < stop, upsert = nu > 0 and rawlist(up) or U.EMPTY, remove = U.list(rm),
    cells = U.list(cells), cell = CELL})
end})

O.register('graph_protos', {fn = function(_, p)
  local force = game.forces[FORCE]
  local protos, recipes = {}, {}
  for _, n in ipairs(type(p.names) == 'table' and p.names or {}) do
    local pi = type(n) == 'string' and proto_info(n)
    if pi then protos[n] = pi end
  end
  for _, n in ipairs(type(p.recipes) == 'table' and p.recipes or {}) do
    local ri = type(n) == 'string' and recipe_info(force, n)
    if ri then recipes[n] = ri end
  end
  return raw({protos = protos, recipes = recipes, force_bonus = force_bonus(force)})
end})

-- Содержимое постройки: инвентари по слотам окна, жидкости по ёмкостям, полосы лент, рука манипулятора, статус.
local function contents_of(e)
  local r = {u = e.unit_number}
  local st = e.status
  if st then r.status = STATUS[st] end
  local inv
  for name, i in pairs(Inv.all(e)) do
    if not i.is_empty() then
      inv = inv or {}
      inv[name] = U.contents(i)
    end
  end
  r.inv = inv
  local n = e.fluids_count
  if n > 0 then
    local fl = {}
    for i = 1, n do
      local f = e.get_fluid(i)
      fl[i] = f and {f.name, r2(f.amount)} or 0
    end
    r.fluids = fl
  end
  local t = e.type
  if BELTLIKE[TYPES[t]] then
    local lanes = {}
    for i = 1, e.get_max_transport_line_index() do lanes[i] = U.contents(e.get_transport_line(i)) end
    r.lanes = lanes
  elseif t == 'inserter' then
    local h = e.held_stack
    if h.valid_for_read then r.held = {U.item_key(h.name, h.quality.name), h.count} end
  elseif CRAFTER[t] then
    r.pfin = e.products_finished
  elseif t == 'mining-drill' then
    local amt = 0
    for _, o in pairs(e.surface.find_entities_filtered{area = e.mining_area, type = 'resource'}) do amt = amt + o.amount end
    r.amt = amt
  end
  return r
end

-- Найти постройку по номеру. game.get_entity_by_unit_number находит только прототипы с флагом get-by-unit-number
-- (из построек — почти никого: станции, вагоны), поэтому клиент передаёт и позицию из записи: [u, x, y].
local function by_unit(s, force, ref)
  local u, x, y
  if type(ref) == 'number' then u = ref
  elseif type(ref) == 'table' then u, x, y = ref[1] or ref.u, ref[2] or ref.x, ref[3] or ref.y end
  if type(u) ~= 'number' then return nil, u end
  if type(x) == 'number' and type(y) == 'number' then
    for _, e in pairs(s.find_entities_filtered{area = {{x - 0.01, y - 0.01}, {x + 0.01, y + 0.01}}, force = force}) do
      if e.unit_number == u then return e, u end
    end
    return nil, u
  end
  local e = game.get_entity_by_unit_number(u)
  return e, u
end

O.register('graph_contents', {fn = function(_, p)
  local list = p.units
  if type(list) ~= 'table' then U.fail('bad_request', 'units: список [u, x, y] (до 500)') end
  if #list > 500 then U.fail('bad_request', 'units: не больше 500 за вызов') end
  local s = surface_of(p)
  local force = game.forces[FORCE]
  local out, missing = {}, {}
  for _, ref in ipairs(list) do
    local e, u = by_unit(s, force, ref)
    if e and e.valid then
      local ok, r = pcall(contents_of, e)
      out[#out + 1] = ok and r or {u = u, err = tostring(r):sub(1, 200)}
    else
      missing[#missing + 1] = u
    end
  end
  return raw({entities = U.list(out), missing = U.list(missing)})
end})

-- Статистика производства команды: предмет → [выпуск за 1 мин, расход за 1 мин, выпуск в минуту за 10 мин, расход в минуту за 10 мин].
local function flow(force, s)
  local one, ten = defines.flow_precision_index.one_minute, defines.flow_precision_index.ten_minutes
  local function stat(st)
    local out = {}
    local names = {}
    for n in pairs(st.input_counts) do names[n] = true end
    for n in pairs(st.output_counts) do names[n] = true end
    for n in pairs(names) do
      local p1 = st.get_flow_count{name = n, category = 'input', precision_index = one, count = true}
      local c1 = st.get_flow_count{name = n, category = 'output', precision_index = one, count = true}
      local p10 = st.get_flow_count{name = n, category = 'input', precision_index = ten, count = true} / 10
      local c10 = st.get_flow_count{name = n, category = 'output', precision_index = ten, count = true} / 10
      if p1 > 0 or c1 > 0 or p10 > 0 or c10 > 0 then out[n] = {r2(p1), r2(c1), r2(p10), r2(c10)} end
    end
    return out
  end
  return {items = stat(force.get_item_production_statistics(s)), fluids = stat(force.get_fluid_production_statistics(s))}
end

-- Выборка по машинам, встреченным в снимках и пересборках клеток: [u, status, pfin?, rc?].
O.register('graph_sample', {fn = function(_, p)
  local g = G.st()
  local s = surface_of(p)
  local limit = limit_of(p, 3000)
  local m = g.machines[s.index] or {list = {}, units = {}, set = {}}
  local out = {}
  local i = 1
  if p.cursor == nil then
    -- Начало обхода: выбросить исчезнувшие машины (сдвиг одним проходом по списку).
    local list, us, set = m.list, m.units, m.set
    local j = 0
    for k = 1, #list do
      local e = list[k]
      if e.valid then
        j = j + 1
        list[j], us[j] = e, us[k]
      else
        set[us[k]] = nil
      end
    end
    for k = #list, j + 1, -1 do list[k], us[k] = nil, nil end
    out.flow = flow(game.forces[FORCE], s)
    out.tick = game.tick
    out.machines = j
  else
    i = tonumber(p.cursor)
    if not i or i < 1 then U.fail('bad_request', 'cursor: число из прошлого ответа') end
  end
  local rows, nr = {}, 0
  local list = m.list
  local n = #list
  while i <= n and nr < limit do
    local e = list[i]
    if e.valid then
      local t = e.type
      local st = e.status
      local row = '[' .. itos(e.unit_number) .. ',' .. str(st and STATUS[st] or 'none')
      if CRAFTER[t] then
        row = row .. ',' .. itos(e.products_finished)
        if t == 'furnace' then
          local rc = e.get_recipe()
          if rc then row = row .. ',' .. str(rc.name) end
        end
      end
      nr = nr + 1
      rows[nr] = row .. ']'
    end
    i = i + 1
  end
  out.rows = nr > 0 and rawlist(rows) or U.EMPTY
  if i <= n then out.cursor = i end
  return raw(out)
end})

return G
