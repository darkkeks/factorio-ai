-- equip / unequip: оружие, патроны и броня между инвентарём персонажа и его слотами экипировки — как игрок
-- перекладывает их в окне персонажа. Что, куда и сколько — задаёт бот; совместимость патронов с оружием в слоте
-- и вид предмета в слоте проверяет сама игра (can_set_stack / swap_stack).
-- Оборудование брони (личный робопорт, батареи, панели, щиты…) — в сетку НАДЕТОЙ брони и обратно, как перетаскивание
-- в окне брони: предмет уходит из инвентаря, место и допустимость проверяет сама игра (LuaEquipmentGrid.put).
local U = require('agent.util')
local Q = require('agent.queue')

local KIND = {gun = 'gun', ammo = 'ammo', armor = 'armor'}
local INV = {gun = defines.inventory.character_guns, ammo = defines.inventory.character_ammo, armor = defines.inventory.character_armor}

local function kind_of(proto)
  return KIND[proto.type] or (proto.place_as_equipment_result and 'equipment') or nil
end

local function check(p)
  local item = U.arg(p.item, 'string', 'item')
  local proto = prototypes.item[item]
  if not proto then U.fail('bad_request', 'нет такого предмета: ' .. item) end
  local kind = kind_of(proto)
  if not kind then U.fail('bad_request', item .. ' — не оружие, не патроны, не броня и не оборудование брони') end
  U.arg(p.x, 'int', 'x', true)
  U.arg(p.y, 'int', 'y', true)
  if (p.x == nil) ~= (p.y == nil) then U.fail('bad_request', 'x и y задаются вместе') end
  if p.x and kind ~= 'equipment' then U.fail('bad_request', 'x, y — только для оборудования брони') end
  if p.x and (p.x < 0 or p.y < 0) then U.fail('bad_request', 'x, y: клетка сетки брони, от 0') end
  if kind == 'equipment' then
    if p.slot ~= nil then U.fail('bad_request', 'slot — для оружия и патронов; у оборудования брони место задают x, y') end
    if p.count ~= nil and p.count ~= 1 then U.fail('bad_request', 'оборудование ставится и снимается по одному') end
  end
  if p.quality ~= nil and (type(p.quality) ~= 'string' or not prototypes.quality[p.quality]) then U.fail('bad_request', 'нет такого качества') end
  U.arg(p.count, 'int', 'count', true)
  if p.count and p.count < 1 then U.fail('bad_request', 'count: от 1') end
  U.arg(p.slot, 'int', 'slot', true)
  if p.slot and kind ~= 'equipment' and (proto.type == 'armor' and p.slot ~= 1 or p.slot < 1 or p.slot > 3) then U.fail('bad_request', 'slot: 1…3 для оружия и патронов') end
end

local function ident(p)
  return p.quality and {name = p.item, quality = p.quality} or p.item
end

local function matches(stack, p)
  return stack.valid_for_read and stack.name == p.item and (not p.quality or stack.quality.name == p.quality)
end

local function bonus(stack)
  if not stack.valid_for_read or stack.type ~= 'armor' then return 0 end
  local grid = stack.grid
  return (stack.prototype.get_inventory_size_bonus(stack.quality) or 0) + (grid and grid.inventory_bonus or 0)
end

local function kj(j) return math.floor(j / 100 + 0.5) / 10 end

