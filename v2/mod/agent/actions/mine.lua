-- mine: добыча ресурса, дерева, камня и снятие построек — состоянием добычи самого движка
-- (время добычи, продукты и содержимое постройки в инвентарь считает игра).
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')
local Tour = require('agent.actions.tour')
local Plans = require('agent.plans')
local B = require('agent.actions.build')
local E = require('agent.events')
local J = require('agent.journal')

local IDLE_LIMIT = 90   -- тиков без добычи, после которых разбираемся, почему движок её остановил
local STALL_LIMIT = 300 -- тиков без единого добытого предмета (ни один ресурс руками не добывается так долго)

-- Сколько у персонажа продуктов добычи этого объекта (руда, дерево, камень). Считаем именно их:
-- общий счёт инвентаря сбивает идущий параллельно ручной крафт.
local function product_count(e, it)
  local n = 0
  local inv = e.get_main_inventory()
  for name in pairs(it.products) do n = n + inv.get_item_count(name) end
  return n
end

local function stop_mining(e)
  if e.valid then
    e.mining_state = {mining = false}
    e.selected = nil
  end
end

local function begin(A, it)
  local e, ent = A.entity, it.entity
  if not ent.valid then U.fail('not_found', 'объекта уже нет') end
  if ent.type == 'entity-ghost' or ent.type == 'tile-ghost' then
    -- Призрак снимается сразу, как у игрока.
    local name = ent.ghost_name
    Plans.forget(ent)
    ent.destroy{raise_destroy = true}
    return {name = name, ghost = true, gone = true}
  end
  if ent.force ~= e.force and ent.force.name ~= 'neutral' then U.fail('not_allowed', 'это объект чужой команды') end
  if not ent.minable then U.fail('not_allowed', ent.name .. ' нельзя добыть или снять') end
  it.name = ent.name
  it.resource = ent.type == 'resource'
  if ent.force == e.force and ent.unit_number then E.tally('entities_removed', A.name, ent) end
  it.products = {}
  for _, pr in pairs(ent.prototype.mineable_properties.products or {}) do
    if pr.type == 'item' then it.products[pr.name] = true end
  end
  it.start_total = product_count(e, it)
  it.start_tick = game.tick
  it.last_gain = game.tick
  it.last_total = it.start_total
  it.idle = 0
  if it.resource then it.want = it.count or 1 end
  e.selected = ent
  e.mining_state = {mining = true, position = ent.position}
  return nil
end

local function step(A, it)
  local e, ent = A.entity, it.entity
  local total = product_count(e, it)
  if total > it.last_total then
    it.last_gain = game.tick
    it.last_total = total
  end
  local gained = total - it.start_total
  if not ent.valid then
    stop_mining(e)
    return {name = it.name, gone = true, gained = gained}
  end
  if it.resource and gained >= it.want then
    stop_mining(e)
    return {name = it.name, gained = gained, amount_left = ent.amount}
  end
  if e.mining_state.mining then
    it.idle = 0
  else
    it.idle = it.idle + 1
    if it.idle > IDLE_LIMIT then
      stop_mining(e)
      local d = U.dist(e.position, ent.position)
      if it.resource and d > e.resource_reach_distance then
        U.fail('out_of_reach', 'до ресурса не дотянуться: дальность добычи ' .. U.r2(e.resource_reach_distance), {distance = U.r2(d), gained = gained})
      end
      if e.get_main_inventory().count_empty_stacks() == 0 then
        J.add('inventory_full', A.name, {})
        U.fail('no_space', 'инвентарь полон', {gained = gained})
      end
      U.fail('not_allowed', 'игра не даёт это добыть руками (нужна жидкость, инструмент или объект не добывается)', {gained = gained})
    end
    e.selected = ent
    e.mining_state = {mining = true, position = ent.position}
  end
  if game.tick - it.last_gain > STALL_LIMIT then
    stop_mining(e)
    U.fail('stuck', 'добыча не продвигается', {gained = gained})
  end
  return nil
end

local function point(A, it)
  local e = A.entity
  if not it.entity then it.entity = T.get(e.surface, it.target) end
  if not it.entity.valid then
    if it.name then return e.position, 1 end -- уже добыт: step вернёт итог
    U.fail('not_found', 'объекта уже нет')
  end
  if it.entity.type == 'resource' then return it.entity.position, e.resource_reach_distance end
  return it.entity.position, e.reach_distance
end

local function in_reach(A, it)
  local e, ent = A.entity, it.entity
  if not ent.valid then return true end
  if ent.type == 'resource' then return U.dist(e.position, ent.position) <= e.resource_reach_distance end
  if ent.type == 'entity-ghost' or ent.type == 'tile-ghost' then return true end -- призрак снимается и с карты
  return e.can_reach_entity(ent)
end

Q.register('mine', Tour.action{
  check = function(p)
    local n = (p.target and 1 or 0) + (p.targets and 1 or 0) + ((p.marked or p.plan) and 1 or 0)
    if n ~= 1 then U.fail('bad_request', 'нужно одно из: target (одна цель), targets (список целей), marked: true с area или plan (помеченное на снос)') end
    if p.target and type(p.target) ~= 'table' then U.fail('bad_request', 'target: {unit} или {x, y, name?}') end
    if p.targets and type(p.targets) ~= 'table' then U.fail('bad_request', 'targets: список целей') end
    if p.count ~= nil and (type(p.count) ~= 'number' or p.count % 1 ~= 0 or p.count < 1) then U.fail('bad_request', 'count: целое от 1') end
    if p.marked and not p.area and not p.plan then U.fail('bad_request', 'marked: укажи area или plan') end
    if p.area then B.area_of(p) end
  end,
  items = function(A, p)
    local e = A.entity
    if p.target then return {{target = p.target, count = p.count}}, true end
    local list = {}
    if p.targets then
      for i, ref in ipairs(p.targets) do
        if type(ref) ~= 'table' then U.fail('bad_request', 'targets[' .. i .. ']: {unit} или {x, y, name?}') end
        list[i] = {target = ref, count = ref.count or p.count}
      end
      return list, false
    end
    -- Помеченное на снос: в области или по имени плана.
    local found
    if p.plan and not p.area then
      found = Plans.entities(p.plan)
    else
      found = e.surface.find_entities_filtered{area = B.area_of(p), to_be_deconstructed = true}
    end
    for _, c in pairs(found) do
      if c.valid and c.to_be_deconstructed() and (c.force == e.force or c.force.name == 'neutral')
        and (not p.plan or Plans.of(c) == p.plan) then
        list[#list + 1] = {entity = c, target = {x = c.position.x, y = c.position.y}}
      end
    end
    return list, false
  end,
  point = point,
  in_reach = in_reach,
  begin = begin,
  step = step,
  abort = function(A, it) stop_mining(A.entity) end,
  brief = function(it)
    local r = {}
    if it.entity and it.entity.valid then
      r.name = it.entity.name
      r.x, r.y = U.r2(it.entity.position.x), U.r2(it.entity.position.y)
    else
      r.name = it.name
      r.x, r.y = it.target and it.target.x, it.target and it.target.y
    end
    return r
  end,
})
