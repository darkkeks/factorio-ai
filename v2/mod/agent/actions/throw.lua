-- throw / stop_throwing: применить капсулу из инвентаря — как игрок, щёлкнувший ею по земле: гранаты, ядовитые
-- и замедляющие капсулы, боевые дроны, взрывчатка для скал; рыба — съесть. Сам бросок делает движок
-- (LuaItemStack.use_capsule: снаряд, урон, дроны, расход предмета), но дальность и перезарядку он при этом
-- не проверяет — их, как у игрока, соблюдает мод по прототипу капсулы (capsule_action.attack_parameters).
-- Тело бросок не занимает: команда исполняется в том же тике и не ждёт очереди действий. Серия (count) бросается
-- по одной капсуле за перезарядку; пока идёт перезарядка, новая команда ждёт её конца, а не отказывает.
local U = require('agent.util')
local Q = require('agent.queue')
local J = require('agent.journal')
local T = require('agent.target')
local Fog = require('agent.fog')

local Throw = {}
local MAX_COUNT = 20
local KINDS = {throw = true, ['use-on-self'] = true, ['destroy-cliffs'] = true}
local CLIFF_RADIUS = 2.5 -- взрывчатка без скалы рядом с точкой у игрока не применяется

local function ident(t)
  return t.quality and {name = t.item, quality = t.quality} or t.item
end

local function capsule(item)
  local proto = prototypes.item[item]
  local ca = proto and proto.capsule_action
  if not ca or not KINDS[ca.type] then return nil end
  local ap = ca.attack_parameters
  return {kind = ca.type, range = ap and ap.range or 0, cooldown = math.max(1, math.ceil(ap and ap.cooldown or 30))}
end

--- Куда бросать сейчас: точка и расстояние до неё; nil, reason — бросать нельзя.
local function aim(e, t, c)
  if c.kind == 'use-on-self' then
    if e.health >= e.max_health then return nil, 'full_health' end
    return e.position, 0
  end
  local p = t.at
  if t.target then
    if not t.target.valid then return nil, 'target_dead' end
    p = t.target.position
  end
  local d = U.dist(e.position, p)
  if d > c.range then return nil, 'out_of_range', d end
  if c.kind == 'destroy-cliffs' and e.surface.count_entities_filtered{type = 'cliff', position = p, radius = CLIFF_RADIUS, limit = 1} == 0 then
    return nil, 'no_cliff'
  end
  return p, d
end

--- Закончить серию; событие throw_done — если итог не ушёл ботом прямо в ответе на команду.
local function finish(A, reason, silent)
  local t, e = A.throw, A.entity
  if not t then return nil end
  A.throw = nil
  storage.agent.throwing[A.name] = nil
  local r = {reason = reason, action_id = t.id, item = U.item_key(t.item, t.quality), thrown = t.thrown, count = t.count}
  if e and e.valid then
    r.left = e.get_main_inventory().get_item_count(ident(t))
    r.health = U.r2(e.health)
    r.position = U.pos(e.position)
  end
  if not silent then J.add('throw_done', A.name, r) end
  return r
end
Throw.stop = finish

--- Каждый тик, пока серия не кончилась: перезарядка прошла — бросить следующую капсулу.
function Throw.tick(A, silent)
  local t, e = A.throw, A.entity
  if not t then storage.agent.throwing[A.name] = nil return end
  if not (e and e.valid) then return finish(A, 'died', silent) end
  if game.tick < (A.throw_ready or 0) then return nil end
  local c = capsule(t.item)
  if not c then return finish(A, 'no_item', silent) end
  local p, why = aim(e, t, c)
  if not p then return finish(A, why, silent) end
  local stack = e.get_main_inventory().find_item_stack(ident(t))
  if not stack then return finish(A, 'no_item', silent) end
  stack.use_capsule(e, p)
  A.throw_ready = game.tick + c.cooldown
  t.thrown = t.thrown + 1
  if t.thrown >= t.count then return finish(A, 'done', silent) end
  return nil
end

--- Для status: идущая серия бросков.
function Throw.view(A)
  local t = A.throw
  if not t then return nil end
  return {item = U.item_key(t.item, t.quality), action_id = t.id, thrown = t.thrown, count = t.count,
    next_in_ticks = math.max(0, (A.throw_ready or 0) - game.tick),
    target = t.target and t.target.valid and T.brief(t.target) or nil, at = t.at}
