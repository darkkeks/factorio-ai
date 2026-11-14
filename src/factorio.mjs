// MCP-инструменты для управления персонажем на сервере Factorio. У каждой сессии Claude свой экземпляр,
// привязанный к одному персонажу. Всё делается Lua-командами через RCON; модов на сервере нет.
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { lua } from './rcon.mjs';
import { submitFeedback } from './feedback.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Общая часть каждой команды. A — аргументы вызова (A.bot — имя персонажа).
const PRELUDE = `
storage.vb = storage.vb or {}
storage.vb_kit = storage.vb_kit or {}
local function fail(m) error(m, 0) end
local function bot()
  local e = storage.vb[A.bot]
  if e and e.valid then return e end
  local S = game.surfaces.nauvis
  local F = game.forces.player
  e = S.create_entity{name='character', position=S.find_non_colliding_position('character', F.get_spawn_position(S), 40, 0.5), force=F}
  storage.vb[A.bot] = e
  if not storage.vb_kit[A.bot] then
    storage.vb_kit[A.bot] = true
    e.insert{name='iron-plate', count=8} e.insert{name='wood', count=1}
    e.insert{name='burner-mining-drill', count=1} e.insert{name='stone-furnace', count=1}
  end
  rendering.draw_text{text=A.bot, target={entity=e, offset={0,-2.6}}, surface=S, color={1,0.8,0.2}, alignment='center', scale=1.3}
  return e
end
local function r1(v) return math.floor(v*10+0.5)/10 end
local function P(p) return {x=r1(p.x), y=r1(p.y)} end
local function dist(a, b) return ((a.x-b.x)^2+(a.y-b.y)^2)^0.5 end
local function contents(i) local r = {} if i then for _, s in pairs(i.get_contents()) do r[s.name] = (r[s.name] or 0) + s.count end end return r end
local SKIP = {character=true, corpse=true, ['character-corpse']=true, ['item-entity']=true, fish=true}
local function at(e, x, y)
  local res
  for _, c in pairs(e.surface.find_entities_filtered{area={{x-0.45,y-0.45},{x+0.45,y+0.45}}}) do
    if c.type == 'resource' then res = c elseif not SKIP[c.type] and c.prototype.selectable_in_game then return c end
  end
  if res then return res end
  fail('в точке '..x..','..y..' ничего нет')
end
local function reach(e, t, d) if dist(e.position, t.position or t) > (d or 10) then fail('слишком далеко, подойди ближе') end end
local function dirname(d) for k, v in pairs(defines.direction) do if v == d then return k end end end
local function status_of(t)
  local r
  pcall(function() for k, v in pairs(defines.entity_status) do if v == t.status then r = k end end end)
  return r
end
local function tile(p) return {x=math.floor(p.x)+0.5, y=math.floor(p.y)+0.5} end
local function thing(s, p)
  for _, c in pairs(s.find_entities_filtered{position=p}) do if not SKIP[c.type] and c.type ~= 'resource' then return c.name end end
  return 'земля'
end
local function arm(t)
  return {pos=tile(t.pickup_position), what=thing(t.surface, t.pickup_position)}, {pos=tile(t.drop_position), what=thing(t.surface, t.drop_position)}
end
local BELT = {['transport-belt']=true, ['underground-belt']=true, splitter=true}
-- Полосы конвейера: у всех видов нечётные линии — левая полоса по ходу движения, чётные — правая.
local function belt_lanes(t)
  local l = {left={}, right={}}
  for i = 1, t.get_max_transport_line_index() do
    local side = i % 2 == 1 and l.left or l.right
    for k, v in pairs(contents(t.get_transport_line(i))) do side[k] = (side[k] or 0) + v end
  end
  return l
end
local function belt_items(t)
  local r = {}
  for _, side in pairs(belt_lanes(t)) do for k, v in pairs(side) do r[k] = (r[k] or 0) + v end end
  return r
end
`;