--- Сетка надетой брони, как в окне брони: размеры, оборудование по клеткам, заряд. Брони с сеткой нет — nil.
local function grid_view(e)
  local grid = e.grid
  if not grid then return nil end
  local armor = e.get_inventory(INV.armor)
  local a = armor and armor[1]
  local list, used = {}, 0
  for _, eq in pairs(grid.equipment) do
    local sh, pos = eq.shape, eq.position
    local r = {name = eq.name, x = pos.x, y = pos.y, w = sh.width, h = sh.height}
    if eq.type == 'equipment-ghost' then
      r.name, r.ghost = eq.ghost_name, true
    else
      if eq.quality.name ~= 'normal' then r.quality = eq.quality.name end
      if eq.max_energy > 0 then r.energy_kj, r.max_energy_kj = kj(eq.energy), kj(eq.max_energy) end
      if eq.max_shield > 0 then r.shield, r.max_shield = U.r2(eq.shield), U.r2(eq.max_shield) end
    end
    used = used + sh.width * sh.height
    list[#list + 1] = r
  end
  table.sort(list, function(l, r) if l.y ~= r.y then return l.y < r.y end return l.x < r.x end)
  local out = {
    armor = a and a.valid_for_read and U.item_key(a.name, a.quality.name) or nil,
    width = grid.width, height = grid.height, free_cells = grid.width * grid.height - used,
    equipment = U.list(list),
  }
  if grid.battery_capacity > 0 then out.battery_kj, out.battery_capacity_kj = kj(grid.available_in_batteries), kj(grid.battery_capacity) end
  if grid.max_shield > 0 then out.shield, out.max_shield = U.r2(grid.shield), U.r2(grid.max_shield) end
  if grid.inventory_bonus > 0 then out.inventory_bonus = grid.inventory_bonus end
  return out
end

local function worn_grid(e)
  local grid = e.grid
  if not grid then U.fail('not_allowed', 'на персонаже нет брони с сеткой оборудования: надень модульную или силовую броню (equip)') end
  if grid.prototype.locked then U.fail('not_allowed', 'сетка этой брони закрыта для изменений') end
  return grid
end

local function equip_grid(A, p)
  local e = A.entity
  local main = e.get_main_inventory()
  local key = U.item_key(p.item, p.quality)
  local eproto = prototypes.item[p.item].place_as_equipment_result
  local grid = worn_grid(e)
  local src = main.find_item_stack(ident(p))
  if not src then U.fail('no_item', 'в инвентаре нет ' .. key, {item = p.item}) end
  local allowed = {}
  for _, c in pairs(grid.prototype.equipment_categories) do allowed[c] = true end
  local fits = false
  for _, c in pairs(eproto.equipment_categories) do if allowed[c] then fits = true break end end
  if not fits then U.fail('not_allowed', p.item .. ' не ставится в сетку этой брони (не та категория оборудования)') end
  local sh = eproto.shape
  if p.x and (p.x + sh.width > grid.width or p.y + sh.height > grid.height) then
    U.fail('no_space', 'не помещается: оборудование ' .. sh.width .. '×' .. sh.height .. ', сетка ' .. grid.width .. '×' .. grid.height
      .. ' (x, y — левая верхняя клетка, от 0)', {grid = grid_view(e)})
  end
  local quality = src.quality.name
  local eq = grid.put{name = eproto.name, position = p.x and {x = p.x, y = p.y} or nil, quality = quality}
  if not eq then
    U.fail('no_space', p.x and 'клетки заняты другим оборудованием: выбери другие x, y или сними мешающее (unequip)'
      or ('в сетке нет свободного места ' .. sh.width .. '×' .. sh.height .. ': сними лишнее (unequip)'), {grid = grid_view(e)})
  end
  main.remove{name = p.item, quality = quality, count = 1}
  local pos = eq.position
  return {item = U.item_key(p.item, quality), kind = 'equipment', x = pos.x, y = pos.y, moved = 1, grid = grid_view(e), inventory_slots = #main}
end

local function unequip_grid(A, p)
  local e = A.entity
  local main = e.get_main_inventory()
  local key = U.item_key(p.item, p.quality)
  local grid = worn_grid(e)
  local function is(eq)
    if not eq or eq.type == 'equipment-ghost' then return false end
    local take = eq.prototype.take_result
    return (take and take.name or eq.name) == p.item and (not p.quality or eq.quality.name == p.quality)
  end
  local found
  if p.x then
    local eq = grid.get{x = p.x, y = p.y}
    if is(eq) then found = eq end
  else
    for _, eq in pairs(grid.equipment) do if is(eq) then found = eq break end end
  end
  if not found then
    U.fail('no_item', key .. ' нет в сетке брони' .. (p.x and (' в клетке ' .. p.x .. ',' .. p.y) or ''), {item = p.item, grid = grid_view(e)})
  end
  local quality = found.quality.name
  -- Оборудование с запасом слотов инвентаря: без него инвентарь сожмётся, лишнее высыпалось бы на землю.
  local shrink = found.inventory_bonus or 0
  if shrink > 0 and main.count_empty_stacks() < shrink + 1 then
    U.fail('no_space', 'без этого оборудования инвентарь меньше на ' .. shrink .. ' слотов: нужно ' .. (shrink + 1) .. ' свободных, есть ' .. main.count_empty_stacks())
  end
  if not main.can_insert{name = p.item, quality = quality, count = 1} then U.fail('no_space', 'в инвентаре нет места') end
  local got = grid.take{equipment = found}
  if not got then U.fail('not_allowed', 'это оборудование не снимается') end
  main.insert{name = got.name, quality = got.quality, count = got.count}
  return {item = U.item_key(got.name, quality), kind = 'equipment', moved = 1, grid = grid_view(e), inventory_slots = #main}
end

--- Слоты оружия и патронов, как в окне персонажа: [{slot, gun?, ammo?, count?}].
local function weapons(e)
  local g, a = e.get_inventory(INV.gun), e.get_inventory(INV.ammo)
  local out = {}
  if not g or not a then return out end
  for i = 1, #g do
    local r = {slot = i}
    if g[i].valid_for_read then r.gun = U.item_key(g[i].name, g[i].quality.name) end
    if a[i] and a[i].valid_for_read then r.ammo, r.count = U.item_key(a[i].name, a[i].quality.name), a[i].count end
    out[i] = r
  end
  return out
end

local function equip(A, p)
  local e = A.entity
  local main = e.get_main_inventory()
  local kind = kind_of(prototypes.item[p.item])
  if kind == 'equipment' then return equip_grid(A, p) end
  local dst = e.get_inventory(INV[kind])
  local key = U.item_key(p.item, p.quality)
  local src = main.find_item_stack(ident(p))
  if not src then U.fail('no_item', 'в инвентаре нет ' .. key, {item = p.item}) end

  if kind == 'ammo' then
    local want = p.count or main.get_item_count(ident(p))
    local moved, slot = 0, nil
    local first, last = p.slot or 1, p.slot or #dst
    for i = first, last do
      local d = dst[i]
      while moved < want do
        src = main.find_item_stack(ident(p))
        if not src then break end
        if d.valid_for_read and not (d.name == src.name and d.quality == src.quality) then break end
        if not d.valid_for_read and not d.can_set_stack(src) then break end
        local before = d.valid_for_read and d.count or 0
        d.transfer_stack(src, math.min(want - moved, src.count))
        local got = (d.valid_for_read and d.count or 0) - before
        if got <= 0 then break end
        moved, slot = moved + got, i
      end
      if moved > 0 then break end -- один слот за раз: остальное — отдельным запросом с другим slot
    end
    if moved == 0 then
      U.fail('no_space', p.slot and ('в слот ' .. p.slot .. ' эти патроны не кладутся: занят другими, полон или оружие в слоте стреляет другими')
        or 'нет слота под эти патроны: слоты заняты или оружие в них стреляет другими', {weapons = weapons(e)})
    end
    return {item = key, kind = kind, slot = slot, moved = moved, weapons = weapons(e)}
  end

  local slot = p.slot
  if kind == 'armor' then slot = 1 end
  if not slot then
    for i = 1, #dst do if not dst[i].valid_for_read then slot = i break end end
    if not slot then U.fail('no_space', 'все слоты оружия заняты: укажи slot — оружие в нём поменяется местами с новым', {weapons = weapons(e)}) end
  end
  local d = dst[slot]
  local replaced
  if d.valid_for_read then
    if d.name == src.name and d.quality == src.quality then
      return {item = key, kind = kind, slot = slot, already = true, weapons = kind == 'gun' and weapons(e) or nil}
    end
    replaced = U.item_key(d.name, d.quality.name)
    -- Броня с меньшим запасом слотов: лишнее игра высыпала бы на землю — не даём терять предметы.
    local shrink = bonus(d) - bonus(src)
    if shrink > 0 and main.count_empty_stacks() < shrink then
      U.fail('no_space', 'инвентарь станет меньше на ' .. shrink .. ' слотов, а свободных ' .. main.count_empty_stacks() .. ': освободи место')
    end
  end
  if not d.swap_stack(src) then
    U.fail('not_allowed', kind == 'gun' and 'оружие не встаёт в этот слот: патроны в слоте ему не подходят' or 'предмет не встаёт в этот слот',
      {weapons = weapons(e)})
  end
  local r = {item = key, kind = kind, slot = slot, moved = 1, replaced = replaced}
  if kind == 'gun' then r.weapons = weapons(e) else r.inventory_slots = #main end
  return r
end

local function unequip(A, p)
  local e = A.entity
  local main = e.get_main_inventory()
  local kind = kind_of(prototypes.item[p.item])
  if kind == 'equipment' then return unequip_grid(A, p) end
  local from = e.get_inventory(INV[kind])
  local key = U.item_key(p.item, p.quality)
  local src, slot
  for i = p.slot or 1, p.slot or #from do
    if matches(from[i], p) then src, slot = from[i], i break end
  end
  if not src then U.fail('no_item', key .. ' не надет' .. (p.slot and (' в слоте ' .. p.slot) or ''), {item = p.item}) end

  if kind == 'ammo' then
    local n = math.min(p.count or src.count, src.count)
    local moved
    if n == src.count then
      moved = main.insert(src)
    else
      moved = main.insert{name = src.name, quality = src.quality, count = n}
    end
    if moved == 0 then U.fail('no_space', 'в инвентаре нет места') end
    if moved >= src.count then src.clear() else src.count = src.count - moved end
    return {item = key, kind = kind, slot = slot, moved = moved, weapons = weapons(e)}
  end

  local need = 1 + bonus(src)
  if main.count_empty_stacks() < need then
    U.fail('no_space', kind == 'armor' and need > 1
      and ('без этой брони инвентарь меньше на ' .. (need - 1) .. ' слотов: нужно ' .. need .. ' свободных, есть ' .. main.count_empty_stacks())
      or 'в инвентаре нет свободного слота')
  end
  local empty = main.find_empty_stack()
  if not empty or not empty.swap_stack(src) then U.fail('no_space', 'в инвентаре нет свободного слота') end
  local r = {item = key, kind = kind, slot = slot, moved = 1}
  if kind == 'gun' then r.weapons = weapons(e) else r.inventory_slots = #main end
  return r
end

Q.register('equip', {
  instant = true,
  check = check,
  start = function(A, act) return equip(A, act.p) end,
})

Q.register('unequip', {
  instant = true,
  check = check,
  start = function(A, act) return unequip(A, act.p) end,
})

return {weapons = weapons, grid = grid_view}
