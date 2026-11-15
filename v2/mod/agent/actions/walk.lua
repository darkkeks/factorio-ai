-- Ходьба: путь ищет встроенный поисковик игры (асинхронно), шаг делается каждый тик.
-- Никаких повторов и обходов: нет пути, упёрся, снесло с пути, ранили — действие сразу завершается с причиной.
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')

local W = {}

local ARRIVE = 0.25        -- точнее персонаж не останавливается: шаг за тик около 0,15 клетки
local WAYPOINT = 0.25      -- на таком расстоянии точка пути считается пройденной
local STUCK_TICKS = 60     -- нет продвижения к точке пути дольше секунды — упёрся
local OFF_PATH = 2         -- отклонение от пути в клетках
local PATH_RADIUS = 1       -- наименьший радиус цели для поисковика пути
local BUSY_RETRIES = 5     -- поисковик занят (это не «пути нет»): повторить запрос

local function request(A, act)
  local e, st = A.entity, act.st
  local proto = e.prototype
  st.req = e.surface.request_path{
    bounding_box = proto.collision_box,
    collision_mask = proto.collision_mask,
    start = e.position,
    goal = st.goal,
    force = e.force,
    -- Узлы поиска — центры клеток: до произвольной точки ближе 0,7 клетки узла может не быть.
    -- Поэтому поисковик ведёт на клетку рядом, а последний отрезок персонаж идёт прямо к цели.
    radius = math.max(st.radius, PATH_RADIUS),
    entity_to_ignore = e,
    can_open_gates = true,
    path_resolution_modifier = act.p.resolution or 0,
    -- cache = false: с кэшем движок отдаёт «дойти до недавнего чужого маршрута и идти по нему» — путь длиннее.
    pathfind_flags = {cache = false, prefer_straight_paths = true, no_break = false},
  }
  storage.agent.path_requests[st.req] = {agent = A.name, action = act.id}
end

local function report(A, act, extra)
  local st, pos = act.st, A.entity.position
  local r = {
    position = U.pos(pos),
    walked = U.r2(st.walked + U.dist(pos, st.last)),
    straight = U.r2(U.dist(st.from, st.goal)),
    path_length = st.path_len and U.r2(st.path_len) or nil,
    left = U.r2(U.dist(pos, st.goal)),
  }
  if act.p.return_path and st.path then
    r.path = {}
    for i, w in ipairs(st.path) do r.path[i] = {U.r2(w.x), U.r2(w.y)} end
  end
  if extra then for k, v in pairs(extra) do r[k] = v end end
  return r
end

function W.check(p)
  if p.target == nil then
    U.arg(p.x, 'number', 'x') U.arg(p.y, 'number', 'y')
  end
  U.arg(p.distance, 'number', 'distance', true)
  if p.resolution ~= nil and (type(p.resolution) ~= 'number' or p.resolution % 1 ~= 0 or p.resolution < -2 or p.resolution > 3) then
    U.fail('bad_request', 'resolution — целое от -2 до 3')
  end
end

function W.start(A, act)
  local e, p, st = A.entity, act.p, act.st
  if p.target then
    local t = T.get(e.surface, p.target)
    st.goal = {x = t.position.x, y = t.position.y}
    st.radius = math.max(p.distance or 2, ARRIVE)
  else
    st.goal = {x = p.x, y = p.y}
    st.radius = math.max(p.distance or 0, ARRIVE)
  end
  st.from = {x = e.position.x, y = e.position.y}
  st.last = st.from
  st.walked = 0
  st.hp = e.health
  if U.dist(st.from, st.goal) <= st.radius then return report(A, act, {already_there = true}) end
  if st.radius < PATH_RADIUS and e.surface.entity_prototype_collides('character', st.goal, false) then
    U.fail('no_path', 'в точке назначения нельзя стоять: она занята постройкой, водой или скалой', report(A, act))
  end
  st.tries = 0
  request(A, act)
  return nil
