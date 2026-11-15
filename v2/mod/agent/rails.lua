-- Рельсы: геометрия частей пути (как у рельсового планировщика игры) и стыки построенных рельсов.
-- rail_path только считает координаты частей по перечисленным ботом шагам — ничего не ставит и маршрут не выбирает.
local U = require('agent.util')
local O = require('agent.ops')

local R = {}

-- Продолжения пути от конца рельса с направлением движения d (0…15), снятые с get_rail_extensions игры 2.1:
-- {имя части, смещение её центра от конца (x, y), её direction, смещение нового конца (x, y), новое направление}.
local EXT = {
  [0] = {{"straight-rail", 0, -1, 0, 0, -2, 0}, {"curved-rail-a", 0, -2, 0, -1, -5, 15}, {"curved-rail-a", 0, -2, 2, 1, -5, 1}},
  [1] = {{"curved-rail-a", 1, -3, 10, 1, -5, 0}, {"curved-rail-b", 1, -2, 2, 3, -4, 2}, {"half-diagonal-rail", 1, -2, 2, 2, -4, 1}},
  [2] = {{"straight-rail", 1, -1, 2, 2, -2, 2}, {"curved-rail-b", 2, -2, 10, 3, -4, 1}, {"curved-rail-b", 2, -2, 12, 4, -3, 3}},
  [3] = {{"curved-rail-a", 3, -1, 12, 5, -1, 4}, {"curved-rail-b", 2, -1, 4, 4, -3, 2}, {"half-diagonal-rail", 2, -1, 4, 4, -2, 3}},
  [4] = {{"straight-rail", 1, 0, 4, 2, 0, 4}, {"curved-rail-a", 2, 0, 4, 5, -1, 3}, {"curved-rail-a", 2, 0, 6, 5, 1, 5}},
  [5] = {{"curved-rail-a", 3, 1, 14, 5, 1, 4}, {"curved-rail-b", 2, 1, 6, 4, 3, 6}, {"half-diagonal-rail", 2, 1, 6, 4, 2, 5}},
  [6] = {{"straight-rail", 1, 1, 6, 2, 2, 6}, {"curved-rail-b", 2, 2, 0, 3, 4, 7}, {"curved-rail-b", 2, 2, 14, 4, 3, 5}},
  [7] = {{"curved-rail-a", 1, 3, 0, 1, 5, 8}, {"curved-rail-b", 1, 2, 8, 3, 4, 6}, {"half-diagonal-rail", 1, 2, 0, 2, 4, 7}},
  [8] = {{"straight-rail", 0, 1, 0, 0, 2, 8}, {"curved-rail-a", 0, 2, 8, 1, 5, 7}, {"curved-rail-a", 0, 2, 10, -1, 5, 9}},
  [9] = {{"curved-rail-a", -1, 3, 2, -1, 5, 8}, {"curved-rail-b", -1, 2, 10, -3, 4, 10}, {"half-diagonal-rail", -1, 2, 2, -2, 4, 9}},
  [10] = {{"straight-rail", -1, 1, 2, -2, 2, 10}, {"curved-rail-b", -2, 2, 2, -3, 4, 9}, {"curved-rail-b", -2, 2, 4, -4, 3, 11}},
  [11] = {{"curved-rail-a", -3, 1, 4, -5, 1, 12}, {"curved-rail-b", -2, 1, 12, -4, 3, 10}, {"half-diagonal-rail", -2, 1, 4, -4, 2, 11}},
  [12] = {{"straight-rail", -1, 0, 4, -2, 0, 12}, {"curved-rail-a", -2, 0, 12, -5, 1, 11}, {"curved-rail-a", -2, 0, 14, -5, -1, 13}},
  [13] = {{"curved-rail-a", -3, -1, 6, -5, -1, 12}, {"curved-rail-b", -2, -1, 14, -4, -3, 14}, {"half-diagonal-rail", -2, -1, 6, -4, -2, 13}},
  [14] = {{"straight-rail", -1, -1, 6, -2, -2, 14}, {"curved-rail-b", -2, -2, 6, -4, -3, 13}, {"curved-rail-b", -2, -2, 8, -3, -4, 15}},
  [15] = {{"curved-rail-a", -1, -3, 8, -1, -5, 0}, {"curved-rail-b", -1, -2, 0, -3, -4, 14}, {"half-diagonal-rail", -1, -2, 0, -2, -4, 15}},
}
-- Концы части по имени и direction: {чётность центра x, y (остаток от 2), конец 1 {dx, dy, направление наружу}, конец 2}.
local ENDS = {
  ["straight-rail"] = {[0] = {1, 1, {0, -1, 0}, {0, 1, 8}}, [2] = {0, 0, {-1, 1, 10}, {1, -1, 2}}, [4] = {1, 1, {1, 0, 4}, {-1, 0, 12}}, [6] = {0, 0, {-1, -1, 14}, {1, 1, 6}}, [8] = {1, 1, {0, -1, 0}, {0, 1, 8}}, [10] = {0, 0, {-1, 1, 10}, {1, -1, 2}}, [12] = {1, 1, {1, 0, 4}, {-1, 0, 12}}, [14] = {0, 0, {-1, -1, 14}, {1, 1, 6}}},
  ["curved-rail-a"] = {[0] = {1, 0, {0, 2, 8}, {-1, -3, 15}}, [2] = {1, 0, {0, 2, 8}, {1, -3, 1}}, [4] = {0, 1, {-2, 0, 12}, {3, -1, 3}}, [6] = {0, 1, {-2, 0, 12}, {3, 1, 5}}, [8] = {1, 0, {0, -2, 0}, {1, 3, 7}}, [10] = {1, 0, {0, -2, 0}, {-1, 3, 9}}, [12] = {0, 1, {2, 0, 4}, {-3, 1, 11}}, [14] = {0, 1, {2, 0, 4}, {-3, -1, 13}}},
  ["curved-rail-b"] = {[0] = {1, 1, {1, 2, 7}, {-2, -2, 14}}, [2] = {1, 1, {-1, 2, 9}, {2, -2, 2}}, [4] = {1, 1, {-2, 1, 11}, {2, -2, 2}}, [6] = {1, 1, {-2, -1, 13}, {2, 2, 6}}, [8] = {1, 1, {-1, -2, 15}, {2, 2, 6}}, [10] = {1, 1, {1, -2, 1}, {-2, 2, 10}}, [12] = {1, 1, {2, -1, 3}, {-2, 2, 10}}, [14] = {1, 1, {2, 1, 5}, {-2, -2, 14}}},
  ["half-diagonal-rail"] = {[0] = {1, 1, {1, 2, 7}, {-1, -2, 15}}, [2] = {1, 1, {-1, 2, 9}, {1, -2, 1}}, [4] = {1, 1, {-2, 1, 11}, {2, -1, 3}}, [6] = {1, 1, {-2, -1, 13}, {2, 1, 5}}, [8] = {1, 1, {1, 2, 7}, {-1, -2, 15}}, [10] = {1, 1, {-1, 2, 9}, {1, -2, 1}}, [12] = {1, 1, {-2, 1, 11}, {2, -1, 3}}, [14] = {1, 1, {-2, -1, 13}, {2, 1, 5}}},
}
local MAX_PARTS = 600

