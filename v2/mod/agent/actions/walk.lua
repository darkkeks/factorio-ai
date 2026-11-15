-- Ходьба: путь ищет встроенный поисковик игры (асинхронно), шаг делается каждый тик.
-- Никаких повторов и обходов: нет пути, упёрся, снесло с пути, ранили — ходьба сразу завершается с причиной.
-- «Шагатель» (walker) — состояние одной ходьбы; им пользуются действие walk_to и пакеты с подходом (tour.lua).
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')

local W = {}

local ARRIVE = 0.25        -- точнее персонаж не останавливается: шаг за тик около 0,15 клетки
local WAYPOINT = 0.25      -- на таком расстоянии точка пути считается пройденной
local STUCK_TICKS = 60     -- нет продвижения к точке пути дольше секунды — упёрся
local OFF_PATH = 2         -- отклонение от пути в клетках
local PATH_RADIUS = 1      -- наименьший радиус цели для поисковика пути
local PATH_WAIT = 300      -- тиков ждём ответа поисковика, прежде чем спросить заново
local BUSY_RETRIES = 5     -- поисковик занят (это не «пути нет»): повторить запрос
W.ARRIVE = ARRIVE

local function request(A, act, w)
  local e = A.entity
  local proto = e.prototype
  w.req = e.surface.request_path{
    bounding_box = proto.collision_box,
    collision_mask = proto.collision_mask,
    start = e.position,
    goal = w.goal,
    force = e.force,
    -- Узлы поиска — центры клеток: до произвольной точки ближе 0,7 клетки узла может не быть.
    -- Поэтому поисковик ведёт на клетку рядом, а последний отрезок персонаж идёт прямо к цели.
    radius = math.max(w.radius, PATH_RADIUS),
    entity_to_ignore = e,
    can_open_gates = true,
    path_resolution_modifier = w.resolution or 0,
    -- cache = false: с кэшем движок отдаёт «дойти до недавнего чужого маршрута и идти по нему» — путь длиннее.
    pathfind_flags = {cache = false, prefer_straight_paths = true, no_break = false},
  }
  w.req_tick = game.tick
  storage.agent.path_requests[w.req] = {agent = A.name, action = act.id}
end

--- Отчёт о ходьбе: где стоит, сколько пройдено, по прямой, длина найденного пути, сколько осталось.
function W.report(A, w, extra)
  local pos = A.entity.position
  local r = {
    position = U.pos(pos),
    walked = U.r2(w.walked + U.dist(pos, w.last)),
    straight = U.r2(U.dist(w.from, w.goal)),
    path_length = w.path_len and U.r2(w.path_len) or nil,
    left = U.r2(U.dist(pos, w.goal)),
  }
  if w.return_path and w.path then
    r.path = {}
    for i, q in ipairs(w.path) do r.path[i] = {U.r2(q.x), U.r2(q.y)} end
  end
  if extra then for k, v in pairs(extra) do r[k] = v end end
  return r
end

--- Начать ходьбу к точке goal с остановкой на расстоянии radius. Возвращает шагатель;
--- w.done = true, если персонаж уже на месте. Ошибка no_path — если в точке нельзя стоять.
function W.new(A, act, goal, radius, opts)
  local e = A.entity
  opts = opts or {}
  local w = {
    goal = {x = goal.x, y = goal.y},
    radius = math.max(radius or 0, ARRIVE),
    from = {x = e.position.x, y = e.position.y},
    walked = 0,
    hp = e.health,
    tries = 0,
    resolution = opts.resolution,
    stop_on_damage = opts.stop_on_damage ~= false,
    return_path = opts.return_path,
  }
  w.last = w.from
  if U.dist(w.from, w.goal) <= w.radius then
    w.done = true
    return w
  end
  if w.radius < PATH_RADIUS and e.surface.entity_prototype_collides('character', w.goal, false) then
    U.fail('no_path', 'в точке назначения нельзя стоять: она занята постройкой, водой или скалой', W.report(A, w))
  end
  request(A, act, w)
  return w
end

--- Ответ поисковика пути (on_script_path_request_finished).
function W.path_finished(ev)
  local reqs = storage.agent.path_requests
  local r = reqs[ev.id]
  if not r then return end
  reqs[ev.id] = nil
  local A = storage.agent.agents[r.agent]
  local act = A and A.queue[1]
  local w = act and act.id == r.action and act.st and act.st.w
  if not w or w.req ~= ev.id then return end
  w.req = nil
  if ev.path and #ev.path > 0 then
    local path, len, prev = {}, 0, w.from
    for i, p in ipairs(ev.path) do
      local q = {x = p.position.x, y = p.position.y}
      len = len + U.dist(prev, q)
      path[i] = q
      prev = q
    end
    w.path, w.i, w.path_len = path, 1, len
    w.best, w.best_tick = math.huge, game.tick
  elseif ev.try_again_later and w.tries < BUSY_RETRIES then
    w.tries = w.tries + 1
    w.retry_at = game.tick + 10
  elseif ev.try_again_later then
    w.error = {code = 'busy', message = 'поисковик пути игры занят, повтори позже'}
  else
    w.error = {code = 'no_path', message = 'пути нет: цель отрезана препятствиями или занята'}
  end
  Q.pump(A)