end

--- Ответ поисковика пути (on_script_path_request_finished).
function W.path_finished(ev)
  local reqs = storage.agent.path_requests
  local r = reqs[ev.id]
  if not r then return end
  reqs[ev.id] = nil
  local A = storage.agent.agents[r.agent]
  local act = A and A.queue[1]
  if not act or act.id ~= r.action or act.type ~= 'walk_to' or act.st.req ~= ev.id then return end
  local st = act.st
  st.req = nil
  if ev.path and #ev.path > 0 then
    local path, len, prev = {}, 0, st.from
    for i, w in ipairs(ev.path) do
      local q = {x = w.position.x, y = w.position.y}
      len = len + U.dist(prev, q)
      path[i] = q
      prev = q
    end
    st.path, st.i, st.path_len = path, 1, len
    st.best, st.best_tick = math.huge, game.tick
  elseif ev.try_again_later and st.tries < BUSY_RETRIES then
    st.tries = st.tries + 1
    st.retry_at = game.tick + 10
  elseif ev.try_again_later then
    st.error = {code = 'busy', message = 'поисковик пути игры занят, повтори позже'}
  else
    st.error = {code = 'no_path', message = 'пути нет: цель отрезана препятствиями или занята'}
  end
  Q.pump(A)
end

function W.tick(A, act)
  local e, st, p = A.entity, act.st, act.p
  local pos = e.position
  st.walked = st.walked + U.dist(pos, st.last)
  st.last = {x = pos.x, y = pos.y}
  if st.error then
    st.error.data = report(A, act)
    error(st.error, 0)
  end
  if p.stop_on_damage ~= false and e.health < st.hp - 0.001 then
    U.fail('damaged', 'персонаж получил урон, ходьба прервана', report(A, act, {health = U.r2(e.health)}))
  end
  st.hp = e.health
  if U.dist(pos, st.goal) <= st.radius then return report(A, act) end
  local path = st.path
  if not path then
    if st.retry_at and game.tick >= st.retry_at then
      st.retry_at = nil
      request(A, act)
    end
    return nil
  end
  -- Следующая точка пути; после последней идём прямо к цели.
  local prev = st.i > 1 and path[st.i - 1] or st.from
  local wp = path[st.i] or st.goal
  while st.i <= #path do
    local d, t = U.dist_segment(pos, prev, wp)
    if U.dist(pos, wp) <= WAYPOINT or t >= 1 then
      st.i = st.i + 1
      prev, wp = wp, path[st.i] or st.goal
      st.best, st.best_tick = math.huge, game.tick
    else
      break
    end
  end
  local off = U.dist_segment(pos, prev, wp)
  if off > OFF_PATH then
    U.fail('off_path', 'персонажа снесло с пути дальше 2 клеток', report(A, act, {off = U.r2(off)}))
  end
  local d = U.dist(pos, wp)
  if d < st.best - 0.02 then
    st.best, st.best_tick = d, game.tick
  elseif game.tick - st.best_tick > STUCK_TICKS then
    U.fail('stuck', 'упёрся: нет продвижения к следующей точке пути дольше секунды', report(A, act, {waypoint = U.pos(wp)}))
  end
  local angle = math.atan2(wp.x - pos.x, pos.y - wp.y) -- 0 — север, по часовой
  local dir = (math.floor(angle / (math.pi / 4) + 0.5) % 8) * 2
  e.walking_state = {walking = true, direction = dir}
  return nil
end

function W.stop(A, act)
  local e = A.entity
  e.walking_state = {walking = false, direction = e.walking_state.direction}
  if act.st and act.st.req then storage.agent.path_requests[act.st.req] = nil end
end

function W.progress(A, act)
  local st = act.st
  return {goal = U.pos(st.goal), left = U.r2(U.dist(A.entity.position, st.goal)), path = st.path and true or false}
end

Q.register('walk_to', W)
return W
