-- Постройка из инвентаря: place (по списку) и build_ghosts (по призракам и пометкам на замену).
-- Правила как у игрока: дальность постройки, предмет в инвентаре, свободное место; предмет тратится.
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')
local Tour = require('agent.actions.tour')
local Plans = require('agent.plans')

local B = {}

local function vec(dir)
  if dir == defines.direction.north then return 0, -1 end
  if dir == defines.direction.east then return 1, 0 end
  if dir == defines.direction.south then return 0, 1 end
  return -1, 0
end

-- Ближайший такой же подземный конвейер (трубу), смотрящий туда же: sign = -1 — позади по ходу, 1 — впереди.
local function underground_near(s, proto, pos, dir, sign)
  local vx, vy = vec(dir)
  for k = 1, proto.max_underground_distance or 0 do
    local o = s.find_entities_filtered{name = proto.name, position = {pos.x + vx * k * sign, pos.y + vy * k * sign}}[1]
    if o and o.direction == dir then return o end
  end
end

--- Сколько предметов item нужно на постройку прототипа (обычно 1; изогнутые рельсы — больше).
local function item_need(proto, item)
  for _, s in pairs(proto.items_to_place_this or {}) do
    if s.name == item then return s.count or 1 end
  end
  return 1
end

--- Какой предмет из инвентаря годится, чтобы поставить прототип нужного качества: имя, количество.
local function item_for(e, proto, quality)
  local first
  for _, s in pairs(proto.items_to_place_this or {}) do
    first = first or s
    if U.count(e, s.name, quality) >= (s.count or 1) then return s.name, s.count or 1 end
  end
  return nil, first and first.name
end
B.item_for = item_for

local function describe(n, extra)
  local r = {name = n.name, x = U.r2(n.position.x), y = U.r2(n.position.y), unit = n.unit_number}
  if n.supports_direction then r.direction = U.dirname(n.direction) end
  if n.type == 'underground-belt' then
    r.underground = n.belt_to_ground_type
    local o = n.neighbours
    if o then r.paired_with = U.pos(o.position) end
  end
  if n.type == 'inserter' then
    r.takes_from, r.puts_to = U.pos(n.pickup_position), U.pos(n.drop_position)
  end
  if extra then for k, v in pairs(extra) do r[k] = v end end
  return r
end
B.describe = describe

-- Поставить одну постройку из инвентаря. it — {item, x, y, direction?, underground?, recipe?, quality?}.
local function place_one(A, it)
  local e = A.entity
  local s, force = e.surface, e.force
  local ip = prototypes.item[it.item]
  local proto = ip.place_result
  local dir = U.dir(it.direction) or defines.direction.north
  local quality = it.quality or 'normal'
  local pos = {x = it.x, y = it.y}

  -- Такая же постройка уже стоит здесь: предмет не тратится; иное направление — поворот на месте, как у игрока.
  for _, c in pairs(s.find_entities_filtered{name = proto.name, position = pos, radius = 0.6, force = force}) do
    if U.dist(c.position, pos) < 0.51 and c.quality.name == quality then
      local res = {already = true}
      if c.supports_direction and c.direction ~= dir and it.direction ~= nil then
        if c.type == 'underground-belt' or c.type == 'pipe-to-ground' then
          U.fail('blocked', 'здесь уже стоит ' .. c.name .. ', смотрит на ' .. U.dirname(c.direction) .. ': сними и поставь заново')
        end
        c.direction = dir
        res.rotated = true
      end
      return describe(c, res)
    end
  end

  local need = item_need(proto, it.item)
  if U.count(e, it.item, quality) < need then
    U.fail('no_item', 'в инвентаре нет ' .. U.item_key(it.item, quality), {item = it.item, need = need})
  end

  local n, replaced
  -- Призрак этой же постройки в этой точке: оживляем его — настройки призрака (рецепт, фильтры) сохраняются.
  for _, g in pairs(s.find_entities_filtered{type = 'entity-ghost', position = pos, radius = 0.6, force = force}) do
    if g.valid and g.ghost_name == proto.name and U.dist(g.position, pos) < 0.51 and g.quality.name == quality then
      if it.direction ~= nil and g.supports_direction and g.direction ~= dir then g.direction = dir end
      local plan = Plans.forget(g)
      local _, revived = g.revive{raise_revive = true}
      if not revived then U.fail('blocked', 'место под призраком занято (мешает постройка, дерево, камень или персонаж)') end
      n = revived
      break
    end
  end

  if not n then
    local args = {name = proto.name, position = pos, direction = dir, force = force, quality = quality}
    if proto.type == 'underground-belt' then
      -- Как в игре: подземный конвейер ставится входом, а если позади по ходу стоит такой же вход — выходом.
      local kind = it.underground
      if kind == nil then
        local o = underground_near(s, proto, pos, dir, -1)
        kind = (o and o.belt_to_ground_type == 'input') and 'output' or 'input'
      end
      args.type = kind
    end
    if s.can_fast_replace{name = proto.name, position = pos, direction = dir, force = force} then
      -- Быстрая замена на месте: старая постройка возвращается в инвентарь, содержимое и настройки сохраняются.
      local old = s.find_entities_filtered{position = pos, force = force, type = proto.type}[1]
      replaced = old and old.name or true
      args.fast_replace, args.character, args.spill = true, e, false
    elseif not s.can_place_entity{name = proto.name, position = pos, direction = dir, force = force,
        build_check_type = defines.build_check_type.manual} then
      U.fail('blocked', 'сюда поставить нельзя: место занято, не та поверхность или нет ресурса под буром')
    end
    args.raise_built = true
    n = s.create_entity(args)
    if not n then U.fail('blocked', 'сюда поставить нельзя') end
  end

  e.remove_item{name = it.item, count = need, quality = quality}
  local extra = {}
  if replaced then extra.replaced = replaced end
  if it.recipe and (n.type == 'assembling-machine' or n.type == 'rocket-silo') then
    local rc = force.recipes[it.recipe]
    if rc and rc.enabled and pcall(function() n.set_recipe(rc) end) then extra.recipe = it.recipe
    else extra.recipe_error = 'рецепт недоступен или не подходит этой машине' end
  end
  return describe(n, extra)