end

--- Один тик ходьбы. Возвращает true, когда персонаж дошёл; nil — идёт дальше; ошибка — U.fail.
function W.step(A, act, w)
  local e = A.entity
  local pos = e.position
  w.walked = w.walked + U.dist(pos, w.last)
  w.last = {x = pos.x, y = pos.y}
  if w.error then
    w.error.data = W.report(A, w)
    error(w.error, 0)
  end
  if w.stop_on_damage and e.health < w.hp - 0.001 then
    U.fail('damaged', 'персонаж получил урон, ходьба прервана', W.report(A, w, {health = U.r2(e.health)}))
  end
  w.hp = e.health
  if U.dist(pos, w.goal) <= w.radius then
    W.halt(A, w)
    return true
  end
  local path = w.path
  if not path then
    if w.retry_at and game.tick >= w.retry_at then
      w.retry_at = nil
      request(A, act, w)
    elseif w.req and game.tick - (w.req_tick or 0) > PATH_WAIT then
      -- Ответ поисковика не пришёл (так бывает, если игру сохранили и загрузили, пока он считал): спрашиваем заново.
      storage.agent.path_requests[w.req] = nil
      w.req = nil
      w.tries = w.tries + 1
      if w.tries > BUSY_RETRIES then U.fail('busy', 'поисковик пути игры не отвечает, повтори позже', W.report(A, w)) end
      request(A, act, w)
    end
    return nil
  end
  -- Следующая точка пути; после последней идём прямо к цели.
  local prev = w.i > 1 and path[w.i - 1] or w.from
  local wp = path[w.i] or w.goal
  while w.i <= #path do
    local _, t = U.dist_segment(pos, prev, wp)
    if U.dist(pos, wp) <= WAYPOINT or t >= 1 then
      w.i = w.i + 1
      prev, wp = wp, path[w.i] or w.goal
      w.best, w.best_tick = math.huge, game.tick
    else
      break
    end
  end
  local off = U.dist_segment(pos, prev, wp)
  if off > OFF_PATH then
    U.fail('off_path', 'персонажа снесло с пути дальше 2 клеток', W.report(A, w, {off = U.r2(off)}))
  end
  local d = U.dist(pos, wp)
  if d < w.best - 0.02 then
    w.best, w.best_tick = d, game.tick
  elseif game.tick - w.best_tick > STUCK_TICKS then
    U.fail('stuck', 'упёрся: нет продвижения к следующей точке пути дольше секунды', W.report(A, w, {waypoint = U.pos(wp)}))
  end
  local angle = math.atan2(wp.x - pos.x, pos.y - wp.y) -- 0 — север, по часовой
  local dir = (math.floor(angle / (math.pi / 4) + 0.5) % 8) * 2
  e.walking_state = {walking = true, direction = dir}
  return nil
end

--- Остановить персонажа и забыть запрос пути.
function W.halt(A, w)
  local e = A.entity
  if e and e.valid then e.walking_state = {walking = false, direction = e.walking_state.direction} end
  if w and w.req then
    storage.agent.path_requests[w.req] = nil
    w.req = nil
  end
end

-- ── Действие walk_to ──
local action = {}

function action.check(p)
  if p.target == nil then
    U.arg(p.x, 'number', 'x') U.arg(p.y, 'number', 'y')
  end
  U.arg(p.distance, 'number', 'distance', true)
  if p.resolution ~= nil and (type(p.resolution) ~= 'number' or p.resolution % 1 ~= 0 or p.resolution < -2 or p.resolution > 3) then
    U.fail('bad_request', 'resolution — целое от -2 до 3')
  end
end

function action.start(A, act)
  local e, p = A.entity, act.p
  local goal, radius
  if p.target then
    local t = T.get(e.surface, p.target)
    goal, radius = t.position, p.distance or 2
  else
    goal, radius = {x = p.x, y = p.y}, p.distance or 0
  end
  local w = W.new(A, act, goal, radius, p)
  act.st.w = w
  if w.done then return W.report(A, w, {already_there = true}) end
  return nil
end

function action.tick(A, act)
  local w = act.st.w
  if W.step(A, act, w) then return W.report(A, w) end
  return nil
end

function action.stop(A, act)
  W.halt(A, act.st and act.st.w)
end

function action.progress(A, act)
  local w = act.st.w
  return {goal = U.pos(w.goal), left = U.r2(U.dist(A.entity.position, w.goal)), path = w.path and true or false}
end

Q.register('walk_to', action)
return W
