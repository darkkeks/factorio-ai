-- transfer: переложить предметы между инвентарём персонажа и объектами в пределах досягаемости.
-- Источники и количества задаёт бот; исполнитель ничего не подбирает и не заменяет.
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')
local Tour = require('agent.actions.tour')
local Inv = require('agent.inv')

local BELT = {['transport-belt'] = true, ['underground-belt'] = true, splitter = true, ['lane-splitter'] = true, loader = true, ['loader-1x1'] = true}

--- Инвентарь объекта по имени: fuel, input, output, modules, main, ammo, burnt или имя из defines.inventory.
local function inventory(ent, name)
  local inv, unknown = Inv.named(ent, name)
  if unknown then U.fail('bad_request', 'inventory: fuel, input, output, modules, main, ammo, burnt, rocket, robots или имя из defines.inventory') end
  return inv
end

-- Копия свойств стопки для вставки: количество задаём сами, остальное (качество, прочность, патроны) — как было.
local function spec_of(stack, count)
  local sp = {name = stack.name, count = count, quality = stack.quality.name}
  if stack.health < 1 then sp.health = stack.health end
  if stack.is_tool then sp.durability = stack.durability end
  if stack.is_ammo then sp.ammo = stack.ammo end
  if stack.spoil_percent and stack.spoil_percent > 0 then sp.spoil_percent = stack.spoil_percent end
  return sp
end

-- Переложить из инвентаря src в приёмник insert(sp) → вставлено. item = nil — любые предметы.
local function move(src, insert, item, quality, limit, moved)
  local total = 0
  for i = 1, #src do
    if limit and total >= limit then break end
    local stack = src[i]
    if stack.valid_for_read and (not item or stack.name == item) and (not quality or stack.quality.name == quality) then
      local want = limit and math.min(stack.count, limit - total) or stack.count
      local name, q = stack.name, stack.quality.name
      local n = insert(spec_of(stack, want))
      if n > 0 then
        stack.count = stack.count - n
        total = total + n
        local k = U.item_key(name, q)
        moved[k] = (moved[k] or 0) + n
      end
    end
  end
  return total
end

