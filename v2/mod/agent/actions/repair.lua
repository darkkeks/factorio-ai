-- repair: починка построек ремкомплектом из инвентаря, в темпе игры.
-- Состояние ремонта движка (repair_state) у персонажа без игрока не работает, поэтому ремонт считается здесь
-- по правилу самой игры (замерено на стенде по строительному роботу): каждый тик прочность цели растёт на
-- «скорость комплекта × множитель ремонта постройки», а ресурс комплекта убывает на единицу.
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')
local Tour = require('agent.actions.tour')
local B = require('agent.actions.build')

local DEFAULT_TOOL = 'repair-pack'
local AREA_SIDE = 64    -- предел стороны области
local AREA_LIMIT = 200  -- предел числа целей из области

local function tool_stack(A, it)
  return A.entity.get_main_inventory().find_item_stack(it.quality and {name = it.item, quality = it.quality} or it.item)
end

local function tools_left(A, it)
  return A.entity.get_main_inventory().get_item_count(it.quality and {name = it.item, quality = it.quality} or it.item)
end

local function damaged(ent)
  return ent.is_entity_with_health and ent.health ~= nil and ent.health < ent.max_health
end

local function summary(A, it, extra)
  local ent = it.entity
  local r = extra or {}
  r.health, r.max_health = U.r2(ent.health), ent.max_health
  r.repaired = U.r2(ent.health - it.start_health)
  r.ticks = it.used
  r.tools_left = tools_left(A, it)
  return r
end

local function begin(A, it)
  local e, ent = A.entity, it.entity
  if not ent.valid then U.fail('not_found', 'объекта уже нет') end
  if ent.type == 'entity-ghost' or ent.type == 'tile-ghost' then U.fail('not_allowed', 'призрак чинить нечем: его надо построить') end
  if not ent.is_entity_with_health or ent.health == nil or ent.type == 'character' then U.fail('not_allowed', ent.name .. ' не чинится') end
  if ent.force ~= e.force then U.fail('not_allowed', 'чинить можно только постройки своей команды') end
  it.start_health, it.used = ent.health, 0
  if not damaged(ent) then return {already = true, health = U.r2(ent.health), max_health = ent.max_health, repaired = 0} end
  if (ent.prototype.repair_speed_modifier or 1) <= 0 then U.fail('not_allowed', ent.name .. ' не чинится ремкомплектом') end
  if not tool_stack(A, it) then U.fail('no_item', 'в инвентаре нет ' .. U.item_key(it.item, it.quality), {item = it.item}) end
  return nil
end

local function step(A, it)
  local e, ent = A.entity, it.entity
  if not ent.valid then U.fail('not_found', 'объект разрушен, пока его чинили') end
  if not damaged(ent) then return summary(A, it) end
  if not e.can_reach_entity(ent) then U.fail('out_of_reach', 'цель ушла из досягаемости', summary(A, it)) end
  local stack = tool_stack(A, it)
  if not stack then U.fail('no_item', 'ремкомплекты кончились', summary(A, it, {item = it.item})) end
  local rate = stack.prototype.speed * (ent.prototype.repair_speed_modifier or 1)
  ent.health = math.min(ent.max_health, ent.health + rate)
  stack.drain_durability(1)
  it.used = it.used + 1
  if not damaged(ent) then return summary(A, it) end
  return nil
end

local function check_ref(ref, where)
  if type(ref) ~= 'table' then U.fail('bad_request', where .. ': {x, y, name?} или {unit}') end
end

Q.register('repair', Tour.action{
  check = function(p)
    local n = (p.target and 1 or 0) + (p.targets and 1 or 0) + (p.area and 1 or 0)
    if n ~= 1 then U.fail('bad_request', 'нужно одно из: target (одна цель), targets (список целей), area (всё повреждённое в области)') end
    if p.target then check_ref(p.target, 'target') end
    if p.targets then
      if type(p.targets) ~= 'table' then U.fail('bad_request', 'targets: список целей') end
      for i, ref in ipairs(p.targets) do check_ref(ref, 'targets[' .. i .. ']') end
    end
    if p.area then
      local a = B.area_of(p)
      if a[2][1] - a[1][1] > AREA_SIDE or a[2][2] - a[1][2] > AREA_SIDE then
        U.fail('bad_request', 'area больше ' .. AREA_SIDE .. '×' .. AREA_SIDE .. ' клеток')
      end
    end
    local item = U.arg(p.item, 'string', 'item', true) or DEFAULT_TOOL
    local proto = prototypes.item[item]
    if not proto then U.fail('bad_request', 'нет такого предмета: ' .. item) end
    if proto.type ~= 'repair-tool' then U.fail('bad_request', item .. ' — не ремкомплект') end
    if p.quality ~= nil and (type(p.quality) ~= 'string' or not prototypes.quality[p.quality]) then U.fail('bad_request', 'нет такого качества') end
  end,
  items = function(A, p)
    local e = A.entity
    local item = p.item or DEFAULT_TOOL
    if p.target then return {{target = p.target, item = item, quality = p.quality}}, true end
    local list = {}
    if p.targets then
      for i, ref in ipairs(p.targets) do list[i] = {target = ref, item = item, quality = p.quality} end
      return list, false
    end
    -- Всё повреждённое своей команды в области (игрок видит полоски прочности на экране).
    for _, c in pairs(e.surface.find_entities_filtered{area = B.area_of(p), force = e.force}) do
      if c ~= e and c.type ~= 'character' and damaged(c) then
        list[#list + 1] = {entity = c, target = {x = c.position.x, y = c.position.y}, item = item, quality = p.quality}
        if #list >= AREA_LIMIT then break end
      end
    end
    return list, false
  end,
  point = function(A, it)
    if not it.entity then it.entity = T.get(A.entity.surface, it.target) end
    if not it.entity.valid then U.fail('not_found', 'объекта уже нет') end
    -- До чужого персонаж не «дотягивается» вовсе: отказываем сразу, а не идём к нему.
    if it.entity.force ~= A.entity.force then U.fail('not_allowed', 'чинить можно только постройки своей команды') end
    return it.entity.position, A.entity.reach_distance
  end,
  in_reach = function(A, it) return A.entity.can_reach_entity(it.entity) end,
  begin = begin,
  step = step,
  brief = function(it)
    local r = {}
    if it.entity and it.entity.valid then
      r.name = it.entity.name
      r.x, r.y = U.r2(it.entity.position.x), U.r2(it.entity.position.y)
    else
      r.x, r.y = it.target and it.target.x, it.target and it.target.y
    end
    return r
  end,
})
