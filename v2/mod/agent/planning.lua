-- Планирование: призраки, пометки на снос и замену, чертежи. План — это сущности игры на карте; досягаемость
-- и предметы для него не нужны, как у игрока с картой. Исполняет план тело персонажа (build_ghosts, mine)
-- или строительные роботы игры.
local U = require('agent.util')
local T = require('agent.target')
local Q = require('agent.queue')
local O = require('agent.ops')
local BP = require('agent.blueprints')
local Plans = require('agent.plans')
local B = require('agent.actions.build')
local Fog = require('agent.fog')

local NATURE = {tree = true, ['simple-entity'] = true, cliff = true, fish = true, plant = true}
local MODES = {normal = true, forced = true, superforced = true}
local ROT = {[0] = 0, [90] = 1, [180] = 2, [270] = 3, north = 0, east = 1, south = 2, west = 3}

local function rot_of(v)
  if v == nil then return 0 end
  local k = ROT[v]
  if k == nil then U.fail('bad_request', 'rotation: 0, 90, 180 или 270 (по часовой)') end
  return k
end

local function flip_of(v)
  if v == nil or v == false then return nil end
  if v ~= 'h' and v ~= 'v' then U.fail('bad_request', 'flip: "h" (слева направо) или "v" (сверху вниз)') end
  return v
end