local function lanes_of(ent, lane)
  local out = {}
  for i = 1, ent.get_max_transport_line_index() do
    local left = i % 2 == 1 -- нечётные линии — левая полоса по ходу движения
    if lane == nil or (lane == 'left') == left then out[#out + 1] = ent.get_transport_line(i) end
  end
  return out
end

local function transfer_one(A, it)
  local e, ent = A.entity, it.entity
  if not ent.valid then U.fail('not_found', 'объекта уже нет') end
  if ent.type == 'character-corpse' then
    -- Кто последним брал из трупа: попадёт в событие corpse_gone его владельцу.
    local p = ent.position
    local rec = storage.agent.corpses[math.floor(p.x * 256 + 0.5) .. ',' .. math.floor(p.y * 256 + 0.5)]
    if rec then rec.by = A.name end
  end
  if ent.force ~= e.force and ent.force.name ~= 'neutral' and ent.type ~= 'character-corpse' then
    U.fail('not_allowed', 'это объект чужой команды')
  end
  local mine = e.get_main_inventory()
  local quality = it.quality
  local moved = {}
  local total

  if it.direction == 'put' then
    local have = mine.get_item_count(quality and {name = it.item, quality = quality} or it.item)
    if have == 0 then U.fail('no_item', 'в инвентаре нет ' .. U.item_key(it.item, quality), {item = it.item}) end
    local limit = it.count or have
    if BELT[ent.type] then
      -- На клетку конвейера предметы кладутся по одному, пока на полосе есть место.
      local lines = lanes_of(ent, it.lane)
      total = move(mine, function(sp)
        local n = 0
        for _ = 1, sp.count do
          local placed = false
          for _, line in ipairs(lines) do
            if line.can_insert_at_back() and line.insert_at_back({name = sp.name, count = 1, quality = sp.quality}) then
              placed = true
              break
            end
          end
          if not placed then break end
          n = n + 1
        end
        return n
      end, it.item, quality, limit, moved)
    else
      local dst
      if it.inventory then
        if it.inventory == 'output' or it.inventory == 'burnt' then U.fail('not_allowed', 'в выходной слот руками положить нельзя') end
        dst = inventory(ent, it.inventory)
        if not dst then U.fail('not_found', 'у ' .. ent.name .. ' нет инвентаря ' .. it.inventory) end
      end
      -- Без inventory предмет кладётся как у игрока по ctrl-клику: игра сама выбирает слот (топливо, сырьё, патроны).
      local insert = dst and function(sp) return dst.insert(sp) end or function(sp) return ent.insert(sp) end
      total = move(mine, insert, it.item, quality, limit, moved)
    end
    if total == 0 then
      local hint = ''
      if ent.type == 'roboport' and it.inventory then
        hint = ' (у робопорта роботы кладутся в inventory: "robots", ремкомплекты — в "main"; без inventory игра выбирает сама)'
      end
      U.fail('no_space', ent.name .. ' не принимает ' .. it.item .. ' или в нём нет места' .. hint, {item = it.item})
    end
  else
    local limit = it.count
    local insert = function(sp) return mine.insert(sp) end
    if BELT[ent.type] then
      total = 0
      for _, line in ipairs(lanes_of(ent, it.lane)) do
        for _, c in pairs(line.get_contents()) do
          if (not it.item or c.name == it.item) and (not quality or c.quality == quality) and (not limit or total < limit) then
            local want = limit and math.min(c.count, limit - total) or c.count
            local can = mine.insert{name = c.name, count = want, quality = c.quality}
            if can > 0 then
              local removed = line.remove_item{name = c.name, count = can, quality = c.quality}
              if removed < can then mine.remove{name = c.name, count = can - removed, quality = c.quality} end
              total = total + removed
              local k = U.item_key(c.name, c.quality)
              moved[k] = (moved[k] or 0) + removed
            end
          end
        end
      end
    else
      local sources = {}
      if it.inventory then
        local src = inventory(ent, it.inventory)
        if not src then U.fail('not_found', 'у ' .. ent.name .. ' нет инвентаря ' .. it.inventory) end
        sources[1] = src
      else
        -- Без inventory: выходной слот машины или содержимое сундука; у остальных (лаборатория, турель) — всё, что в них лежит.
        -- У робопорта забирается всё: и роботы, и ремкомплекты.
        local out = ent.type ~= 'roboport' and (Inv.named(ent, 'output') or Inv.named(ent, 'main')) or nil
        if out then
          sources[1] = out
        else
          for i = 1, ent.get_max_inventory_index() do
            local inv = ent.get_inventory(i)
            if inv then sources[#sources + 1] = inv end
          end
        end
      end
      total = 0
      local seen = false
      for _, src in ipairs(sources) do
        if not src.is_empty() then seen = true end
        total = total + move(src, insert, it.item, quality, limit and (limit - total) or nil, moved)
        if limit and total >= limit then break end
      end
      if total == 0 and not seen then U.fail('no_item', 'в ' .. ent.name .. ' пусто', {item = it.item}) end
    end
    if total == 0 then
      local full = mine.count_empty_stacks() == 0 and not (it.item and mine.can_insert{name = it.item, count = 1})
      if full then U.fail('no_space', 'в инвентаре персонажа нет места') end
      U.fail('no_item', 'в ' .. ent.name .. ' нет ' .. (it.item or 'предметов'), {item = it.item})
    end
  end
  return {moved = total, items = moved}
end

local function check_one(it, where)
  if type(it) ~= 'table' then U.fail('bad_request', where .. ': ожидается объект {target, direction, item?, count?}') end
  if type(it.target) ~= 'table' then U.fail('bad_request', where .. '.target: {unit} или {x, y, name?}') end
  if it.direction ~= 'put' and it.direction ~= 'take' then U.fail('bad_request', where .. '.direction: put (положить в объект) или take (забрать)') end
  if it.direction == 'put' then U.arg(it.item, 'string', where .. '.item') else U.arg(it.item, 'string', where .. '.item', true) end
  if it.item and not prototypes.item[it.item] then U.fail('bad_request', where .. ': нет такого предмета: ' .. it.item) end
  if it.count ~= nil and (type(it.count) ~= 'number' or it.count % 1 ~= 0 or it.count < 1) then U.fail('bad_request', where .. '.count: целое от 1') end
  if it.lane ~= nil and it.lane ~= 'left' and it.lane ~= 'right' then U.fail('bad_request', where .. '.lane: left или right') end
  U.arg(it.inventory, 'string', where .. '.inventory', true)
  if it.quality ~= nil and not prototypes.quality[it.quality] then U.fail('bad_request', where .. ': нет такого качества') end
end

local FIELDS = {'target', 'direction', 'item', 'count', 'inventory', 'quality', 'lane'}

Q.register('transfer', Tour.action{
  check = function(p)
    if p.items ~= nil then
      if type(p.items) ~= 'table' then U.fail('bad_request', 'items: список {target, direction, item?, count?}') end
      for i, it in ipairs(p.items) do check_one(it, 'items[' .. i .. ']') end
    else
      check_one(p, 'transfer')
    end
  end,
  items = function(A, p)
    local src, single = p.items, false
    if src == nil then src, single = {p}, true end
    local list = {}
    for i, it in ipairs(src) do
      local c = {}
      for _, f in ipairs(FIELDS) do c[f] = it[f] end
      list[i] = c
    end
    return list, single
  end,
  point = function(A, it)
    if not it.entity then it.entity = T.get(A.entity.surface, it.target) end
    if not it.entity.valid then U.fail('not_found', 'объекта уже нет') end
    return it.entity.position, A.entity.reach_distance
  end,
  in_reach = function(A, it) return A.entity.can_reach_entity(it.entity) end,
  exec = transfer_one,
  brief = function(it)
    local r = {direction = it.direction, item = it.item}
    if it.entity and it.entity.valid then
      r.target = it.entity.name
      r.x, r.y = U.r2(it.entity.position.x), U.r2(it.entity.position.y)
    else
      r.x, r.y = it.target.x, it.target.y
    end
    return r
  end,
})