-- Шаг → продолжение: straight сохраняет направление, left — на 22,5° против часовой, right — по часовой.
local TURN = {straight = 0, left = -1, right = 1}
local STEP = {}
for d, list in pairs(EXT) do
  STEP[d] = {}
  for _, x in ipairs(list) do STEP[d][(x[7] - d + 17) % 16 - 1] = x end
end

-- Часть пути из запроса: {name, x, y, direction} → запись ENDS; проверяет имя, направление и сетку.
local function part_of(ref, what)
  if type(ref) ~= 'table' then U.fail('bad_request', what .. ': {name?, x, y, direction} — рельс, существующий или задуманный') end
  local name = ref.name or 'straight-rail'
  local kinds = ENDS[name]
  if not kinds then U.fail('bad_request', what .. '.name: straight-rail, curved-rail-a, curved-rail-b или half-diagonal-rail') end
  local x, y = U.arg(ref.x, 'number', what .. '.x'), U.arg(ref.y, 'number', what .. '.y')
  local d = U.dir(ref.direction or 'north', what .. '.direction')
  local rec = kinds[d]
  if not rec then U.fail('bad_request', what .. '.direction: у рельсов восемь направлений (north, northeast, east, …)') end
  if x % 2 ~= rec[1] or y % 2 ~= rec[2] then
    local word = {[0] = 'чётный', [1] = 'нечётный'}
    U.fail('bad_position', ('%s: центр %s direction %s стоит на сетке: x %s, y %s — возьми x, y из inspect или area'):format(
      what, name, U.dirname(d), word[rec[1]], word[rec[2]]), {x = x, y = y})
  end
  return name, x, y, d, rec