end

local function check_place_item(it, where)
  if type(it) ~= 'table' then U.fail('bad_request', where .. ': ожидается объект {item, x, y, direction?}') end
  U.arg(it.item, 'string', where .. '.item') U.arg(it.x, 'number', where .. '.x') U.arg(it.y, 'number', where .. '.y')
  local ip = prototypes.item[it.item]
  if not ip then U.fail('bad_request', where .. ': нет такого предмета: ' .. it.item) end
  if not ip.place_result then U.fail('bad_request', where .. ': ' .. it.item .. ' нельзя поставить как постройку') end
  U.dir(it.direction, where .. '.direction')
  if it.quality ~= nil and not prototypes.quality[it.quality] then U.fail('bad_request', where .. ': нет такого качества: ' .. tostring(it.quality)) end
  if it.underground ~= nil and it.underground ~= 'input' and it.underground ~= 'output' then
    U.fail('bad_request', where .. '.underground: input или output')
  end
end

Q.register('place', Tour.action{
  check = function(p)
    if p.items ~= nil then
      if type(p.items) ~= 'table' then U.fail('bad_request', 'items: список {item, x, y, direction?}') end
      for i, it in ipairs(p.items) do check_place_item(it, 'items[' .. i .. ']') end
    else
      check_place_item(p, 'place')
    end
  end,
  items = function(A, p)
    if p.items == nil then
      return {{item = p.item, x = p.x, y = p.y, direction = p.direction, underground = p.underground, recipe = p.recipe, quality = p.quality}}, true
    end
    local list = {}
    for i, it in ipairs(p.items) do
      list[i] = {item = it.item, x = it.x, y = it.y, direction = it.direction, underground = it.underground, recipe = it.recipe, quality = it.quality}
    end
    return list, false
  end,
  point = function(A, it) return it, A.entity.build_distance end,
  exec = place_one,
  brief = function(it) return {item = it.item, x = it.x, y = it.y} end,
})

-- ── build_ghosts ──
-- Элемент — призрак постройки или плитки, либо постройка с пометкой на замену (upgrade).

local function build_ghost(A, it)
  local e, g = A.entity, it.entity
  if not g.valid then U.fail('not_found', 'призрака уже нет (построен или убран)') end
  local quality = g.quality.name
  if it.upgrade then
    local target, tq = g.get_upgrade_target()
    if not target then U.fail('not_found', 'пометка на замену уже снята') end
    local qn = tq and tq.name or quality
    local item, need = item_for(e, target, qn)
    if not item then U.fail('no_item', 'в инвентаре нет ' .. U.item_key(need or target.name, qn), {item = need or target.name}) end
    local old = g.name
    local n = g.surface.create_entity{name = target.name, position = g.position, direction = g.direction, force = g.force,
      quality = qn, fast_replace = true, character = e, spill = false, raise_built = true}
    if not n then U.fail('blocked', 'замена на месте не удалась') end
    e.remove_item{name = item, count = need, quality = qn}
    return describe(n, {replaced = old})
  end
  local proto = g.ghost_prototype
  local item, need = item_for(e, proto, quality)
  if not item then
    U.fail('no_item', 'в инвентаре нет ' .. U.item_key(need or g.ghost_name, quality), {item = need or g.ghost_name})
  end
  local tile = g.type == 'tile-ghost'
  local name, pos = g.ghost_name, U.pos(g.position)
  local plan = Plans.forget(g)
  local _, revived = g.revive{raise_revive = true}
  if g.valid then
    Plans.remember(g, plan)
    U.fail('blocked', 'место под призраком занято: мешает постройка (возможно, помеченная на снос), дерево, камень или персонаж')
  end
  e.remove_item{name = item, count = need, quality = quality}
  if revived then return describe(revived, {plan = plan}) end
  return {name = name, x = pos.x, y = pos.y, tile = tile or nil, plan = plan}
