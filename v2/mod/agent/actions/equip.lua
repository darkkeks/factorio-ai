-- equip / unequip: оружие, патроны и броня между инвентарём персонажа и его слотами экипировки — как игрок
-- перекладывает их в окне персонажа. Что, куда и сколько — задаёт бот; совместимость патронов с оружием в слоте
-- и вид предмета в слоте проверяет сама игра (can_set_stack / swap_stack).
local U = require('agent.util')
local Q = require('agent.queue')

local KIND = {gun = 'gun', ammo = 'ammo', armor = 'armor'}
local INV = {gun = defines.inventory.character_guns, ammo = defines.inventory.character_ammo, armor = defines.inventory.character_armor}

local function check(p)
  local item = U.arg(p.item, 'string', 'item')
  local proto = prototypes.item[item]
  if not proto then U.fail('bad_request', 'нет такого предмета: ' .. item) end
  if not KIND[proto.type] then U.fail('bad_request', item .. ' — не оружие, не патроны и не броня') end
  if p.quality ~= nil and (type(p.quality) ~= 'string' or not prototypes.quality[p.quality]) then U.fail('bad_request', 'нет такого качества') end
  U.arg(p.count, 'int', 'count', true)
  if p.count and p.count < 1 then U.fail('bad_request', 'count: от 1') end
  U.arg(p.slot, 'int', 'slot', true)
  if p.slot and (proto.type == 'armor' and p.slot ~= 1 or p.slot < 1 or p.slot > 3) then U.fail('bad_request', 'slot: 1…3 для оружия и патронов') end
end

local function ident(p)
  return p.quality and {name = p.item, quality = p.quality} or p.item
end

local function matches(stack, p)
  return stack.valid_for_read and stack.name == p.item and (not p.quality or stack.quality.name == p.quality)
end

local function bonus(stack)
  if not stack.valid_for_read or stack.type ~= 'armor' then return 0 end
  return stack.prototype.get_inventory_size_bonus(stack.quality) or 0
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
  local kind = KIND[prototypes.item[p.item].type]
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
  local kind = KIND[prototypes.item[p.item].type]
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

return {weapons = weapons}
