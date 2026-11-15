-- Туман войны для ботов.
--   видно вживую  — чанк виден команде (радары, люди) или в пределах обзора персонажа-бота: полные данные;
--   открыто       — чанк есть на карте, но сейчас не виден: только то, что было при последнем обновлении карты;
--   не открыто    — неизвестно.
-- Персонаж без игрока сам карту не открывает и обзора не даёт (проверено на 2.1.24), поэтому мод открывает
-- карту вокруг бота так же, как игра вокруг игрока: квадрат 5×5 чанков, — и считает эту зону видимой.
-- Снимков карты движок не хранит. «Память карты» ведётся так: для чанков без обзора записывается, что построено
-- и что исчезло с последнего обновления карты; при ответе построенное скрывается, исчезнувшее показывается.
local Fog = {}

local VISION = 2          -- чанков в каждую сторону от чанка персонажа
local RECHART_TICKS = 300 -- как часто обновлять карту вокруг стоящего бота

function Fog.init(st)
  st.fog = st.fog or {mem = {}, seen = {}}
end

local function key(surface_index, cx, cy) return surface_index .. ':' .. cx .. ':' .. cy end

-- Чанки, где стоят боты (на данной поверхности).
local function viewers(surface)
  local out = {}
  for _, A in pairs(storage.agent.agents) do
    local e = A.entity
    if e and e.valid and e.surface == surface then
      out[#out + 1] = {math.floor(e.position.x / 32), math.floor(e.position.y / 32)}
    end
  end
  return out
end

--- Функция visible(cx, cy) для серии проверок на одной поверхности (с кэшем по чанкам).
function Fog.viewer(surface, force)
  local vs = viewers(surface)
  local cache = {}
  return function(cx, cy)
    local k = cx * 65536 + cy
    local v = cache[k]
    if v == nil then
      v = force.is_chunk_visible(surface, {cx, cy})
      if not v then
        for _, c in ipairs(vs) do
          if math.abs(c[1] - cx) <= VISION and math.abs(c[2] - cy) <= VISION then v = true break end
        end
      end
      cache[k] = v
    end
    return v
  end
end

--- Состояние точки: 'visible' | 'charted' | 'unknown'.
function Fog.state(surface, force, x, y, visible)
  local cx, cy = math.floor(x / 32), math.floor(y / 32)
  visible = visible or Fog.viewer(surface, force)
  if visible(cx, cy) then return 'visible' end
  if force.is_chunk_charted(surface, {cx, cy}) then return 'charted' end
  return 'unknown'
end

--- Вся ли область открыта на карте.
function Fog.area_charted(surface, force, area)
  local visible = Fog.viewer(surface, force)
  for cx = math.floor(area[1][1] / 32), math.floor((area[2][1] - 0.001) / 32) do
    for cy = math.floor(area[1][2] / 32), math.floor((area[2][2] - 0.001) / 32) do
      if not visible(cx, cy) and not force.is_chunk_charted(surface, {cx, cy}) then return false end
    end
  end
  return true
end

--- Память чанка: {added = {номер → true}, removed = {…}} или nil, если с последнего обновления карты ничего не менялось.
function Fog.memory(surface, cx, cy)
  return storage.agent.fog.mem[key(surface.index, cx, cy)]
end

-- Постройка команды появилась или исчезла. В чанке без обзора это меняет «память карты».
local function changed(e, appeared)
  if not (e and e.valid) or e.force.name ~= 'player' or not e.unit_number then return end
  if e.type == 'character' or e.type == 'entity-ghost' or e.type == 'tile-ghost' then return end
  local surface = e.surface
  local cx, cy = math.floor(e.position.x / 32), math.floor(e.position.y / 32)
  local force = e.force
  if force.is_chunk_visible(surface, {cx, cy}) then return end
  for _, c in ipairs(viewers(surface)) do
    if math.abs(c[1] - cx) <= VISION and math.abs(c[2] - cy) <= VISION then return end
  end
  local mem = storage.agent.fog.mem
  local k = key(surface.index, cx, cy)
  local m = mem[k]
  if not m then
    m = {added = {}, removed = {}}
    mem[k] = m
  end
  if appeared then
    m.added[e.unit_number] = true
  elseif m.added[e.unit_number] then
    m.added[e.unit_number] = nil -- появилось и исчезло, пока никто не видел: на карте этого не было
  else
    m.removed[#m.removed + 1] = {name = e.name, type = e.type, x = e.position.x, y = e.position.y,
      direction = e.supports_direction and e.direction or nil, unit = e.unit_number}
  end
end

Fog.handlers = {}
local function appeared(ev) changed(ev.entity or ev.destination, true) end
local function vanished(ev) changed(ev.entity, false) end
Fog.handlers[defines.events.on_built_entity] = appeared
Fog.handlers[defines.events.on_robot_built_entity] = appeared
Fog.handlers[defines.events.script_raised_built] = appeared
Fog.handlers[defines.events.script_raised_revive] = appeared
Fog.handlers[defines.events.on_entity_died] = vanished
Fog.handlers[defines.events.on_player_mined_entity] = vanished
Fog.handlers[defines.events.on_robot_mined_entity] = vanished
Fog.handlers[defines.events.script_raised_destroy] = vanished
-- Карта чанка обновилась (радар, игрок, бот): память больше не нужна.
Fog.handlers[defines.events.on_chunk_charted] = function(ev)
  storage.agent.fog.mem[key(ev.surface_index, ev.position.x, ev.position.y)] = nil
end

--- Раз в секунду: открыть карту вокруг ботов (при смене чанка и изредка — чтобы карта не устаревала).
function Fog.tick(tick)
  local st = storage.agent
  local seen = st.fog.seen
  for name, A in pairs(st.agents) do
    local e = A.entity
    if e and e.valid then
      local cx, cy = math.floor(e.position.x / 32), math.floor(e.position.y / 32)
      local s = seen[name]
      if not s or s.cx ~= cx or s.cy ~= cy or s.surface ~= e.surface.index or tick - s.tick >= RECHART_TICKS then
        seen[name] = {cx = cx, cy = cy, surface = e.surface.index, tick = tick}
        e.force.chart(e.surface, {{(cx - VISION) * 32, (cy - VISION) * 32}, {(cx + VISION + 1) * 32 - 1, (cy + VISION + 1) * 32 - 1}})
      end
    end
  end
  -- Память чанков, которые снова видны, больше не нужна.
  if tick % 600 == 0 then
    local force = game.forces.player
    for k in pairs(st.fog.mem) do
      local si, cx, cy = k:match('^(%d+):(-?%d+):(-?%d+)$')
      local surface = game.get_surface(tonumber(si))
      if not surface or force.is_chunk_visible(surface, {tonumber(cx), tonumber(cy)}) then st.fog.mem[k] = nil end
    end
  end
end

return Fog
