-- Общие мелочи: ошибки единого вида, округление, расстояния, пустые списки.
local U = {}

-- table_to_json превращает пустую таблицу в {}, а клиенту нужен []. Пустые списки помечаются этой строкой,
-- сервер на хосте заменяет её на [].
U.EMPTY = '\1[]'

-- Результат, уже закодированный в JSON (большие ответы графа фабрики кодируются своим кодировщиком — см. graph.lua):
-- main.lua вставляет строку в ответ как есть.
U.RAW = {}
function U.raw(json) return {[U.RAW] = json} end

--- Прервать операцию ошибкой единого вида {code, message, data}.
function U.fail(code, message, data)
  error({code = code, message = message, data = data}, 0)
end

function U.list(t)
  if t == nil or next(t) == nil then return U.EMPTY end
  return t
end

function U.r2(v) return math.floor(v * 100 + 0.5) / 100 end
function U.pos(p) return {x = U.r2(p.x), y = U.r2(p.y)} end

function U.dist(a, b)
  local dx, dy = a.x - b.x, a.y - b.y
  return math.sqrt(dx * dx + dy * dy)
end

--- Расстояние от точки до прямоугольника (0, если точка внутри).
function U.dist_box(p, box)
  local lt, rb = box.left_top, box.right_bottom
  local dx = math.max(lt.x - p.x, 0, p.x - rb.x)
  local dy = math.max(lt.y - p.y, 0, p.y - rb.y)
  return math.sqrt(dx * dx + dy * dy)
end

--- Расстояние от точки p до отрезка ab.
function U.dist_segment(p, a, b)
  local vx, vy = b.x - a.x, b.y - a.y
  local len2 = vx * vx + vy * vy
  if len2 < 1e-9 then return U.dist(p, a), 0 end
  local t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2
  local tc = math.max(0, math.min(1, t))
  local dx, dy = p.x - (a.x + vx * tc), p.y - (a.y + vy * tc)
  return math.sqrt(dx * dx + dy * dy), t
end

--- Проверка аргумента: U.arg(p.x, 'number', 'x').
function U.arg(v, kind, name, optional)
  if v == nil then
    if optional then return nil end
    U.fail('bad_request', 'нет обязательного параметра ' .. name)
  end
  if kind == 'int' then
    if type(v) ~= 'number' or v % 1 ~= 0 then U.fail('bad_request', 'параметр ' .. name .. ' должен быть целым числом') end
  elseif type(v) ~= kind then
    U.fail('bad_request', 'параметр ' .. name .. ' должен быть типа ' .. kind)
  end
  return v
end

--- Содержимое инвентаря: имя → количество; для качества выше обычного ключ вида "имя@качество".
function U.contents(inv)
  local r = {}
  if not inv then return r end
  for _, s in pairs(inv.get_contents()) do
    local k = (s.quality and s.quality ~= 'normal') and (s.name .. '@' .. s.quality) or s.name
    r[k] = (r[k] or 0) + s.count
  end
  return r
end

-- Направления: в запросах и ответах — имена (north, east, south, west и промежуточные), можно и числом 0…15.
local DIRS = {}
for name, v in pairs(defines.direction) do DIRS[v] = name end

function U.dir(v, name)
  if v == nil then return nil end
  if type(v) == 'number' and v % 1 == 0 and v >= 0 and v < 16 then return v end
  local d = type(v) == 'string' and defines.direction[v]
  if d == nil then U.fail('bad_request', (name or 'direction') .. ': north, east, south, west (или число 0…15)') end
  return d
end

function U.dirname(d) return DIRS[d] or d end

--- Ключ предмета для ответов: имя, а для качества выше обычного — "имя@качество".
function U.item_key(name, quality)
  if quality and quality ~= 'normal' then return name .. '@' .. quality end
  return name
end

--- Расписание поезда, как в его окне: [{station, wait: [{type, ticks?, compare?, item? | fluid?, comparator?, count?}]}].
function U.schedule(train)
  local sch = train.schedule
  local out = {}
  if not sch then return out end
  for i, rec in ipairs(sch.records) do
    local r = {station = rec.station or (rec.rail and 'rail') or '?'}
    if rec.temporary then r.temporary = true end
    local wait = {}
    for j, w in ipairs(rec.wait_conditions or {}) do
      local c = {type = w.type}
      if w.ticks then c.ticks = w.ticks end
      if j > 1 then c.compare = w.compare_type end
      local cond = w.condition
      if cond and (w.type == 'item_count' or w.type == 'fluid_count') then
        local sig = cond.first_signal
        if sig then c[w.type == 'item_count' and 'item' or 'fluid'] = sig.name end
        c.comparator, c.count = cond.comparator, cond.constant
      end
      wait[j] = c
    end
    if #wait > 0 then r.wait = wait end
    out[i] = r
  end
  return out
end

--- Сколько предметов (с учётом качества) у сущности или в инвентаре.
function U.count(holder, name, quality)
  return holder.get_item_count{name = name, quality = quality or 'normal'}
end

return U