const BODY = {
  ensure: `local e = bot() return {pos=P(e.position)}`,

  status: `
    local e = bot()
    local players = {}
    for _, p in pairs(game.connected_players) do players[#players+1] = {name=p.name, pos=P(p.position), dist=r1(dist(p.position, e.position))} end
    local bots = {}
    for n, b in pairs(storage.vb) do if b.valid and n ~= A.bot then bots[#bots+1] = {name=n, pos=P(b.position)} end end
    local crafting = {}
    if e.crafting_queue_size > 0 then for _, q in pairs(e.crafting_queue or {}) do crafting[#crafting+1] = {recipe=q.recipe, count=q.count} end end
    return {me=A.bot, pos=P(e.position), health=math.floor(e.health), inventory=contents(e.get_main_inventory()),
      crafting_queue=e.crafting_queue_size, crafting=crafting, players_in_game=players, other_bots=bots,
      research=e.force.current_research and e.force.current_research.name or nil}`,

  pos: `local e = bot() return {x=e.position.x, y=e.position.y, queue=e.crafting_queue_size}`,

  player_pos: `
    local p = game.players[A.player]
    if not p or not p.connected then fail('игрок '..A.player..' не в игре') end
    return {x=p.position.x, y=p.position.y}`,

  step: `
    local e = bot()
    local d = dist(e.position, A)
    if d <= A.tol then e.walking_state = {walking=false, direction=e.walking_state.direction} return {done=true, x=e.position.x, y=e.position.y} end
    local idx = math.floor(math.atan2(A.x-e.position.x, -(A.y-e.position.y))/(math.pi/4)+0.5) % 8
    e.walking_state = {walking=true, direction=idx*2}
    return {x=e.position.x, y=e.position.y}`,

  stop: `local e = bot() e.walking_state = {walking=false, direction=e.walking_state.direction} return {x=e.position.x, y=e.position.y}`,

  // Обход препятствий: A* по клеткам от персонажа (проверяется только «можно ли здесь стоять»), идёт он потом сам, пешком.
  // Если до цели не дотянулись за лимит узлов, возвращается путь до самой близкой к цели достигнутой клетки.
  path: `
    local e = bot()
    local s = e.surface
    local sx, sy = math.floor(e.position.x), math.floor(e.position.y)
    local function key(x, y) return (x+1000000)*4000000 + (y+1000000) end
    local fc = {}
    local function free(x, y)
      local k = key(x, y)
      local v = fc[k]
      if v == nil then v = s.can_place_entity{name='character', position={x+0.5, y+0.5}} fc[k] = v end
      return v
    end
    local function h(x, y) local dx, dy = math.abs(x+0.5-A.x), math.abs(y+0.5-A.y) return math.max(dx, dy) + 0.41*math.min(dx, dy) end
    local heap, n = {}, 0
    local function push(f, x, y)
      n = n + 1
      local i = n
      heap[i] = {f, x, y}
      while i > 1 do
        local p = math.floor(i/2)
        if heap[p][1] <= heap[i][1] then break end
        heap[p], heap[i] = heap[i], heap[p]
        i = p
      end
    end
    local function pop()
      local top = heap[1]
      heap[1] = heap[n] heap[n] = nil n = n - 1
      local i = 1
      while true do
        local l, r, m = i*2, i*2+1, i
        if l <= n and heap[l][1] < heap[m][1] then m = l end
        if r <= n and heap[r][1] < heap[m][1] then m = r end
        if m == i then break end
        heap[m], heap[i] = heap[i], heap[m]
        i = m
      end
      return top
    end
    local g, from, closed = {[key(sx, sy)]=0}, {}, {}
    push(h(sx, sy), sx, sy)
    local goal, best, bh, expanded = nil, nil, h(sx, sy), 0
    while n > 0 and expanded < 2500 do
      local c = pop()
      local x, y = c[2], c[3]
      local k = key(x, y)
      if not closed[k] then
        closed[k] = true
        expanded = expanded + 1
        if dist({x=x+0.5, y=y+0.5}, A) <= A.tol then goal = {x, y} break end
        if h(x, y) < bh - 0.01 then bh = h(x, y) best = {x, y} end
        for dx = -1, 1 do for dy = -1, 1 do
          local nx, ny = x+dx, y+dy
          local nk = key(nx, ny)
          if (dx ~= 0 or dy ~= 0) and not closed[nk] and free(nx, ny) and (dx == 0 or dy == 0 or (free(nx, y) and free(x, ny))) then
            local cost = (dx ~= 0 and dy ~= 0) and 1.41 or 1
            if not (free(nx+1, ny) and free(nx-1, ny) and free(nx, ny+1) and free(nx, ny-1)) then cost = cost + 1.5 end
            local ng = g[k] + cost
            if not g[nk] or ng < g[nk] then g[nk] = ng from[nk] = {x, y} push(ng + h(nx, ny), nx, ny) end
          end
        end end
      end
    end
    local last = goal or best
    local rev = {}
    local c = last
    while c and not (c[1] == sx and c[2] == sy) do rev[#rev+1] = c c = from[key(c[1], c[2])] end
    local pts = {}
    for i = #rev, 1, -1 do pts[#pts+1] = {x=rev[i][1]+0.5, y=rev[i][2]+0.5} end
    return {found=goal ~= nil, count=#pts, points=pts}`,

  look: `
    local e = bot()
    local groups, list = {}, {}
    for _, c in pairs(e.surface.find_entities_filtered{position=e.position, radius=A.radius}) do
      if not SKIP[c.type] and c.type ~= 'cliff' and c.prototype.selectable_in_game then
        local key = c.name
        if c.type == 'tree' then key = 'tree' elseif c.force.name == 'enemy' then key = 'ВРАГ '..c.name end
        local g = groups[key]
        local d = dist(c.position, e.position)
        if not g then g = {name=key, count=0, dist=d, nearest=P(c.position)} groups[key] = g list[#list+1] = g end
        g.count = g.count + 1
        if c.type == 'resource' then g.amount = (g.amount or 0) + c.amount end
        if d < g.dist then g.dist = d g.nearest = P(c.position) end
      end
    end
    table.sort(list, function(a, b) return a.dist < b.dist end)
    local out = {}
    for i = 1, math.min(#list, 40) do list[i].dist = r1(list[i].dist) out[i] = list[i] end
    return {me=P(e.position), radius=A.radius, objects=out}`,

  find: `
    local e = bot()
    local f = {position=e.position, radius=A.radius, limit=20000}
    if A.name == 'tree' then f.type = 'tree' elseif prototypes.entity[A.name] then f.name = A.name
    else fail('нет объекта с именем '..A.name..' (нужно внутреннее имя, например iron-ore, stone-furnace, tree)') end
    local found = e.surface.find_entities_filtered(f)
    table.sort(found, function(a, b) return dist(a.position, e.position) < dist(b.position, e.position) end)
    local out = {}
    for i = 1, math.min(#found, 5) do local c = found[i] out[i] = {pos=P(c.position), dist=r1(dist(c.position, e.position)), amount=c.type == 'resource' and c.amount or nil} end
    return {name=A.name, total_found=#found, radius=A.radius, nearest=out}`,

  inspect: `
    local e = bot()
    local t = at(e, A.x, A.y)
    local r = {name=t.name, type=t.type, pos=P(t.position), dist=r1(dist(t.position, e.position))}
    if t.type == 'resource' then r.amount = t.amount return r end
    r.direction = t.supports_direction and dirname(t.direction) or nil
    if t.health then r.health = math.floor(t.health) end
    pcall(function() local rc = t.get_recipe() if rc then r.recipe = rc.name end end)
    r.status = status_of(t)
    if t.type == 'inserter' then
      r.takes_from, r.puts_to = arm(t)
      pcall(function() if t.held_stack.valid_for_read then r.holding = t.held_stack.name end end)
    end
    if BELT[t.type] then r.on_belt = belt_items(t) r.lanes = belt_lanes(t) end
    if t.type == 'underground-belt' then r.underground = t.belt_to_ground_type == 'input' and 'вход под землю' or 'выход из-под земли' end
    pcall(function() r.crafting_progress = r1(t.crafting_progress) end)
    pcall(function() if t.mining_target then r.mining_target = t.mining_target.name end end)
    local inv = {}
    pcall(function() for i = 1, t.get_max_inventory_index() do local c = contents(t.get_inventory(i)) if next(c) then for k, v in pairs(c) do inv[k] = (inv[k] or 0) + v end end end end)
    r.items = BELT[t.type] and r.on_belt or inv
    pcall(function() if t.burner then r.fuel_left = t.burner.remaining_burning_fuel > 0 or next(contents(t.burner.inventory)) ~= nil end end)
    return r`,

  mine: `
    local e = bot()
    local best, bd
    for _, c in pairs(e.surface.find_entities_filtered{position={A.x, A.y}, radius=1.6, type={'resource', 'tree', 'simple-entity'}}) do
      local d = dist(c.position, A)
      if c.minable and (not bd or d < bd) then best, bd = c, d end
    end
    if not best then return {done=true, reason='здесь больше нечего добывать'} end
    reach(e, best, 4)
    local name = best.name
    local before = e.get_main_inventory().get_item_count()
    e.mine_entity(best, true)
    local got = e.get_main_inventory().get_item_count() - before
    if got <= 0 then return {done=true, reason='не добывается руками или инвентарь полон', name=name} end
    return {name=name, got=got}`,

  craft: `
    local e = bot()
    local rc = e.force.recipes[A.recipe]
    if not rc then fail('нет рецепта '..A.recipe) end
    if not rc.enabled then fail('рецепт '..A.recipe..' ещё не исследован') end
    local can = e.get_craftable_count(rc)
    local function report(n)
      local list, short = {}, false
      for _, i in pairs(rc.ingredients) do
        if i.type == 'fluid' then list[#list+1] = {item=i.name, need=i.amount*n, have=0} short = true
        else
          local have = e.get_item_count(i.name)
          list[#list+1] = {item=i.name, need=i.amount*n, have=have}
          if have < i.amount*n then short = true end
        end
      end
      return list, short
    end
    if can < 1 then
      local list, short = report(1)
      if not short then fail('рецепт '..A.recipe..' нельзя скрафтить руками (нужна машина)') end
      local need = {}
      for _, i in pairs(list) do need[#need+1] = i.item..': нужно '..i.need..', есть '..i.have end
      fail('не хватает ингредиентов на одну штуку. '..table.concat(need, '; ')..'. Промежуточные предметы крафтятся сами, если на них хватает сырья')
    end
    local list = report(A.count)
    local n = e.begin_crafting{recipe=rc, count=math.min(A.count, can)}
    local r = {queued=n, asked=A.count, queue_size=e.crafting_queue_size}
    if n < A.count then r.ingredients_for_asked = list end
    return r`,

  place: `
    local e = bot()
    local ip = prototypes.item[A.item]
    if not ip then fail('нет предмета '..A.item) end
    if e.get_item_count(A.item) < 1 then fail('в инвентаре нет '..A.item) end
    local pr = ip.place_result
    if not pr then fail(A.item..' нельзя поставить на землю') end
    reach(e, A, 10)
    local dir = defines.direction[A.direction]
    local s = e.surface
    if not s.can_place_entity{name=pr.name, position={A.x, A.y}, direction=dir, force=e.force, build_check_type=defines.build_check_type.manual} then
      fail('сюда поставить нельзя (занято, не та поверхность или нет руды под буром)')
    end
    local kind
    -- Ближайший такой же подземный конвейер, смотрящий туда же: sign=-1 — позади по ходу, sign=1 — впереди.
    local function ug_near(p, sign)
      local v = dir == defines.direction.north and {0,-1} or dir == defines.direction.east and {1,0} or dir == defines.direction.south and {0,1} or {-1,0}
      for k = 1, pr.max_underground_distance do
        local o = s.find_entities_filtered{name=pr.name, position={p.x+v[1]*k*sign, p.y+v[2]*k*sign}}[1]
        if o and o.direction == dir then return o end
      end
    end
    if pr.type == 'underground-belt' then
      -- Как в игре: подземный конвейер ставится входом, а если позади него по ходу в пределах дальности
      -- стоит такой же вход, смотрящий туда же, — выходом. Явный A.underground важнее.
      kind = A.underground
      if not kind then
        local o = ug_near(A, -1)
        kind = (o and o.belt_to_ground_type == 'input') and 'output' or 'input'
      end
    end
    local n = s.create_entity{name=pr.name, position={A.x, A.y}, direction=dir, force=e.force, raise_built=true, type=kind}
    e.remove_item{name=A.item, count=1}
    local r = {placed=n.name, pos=P(n.position), direction=A.direction, left=e.get_item_count(A.item)}
    if n.type == 'underground-belt' then
      r.underground = n.belt_to_ground_type == 'input' and 'вход под землю' or 'выход из-под земли'
      local o = ug_near(n.position, n.belt_to_ground_type == 'input' and 1 or -1)
      if o and o.belt_to_ground_type ~= n.belt_to_ground_type then r.paired_with = P(o.position)
      else r.paired_with = n.belt_to_ground_type == 'input' and 'пары нет: впереди по ходу в пределах дальности нужен выход' or 'пары нет: позади по ходу в пределах дальности нужен вход' end
    end
    if n.type == 'inserter' then r.takes_from, r.puts_to = arm(n) end
    return r`,

  targets: `
    local e = bot()
    if not prototypes.entity[A.name] then fail('нет объекта с именем '..A.name..' (нужно внутреннее имя, например stone-furnace)') end
    local out = {}
    for _, c in pairs(e.surface.find_entities_filtered{name=A.name, position=e.position, radius=A.radius, force=e.force, limit=200}) do out[#out+1] = {x=c.position.x, y=c.position.y} end
    return {count=#out, list=out}`,

  pick_up: `
    local e = bot()
    local t = at(e, A.x, A.y)
    if t.type == 'resource' then fail('это ресурс, его добывают инструментом mine') end
    reach(e, t, 10)
    local name = t.name
    if not e.mine_entity(t, false) then fail('не получилось забрать (нет места в инвентаре?)') end
    return {picked_up=name}`,

  insert: `
    local e = bot()
    local t = at(e, A.x, A.y)
    reach(e, t, 10)
    local have = e.get_item_count(A.item)
    if have < 1 then fail('в инвентаре нет '..A.item) end
    local n = 0
    if t.type == 'transport-belt' then
      -- На ленту предметы кладутся по одному в начало каждой полосы, если там свободно.
      for i = 1, 2 do
        local line = t.get_transport_line(i)
        if n < math.min(have, A.count) and line.can_insert_at_back() and line.insert_at_back({name=A.item, count=1}) then n = n + 1 end
      end
    else n = t.insert{name=A.item, count=math.min(have, A.count)} end
    if n < 1 then fail(t.name..' не принимает '..A.item..' (не подходит или нет места)') end
    e.remove_item{name=A.item, count=n}
    return {inserted=n, item=A.item, into=t.name}`,

  take: `
    local e = bot()
    local t = at(e, A.x, A.y)
    reach(e, t, 10)
    local invs = {}
    if A.item then for i = 1, t.get_max_inventory_index() do local v = t.get_inventory(i) if v then invs[#invs+1] = v end end
    else local v = t.get_output_inventory() if v then invs[1] = v end end
    local taken, left = {}, A.count
    if BELT[t.type] then
      for i = 1, t.get_max_transport_line_index() do
        local line = t.get_transport_line(i)
        for _, s in pairs(line.get_contents()) do
          if left > 0 and (not A.item or s.name == A.item) then
            local n = math.min(s.count, left)
            if e.can_insert{name=s.name, count=n, quality=s.quality} then
              n = line.remove_item{name=s.name, count=n, quality=s.quality}
              if n > 0 then e.insert{name=s.name, count=n, quality=s.quality} taken[s.name] = (taken[s.name] or 0) + n left = left - n end
            end
          end
        end
      end
    end
    for _, v in pairs(invs) do
      for _, s in pairs(v.get_contents()) do
        if left > 0 and (not A.item or s.name == A.item) then
          local n = e.insert{name=s.name, count=math.min(s.count, left), quality=s.quality}
          if n > 0 then v.remove{name=s.name, count=n, quality=s.quality} taken[s.name] = (taken[s.name] or 0) + n left = left - n end
        end
      end
    end
    if not next(taken) then fail('забирать нечего') end
    return {taken=taken, from=t.name}`,

  set_recipe: `
    local e = bot()
    local t = at(e, A.x, A.y)
    reach(e, t, 10)
    local rc = e.force.recipes[A.recipe]
    if not rc or not rc.enabled then fail('рецепт '..A.recipe..' недоступен') end
    for _, s in pairs(t.set_recipe(rc)) do e.insert(s) end
    return {entity=t.name, recipe=A.recipe}`,

  rotate: `
    local e = bot()
    local t = at(e, A.x, A.y)
    reach(e, t, 10)
    t.direction = defines.direction[A.direction]
    local r = {entity=t.name, direction=A.direction}
    if t.type == 'inserter' then r.takes_from, r.puts_to = arm(t) end
    return r`,

  research: `
    local f = bot().force
    local function queued(t) for _, q in pairs(f.research_queue) do if q.name == t.name then return true end end return false end
    local res = {}
    if A.technology then
      local t = f.technologies[A.technology]
      if not t then fail('нет технологии '..A.technology) end
      if t.researched then res.added = false res.reason = 'уже исследована'
      elseif queued(t) then res.added = false res.reason = 'уже в очереди'
      elseif not t.enabled then res.added = false res.reason = 'технология недоступна'
      elseif t.prototype.research_trigger then res.added = false res.reason = 'открывается не колбами, а действием в игре'
      else
        local miss = {}
        for _, p in pairs(t.prerequisites) do if not p.researched and not queued(p) then miss[#miss+1] = p.name end end
        f.add_research(t)
        res.added = queued(t)
        if not res.added then res.reason = #miss > 0 and ('сначала нужны: '..table.concat(miss, ', ')) or 'игра не приняла (очередь заполнена?)' end
      end
    end
    local cur = f.current_research
    local queue = {}
    for _, t in pairs(f.research_queue) do
      local pr = (cur and cur.name == t.name) and f.research_progress or t.saved_progress
      local packs = {}
      for _, i in pairs(t.research_unit_ingredients) do packs[i.name] = i.amount end
      local units = t.research_unit_count
      queue[#queue+1] = {name=t.name, packs_per_unit=packs, units=units, units_left=math.ceil(units*(1-pr)-0.0001),
        seconds_per_unit=r1(t.research_unit_energy/60), progress=math.floor(pr*1000+0.5)/1000}
    end
    local avail = {}
    for name, t in pairs(f.technologies) do
      if t.enabled and not t.researched and #avail < 40 then
        local ok = true
        for _, p in pairs(t.prerequisites) do if not p.researched then ok = false end end
        if ok then avail[#avail+1] = name end
      end
    end
    res.current = cur and cur.name or nil
    res.progress = r1(f.research_progress)
    res.queue = queue
    res.available = avail
    return res`,

  power: `
    local e = bot()
    local pole
    if A.x and A.y then
      pole = at(e, A.x, A.y)
      if pole.type ~= 'electric-pole' then fail('в этой точке не столб, а '..pole.name) end
      if dist(pole.position, e.position) > 60 then fail('слишком далеко: сеть видно по столбу в радиусе 60') end
    else
      local bd
      for _, c in pairs(e.surface.find_entities_filtered{type='electric-pole', position=e.position, radius=60, force=e.force}) do
        local d = dist(c.position, e.position)
        if not bd or d < bd then pole, bd = c, d end
      end
      if not pole then fail('в радиусе 60 нет ни одного столба') end
    end
    local id = pole.electric_network_id
    local st = pole.electric_network_statistics
    local idx = defines.flow_precision_index.five_seconds
    local function flows(counts, cat)
      local list, total = {}, 0
      for name in pairs(counts) do
        local w = st.get_flow_count{name=name, category=cat, precision_index=idx} * 60
        if w > 0 then list[#list+1] = {name=name, kw=r1(w/1000)} total = total + w end
      end
      table.sort(list, function(a, b) return a.kw > b.kw end)
      local out = {}
      for i = 1, math.min(#list, 15) do out[i] = list[i] end
      return out, r1(total/1000)
    end
    local r = {pole={name=pole.name, pos=P(pole.position)}, radius=A.radius, window='среднее за 5 секунд'}
    r.production, r.production_kw = flows(st.output_counts, 'output')
    r.consumption, r.consumption_kw = flows(st.input_counts, 'input')
    local SRC = {generator=true, boiler=true, ['solar-panel']=true, reactor=true, ['burner-generator']=true, ['offshore-pump']=true}
    local sources, problems, acc, cap, ok, low, other = {}, {}, 0, 0, 0, 0, 0
    for _, c in pairs(e.surface.find_entities_filtered{position=e.position, radius=A.radius, force=e.force}) do
      if SRC[c.type] then
        local k = c.name..': '..(status_of(c) or '?')
        sources[k] = (sources[k] or 0) + 1
      elseif c.type == 'accumulator' then
        if c.electric_network_id == id then acc = acc + c.energy cap = cap + c.electric_buffer_size end
      elseif c.type ~= 'electric-pole' and c.prototype.electric_energy_source_prototype then
        local stt = status_of(c)
        local nid
        pcall(function() nid = c.electric_network_id end)
        if stt == 'no_power' or stt == 'low_power' or nid == nil then
          if stt == 'low_power' then low = low + 1 end
          if #problems < 40 then problems[#problems+1] = {name=c.name, pos=P(c.position), status=nid == nil and 'не подключён к сети' or stt} end
        elseif nid == id then ok = ok + 1 else other = other + 1 end
      end
    end
    r.sources_nearby = sources
    if cap > 0 then r.accumulators_charge_percent = math.floor(acc/cap*100) end
    r.machines_powered_ok = ok
    r.machines_in_other_networks = other
    r.machines_without_power = problems
    r.shortage = low > 0
    return r`,

  belt: `
    local e = bot()
    local t = at(e, A.x, A.y)
    if not BELT[t.type] then fail('в этой точке не конвейер, а '..t.name) end
    if dist(t.position, e.position) > 60 then fail('слишком далеко: конвейер видно в радиусе 60') end
    local function vec(d) return d == defines.direction.north and {0,-1} or d == defines.direction.east and {1,0} or d == defines.direction.south and {0,1} or {-1,0} end
    local function nexts(c, down)
      if c.type == 'underground-belt' and (c.belt_to_ground_type == 'input') == down then
        -- Парный конец подземного конвейера: ближайший такой же по ходу, смотрящий туда же.
        local v = vec(c.direction)
        local sign = down and 1 or -1
        for k = 1, c.prototype.max_underground_distance do
          local o = e.surface.find_entities_filtered{name=c.name, position={c.position.x+v[1]*k*sign, c.position.y+v[2]*k*sign}}[1]
          if o and o.direction == c.direction then
            if o.belt_to_ground_type ~= c.belt_to_ground_type then return {o} end
            return {}
          end
        end
        return {}
      end
      local nb = c.belt_neighbours
      return down and nb.outputs or nb.inputs
    end
    -- Сначала вверх по течению от указанной точки (на слиянии — по прямой), потом вниз; линия всегда проходит через точку.
    local seen = {[t.unit_number]=true}
    local up = {}
    local head = t
    for i = 1, 200 do
      local ins = nexts(head, false)
      local pick = ins[1]
      for _, c in pairs(ins) do if c.direction == head.direction then pick = c end end
      if not pick or seen[pick.unit_number] or dist(pick.position, e.position) > 60 then break end
      seen[pick.unit_number] = true
      up[#up+1] = pick
      head = pick
    end
    local sections, branches, total, n = {}, {}, {}, 0
    local cur, prev, ends
    local c = head
    local ui = #up
    seen = {}
    while c do
      if seen[c.unit_number] then ends = 'кольцо: лента замкнута' break end
      if dist(c.position, e.position) > 60 then ends = 'дальше не видно (больше 60 клеток от тебя)' break end
      if n >= 400 then ends = 'дальше не смотрел (400 звеньев)' break end
      seen[c.unit_number] = true
      n = n + 1
      if not cur or cur.direction ~= dirname(c.direction) or cur.belts >= A.section then
        cur = {from=P(c.position), direction=dirname(c.direction), belts=0, items={}}
        sections[#sections+1] = cur
      end
      cur.to = P(c.position)
      cur.belts = cur.belts + 1
      for k, v in pairs(belt_items(c)) do cur.items[k] = (cur.items[k] or 0) + v total[k] = (total[k] or 0) + v end
      local outs = nexts(c, true)
      -- Пока не дошли до указанной точки, следующее звено известно из прохода вверх; дальше на развилке берём первый выход.
      local nxt = outs[1]
      ui = ui - 1
      if ui >= 1 then nxt = up[ui] elseif ui == 0 then nxt = t end
      for _, o in pairs(outs) do
        if nxt and o.unit_number ~= nxt.unit_number and #branches < 10 then branches[#branches+1] = {at=P(c.position), other_branch=P(o.position)} end
      end
      prev = c
      c = nxt
    end
    if not ends then
      local v = vec(prev.direction)
      if prev.type == 'underground-belt' and prev.belt_to_ground_type == 'input' then ends = 'подземный вход без парного выхода'
      else ends = 'упирается в: '..thing(e.surface, {x=prev.position.x+v[1], y=prev.position.y+v[2]}) end
    end
    return {start=P(head.position), belts=n, total_items=total, sections=sections, branches=branches, ends=ends}`,

  recipe: `
    local f = bot().force
    local function info(rc)
      local ing, prod = {}, {}
      for _, i in pairs(rc.ingredients) do ing[i.name] = i.amount end
      for _, p in pairs(rc.products) do prod[p.name] = p.amount or p.amount_max end
      return {recipe=rc.name, ingredients=ing, products=prod, seconds=rc.energy, unlocked=rc.enabled}
    end
    if f.recipes[A.name] then return {info(f.recipes[A.name])} end
    local out = {}
    for _, rc in pairs(f.recipes) do
      for _, p in pairs(rc.products) do if p.name == A.name and #out < 5 then out[#out+1] = info(rc) end end
    end
    if #out == 0 then fail('нет рецепта или предмета '..A.name..' (нужно внутреннее имя, например iron-gear-wheel)') end
    return out`,

  give: `
    local e = bot()
    local p = game.players[A.player]
    if not p or not p.connected or not p.character then fail('игрок '..A.player..' не в игре') end
    reach(e, p, 10)
    local have = e.get_item_count(A.item)
    if have < 1 then fail('в инвентаре нет '..A.item) end
    local n = p.insert{name=A.item, count=math.min(have, A.count)}
    if n < 1 then fail('у игрока нет места') end
    e.remove_item{name=A.item, count=n}
    return {given=n, item=A.item, to=p.name}`,

  // Чат ботов хранится в самой игре (последние 50 сообщений), чтобы его видели все процессы: и голосовой бот, и внешние клиенты.
  say: `
    storage.vb_chat = storage.vb_chat or {seq=0, items={}}
    local c = storage.vb_chat
    c.seq = c.seq + 1
    c.items[#c.items+1] = {seq=c.seq, from=A.bot, text=A.message}
    if #c.items > 50 then table.remove(c.items, 1) end
    game.print('[color=1,0.8,0.2]'..A.bot..':[/color] '..A.message)
    return {sent=true}`,

  chat: `
    local c = storage.vb_chat or {seq=0, items={}}
    local out = {}
    for _, m in pairs(c.items) do if m.seq > A.since and m.from ~= A.bot then out[#out+1] = {from=m.from, text=m.text} end end
    return {seq=c.seq, messages=out}`,
};