end

Q.register('throw', {
  instant = true, free = true, -- тело не занимает: исполняется сразу, даже когда персонаж идёт или строит
  check = function(p)
    local item = U.arg(p.item, 'string', 'item')
    if not prototypes.item[item] then U.fail('bad_request', 'нет такого предмета: ' .. item) end
    local c = capsule(item)
    if not c then U.fail('bad_request', item .. ' — не капсула, которую бросают или применяют на себя (гранаты, капсулы, дроны, cliff-explosives, raw-fish)') end
    if p.quality ~= nil and (type(p.quality) ~= 'string' or not prototypes.quality[p.quality]) then U.fail('bad_request', 'нет такого качества') end
    if p.target ~= nil and type(p.target) ~= 'table' then U.fail('bad_request', 'target: объект {x, y, name?}') end
    if p.at ~= nil then
      if type(p.at) ~= 'table' then U.fail('bad_request', 'at: точка {x, y}') end
      U.arg(p.at.x, 'number', 'at.x')
      U.arg(p.at.y, 'number', 'at.y')
    end
    if p.target ~= nil and p.at ~= nil then U.fail('bad_request', 'либо target, либо at') end
    if c.kind ~= 'use-on-self' and p.target == nil and p.at == nil then U.fail('bad_request', 'куда бросать: at {x, y} или target {x, y, name?}') end
    U.arg(p.count, 'int', 'count', true)
    if p.count and (p.count < 1 or p.count > MAX_COUNT) then U.fail('bad_request', 'count: 1…' .. MAX_COUNT) end
  end,
  start = function(A, act)
    local p, e = act.p, A.entity
    local c = capsule(p.item)
    local t = {item = p.item, quality = p.quality, count = p.count or 1, thrown = 0, id = act.id}
    local key = U.item_key(p.item, p.quality)
    local have = e.get_main_inventory().get_item_count(ident(t))
    if have == 0 then U.fail('no_item', 'в инвентаре нет ' .. key, {item = p.item}) end
    if c.kind ~= 'use-on-self' then
      if p.target then
        local x = T.get(e.surface, p.target)
        if Fog.state(x.surface, e.force, x.position.x, x.position.y) ~= 'visible' then
          U.fail('not_visible', 'цель скрыта туманом войны', {target = p.target})
        end
        t.target = x
      else
        t.at = {x = p.at.x, y = p.at.y}
      end
    end
    local pos, why, d = aim(e, t, c)
    if not pos then
      if why == 'out_of_range' then
        U.fail('out_of_range', 'дальше дальности броска: подойди ближе', {range = U.r2(c.range), distance = U.r2(d)})
      elseif why == 'no_cliff' then
        U.fail('not_found', 'рядом с точкой нет скалы (cliff)', {at = t.at})
      elseif why == 'full_health' then
        U.fail('not_allowed', 'здоровье полное: лечиться нечем', {health = U.r2(e.health)})
      end
      U.fail('not_found', 'цель не найдена', {target = p.target})
    end
    local r = {item = key, kind = c.kind, range = U.r2(c.range), cooldown_ticks = c.cooldown, count = t.count}
    if c.kind ~= 'use-on-self' then
      r.at, r.distance = U.pos(pos), U.r2(why)
      if t.target then r.target = T.brief(t.target) end
    end
    local replaced = A.throw and finish(A, 'replaced') -- новая команда сменяет недобросанную серию
    A.throw = t
    storage.agent.throwing[A.name] = true
    if game.tick_paused then game.tick_paused = false end
    local fin = Throw.tick(A, true) -- перезарядки нет — первая капсула летит уже в этом тике
    r.thrown = fin and fin.thrown or t.thrown
    if fin then
      r.done, r.reason = true, fin.reason
    else
      r.done = false
      r.next_in_ticks = math.max(0, (A.throw_ready or 0) - game.tick)
    end
    r.left = e.get_main_inventory().get_item_count(ident(t))
    r.health = c.kind == 'use-on-self' and U.r2(e.health) or nil
    r.replaced = replaced and replaced.action_id or nil
    return r
  end,
})

Q.register('stop_throwing', {
  instant = true, free = true,
  check = function() end,
  start = function(A)
    if not A.throw then return {throwing = false, already = true} end
    local r = finish(A, 'stopped')
    r.throwing = false
    return r
  end,
})

return Throw
