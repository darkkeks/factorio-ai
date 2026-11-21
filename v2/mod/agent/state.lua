-- Состояние исполнителя в storage.agent и персонажи.
-- При замене сценария в существующем сохранении игра не вызывает ни on_init, ни on_configuration_changed,
-- поэтому состояние создаётся и обновляется лениво: ensure() стоит в начале каждого обработчика.
local U = require('agent.util')
local J = require('agent.journal')
local Plans = require('agent.plans')
local Fog = require('agent.fog')
local BP = require('agent.blueprints')
local Gui = require('agent.gui')
local Legacy = require('agent.legacy')
local Trig = require('agent.triggers')

local S = {}
S.VERSION = 12
S.REPLIES = 512 -- сколько ответов с идентификатором хранить на персонажа

local LABEL_COLOR = {1, 0.8, 0.2}

local function new_agent(name)
  return {
    name = name,
    queue = {},          -- действия; [1] — текущее
    next_action = 1,
    replies = {map = {}, order = {}, head = 1, tail = 0},
    seen = game.tick,    -- тик последнего запроса бота (для cancel_if_silent_s)
    seen_at = storage.agent and storage.agent.now, -- то же по часам сторожа паузы (правило паузы)
    kit = false,         -- выдан ли стартовый набор
    deaths = 0,
  }
end

local function draw_label(A)
  local e = A.entity
  -- Подписи старой системы привязаны к той же сущности: убираем, чтобы имя не двоилось.
  for _, o in pairs(rendering.get_all_objects()) do
    if o.valid and o.type == 'text' then
      local t = o.target
      if t and t.entity and t.entity == e then o.destroy() end
    end
  end
  A.label = rendering.draw_text{text = A.name, target = {entity = e, offset = {0, -2.6}}, surface = e.surface,
    color = LABEL_COLOR, alignment = 'center', scale = 1.3}
  A.label2 = nil
end

--- Привязать сущность персонажа к записи бота.
function S.attach(A, e)
  local st = storage.agent
  if A.unit then st.by_unit[A.unit] = nil end
  A.entity = e
  A.unit = e.unit_number
  st.by_unit[A.unit] = A.name
  -- Зеркало для веб-карты и хозяина сессий: они читают storage.vb (имя → сущность).
  storage.vb = storage.vb or {}
  storage.vb[A.name] = e
  draw_label(A)
end

--- Создать персонажа у точки возрождения. Стартовый набор — как у игрока свободной игры, один раз на имя.
function S.spawn(A)
  local surface = game.surfaces.nauvis
  local force = game.forces.player
  local pos = surface.find_non_colliding_position('character', force.get_spawn_position(surface), 40, 0.5)
  if not pos then U.fail('blocked', 'нет свободного места у точки возрождения') end
  local e = surface.create_entity{name = 'character', position = pos, force = force}
  if not e then U.fail('internal', 'не удалось создать персонажа') end
  S.attach(A, e)
  if not A.kit then
    A.kit = true
    for name, count in pairs(storage.created_items or {['iron-plate'] = 8, wood = 1, ['burner-mining-drill'] = 1, ['stone-furnace'] = 1}) do
      e.insert{name = name, count = count}
    end
  end
  return e
end

-- Возрождение после гибели — как у игрока в сетевой игре: не сразу, а через время возрождения из прототипа
-- персонажа (10 секунд), само, у точки возрождения команды. Пока A.dead задан, персонажа в мире нет.
function S.respawn_ticks()
  local t = prototypes.entity.character.respawn_time -- в секундах
  return (t and t > 0) and t * 60 or 600
end

--- Погибший: запомнить, когда возродится. Сам персонаж появится в S.respawn (по тику или при запросе бота).
function S.died(A, where)
  local now = game.tick
  A.dead = {tick = now, respawn_tick = now + S.respawn_ticks(), position = where}
  storage.agent.dead[A.name] = true
  if storage.vb then storage.vb[A.name] = nil end
end

--- Возродить погибшего, если время вышло. Нет места у точки возрождения — повтор через секунду.
function S.respawn(A)
  local d = A.dead
  if not d or game.tick < d.respawn_tick then return false end
  local ok = pcall(S.spawn, A)
  if not ok then
    d.respawn_tick = game.tick + 60
    return false
  end
  A.dead = nil
  storage.agent.dead[A.name] = nil
  J.add('agent_respawned', A.name, {position = U.pos(A.entity.position), died_position = d.position, dead_ticks = game.tick - d.tick})
  return true
end

--- Сколько тиков до возрождения (0 — вот-вот).
function S.respawn_in(A)
  return math.max(0, A.dead.respawn_tick - game.tick)
end

--- Запись бота по имени; create — завести нового («первое обращение токена»).
function S.agent(name, create)
  local st = storage.agent
  local A = st.agents[name]
  if not A then
    if not create then return nil end
    A = new_agent(name)
    st.agents[name] = A
    J.add('agent_created', nil, {name = name})
  end
  -- Вышедшего из игры (logout) не возрождаем: его персонаж цел и ждёт на скрытой поверхности.
  -- Погибший возрождается по времени (S.respawn), а не по запросу.
  if not A.offline and not A.dead and not (A.entity and A.entity.valid) then S.spawn(A) end
  return A
end

--- Запомнить ответ на запрос с идентификатором.
function S.remember(A, id, json)
  local r = A.replies
  if r.map[id] == nil then
    r.tail = r.tail + 1
    r.order[r.tail] = id
    while r.tail - r.head + 1 > S.REPLIES do
      r.map[r.order[r.head]] = nil
      r.order[r.head] = nil
      r.head = r.head + 1
    end
  end
  r.map[id] = json
end

-- Приём персонажей старой системы (storage.vb: имя → сущность) с инвентарём и позицией.
local function adopt_legacy(st)
  local kit = storage.vb_kit or {}
  for name, e in pairs(storage.vb or {}) do
    if not st.agents[name] then
      local A = new_agent(name)
      A.kit = kit[name] and true or false
      st.agents[name] = A
      if e.valid then
        e.walking_state = {walking = false, direction = e.walking_state.direction}
        e.character_running_speed_modifier = 0 -- старая ходьба подгоняла скорость под шаг
        S.attach(A, e)
      end
    end
  end
  -- Служебное состояние старой ходьбы, сноса и постройки новой системе не нужно.
  for _, k in pairs{'vb_until', 'vb_path', 'vb_dm', 'vb_pm', 'vb_rot', 'vb_ev', 'vb_dead'} do storage[k] = nil end
end

function S.ensure()
  local st = storage.agent
  if st and st.version == S.VERSION then return st end
  st = st or {}
  storage.agent = st
  st.agents = st.agents or {}
  st.by_unit = st.by_unit or {}
  st.active = st.active or {}          -- имена ботов с непустой очередью
  st.crafting = st.crafting or {}      -- имена ботов с непустой очередью ручного крафта
  st.firing = st.firing or {}          -- имена ботов, у которых зажат огонь (actions/shoot.lua)
  st.throwing = st.throwing or {}      -- имена ботов с недобросанной серией капсул (actions/throw.lua)
  st.dead = st.dead or {}              -- имена погибших ботов, ждущих возрождения
  st.path_requests = st.path_requests or {}
  J.init(st)
  Plans.init(st)
  Fog.init(st)
  BP.init(st)
  Gui.init(st)
  Trig.init(st)
  Gui.setup_players()
  if not st.legacy then
    st.legacy = 1
    adopt_legacy(st)
  end
  if not st.legacy_plans then
    st.legacy_plans = true
    Legacy.plans(st)
  end
  st.version = S.VERSION
  return st
end

return S