const DIRECTIONS = ['north', 'east', 'south', 'west'];
const coords = { x: z.number().describe('координата x'), y: z.number().describe('координата y') };

/**
 * @param botName имя персонажа
 * @param hooks { log(line), aborted(), activity?(), chatTool? } — лог; признак «долгие действия пора сворачивать»;
 *              вызывается при каждом обращении к инструменту; chatTool добавляет инструмент read_chat
 *              (сессиям голосового бота чат доставляется сам, внешним клиентам его нужно читать)
 */
export function createFactorioServer(botName, hooks) {
  const run = (body, args = {}) => lua(PRELUDE + BODY[body], { bot: botName, ...args });

  // Чат для внешних клиентов (hooks.chatTool): новые сообщения сами прикладываются к ответу любого инструмента
  // в поле chat, а долгие действия сворачиваются, как только в чате появилось что-то новое.
  const memo = hooks.chatTool; // { seq } — живёт дольше одного запроса
  let chatChecked = 0;
  let chatNew = false;
  let chatBase = null; // номер последнего сообщения на момент начала действия: прерывает только то, что пришло позже
  async function chatWaiting() {
    if (!memo) return false;
    if (chatNew || Date.now() - chatChecked < 1000) return chatNew;
    chatChecked = Date.now();
    const r = await run('chat', { since: chatBase ?? 1e15 }).catch(() => null);
    if (!r) return false;
    if (chatBase === null) chatBase = r.seq;
    else chatNew = Array.isArray(r.messages) && r.messages.length > 0;
    return chatNew;
  }
  async function takeChat() {
    const r = await run('chat', { since: memo.seq });
    memo.seq = r.seq;
    chatNew = false;
    return Array.isArray(r.messages) ? r.messages : [];
  }
  /** Причина свернуть долгое действие либо null. */
  async function interrupted() {
    if (hooks.aborted()) return 'прервано новой репликой';
    if (await chatWaiting()) return 'прервано: новое сообщение в чате (оно в поле chat)';
    return null;
  }

  /** Идти по прямой к точке. Итог: done | stuck (упёрся или не уложился в limitMs) | interrupted. */
  async function go(x, y, tol, pollMs, limitMs) {
    const start = Date.now();
    let best = Infinity;
    let lastProgress = Date.now();
    for (;;) {
      const s = await run('step', { x, y, tol });
      if (s.done) return { done: true, x: s.x, y: s.y };
      if (hooks.aborted()) return { interrupted: true, x: s.x, y: s.y };
      // Застрял — значит, перестал приближаться к цели (а не просто стоит: по ленте может и возить туда-сюда).
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < best - 0.3) { best = d; lastProgress = Date.now(); }
      if (Date.now() - lastProgress > 1500 || Date.now() - start > limitMs) return { stuck: true, x: s.x, y: s.y };
      await sleep(pollMs);
    }
  }

  // Ходьба только пешком. Сначала по прямой; упёрся — ищем обход (BODY.path) и идём по его клеткам.
  // Не получилось — честно говорим, где остановились: переносить персонажа нельзя.
  async function walk(x, y, tol = 1.5) {
    const deadline = Date.now() + 90_000;
    const pos = (s) => ({ x: Math.round(s.x), y: Math.round(s.y) });
    try {
      let s = await go(x, y, tol, 120, 90_000);
      let detours = 0;
      let bestDist = Infinity;
      while (s.stuck && Date.now() < deadline && detours < 12) {
        const p = await run('path', { x, y, tol });
        const points = Array.isArray(p.points) ? p.points : [];
        if (!points.length) break;
        // Неполный обход имеет смысл, только пока он приближает к цели, иначе будем ходить кругами.
        const end = points[points.length - 1];
        const endDist = Math.hypot(end.x - x, end.y - y);
        if (!p.found && endDist > bestDist - 1) break;
        bestDist = Math.min(bestDist, endDist);
        detours++;
        for (const w of points) {
          s = await go(w.x, w.y, 0.45, 60, 4000);
          if (!s.done) break;
        }
        if (s.interrupted) break;
        if (s.done) s = await go(x, y, tol, 120, Math.max(1000, deadline - Date.now()));
      }
      if (s.done) return detours ? { pos: pos(s), note: 'дошёл пешком в обход препятствия' } : { pos: pos(s) };
      if (s.interrupted) return { interrupted: 'прервано новой репликой', pos: pos(s) };
      const left = Math.round(Math.hypot(s.x - x, s.y - y));
      if (Date.now() >= deadline) return { pos: pos(s), not_reached: `ещё не дошёл, осталось около ${left} клеток: вызови ещё раз` };
      return { pos: pos(s), not_reached: `упёрся в препятствие и не нашёл обход, до цели около ${left} клеток. Осмотрись (look_around) и иди в обход через промежуточные точки` };
    } finally {
      await run('stop').catch(() => {});
    }
  }

  /** Подойти, если цель дальше reach. */
  async function approach(x, y, reach) {
    const me = await run('pos');
    if (Math.hypot(me.x - x, me.y - y) > reach) await walk(x, y, Math.max(1.5, reach - 2));
  }

  const def = (name, description, shape, handler) => tool(name, description, shape, async (args) => {
    const shown = JSON.stringify(args);
    hooks.activity?.();
    try {
      chatBase = null; chatNew = false; chatChecked = 0;
      await chatWaiting();
      const value = await handler(args);
      if (memo && name !== 'read_chat' && value && typeof value === 'object' && !Array.isArray(value)) {
        const messages = await takeChat().catch(() => []);
        if (messages.length) value.chat = messages;
      }
      const result = JSON.stringify(value);
      hooks.log(`🔧 ${botName} ${name}${shown === '{}' ? '' : ' ' + shown} → ${result.slice(0, 300)}`);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      hooks.log(`🔧 ${botName} ${name} ${shown} → ❌ ${e.message}`);
      return { content: [{ type: 'text', text: `Ошибка: ${e.message}` }], isError: true };
    }
  });

  const tools = [
    def('status', 'Состояние твоего персонажа: позиция, здоровье, инвентарь, очередь крафта, люди в игре и другие боты с координатами.', {}, () => run('status')),

    def('look_around', 'Что находится вокруг персонажа: объекты сгруппированы по типу, с количеством, расстоянием и координатами ближайшего. Для руды — суммарный запас.',
      { radius: z.number().min(1).max(60).default(25).describe('радиус обзора в клетках') },
      (a) => run('look', a)),

    def('find', 'Найти ближайшие объекты по внутреннему имени (iron-ore, copper-ore, coal, stone, tree, stone-furnace, ...) в большом радиусе.',
      { name: z.string(), radius: z.number().min(1).max(1000).default(300) },
      (a) => run('find', a)),

    def('inspect', 'Подробности об объекте в точке: рецепт, состояние, содержимое, топливо, направление. Для манипулятора — откуда берёт (takes_from) и куда кладёт (puts_to), для конвейера — что на нём лежит: всего (on_belt) и по полосам (lanes: left — левая по ходу движения, right — правая); для подземного конвейера — вход это или выход (underground).', coords, (a) => run('inspect', a)),

    def('move_to', 'Идти в точку или к игроку-человеку. Укажи либо x и y, либо player. Идёт только пешком, препятствия обходит; если дойти не удалось, в ответе not_reached и место, где остановился.',
      { x: z.number().optional(), y: z.number().optional(), player: z.string().optional().describe('имя игрока в Factorio') },
      async (a) => {
        let target = a;
        if (a.player) target = await run('player_pos', { player: a.player });
        else if (a.x === undefined || a.y === undefined) throw new Error('нужны x и y либо player');
        return walk(target.x, target.y, a.player ? 2.5 : 1.5);
      }),

    def('mine', 'Добывать руками ресурс, дерево или камень в точке. Сам подходит. Примерно одна единица в секунду.',
      { ...coords, count: z.number().int().min(1).max(100).default(10).describe('сколько раз добыть') },
      async (a) => {
        await approach(a.x, a.y, 2.5);
        const got = {};
        let reason;
        for (let i = 0; i < a.count; i++) {
          const r = await run('mine', { x: a.x, y: a.y });
          if (r.done) { reason = r.reason; break; }
          got[r.name] = (got[r.name] || 0) + r.got;
          if (i === a.count - 1) break;
          reason = await interrupted();
          if (reason) break;
          await sleep(1000);
        }
        return { got, stopped: reason || undefined };
      }),

    def('craft', 'Скрафтить предмет руками из инвентаря. По умолчанию ждёт готовности (до двух минут); с wait=false только ставит в очередь и сразу возвращается — крафт идёт сам, очередь видна в status (поле crafting). Если на всё количество не хватило, ставит сколько может (queued), а в ingredients_for_asked — прямые ингредиенты на всё запрошенное: сколько нужно и сколько было (недостающие промежуточные крафтятся из сырья сами).',
      { recipe: z.string().describe('внутреннее имя рецепта, например iron-gear-wheel'), count: z.number().int().min(1).max(200).default(1),
        wait: z.boolean().default(true).describe('ждать ли готовности') },
      async (a) => {
        const r = await run('craft', { recipe: a.recipe, count: a.count });
        if (!a.wait) return { ...r, note: 'поставлено в очередь, крафт идёт сам' };
        const start = Date.now();
        while (Date.now() - start < 120_000) {
          await sleep(500);
          const p = await run('pos');
          if (p.queue === 0) return { ...r, queue_size: 0, crafted: r.queued };
          const why = await interrupted();
          if (why) return { ...r, queue_size: p.queue, note: `крафт продолжается сам, ждать перестал: ${why}` };
        }
        return { ...r, note: 'крафт ещё идёт' };
      }),

    def('place', 'Поставить постройку из инвентаря в точку. Сам подходит. Для манипулятора в ответе видно, откуда он берёт (takes_from) и куда кладёт (puts_to). Подземный конвейер: direction у входа и у выхода одинаковый — куда едут предметы; вход это или выход, задаёт underground, а в ответе видно, чем он встал (underground) и с каким концом соединился (paired_with).',
      { item: z.string().describe('внутреннее имя предмета'), ...coords, direction: z.enum(DIRECTIONS).default('north').describe('куда смотрит постройка: конвейер (и подземный тоже) везёт в эту сторону; манипулятор с этой стороны берёт, а кладёт на противоположную'),
        underground: z.enum(['input', 'output']).optional().describe('только для подземного конвейера: input — вход под землю, output — выход из-под земли. По умолчанию как в игре: выход, если позади по ходу в пределах дальности стоит вход без пары, иначе вход') },
      async (a) => { await approach(a.x, a.y, 8); return run('place', a); }),

    def('place_line', 'Поставить ряд одинаковых построек из инвентаря от точки (x, y) до точки (x2, y2): лента, столбы, трубы, стены. Идёт вдоль ряда и ставит по одной, как игрок с зажатой кнопкой. Занятые клетки пропускает, останавливается, когда предметы кончились. С параметром turn ряд идёт с одним поворотом под прямым углом: лента на углу сразу смотрит вдоль второго отрезка. Если действие прервалось, повтори тот же вызов: уже поставленное пропустится.',
      { item: z.string().describe('внутреннее имя предмета'), ...coords, x2: z.number().describe('x конца ряда'), y2: z.number().describe('y конца ряда'),
        step: z.number().min(1).max(64).default(1).describe('шаг между постройками в клетках: 1 для ленты, для столбов — их дальность провода'),
        direction: z.enum(DIRECTIONS).optional().describe('куда смотрят постройки; по умолчанию — вдоль ряда, от начала к концу (лента повезёт к концу ряда)'),
        turn: z.enum(['x_first', 'y_first']).optional().describe('ряд с одним поворотом: x_first — сначала по горизонтали до x2, потом по вертикали до y2; y_first — наоборот. Без него ряд идёт по прямой от начала к концу') },
      async (a) => {
        const along = (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 'east' : 'west') : (dy >= 0 ? 'south' : 'north'));
        // Отрезок ряда: точки от (x1, y1) к (x2, y2) с шагом step; конец включается, только если withEnd.
        const leg = (x1, y1, x2, y2, withEnd) => {
          const dx = x2 - x1, dy = y2 - y1;
          const len = Math.hypot(dx, dy);
          const dir = a.direction || along(dx, dy);
          const out = [];
          for (let i = 0; a.step * i <= len + 1e-6; i++) {
            const d = a.step * i;
            if (!withEnd && d > len - 1e-6) break;
            out.push({ x: len ? x1 + dx / len * d : x1, y: len ? y1 + dy / len * d : y1, direction: dir });
          }
          return out;
        };
        let points, turn_at;
        if (a.turn && a.x !== a.x2 && a.y !== a.y2) {
          turn_at = a.turn === 'x_first' ? { x: a.x2, y: a.y } : { x: a.x, y: a.y2 };
          points = [...leg(a.x, a.y, turn_at.x, turn_at.y, false), ...leg(turn_at.x, turn_at.y, a.x2, a.y2, true)];
        } else points = leg(a.x, a.y, a.x2, a.y2, true);
        const n = points.length;
        if (n > 100) throw new Error(`в ряду получается ${n} построек, за один вызов можно не больше 100`);
        const direction = points[0].direction;
        let placed = 0, left, stopped, last;
        const skipped = [];
        for (let i = 0; i < n; i++) {
          const { x, y } = points[i];
          try {
            await approach(x, y, 8);
            const r = await run('place', { item: a.item, x, y, direction: points[i].direction });
            placed++; left = r.left; last = r.pos;
          } catch (e) {
            if (/в инвентаре нет|нет предмета|нельзя поставить на землю/.test(e.message)) { stopped = e.message.replace(/^Lua: /, ''); break; }
            skipped.push({ x, y, why: e.message.replace(/^Lua: /, '') });
          }
          if (i === n - 1) break;
          stopped = await interrupted();
          if (stopped) break;
          await sleep(150);
        }
        return { placed, asked: n, direction, turn_at, then_direction: turn_at ? points[n - 1].direction : undefined, last, left, skipped: skipped.slice(0, 10), skipped_count: skipped.length, stopped: stopped || undefined };
      }),

    def('insert_all', 'Положить предметы из инвентаря во все объекты одного вида рядом: заправить все печи или буры углём, раздать руду по печам. Обходит их пешком по очереди и кладёт в каждый до count штук.',
      { name: z.string().describe('внутреннее имя объектов, например stone-furnace или burner-mining-drill'), item: z.string().describe('что класть, например coal'),
        count: z.number().int().min(1).default(5).describe('сколько класть в каждый'), radius: z.number().min(1).max(40).default(20).describe('радиус поиска объектов от персонажа') },
      async (a) => {
        const t = await run('targets', { name: a.name, radius: a.radius });
        const rest = Array.isArray(t.list) ? t.list : [];
        if (!rest.length) throw new Error(`в радиусе ${a.radius} нет объектов ${a.name}`);
        let me = await run('pos');
        let inserted = 0, objects = 0, stopped;
        const skipped = [];
        while (rest.length && objects + skipped.length < 50) {
          // Каждый раз идём к ближайшему из оставшихся.
          rest.sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y));
          const c = rest.shift();
          try {
            await approach(c.x, c.y, 8);
            const r = await run('insert', { x: c.x, y: c.y, item: a.item, count: a.count });
            inserted += r.inserted; objects++;
          } catch (e) {
            if (/в инвентаре нет/.test(e.message)) { stopped = `${a.item} в инвентаре кончился`; break; }
            skipped.push({ x: c.x, y: c.y, why: e.message.replace(/^Lua: /, '') });
          }
          if (!rest.length) break;
          me = await run('pos');
          stopped = await interrupted();
          if (stopped) break;
          await sleep(150);
        }
        return { item: a.item, into: a.name, found: t.count, objects, inserted, skipped: skipped.slice(0, 10), skipped_count: skipped.length, not_visited: rest.length, stopped: stopped || undefined };
      }),

    def('pick_up', 'Снять постройку в точке обратно в инвентарь. Сам подходит.', coords,
      async (a) => { await approach(a.x, a.y, 8); return run('pick_up', a); }),

    def('insert_items', 'Положить предметы из инвентаря в объект в точке (топливо, руду, ингредиенты). На клетку ленты за раз ложится не больше двух предметов — по одному в начало каждой полосы. Сам подходит.',
      { ...coords, item: z.string(), count: z.number().int().min(1).default(5) },
      async (a) => { await approach(a.x, a.y, 8); return run('insert', a); }),

    def('take_items', 'Забрать предметы из объекта в точке. Без item — всё из выходного слота. С конвейера забирает то, что лежит на этой клетке. Сам подходит.',
      { ...coords, item: z.string().optional(), count: z.number().int().min(1).default(1000) },
      async (a) => { await approach(a.x, a.y, 8); return run('take', a); }),

    def('set_recipe', 'Задать рецепт сборочному автомату в точке.', { ...coords, recipe: z.string() },
      async (a) => { await approach(a.x, a.y, 8); return run('set_recipe', a); }),

    def('rotate', 'Повернуть постройку в точке. Манипулятор берёт со стороны direction и кладёт на противоположную; в ответе видно, откуда и куда.', { ...coords, direction: z.enum(DIRECTIONS) },
      async (a) => { await approach(a.x, a.y, 8); return run('rotate', a); }),

    def('research', 'Исследования: текущее, вся очередь (по каждой технологии — какие колбы и сколько на единицу, сколько единиц всего и осталось, секунд на единицу в одной лаборатории) и список доступных. С параметром technology — поставить в очередь: added=true, только если технология действительно появилась в очереди, иначе в reason причина.',
      { technology: z.string().optional() }, (a) => run('research', a)),

    def('power', 'Электросеть, как в окне столба: выработка и потребление в кВт по видам машин (среднее за 5 секунд), состояние генераторов и котлов рядом, заряд аккумуляторов и список машин без питания (no_power, low_power, не подключён к сети). Без координат берётся ближайший столб.',
      { x: z.number().optional().describe('координата x столба'), y: z.number().optional().describe('координата y столба'),
        radius: z.number().min(1).max(60).default(40).describe('в каком радиусе от персонажа искать машины без питания') },
      (a) => run('power', a)),

    def('belt', 'Обзор конвейерной линии, проходящей через точку: от начала до конца по участкам (откуда, докуда, направление, длина, что лежит), развилки на разделителях и во что линия упирается. Видно в пределах 60 клеток от персонажа.',
      { ...coords, section: z.number().int().min(1).max(100).default(20).describe('наибольшая длина одного участка в отчёте') },
      (a) => run('belt', a)),

    def('recipe_info', 'Рецепт по имени рецепта или предмета: ингредиенты, результат, время, открыт ли.', { name: z.string() }, (a) => run('recipe', a)),

    def('give', 'Отдать предметы из инвентаря игроку-человеку. Сам подходит к нему.',
      { player: z.string(), item: z.string(), count: z.number().int().min(1).default(1) },
      async (a) => {
        const p = await run('player_pos', { player: a.player });
        await approach(p.x, p.y, 8);
        return run('give', a);
      }),

    def('say', 'Написать в игровой чат. Сообщение увидят люди в игре и получат остальные боты. Имя персонажа подставляется само — в тексте его не пиши.',
      { message: z.string().max(400) },
      (a) => {
        // Модель всё равно любит подписываться — срезаем подпись, чтобы имя не двоилось.
        let message = a.message.trim();
        while (message.toLowerCase().startsWith(botName.toLowerCase())) message = message.slice(botName.length).replace(/^[\s:,—-]+/, '');
        return run('say', { message });
      }),

    def('wait', 'Подождать (пока печь плавит, бур копает и т. п.).', { seconds: z.number().min(1).max(30) },
      async (a) => {
        const start = Date.now();
        let why = null;
        while (Date.now() - start < a.seconds * 1000 && !(why = await interrupted())) await sleep(250);
        return { waited: Math.round((Date.now() - start) / 1000), stopped: why || undefined };
      }),
  ];

  tools.push(def('feedback', 'Оставить разработчикам заявку на улучшение этих инструментов: чего не хватает, что работает неудобно или неверно. Одна заявка — одна тема, с примером из практики. Заявки разбираются в фоне; читерских возможностей не добавляют.',
    { text: z.string().min(10).max(4000) },
    (a) => submitFeedback(botName, a.text)));

  if (hooks.chatTool) {
    tools.push(def('read_chat', 'Новые сообщения других ботов из игрового чата. Обычно вызывать не нужно: новые сообщения сами приходят в поле chat ответа любого инструмента, а mine, wait, craft и групповые действия сворачиваются, как только в чате появилось новое.', {},
      async () => ({ messages: await takeChat() })));
  }

  return {
    /** Вызвать инструмент напрямую, без MCP (для tool-test). */
    call: (name, args = {}) => {
      const t = tools.find((x) => x.name === name);
      if (!t) throw new Error(`нет инструмента ${name}; есть: ${tools.map((x) => x.name).join(', ')}`);
      return t.handler(z.object(t.inputSchema).parse(args));
    },
    toolNames: tools.map((x) => x.name),
    server: createSdkMcpServer({ name: 'factorio', version: '1.0.0', tools }),
    /** Создать персонажа, если его ещё нет. */
    ensure: () => run('ensure'),
  };
}

/** Сообщения чата ботов с номером больше since (кроме написанных botName). */
export async function readChat(since, botName = '') {
  const r = await lua(BODY.chat, { since, bot: botName });
  return { seq: r.seq, messages: Array.isArray(r.messages) ? r.messages : [] };
}