end

local function area_of(p)
  local a = p.area
  if type(a) ~= 'table' then U.fail('bad_request', 'area: {x1, y1, x2, y2}') end
  local x1, y1, x2, y2 = a.x1 or a[1], a.y1 or a[2], a.x2 or a[3], a.y2 or a[4]
  if type(x1) ~= 'number' or type(y1) ~= 'number' or type(x2) ~= 'number' or type(y2) ~= 'number' then
    U.fail('bad_request', 'area: {x1, y1, x2, y2} — числа')
  end
  return {{math.min(x1, x2), math.min(y1, y2)}, {math.max(x1, x2), math.max(y1, y2)}}
end
B.area_of = area_of

Q.register('build_ghosts', Tour.action{
  check = function(p)
    if p.ghosts == nil and p.area == nil and p.plan == nil then U.fail('bad_request', 'нужно ghosts (список целей), area или plan') end
    if p.area ~= nil then
      local a = area_of(p)
      if (a[2][1] - a[1][1]) * (a[2][2] - a[1][2]) > 250000 then U.fail('bad_request', 'area больше 500×500 клеток') end
    end
    if p.plan ~= nil then U.arg(p.plan, 'string', 'plan') end
    if p.ghosts ~= nil and type(p.ghosts) ~= 'table' then U.fail('bad_request', 'ghosts: список целей {unit} или {x, y}') end
  end,
  items = function(A, p)
    local e = A.entity
    local s, force = e.surface, e.force
    local list = {}
    if p.ghosts then
      for i, ref in ipairs(p.ghosts) do
        local g
        if type(ref) == 'table' and not ref.unit and type(ref.x) == 'number' then
          -- В точке призрак постройки важнее призрака плитки под ним.
          g = s.find_entities_filtered{type = 'entity-ghost', position = {ref.x, ref.y}, radius = 0.5, force = force, limit = 1}[1]
            or s.find_entities_filtered{type = 'tile-ghost', position = {ref.x, ref.y}, radius = 0.5, force = force, limit = 1}[1]
        end
        g = g or T.find(s, ref)
        if g and (g.type == 'entity-ghost' or g.type == 'tile-ghost') and g.force == force then
          list[#list + 1] = {entity = g, x = g.position.x, y = g.position.y, name = g.ghost_name}
        elseif g and g.force == force and g.to_be_upgraded() then
          list[#list + 1] = {entity = g, x = g.position.x, y = g.position.y, name = g.name, upgrade = true}
        else
          list[#list + 1] = {missing = true, x = ref.x, y = ref.y, unit = ref.unit}
        end
      end
      return list, false
    end
    local filter = {type = {'entity-ghost', 'tile-ghost'}, force = force}
    if p.area then filter.area = area_of(p) end
    local found
    if p.plan and not p.area then
      found = Plans.entities(p.plan)
    else
      found = s.find_entities_filtered(filter)
    end
    for _, g in pairs(found) do
      if g.valid and (not p.plan or Plans.of(g) == p.plan) and (g.type == 'entity-ghost' or g.type == 'tile-ghost') then
        list[#list + 1] = {entity = g, x = g.position.x, y = g.position.y, name = g.ghost_name}
      end
    end
    -- Пометки на замену в области исполняются тем же действием (быстрая замена на месте).
    if p.area and p.upgrades ~= false and not p.plan then
      for _, c in pairs(s.find_entities_filtered{area = filter.area, force = force, to_be_upgraded = true}) do
        list[#list + 1] = {entity = c, x = c.position.x, y = c.position.y, name = c.name, upgrade = true}
      end
    end
    -- Сначала постройки, потом плитка: так строит и игрок.
    return list, false
  end,
  point = function(A, it)
    if it.missing then U.fail('not_found', 'здесь нет призрака своей команды') end
    if not it.entity.valid then U.fail('not_found', 'призрака уже нет (построен или убран)') end
    return it, A.entity.build_distance
  end,
  exec = build_ghost,
  brief = function(it) return {name = it.name, x = U.r2(it.x or 0), y = U.r2(it.y or 0), upgrade = it.upgrade} end,
})

return B
