-- Как бот называет объект мира: {x, y, name?, unit?} (объект в точке), {player = имя}, {agent = имя}.
local U = require('agent.util')

local T = {}

local SKIP = {character = true, corpse = true, ['item-entity'] = true, fish = true, smoke = true, explosion = true,
  ['smoke-with-trigger'] = true, particle = true, projectile = true, beam = true, sticker = true, ['flying-text'] = true,
  ['highlight-box'] = true, ['speech-bubble'] = true, fire = true, stream = true, ['artillery-flare'] = true,
  ['particle-source'] = true, ['entity-ghost'] = false}

--- Найти объект по ссылке; nil, если его нет.
function T.find(surface, ref)
  if type(ref) ~= 'table' then U.fail('bad_request', 'цель: ожидается {x, y, name?}, {player} или {agent}') end
  -- Человек или другой бот — по имени: их место команда знает, как игрок видит товарищей на карте.
  if ref.player ~= nil then
    local p = game.get_player(ref.player)
    local c = p and p.connected and p.character
    if c and c.valid and c.surface == surface then return c end
    return nil
  end
  if ref.agent ~= nil then
    local A = storage.agent.agents[ref.agent]
    local c = A and A.entity
    if c and c.valid and c.surface == surface then return c end
    return nil
  end
  if ref.unit and ref.x == nil then
    -- Движок находит по номеру не все виды построек: надёжная ссылка — координаты (номер можно приложить для сверки).
    local e = game.get_entity_by_unit_number(ref.unit)
    if e and e.valid and e.surface == surface then return e end
    return nil
  end
  if type(ref.x) ~= 'number' or type(ref.y) ~= 'number' then U.fail('bad_request', 'цель: нужны x и y (и, по желанию, name или unit)') end
  local list = surface.find_entities_filtered{position = {ref.x, ref.y}, name = ref.name}
  if #list == 0 then
    -- Точка может попасть в зазор между рамками; пробуем клетку целиком.
    local fx, fy = math.floor(ref.x), math.floor(ref.y)
    list = surface.find_entities_filtered{area = {{fx + 0.05, fy + 0.05}, {fx + 0.95, fy + 0.95}}, name = ref.name}
  end
  local best, rank = nil, 0
  if ref.unit then
    -- Номер приложен к координатам: это должен быть тот самый объект.
    for _, e in pairs(list) do if e.unit_number == ref.unit then return e end end
    return nil
  end
  for _, e in pairs(list) do
    local r
    if SKIP[e.type] then r = 0
    elseif e.type == 'resource' then r = 1
    elseif e.type == 'entity-ghost' or e.type == 'tile-ghost' then r = 2
    else r = 3 end
    if ref.name then r = r + 1 end
    if r > rank then best, rank = e, r end
  end
  return best
end

--- То же, но отсутствие объекта — ошибка not_found.
function T.get(surface, ref)
  local e = T.find(surface, ref)
  if not e then U.fail('not_found', 'объект не найден', {target = ref}) end
  return e
end

--- Краткое описание объекта для ответов.
function T.brief(e)
  local r = {name = e.name, x = U.r2(e.position.x), y = U.r2(e.position.y)}
  if e.unit_number then r.unit = e.unit_number end
  if e.type == 'entity-ghost' or e.type == 'tile-ghost' then r.ghost = e.ghost_name end
  return r
end

return T
