-- craft: ручной крафт. Рецепт ставится в очередь крафта персонажа; время и ингредиенты считает игра.
-- Тело крафт не занимает: действие мгновенное, о конце очереди приходит событие craft_done.
local U = require('agent.util')
local Q = require('agent.queue')

local function by_hand(e, r)
  for cat in pairs(e.prototype.crafting_categories or {}) do
    if r.has_category(cat) then return true end
  end
  return false
end

local function recipe_for(e, p)
  local force = e.force
  if p.recipe then
    local r = force.recipes[p.recipe]
    if not r then U.fail('bad_request', 'нет такого рецепта: ' .. p.recipe) end
    return r
  end
  local r = force.recipes[p.item]
  if r and r.enabled then
    for _, pr in pairs(r.products) do if pr.name == p.item then return r end end
  end
  -- Рецепт с другим именем: первый открытый рецепт ручного крафта, дающий этот предмет.
  local best
  for name, rc in pairs(force.recipes) do
    if rc.enabled and by_hand(e, rc) then
      for _, pr in pairs(rc.products) do
        if pr.type == 'item' and pr.name == p.item and (not best or name < best.name) then best = rc end
      end
    end
  end
  if best then return best end
  if r then return r end
  U.fail('not_found', 'нет открытого рецепта для ' .. p.item)
end

Q.register('craft', {
  instant = true,
  check = function(p)
    if p.recipe == nil and p.item == nil then U.fail('bad_request', 'нужен recipe или item') end
    U.arg(p.recipe, 'string', 'recipe', true) U.arg(p.item, 'string', 'item', true)
    if p.count ~= nil and (type(p.count) ~= 'number' or p.count % 1 ~= 0 or p.count < 1) then U.fail('bad_request', 'count: целое от 1') end
  end,
  start = function(A, act)
    local e, p = A.entity, act.p
    local r = recipe_for(e, p)
    local count = p.count or 1
    if not r.enabled then U.fail('not_allowed', 'рецепт ' .. r.name .. ' ещё не исследован') end
    if not by_hand(e, r) then U.fail('not_allowed', 'рецепт ' .. r.name .. ' руками не делается') end
    local can = e.get_craftable_count(r)
    if can == 0 then
      local need = {}
      for _, ing in pairs(r.ingredients) do
        if ing.type == 'item' then need[ing.name] = {need = ing.amount, have = e.get_item_count(ing.name)} end
      end
      U.fail('no_item', 'не хватает ингредиентов для ' .. r.name, {ingredients = need})
    end
    local n = e.begin_crafting{recipe = r, count = math.min(count, can), silent = true}
    if n > 0 then storage.agent.crafting[A.name] = true end
    return {recipe = r.name, queued = n, requested = count, queue_size = e.crafting_queue_size}
  end,
})

Q.register('cancel_craft', {
  instant = true,
  check = function(p)
    U.arg(p.index, 'int', 'index', true) U.arg(p.count, 'int', 'count', true)
  end,
  start = function(A, act)
    local e, p = A.entity, act.p
    local cancelled = 0
    if p.index then
      local q = e.crafting_queue or {}
      local item = q[p.index]
      if not item then U.fail('not_found', 'в очереди крафта нет позиции ' .. p.index) end
      local c = math.min(p.count or item.count, item.count)
      e.cancel_crafting{index = p.index, count = c}
      cancelled = c
    else
      -- Без index — вся очередь; ингредиенты возвращаются в инвентарь, как у игрока.
      local guard = 0
      while e.crafting_queue_size > 0 and guard < 1000 do
        guard = guard + 1
        local item = e.crafting_queue[1]
        e.cancel_crafting{index = 1, count = item.count}
        cancelled = cancelled + item.count
      end
    end
    return {cancelled = cancelled, queue_size = e.crafting_queue_size}
  end,
})
