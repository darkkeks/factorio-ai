-- Операция patches: поля ресурсов, как на карте игры (наведение на поле показывает, сколько в нём осталось).
-- Поле — связная (по 8 соседям; у нефти — скважины не дальше 6 клеток) группа клеток одного ресурса в открытой части карты. Для каждого поля: ресурс, клетки,
-- остаток (сумма amount; у жидкостей — суммарный выход в %, как в игре), границы, центр; и сколько клеток поля попадает
-- в зону добычи буров своей команды (mining_area) — недокопанное видно числом.
local U = require('agent.util')
local O = require('agent.ops')
local B = require('agent.actions.build')

local MAX_CELLS = 300 * 300

local function rect(A, p)
  local x1, y1, x2, y2
  if p.area then
    local a = B.area_of(p)
    x1, y1, x2, y2 = a[1][1], a[1][2], a[2][1], a[2][2]
  else
    local c = (p.x and p.y) and {x = p.x, y = p.y} or A.entity.position
    local r = math.min(p.radius or 100, 150)
    x1, y1, x2, y2 = c.x - r, c.y - r, c.x + r, c.y + r
  end
  return math.floor(x1), math.floor(y1), math.ceil(x2), math.ceil(y2)
end

O.register('patches', {agent = true, fn = function(A, p)
  local e = A.entity
  local surface, force = e.surface, e.force
  local x1, y1, x2, y2 = rect(A, p)
  if (x2 - x1) * (y2 - y1) > MAX_CELLS then U.fail('bad_request', 'область больше 300×300 клеток: запрашивай частями') end
  local want = p.name and {[p.name] = true} or nil
  -- клетки руды в открытых чанках (ресурсы видны на карте и по памяти)
  local cells = {}
  local charted = {}
  local function is_charted(x, y)
    local cx, cy = math.floor(x / 32), math.floor(y / 32)
    local k = cx * 65536 + cy
    local v = charted[k]
    if v == nil then v = force.is_chunk_charted(surface, {cx, cy}) charted[k] = v end
    return v
  end
  for _, r in pairs(surface.find_entities_filtered{area = {{x1, y1}, {x2, y2}}, type = 'resource'}) do
    local n = r.name
    if not want or want[n] then
      local pos = r.position
      local x, y = math.floor(pos.x), math.floor(pos.y)
      if is_charted(x, y) then
        local fluid = r.prototype.infinite_resource
        cells[x * 65536 + y] = {x = x, y = y, n = n, a = r.amount, fluid = fluid, norm = fluid and r.initial_amount or nil}
      end
    end
  end
  -- зоны добычи своих буров (с запасом на радиус)
  local mined = {}
  local drills_by = {}
  for _, d in pairs(surface.find_entities_filtered{area = {{x1 - 8, y1 - 8}, {x2 + 8, y2 + 8}}, type = 'mining-drill', force = force}) do
    local ma = d.mining_area
    if ma then
      for x = math.floor(ma.left_top.x + 0.01), math.ceil(ma.right_bottom.x - 0.01) - 1 do
        for y = math.floor(ma.left_top.y + 0.01), math.ceil(ma.right_bottom.y - 0.01) - 1 do
          mined[x * 65536 + y] = d.unit_number or true
        end
      end
    end
  end
  -- поля: обход по 8 соседям в пределах одного ресурса
  local seen, out = {}, {}
  for k, c in pairs(cells) do
    if not seen[k] then
      local n = c.n
      local stack, tiles, amount, under = {k}, 0, 0, 0
      local bx1, by1, bx2, by2 = c.x, c.y, c.x, c.y
      local fluid, yield, drills = c.fluid, 0, {}
      seen[k] = true
      while #stack > 0 do
        local kk = table.remove(stack)
        local t = cells[kk]
        tiles = tiles + 1
        amount = amount + t.a
        if t.fluid and t.norm and t.norm > 0 then yield = yield + t.a / t.norm * 100 end
        if mined[kk] then under = under + 1 if type(mined[kk]) == 'number' then drills[mined[kk]] = true end end
        if t.x < bx1 then bx1 = t.x end
        if t.y < by1 then by1 = t.y end
        if t.x > bx2 then bx2 = t.x end
        if t.y > by2 then by2 = t.y end
        local R = t.fluid and 6 or 1   -- скважины нефти стоят вразбивку: одно поле — скважины не дальше 6 клеток друг от друга
        for dx = -R, R do
          for dy = -R, R do
            local nk = (t.x + dx) * 65536 + (t.y + dy)
            local nc = cells[nk]
            if nc and not seen[nk] and nc.n == n then seen[nk] = true stack[#stack + 1] = nk end
          end
        end
      end
      local nd = 0
      for _ in pairs(drills) do nd = nd + 1 end
      local edge = bx1 <= x1 or by1 <= y1 or bx2 >= x2 - 1 or by2 >= y2 - 1
      local r = {name = n, tiles = tiles, area = {x1 = bx1, y1 = by1, x2 = bx2 + 1, y2 = by2 + 1},
        center = {x = U.r2((bx1 + bx2 + 1) / 2), y = U.r2((by1 + by2 + 1) / 2)},
        tiles_mined = under, tiles_free = tiles - under, drills = nd, cut_by_edge = edge or nil}
      if fluid then r.sources = tiles r.yield_percent = math.floor(yield + 0.5) else r.amount = amount end
      out[#out + 1] = r
    end
  end
  table.sort(out, function(a, b) return (a.amount or a.tiles) > (b.amount or b.tiles) end)
  local limit = math.min(p.limit or 50, 300)
  local list = {}
  for i = 1, math.min(#out, limit) do list[i] = out[i] end
  return {area = {x1 = x1, y1 = y1, x2 = x2, y2 = y2}, patches = U.list(list), total = #out, more = #out > limit or nil}
end})