end

local function end_row(x, y, d) return {x = x, y = y, direction = U.dirname(d)} end

O.register('rail_path', {agent = true, fn = function(_, p)
  local name, x, y, d, rec = part_of(p.from, 'from')
  local heading = U.dir(U.arg(p.heading, 'string', 'heading'), 'heading')
  local cur
  for i = 3, 4 do
    if rec[i][3] == heading then cur = {x + rec[i][1], y + rec[i][2], heading} end
  end
  if not cur then
    U.fail('bad_request', ('heading: у рельса %s direction %s концы смотрят на %s и %s — укажи один из них'):format(
      name, U.dirname(d), U.dirname(rec[3][3]), U.dirname(rec[4][3])), {headings = {U.dirname(rec[3][3]), U.dirname(rec[4][3])}})
  end
  if type(p.moves) ~= 'table' then U.fail('bad_request', "moves: список шагов 'straight' | 'left' | 'right', можно с числом повторов: 'straight*10'") end
  local items = {}
  for i, m in ipairs(p.moves) do
    local word, n = m, 1
    if type(m) == 'string' then
      local w, c = m:match('^(%a+)%s*%*%s*(%d+)$')
      if w then word, n = w, tonumber(c) end
    end
    local turn = TURN[word]
    if not turn then U.fail('bad_request', ("moves[%d]: 'straight' | 'left' | 'right', можно с числом повторов: 'straight*10'"):format(i)) end
    if #items + n > MAX_PARTS then U.fail('bad_request', 'не больше ' .. MAX_PARTS .. ' частей за запрос — продолжи следующим запросом от последней части') end
    for _ = 1, n do
      local s = STEP[cur[3]][turn]
      items[#items + 1] = {name = s[1], x = cur[1] + s[2], y = cur[2] + s[3], direction = U.dirname(s[4])}
      cur = {cur[1] + s[5], cur[2] + s[6], s[7]}
    end
  end
  local out = {items = U.list(items), count = #items, ['end'] = end_row(cur[1], cur[2], cur[3])}
  if p.to ~= nil then
    local _, tx, ty, _, trec = part_of(p.to, 'to')
    local ends = {}
    out.joins = false
    for i = 3, 4 do
      local ex, ey, ed = tx + trec[i][1], ty + trec[i][2], trec[i][3]
      ends[#ends + 1] = end_row(ex, ey, (ed + 8) % 16)
      if ex == cur[1] and ey == cur[2] and (ed + 8) % 16 == cur[3] then out.joins = true end
    end
    -- С какими end путь состыкуется с рельсом to (точка стыка и направление движения в ней).
    out.to_ends = ends
  end
  return out
end})

local CONN = {'left', 'straight', 'right'}

--- Стыки построенного рельса, как их видно на земле: [{x, y, heading, connected: [{name, x, y, direction, turn}]}].
function R.describe(e)
  if not ENDS[e.type] and e.type ~= 'rail-ramp' and not e.type:find('^elevated%-') then return nil end
  local out = {}
  for _, rd in ipairs{defines.rail_direction.front, defines.rail_direction.back} do
    local loc = e.get_rail_end(rd).location
    local row = {x = loc.position.x, y = loc.position.y, heading = U.dirname(loc.direction)}
    local conn = {}
    for _, c in ipairs(CONN) do
      local o = e.get_connected_rail{rail_direction = rd, rail_connection_direction = defines.rail_connection_direction[c]}
      if o then conn[#conn + 1] = {name = o.name, x = o.position.x, y = o.position.y, direction = U.dirname(o.direction), turn = c} end
    end
    row.connected = U.list(conn)
    row.open = #conn == 0
    out[#out + 1] = row
  end
  return out
end

return R