-- Что будет с одной постройкой чертежа в точке мира: ok | already | ghost | replace | blocked.
local function classify(surface, force, e, wx, wy)
  local dir = e.direction or 0
  local pos = {wx, wy}
  for _, c in pairs(surface.find_entities_filtered{name = e.name, position = pos, radius = 0.3, force = force}) do
    if not c.supports_direction or c.direction == dir then return 'already' end
  end
  for _, g in pairs(surface.find_entities_filtered{type = 'entity-ghost', position = pos, radius = 0.3, force = force}) do
    if g.ghost_name == e.name then return 'ghost' end
  end
  if surface.can_fast_replace{name = e.name, position = pos, direction = dir, force = force} then
    local w, h = BP.footprint(e.name, dir)
    local old = surface.find_entities_filtered{area = {{wx - w / 2 + 0.1, wy - h / 2 + 0.1}, {wx + w / 2 - 0.1, wy + h / 2 - 0.1}}, force = force}[1]
    return 'replace', old and old.name
  end
  if surface.can_place_entity{name = e.name, position = pos, direction = dir, force = force,
      build_check_type = defines.build_check_type.manual_ghost} then
    return 'ok'
  end
  local w, h = BP.footprint(e.name, dir)
  local by, nature = {}, true
  for _, c in pairs(surface.find_entities_filtered{area = {{wx - w / 2 + 0.1, wy - h / 2 + 0.1}, {wx + w / 2 - 0.1, wy + h / 2 - 0.1}}}) do
    if c.type ~= 'character' and c.type ~= 'resource' and c.type ~= 'entity-ghost' and c.type ~= 'tile-ghost' and c.prototype.collision_mask.layers and next(c.prototype.collision_mask.layers) then
      by[c.name] = true
      if not NATURE[c.type] then nature = false end
    end
  end
  local names = {}
  for n in pairs(by) do names[#names + 1] = n end
  if #names == 0 then return 'blocked', {'местность (вода, обрыв) или нет ресурса под буром'}, false end
  return 'blocked', names, nature
end

-- Проверка без постановки: списки чертежа, угол (ox, oy) → отчёт.
local function dry_run(A, surface, force, ents, tiles, ox, oy, w, h, cost)
  local counts = {ok = 0, already = 0, ghost = 0, replace = 0, blocked = 0}
  local blocked, replace, replace_ents = {}, {}, {}
  for _, e in ipairs(ents) do
    local wx, wy = ox + e.position.x, oy + e.position.y
    local status, info, nature = classify(surface, force, e, wx, wy)
    counts[status] = counts[status] + 1
    if status == 'blocked' and #blocked < 100 then
      blocked[#blocked + 1] = {name = e.name, x = wx, y = wy, by = info, nature = nature or nil}
    elseif status == 'replace' then
      replace_ents[#replace_ents + 1] = e
      if #replace < 100 then replace[#replace + 1] = {name = e.name, x = wx, y = wy, replaces = info} end
    end
  end
  local have, missing = {}, {}
  local inv = A.entity.get_main_inventory()
  for item, n in pairs(cost) do
    local name, quality = item:match('^(.-)@(.+)$')
    local c = inv.get_item_count(name and {name = name, quality = quality} or item)
    have[item] = c
    if c < n then missing[item] = n - c end
  end
  local charted = Fog.area_charted(surface, force, {{ox, oy}, {ox + w, oy + h}})
  return {
    origin = {x = ox, y = oy}, size = {w = w, h = h}, total = #ents, tiles = #tiles,
    will_place = counts.ok, already = counts.already, already_planned = counts.ghost, replace = counts.replace, blocked = counts.blocked,
    blocked_items = U.list(blocked), replace_items = U.list(replace),
    cost = cost, have = have, missing = missing, charted = charted,
  }, replace_ents
end

-- Загрузить в предмет то, что бот хочет поставить: список, сохранённый чертёж или строку. → списки, угол, размер.
local function load_request(A, stack, p)
  local rot, flip = rot_of(p.rotation), flip_of(p.flip)
  if p.items ~= nil or p.tiles ~= nil then
    if p.items ~= nil and type(p.items) ~= 'table' then U.fail('bad_request', 'items: список построек {name, x, y, direction?}') end
    if rot ~= 0 or flip then U.fail('bad_request', 'поворот и отражение — только для чертежа (blueprint или string); список задаётся готовыми координатами') end
    local ents, tiles, w, h, minx, miny = BP.from_list(stack, p.items, p.tiles)
    return ents, tiles, minx, miny, w, h
  end
  if type(p.x) ~= 'number' or type(p.y) ~= 'number' then U.fail('bad_request', 'нужны x и y — клетка северо-западного угла чертежа') end
  local rec
  if p.string ~= nil then
    U.arg(p.string, 'string', 'string')
    local okc, code = pcall(stack.import_stack, p.string)
    if not okc or code > 0 or not stack.is_blueprint then U.fail('bad_request', 'строка не читается как чертёж (книгу сначала сохрани через blueprint_import)') end
    rec = BP.record(stack, A.name)
  elseif p.blueprint ~= nil then
    rec = BP.find(A, p.blueprint)
  else
    U.fail('bad_request', 'нужно одно из: items (список построек), blueprint (имя сохранённого чертежа), string (строка чертежа)')
  end
  local ents, tiles, w, h = BP.load(stack, rec, rot, flip)
  return ents, tiles, math.floor(p.x), math.floor(p.y), w, h
end

local function marked(surface, area, kind)
  local set = {}
  local filter = {area = area}
  filter[kind] = true
  for _, c in pairs(surface.find_entities_filtered(filter)) do set[c.unit_number or (c.name .. c.position.x .. ',' .. c.position.y)] = c end
  return set
end

Q.register('ghost_place', {
  instant = true, free = true,
  check = function(p)
    U.arg(p.plan, 'string', 'plan', true)
    if p.mode ~= nil and not MODES[p.mode] then U.fail('bad_request', 'mode: normal, forced или superforced') end
    rot_of(p.rotation) flip_of(p.flip)
  end,
  start = function(A, act)
    local p, e = act.p, A.entity
    local surface, force = e.surface, e.force
    if p.plan then Plans.check_owner(p.plan, A.name) end
    return BP.with(function(stack)
      local ents, tiles, ox, oy, w, h = load_request(A, stack, p)
      local area = {{ox, oy}, {ox + w, oy + h}}
      if not Fog.area_charted(surface, force, area) then
        U.fail('not_visible', 'часть области не открыта на карте: план там поставить нельзя')
      end
      local cost = BP.cost_of(stack)
      local report, replace_ents = dry_run(A, surface, force, ents, tiles, ox, oy, w, h, cost)
      local mode = p.mode or 'forced'
      local dec_before, up_before = marked(surface, area, 'to_be_deconstructed'), marked(surface, area, 'to_be_upgraded')
      local created = BP.build(stack, surface, force, ox, oy, w, h, mode)
      if mode == 'forced' and #replace_ents > 0 then
        -- Постройки поверх совместимых (подземный конвейер или разделитель поверх ленты, лента другого вида или направления)
        -- движок в режиме forced молча пропускает. Ставим их отдельным чертежом в режиме superforced, как игрок с зажатыми
        -- Ctrl+Shift: старое помечается на снос или замену, сверху встаёт призрак. Мешать им может только заменяемое.
        local sub = {}
        for i, e in ipairs(replace_ents) do
          local c = {}
          for k, v in pairs(e) do c[k] = v end
          c.entity_number = i
          c.position = {x = e.position.x, y = e.position.y}
          sub[i] = c
        end
        local _, _, sw, sh, sx, sy = BP.normalize(sub, {})
        BP.write(stack, sub, {})
        for _, g in pairs(BP.build(stack, surface, force, ox + sx, oy + sy, sw, sh, 'superforced')) do created[#created + 1] = g end
      end
      local placed, placed_tiles = 0, 0
      for _, g in pairs(created) do
        if g.valid then
          if g.type == 'tile-ghost' then placed_tiles = placed_tiles + 1 else placed = placed + 1 end
          Plans.remember(g, p.plan, A.name)
        end
      end
      -- Пометки сноса и замены, которые поставил этот чертёж, относятся к тому же плану.
      local dec, up = 0, 0
      for k, c in pairs(marked(surface, area, 'to_be_deconstructed')) do
        if not dec_before[k] then dec = dec + 1 Plans.remember(c, p.plan, A.name) end
      end
      for k, c in pairs(marked(surface, area, 'to_be_upgraded')) do
        if not up_before[k] then up = up + 1 Plans.remember(c, p.plan, A.name) end
      end
      report.plan = p.plan
      report.mode = mode
      report.placed, report.placed_tiles = placed, placed_tiles
      report.marked_deconstruct, report.marked_upgrade = dec, up
      report.will_place = nil
      if mode == 'normal' and placed == 0 and placed_tiles == 0 and report.blocked > 0 then
        U.fail('blocked', 'в режиме normal чертёж не ставится, если мешает хоть что-то; см. blocked_items или используй mode: forced', report)
      end
      return report
    end)
  end,
})

-- Области и списки целей для пометок.
local function entities_in(A, p, filter)
  local e = A.entity
  if p.targets ~= nil then
    if type(p.targets) ~= 'table' then U.fail('bad_request', 'targets: список целей') end
    local out = {}
    for _, ref in ipairs(p.targets) do
      local c = T.find(e.surface, ref)
      if c then out[#out + 1] = c end
    end
    return out
  end
  if p.area == nil then U.fail('bad_request', 'нужна area {x1, y1, x2, y2} или targets') end
  local area = B.area_of(p)
  if (area[2][1] - area[1][1]) * (area[2][2] - area[1][2]) > 250000 then U.fail('bad_request', 'area больше 500×500 клеток') end
  filter = filter or {}
  filter.area = area
  return e.surface.find_entities_filtered(filter)
end

local function name_set(v)
  if v == nil then return nil end
  if type(v) == 'string' then v = {v} end
  local s = {}
  for _, n in ipairs(v) do s[n] = true end
  return s
end

Q.register('ghost_clear', {
  instant = true, free = true,
  check = function(p)
    if p.plan == nil and p.area == nil and p.ghosts == nil then U.fail('bad_request', 'нужно plan, area или ghosts') end
  end,
  start = function(A, act)
    local p, e = act.p, A.entity
    local list
    if p.ghosts then
      list = {}
      for _, ref in ipairs(p.ghosts) do
        local g = type(ref.x) == 'number' and e.surface.find_entities_filtered{type = {'entity-ghost', 'tile-ghost'}, position = {ref.x, ref.y}, radius = 0.5, force = e.force, limit = 1}[1]
          or T.find(e.surface, ref)
        if g then list[#list + 1] = g end
      end
    elseif p.area then
      list = entities_in(A, p, {type = {'entity-ghost', 'tile-ghost'}, force = e.force})
    else
      Plans.check_owner(p.plan, A.name)
      list = Plans.entities(p.plan)
    end
    local removed, unmarked, kept = 0, 0, 0
    for _, g in pairs(list) do
      if g.valid then
        local plan = Plans.of(g)
        local mine = plan ~= nil and Plans.owned(plan, A.name)
        local take = (p.plan == nil or plan == p.plan) and (mine or p.all or p.ghosts ~= nil)
        if not take then
          kept = kept + 1
        elseif g.type == 'entity-ghost' or g.type == 'tile-ghost' then
          Plans.forget(g)
          g.destroy{raise_destroy = true}
          removed = removed + 1
        elseif p.plan and not p.area then
          -- План убирается целиком: его пометки сноса и замены тоже снимаются.
          Plans.forget(g)
          if g.to_be_deconstructed() then g.cancel_deconstruction(e.force) end
          if g.to_be_upgraded() then g.cancel_upgrade(e.force) end
          unmarked = unmarked + 1
        end
      end
    end
    return {removed = removed, unmarked = unmarked, kept = kept}
  end,
})

Q.register('mark_deconstruct', {
  instant = true, free = true,
  check = function(p)
    U.arg(p.plan, 'string', 'plan', true)
  end,
  start = function(A, act)
    local p, e = act.p, A.entity
    local force = e.force
    local names = name_set(p.names)
    if p.plan then Plans.check_owner(p.plan, A.name) end
    local by_name, n, skipped = {}, 0, 0
    for _, c in pairs(entities_in(A, p)) do
      if c.valid and c.type ~= 'character' and c.type ~= 'entity-ghost' and c.type ~= 'tile-ghost' and c.type ~= 'resource' then
        local nature = NATURE[c.type] and c.force.name == 'neutral'
        local own = c.force == force
        local match
        if names then
          match = names[c.name] or (names.tree and c.type == 'tree') or (names.rock and c.type == 'simple-entity' and nature)
        else
          match = own or (p.nature and nature)
        end
        if match and (own or nature) and c.prototype.selectable_in_game then
          if p.cancel then
            if c.to_be_deconstructed() then
              c.cancel_deconstruction(force)
              Plans.forget(c)
              n = n + 1
              by_name[c.name] = (by_name[c.name] or 0) + 1
            end
          elseif c.to_be_deconstructed() then
            skipped = skipped + 1
          elseif c.minable and c.order_deconstruction(force) then
            Plans.remember(c, p.plan, A.name)
            n = n + 1
            by_name[c.name] = (by_name[c.name] or 0) + 1
          end
        end
      end
    end
    return {marked = (not p.cancel) and n or nil, unmarked = p.cancel and n or nil, already = skipped, by_name = by_name, plan = p.plan}
  end,
})

Q.register('mark_upgrade', {
  instant = true, free = true,
  check = function(p)
    if not p.cancel then
      U.arg(p.from, 'string', 'from') U.arg(p.to, 'string', 'to')
      if not prototypes.entity[p.from] then U.fail('bad_request', 'нет такой постройки: ' .. p.from) end
      if not prototypes.entity[p.to] then U.fail('bad_request', 'нет такой постройки: ' .. p.to) end
    end
    U.arg(p.plan, 'string', 'plan', true)
  end,
  start = function(A, act)
    local p, e = act.p, A.entity
    local force = e.force
    if p.plan then Plans.check_owner(p.plan, A.name) end
    local n, failed = 0, 0
    for _, c in pairs(entities_in(A, p, {force = force, name = (not p.cancel) and p.from or nil})) do
      if c.valid then
        if p.cancel then
          if c.to_be_upgraded() then
            c.cancel_upgrade(force)
            Plans.forget(c)
            n = n + 1
          end
        elseif c.name == p.from then
          if c.order_upgrade{target = p.to, force = force} then
            Plans.remember(c, p.plan, A.name)
            n = n + 1
          else
            failed = failed + 1
          end
        end
      end
    end
    if not p.cancel and n == 0 and failed > 0 then
      U.fail('not_allowed', 'игра не даёт заменить ' .. p.from .. ' на ' .. p.to .. ': это не совместимые постройки')
    end
    return {marked = (not p.cancel) and n or nil, unmarked = p.cancel and n or nil, plan = p.plan}
  end,
})

-- ── Библиотека чертежей ──

local function summary(name, rec, owner, A)
  return {name = name, owner = owner == BP.TEAM and 'team' or 'me', by = rec.by, w = rec.w, h = rec.h, entities = rec.entities,
    tiles = rec.tiles, cost = rec.cost, label = rec.label}
end

O.register('blueprint_save', {agent = true, write = true, fn = function(A, p)
  U.arg(p.name, 'string', 'name')
  return BP.with(function(stack)
    local _, _, _, _, minx, miny = BP.from_list(stack, p.entities or p.items, p.tiles)
    local rec = BP.record(stack, A.name)
    local owner = BP.store(A, p.name, rec, p.team)
    local s = summary(p.name, rec, owner, A)
    s.origin = {x = minx, y = miny}
    return s
  end)
end})

O.register('blueprint_capture', {agent = true, write = true, fn = function(A, p)
  U.arg(p.name, 'string', 'name')
  local e = A.entity
  local area = B.area_of(p)
  if not Fog.area_charted(e.surface, e.force, area) then U.fail('not_visible', 'часть области не открыта на карте') end
  return BP.with(function(stack)
    stack.create_blueprint{surface = e.surface, force = e.force, area = area, always_include_tiles = p.tiles and true or false,
      include_station_names = true, include_modules = true}
    if not stack.is_blueprint_setup() then U.fail('not_found', 'в области нет построек своей команды') end
    -- Где на карте был северо-западный угол захваченного: нужно для переноса.
    local ents, tiles = BP.read(stack)
    local _, _, _, _, minx, miny = BP.normalize(ents, tiles)
    BP.write(stack, ents, tiles)
    local rec = BP.record(stack, A.name)
    local owner = BP.store(A, p.name, rec, p.team)
    local s = summary(p.name, rec, owner, A)
    s.origin = {x = minx, y = miny}
    return s
  end)
end})

O.register('blueprint_import', {agent = true, write = true, fn = function(A, p)
  U.arg(p.name, 'string', 'name') U.arg(p.string, 'string', 'string')
  return BP.with(function(stack)
    local okc, code = pcall(stack.import_stack, p.string)
    if not okc or code > 0 then U.fail('bad_request', 'строка не читается как чертёж или книга чертежей') end
    local saved = {}
    if stack.is_blueprint_book then
      -- Книга: каждый чертёж сохраняется как «имя/метка».
      local inv = stack.get_inventory(defines.inventory.item_main)
      for i = 1, #inv do
        local b = inv[i]
        if b.valid_for_read and b.is_blueprint and b.is_blueprint_setup() then
          local name = p.name .. '/' .. ((b.label and b.label ~= '') and b.label or tostring(i))
          local rec = BP.record(b, A.name)
          saved[#saved + 1] = summary(name, rec, BP.store(A, name, rec, p.team), A)
        end
      end
      if #saved == 0 then U.fail('bad_request', 'в книге нет чертежей') end
    elseif stack.is_blueprint then
      local rec = BP.record(stack, A.name)
      saved[1] = summary(p.name, rec, BP.store(A, p.name, rec, p.team), A)
    else
      U.fail('bad_request', 'это не чертёж и не книга чертежей')
    end
    return {saved = saved}
  end)
end})

O.register('blueprint_export', {agent = true, fn = function(A, p)
  if p.names ~= nil then
    -- Несколько чертежей одной книгой.
    if type(p.names) ~= 'table' or #p.names == 0 then U.fail('bad_request', 'names: список имён чертежей') end
    return BP.with(function(book, inv)
      book.label = p.book or 'Чертежи ботов'
      local binv = book.get_inventory(defines.inventory.item_main)
      inv.insert{name = 'blueprint', count = 1}
      local tmp = inv[2]
      for _, name in ipairs(p.names) do
        local rec = BP.find(A, name)
        tmp.import_stack(rec.string)
        tmp.label = name
        binv.insert(tmp)
      end
      return {string = book.export_stack(), blueprints = #p.names}
    end, 'blueprint-book')
  end
  U.arg(p.name, 'string', 'name')
  local rec = BP.find(A, p.name)
  return BP.with(function(stack)
    stack.import_stack(rec.string)
    stack.label = p.name
    return {name = p.name, string = stack.export_stack(), w = rec.w, h = rec.h}
  end)
end})

O.register('blueprint_list', {agent = true, fn = function(A)
  local out = {}
  for _, owner in ipairs{A.name, BP.TEAM} do
    for name, rec in pairs(storage.agent.blueprints[owner] or {}) do out[#out + 1] = summary(name, rec, owner, A) end
  end
  table.sort(out, function(a, b) return a.name < b.name end)
  return {blueprints = U.list(out)}
end})

O.register('blueprint_get', {agent = true, fn = function(A, p)
  U.arg(p.name, 'string', 'name')
  local rec, owner = BP.find(A, p.name)
  return BP.with(function(stack)
    local ents, tiles, w, h = BP.load(stack, rec, rot_of(p.rotation), flip_of(p.flip))
    local list, tl = {}, {}
    for i, e in ipairs(ents) do
      local c = {}
      for k, v in pairs(e) do
        if k ~= 'position' and k ~= 'entity_number' and k ~= 'direction' then c[k] = v end
      end
      c.x, c.y = e.position.x, e.position.y
      if e.direction then c.direction = U.dirname(e.direction) end
      list[i] = c
    end
    for i, t in ipairs(tiles) do tl[i] = {name = t.name, x = t.position.x, y = t.position.y} end
    local s = summary(p.name, rec, owner, A)
    s.w, s.h = w, h
    s.items, s.tile_items = U.list(list), U.list(tl)
    return s
  end)
end})

O.register('blueprint_delete', {agent = true, write = true, fn = function(A, p)
  U.arg(p.name, 'string', 'name')
  local rec, owner = BP.find(A, p.name)
  if owner == BP.TEAM and rec.by ~= A.name then U.fail('not_allowed', 'общий чертёж может удалить только автор (' .. tostring(rec.by) .. ')') end
  BP.remove(owner, p.name)
  return {deleted = p.name}
end})

-- Проверка без постановки: что встанет, что упирается во что, сколько стоит, чего не хватает в инвентаре.
O.register('blueprint_check', {agent = true, fn = function(A, p)
  local e = A.entity
  return BP.with(function(stack)
    local ents, tiles, ox, oy, w, h = load_request(A, stack, p)
    return (dry_run(A, e.surface, e.force, ents, tiles, ox, oy, w, h, BP.cost_of(stack)))
  end)
end})

-- ── Запрос ghosts: планы, призраки и пометки, стоимость ──

local function kind_of(c)
  if c.type == 'entity-ghost' then return 'ghost' end
  if c.type == 'tile-ghost' then return 'tile' end
  if c.to_be_deconstructed() then return 'deconstruct' end
  if c.to_be_upgraded() then return 'upgrade' end
  return nil
end

local function add_cost(cost, proto, quality)
  local s = proto and proto.items_to_place_this and proto.items_to_place_this[1]
  if s then
    local k = U.item_key(s.name, quality)
    cost[k] = (cost[k] or 0) + (s.count or 1)
  end
end

-- Что призрак заменит на месте: постройка под ним, помеченная на снос, того же семейства (лента → подземный конвейер,
-- разделитель; та же постройка в другую сторону). build_ghosts ставит такой призрак быстрой заменой, сносить заранее не надо.
local function replaced_by(g)
  local group = g.ghost_prototype.fast_replaceable_group
  if not group then return nil end
  local w, h = BP.footprint(g.ghost_name, g.direction)
  local x, y = g.position.x, g.position.y
  for _, c in pairs(g.surface.find_entities_filtered{area = {{x - w / 2 + 0.1, y - h / 2 + 0.1}, {x + w / 2 - 0.1, y + h / 2 - 0.1}},
      force = g.force, to_be_deconstructed = true}) do
    if c.prototype.fast_replaceable_group == group then return c.name end
  end
end

local function describe_list(A, list, p)
  local by_kind, cost, items = {ghost = 0, tile = 0, deconstruct = 0, upgrade = 0}, {}, {}
  local limit, offset = math.min(p.limit or 200, 2000), p.offset or 0
  local minx, miny, maxx, maxy
  local n = 0
  for _, c in pairs(list) do
    local kind = c.valid and kind_of(c)
    if kind then
      n = n + 1
      by_kind[kind] = by_kind[kind] + 1
      local q = c.quality and c.quality.name
      if kind == 'ghost' or kind == 'tile' then add_cost(cost, c.ghost_prototype, q)
      elseif kind == 'upgrade' then add_cost(cost, c.get_upgrade_target(), q) end
      local x, y = c.position.x, c.position.y
      minx, miny = math.min(minx or x, x), math.min(miny or y, y)
      maxx, maxy = math.max(maxx or x, x), math.max(maxy or y, y)
      if n > offset and #items < limit then
        local r = {kind = kind, name = (kind == 'ghost' or kind == 'tile') and c.ghost_name or c.name, x = x, y = y, unit = c.unit_number,
          plan = Plans.of(c)}
        if c.supports_direction then r.direction = U.dirname(c.direction) end
        if kind == 'upgrade' then local t = c.get_upgrade_target() r.to = t and t.name end
        if kind == 'ghost' then
          r.replaces = replaced_by(c)
        end
        items[#items + 1] = r
      end
    end
  end
  local have, missing = {}, {}
  local inv = A.entity.get_main_inventory()
  for item, need in pairs(cost) do
    local name, quality = item:match('^(.-)@(.+)$')
    local c = inv.get_item_count(name and {name = name, quality = quality} or item)
    have[item] = c
    if c < need then missing[item] = need - c end
  end
  return {total = n, ghosts = by_kind.ghost, tiles = by_kind.tile, deconstruct = by_kind.deconstruct, upgrade = by_kind.upgrade,
    bounds = minx and {x1 = minx, y1 = miny, x2 = maxx, y2 = maxy} or nil, cost = cost, have = have, missing = missing,
    items = U.list(items), more = (n > offset + #items) or nil}
end

O.register('ghosts', {agent = true, fn = function(A, p)
  local e = A.entity
  if p.plan == nil and p.area == nil then
    -- Список планов.
    local out = {}
    for name, pl in pairs(storage.agent.plans) do
      local list = Plans.entities(name)
      if #list > 0 or (pl.done and game.tick - pl.done < 216000) then
        local r = {name = name, by = pl.by, left = #list, done = (#list == 0) or nil}
        local minx, miny, maxx, maxy
        for _, c in pairs(list) do
          local x, y = c.position.x, c.position.y
          minx, miny = math.min(minx or x, x), math.min(miny or y, y)
          maxx, maxy = math.max(maxx or x, x), math.max(maxy or y, y)
        end
        if minx then r.bounds = {x1 = minx, y1 = miny, x2 = maxx, y2 = maxy} end
        out[#out + 1] = r
      end
    end
    table.sort(out, function(a, b) return a.name < b.name end)
    Plans.prune(216000)
    return {plans = U.list(out)}
  end
  local list
  if p.area then
    local area = B.area_of(p)
    list = e.surface.find_entities_filtered{area = area, type = {'entity-ghost', 'tile-ghost'}, force = e.force}
    for _, c in pairs(e.surface.find_entities_filtered{area = area, to_be_deconstructed = true}) do list[#list + 1] = c end
    for _, c in pairs(e.surface.find_entities_filtered{area = area, to_be_upgraded = true, force = e.force}) do list[#list + 1] = c end
    if p.plan then
      local only = {}
      for _, c in pairs(list) do if Plans.of(c) == p.plan then only[#only + 1] = c end end
      list = only
    end
  else
    list = Plans.entities(p.plan)
  end
  local r = describe_list(A, list, p)
  r.plan = p.plan
  if p.plan then
    local pl = storage.agent.plans[p.plan]
    r.by = pl and pl.by
    if not pl then r.unknown_plan = true end
  end
  return r
end})
