// MCP-инструменты для управления персонажем на сервере Factorio. У каждой сессии Claude свой экземпляр,
// привязанный к одному персонажу. Всё делается Lua-командами через RCON; модов на сервере нет.
import { z } from 'zod';
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lua } from './rcon.mjs';
import { submitFeedback, readItems } from './feedback.mjs';

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
-- Труп персонажа у точки (ближайший в радиусе r): игрок открывает его, как сундук, и забирает вещи.
local function corpse_at(e, x, y, r)
  local best, bd
  for _, c in pairs(e.surface.find_entities_filtered{type='character-corpse', position={x, y}, radius=r}) do
    local d = dist(c.position, {x=x, y=y})
    if not bd or d < bd then best, bd = c, d end
  end
  return best
end
-- corpse=true — годится и труп персонажа: точно в этой точке он важнее постройки под ним, рядом — если больше ничего нет.
local function at(e, x, y, corpse)
  local res
  local body = corpse and corpse_at(e, x, y, 0.35)
  if body then return body end
  for _, c in pairs(e.surface.find_entities_filtered{area={{x-0.45,y-0.45},{x+0.45,y+0.45}}}) do
    if c.type == 'resource' then res = c elseif not SKIP[c.type] and c.prototype.selectable_in_game then return c end
  end
  if res then return res end
  body = corpse and corpse_at(e, x, y, 1)
  if body then return body end
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

// Поставить одну постройку из инвентаря персонажа e; a — {item, x, y, direction, underground}. Общая часть place и place_many.
const PLACE_FN = `
local function place_one(e, a)
  local ip = prototypes.item[a.item]
  if not ip then fail('нет предмета '..a.item) end
  local pr = ip.place_result
  if not pr then fail(a.item..' нельзя поставить на землю') end
  reach(e, a, 10)
  local dir = defines.direction[a.direction]
  local s = e.surface
  -- Такая же постройка своей команды уже стоит в этой точке и смотрит туда же — дело сделано (already), предмет не тратится.
  for _, c in pairs(s.find_entities_filtered{name=pr.name, area={{a.x-0.1, a.y-0.1}, {a.x+0.1, a.y+0.1}}, force=e.force}) do
    if dist(c.position, a) < 0.1 then
      if c.supports_direction and c.direction ~= dir then fail('здесь уже стоит '..c.name..', но смотрит на '..dirname(c.direction)..', а не на '..a.direction..': поверни (rotate)') end
      if c.type == 'underground-belt' and a.underground and c.belt_to_ground_type ~= a.underground then fail('здесь уже стоит '..c.name..', но это '..(c.belt_to_ground_type == 'input' and 'вход' or 'выход')..': сними (pick_up) и поставь заново') end
      return {already=true, placed=c.name, pos=P(c.position), direction=a.direction, left=e.get_item_count(a.item)}
    end
  end
  if e.get_item_count(a.item) < 1 then fail('в инвентаре нет '..a.item) end
  if not s.can_place_entity{name=pr.name, position={a.x, a.y}, direction=dir, force=e.force, build_check_type=defines.build_check_type.manual} then
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
    -- стоит такой же вход, смотрящий туда же, — выходом. Явный a.underground важнее.
    kind = a.underground
    if not kind then
      local o = ug_near(a, -1)
      kind = (o and o.belt_to_ground_type == 'input') and 'output' or 'input'
    end
  end
  local n = s.create_entity{name=pr.name, position={a.x, a.y}, direction=dir, force=e.force, raise_built=true, type=kind}
  if not n then fail('сюда поставить нельзя') end
  e.remove_item{name=a.item, count=1}
  -- Как в игре: постройка, поставленная поверх своего призрака, его заменяет.
  for _, g in pairs(s.find_entities_filtered{type='entity-ghost', area={{n.position.x-0.1, n.position.y-0.1}, {n.position.x+0.1, n.position.y+0.1}}, force=e.force}) do
    if g.valid and g.ghost_name == pr.name and dist(g.position, n.position) < 0.1 then g.destroy() end
  end
  local r = {placed=n.name, pos=P(n.position), direction=a.direction, left=e.get_item_count(a.item)}
  if n.type == 'underground-belt' then
    r.underground = n.belt_to_ground_type == 'input' and 'вход под землю' or 'выход из-под земли'
    local o = ug_near(n.position, n.belt_to_ground_type == 'input' and 1 or -1)
    if o and o.belt_to_ground_type ~= n.belt_to_ground_type then r.paired_with = P(o.position)
    else r.paired_with = n.belt_to_ground_type == 'input' and 'пары нет: впереди по ходу в пределах дальности нужен выход' or 'пары нет: позади по ходу в пределах дальности нужен вход' end
  end
  if n.type == 'inserter' then r.takes_from, r.puts_to = arm(n) end
  -- Рецепт сборочного автомата из шаблона: то же, что set_recipe сразу после постройки.
  if a.recipe and n.type == 'assembling-machine' then
    local rc = e.force.recipes[a.recipe]
    if rc and rc.enabled and pcall(function() n.set_recipe(rc) end) then r.recipe = a.recipe end
  end
  return r
end
`;

const BODY = {
  ensure: `local e = bot() return {pos=P(e.position)}`,

  status: `
    local e = bot()
    local players = {}
    -- Игрок camera — клиент-камера веб-карты (src/map.mjs), не человек.
    for _, p in pairs(game.connected_players) do if p.name ~= 'camera' then players[#players+1] = {name=p.name, pos=P(p.position), dist=r1(dist(p.position, e.position))} end end
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

  // Идти по ломаной A.points (первая точка — начало пути), A.i — номер точки, к которой сейчас идём. Следующая команда
  // придёт только через A.n тиков (задержка RCON), и всё это время персонаж идёт сам в одну из восьми сторон. Поэтому
  // каждый раз перебираются варианты «куда и сколько пройти до следующей команды» и берётся тот, после которого до
  // конца пути остаётся меньше всего: на полной скорости, если отрезок свободен, — срезая угол или поворачивая раньше;
  // шаг сбавляется, только когда иначе персонаж проскочит поворот или цель (быстрее игрока — никогда).
  follow: `
    local e = bot()
    local s = e.surface
    local p = e.position
    local pts = storage.vb_path[A.bot]
    local N = #pts
    if N < 2 or dist(p, pts[N]) <= 0.2 then
      e.walking_state = {walking=false, direction=e.walking_state.direction} e.character_running_speed_modifier = 0
      return {done=true, x=p.x, y=p.y}
    end
    e.character_running_speed_modifier = 0
    local full = e.character_running_speed
    if not (full > 0) then full = 0.15 end
    local L = A.n*full
    local rem = {[N]=0}
    for j = N-1, 1, -1 do rem[j] = rem[j+1] + dist(pts[j], pts[j+1]) end
    -- Можно ли стоять в точке (то, что видит игрок: постройки, деревья, вода, скалы). Сам персонаж себе не мешает.
    local fc = {}
    local function free(x, y)
      if math.abs(x-p.x) < 0.41 and math.abs(y-p.y) < 0.41 then return true end
      local k = (math.floor(x*8+0.5)+4000000)*8000000 + math.floor(y*8+0.5)+4000000
      local v = fc[k]
      if v == nil then v = s.can_place_entity{name='character', position={x, y}} fc[k] = v end
      return v
    end
    local function clear(ax, ay, bx, by)
      local k = math.ceil(((bx-ax)^2+(by-ay)^2)^0.5/0.25)
      for t = 1, k do if not free(ax+(bx-ax)*t/k, ay+(by-ay)*t/k) then return false end end
      return true
    end
    local function oct(dx, dy) dx, dy = math.abs(dx), math.abs(dy) return math.max(dx, dy) + 0.4142*math.min(dx, dy) end
    -- Сколько осталось идти из точки q: вернуться на путь (на один из ближайших отрезков, не дальше 3 клеток) и пройти остаток.
    local i0 = math.max(1, A.i-1)
    local function score(qx, qy, check)
      local bs, bj, bo
      for j = i0, math.min(N-1, i0+6) do
        local a, w = pts[j], pts[j+1]
        local vx, vy = w.x-a.x, w.y-a.y
        local len = (vx*vx+vy*vy)^0.5
        if len > 0.01 then
          local t = math.max(0, math.min(len, ((qx-a.x)*vx+(qy-a.y)*vy)/len))
          local perp = dist({x=qx, y=qy}, {x=a.x+vx*t/len, y=a.y+vy*t/len})
          -- Вернуться на путь можно под прямым углом или наискосок вперёд.
          for _, tt in pairs{t, math.min(len, t+perp)} do
            local cx, cy = a.x+vx*tt/len, a.y+vy*tt/len
            local o = oct(qx-cx, qy-cy)
            if o <= 3 then
              local sc = o*1.1 + (len-tt) + rem[j+1]
              if (not bs or sc < bs) and (o < 0.3 or not check or clear(qx, qy, cx, cy)) then bs, bj, bo = sc, j, o end
            end
          end
        end
      end
      return bs, bj, bo
    end
    local cur, curj, off = score(p.x, p.y, false)
    local en = A.w and s.count_entities_filtered{position=p, radius=20, force='enemy', type='unit', limit=1} or 0
    if not cur then return {i=A.i, d=rem[1], off=99, tick=game.tick, x=p.x, y=p.y, en=en} end
    -- На конвейере шаг сбавляем меньше: слишком медленного персонажа лента унесёт.
    local on_belt = s.count_entities_filtered{area={{p.x-0.2, p.y-0.2}, {p.x+0.2, p.y+0.2}}, type={'transport-belt', 'underground-belt', 'splitter'}} > 0
    local minf = on_belt and 0.4 or 0.05
    local best, bdir, bf, bseg = cur - 0.02, nil, nil, nil
    for d = 0, 7 do
      local ux, uy = math.sin(d*math.pi/4), -math.cos(d*math.pi/4)
      local far = 0
      for t = 1, math.ceil((L*1.1+0.1)/0.25) do if free(p.x+ux*t*0.25, p.y+uy*t*0.25) then far = t*0.25 else break end end
      -- Доли полного шага; плюс такие, чтобы встать ровно напротив ближайших поворотов и конца пути.
      local fr = {1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.1, 0.05}
      for _, w in pairs{pts[curj+1], pts[curj+2] or pts[N], pts[N]} do
        local g = (w.x-p.x)*ux + (w.y-p.y)*uy
        if g > 0 and g < L then fr[#fr+1] = g/L end
      end
      for _, f in pairs(fr) do
        local len = f*L
        if f >= minf and len*1.1 <= far + 0.1 then
          local sc, j = score(p.x+ux*len, p.y+uy*len, true)
          if sc and sc < best - 0.001 then best, bdir, bf, bseg = sc, d, f, j end
        end
      end
    end
    if not bdir then
      -- Свободного хода не нашлось (тесно): идём прямо к очередной точке пути; упрёмся — путь поищут заново.
      local w = pts[curj+1]
      if dist(p, w) < 0.2 and pts[curj+2] then curj = curj + 1 w = pts[curj+1] end
      bdir = math.floor(math.atan2(w.x-p.x, -(w.y-p.y))/(math.pi/4)+0.5) % 8
      local g = (w.x-p.x)*math.sin(bdir*math.pi/4) - (w.y-p.y)*math.cos(bdir*math.pi/4)
      bf, bseg = math.max(minf, math.min(1, g/L)), curj
    end
    e.character_running_speed_modifier = math.max(on_belt and -0.6 or -0.95, math.min(0, bf - 1))
    e.walking_state = {walking=true, direction=bdir*2}
    return {i=math.max(A.i, bseg+1), d=cur, off=off, tick=game.tick, x=p.x, y=p.y, en=en}`,

  stop: `local e = bot() e.walking_state = {walking=false, direction=e.walking_state.direction} e.character_running_speed_modifier = 0 return {x=e.position.x, y=e.position.y}`,

  // Поиск пути: A* по клеткам от персонажа (проверяется только «можно ли здесь стоять» — постройки, деревья, вода,
  // скалы), идёт он потом сам, пешком. Эвристика с весом: путь чуть длиннее кратчайшего, зато хватает на дальние переходы.
  // Если в самой цели стоять нельзя, целью становится ближайшая к ней свободная клетка (near). Если до цели не дотянулись,
  // возвращается путь до самой близкой к ней достигнутой клетки; unreachable — перебрали всё, куда можно дойти, цели там нет.
  // В ответе только повороты пути, первая точка — клетка, где стоит персонаж.
  path: `
    local e = bot()
    local s = e.surface
    -- Узлы стоят через полклетки (x, y здесь в половинках клетки): так персонаж проходит и в щель между соседними постройками.
    local sx, sy = math.floor(e.position.x*2+0.5), math.floor(e.position.y*2+0.5)
    local function key(x, y) return (x+1000000)*4000000 + (y+1000000) end
    local fc = {}
    local function free(x, y)
      local k = key(x, y)
      local v = fc[k]
      if v == nil then v = s.can_place_entity{name='character', position={x/2, y/2}} fc[k] = v end
      return v
    end
    -- Конвейеры проходимы, но сносят персонажа: путь по ним дороже, так что ленты он пересекает, а не идёт вдоль.
    local belt = {}
    local p0 = e.position
    for _, b in pairs(s.find_entities_filtered{area={{math.min(p0.x, A.x)-20, math.min(p0.y, A.y)-20}, {math.max(p0.x, A.x)+20, math.max(p0.y, A.y)+20}}, type={'transport-belt', 'underground-belt', 'splitter'}}) do
      local bb = b.bounding_box
      for tx = math.floor(bb.left_top.x+0.1), math.floor(bb.right_bottom.x-0.1) do
        for ty = math.floor(bb.left_top.y+0.1), math.floor(bb.right_bottom.y-0.1) do belt[key(tx, ty)] = true end
      end
    end
    local function on_belt(x, y)
      local ax, bx, ay, by = math.floor(x/2-0.2), math.floor(x/2+0.2), math.floor(y/2-0.2), math.floor(y/2+0.2)
      return belt[key(ax, ay)] or belt[key(bx, ay)] or belt[key(ax, by)] or belt[key(bx, by)]
    end
    -- Есть ли где встать в пределах tol от цели; если нет — ищем ближайшее свободное место в 6 клетках от неё.
    local tol, near = A.tol, false
    local gx, gy = math.floor(A.x*2+0.5), math.floor(A.y*2+0.5)
    local md
    for pass = 1, 2 do
      local r = pass == 1 and math.ceil(tol*2) or 12
      if not md then
        for x = gx-r, gx+r do for y = gy-r, gy+r do
          local d = dist({x=x/2, y=y/2}, A)
          if (not md or d < md) and (pass == 2 or d <= tol) and ((x == sx and y == sy) or free(x, y)) then md = d end
        end end
      end
    end
    if md and md > tol then tol = md + 0.01 near = true end
    local function h(x, y) local dx, dy = math.abs(x/2-A.x), math.abs(y/2-A.y) return math.max(dx, dy) + 0.41*math.min(dx, dy) end
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
    local g, from, closed, pc, belts = {[key(sx, sy)]=0}, {}, {}, {}, next(belt) ~= nil
    local function penalty(x, y)
      local k = key(x, y)
      local pen = pc[k]
      if pen == nil then
        pen = 0
        if not (free(x+1, y) and free(x-1, y) and free(x, y+1) and free(x, y-1)) then pen = 0.75 end
        if belts and on_belt(x, y) then pen = pen + 1.5 end
        pc[k] = pen
      end
      return pen
    end
    push(1.3*h(sx, sy), sx, sy)
    local goal, best, bh, expanded = nil, nil, h(sx, sy), 0
    while n > 0 and expanded < 3000 do
      local c = pop()
      local x, y = c[2], c[3]
      local k = key(x, y)
      if not closed[k] then
        closed[k] = true
        expanded = expanded + 1
        if dist({x=x/2, y=y/2}, A) <= tol then goal = {x, y} break end
        if h(x, y) < bh - 0.01 then bh = h(x, y) best = {x, y} end
        for dx = -1, 1 do for dy = -1, 1 do
          local nx, ny = x+dx, y+dy
          local nk = key(nx, ny)
          if (dx ~= 0 or dy ~= 0) and not closed[nk] and free(nx, ny) and (dx == 0 or dy == 0 or (free(nx, y) and free(x, ny))) then
            -- Вплотную к препятствию и по конвейеру идти дороже: где есть место, путь держится от них в стороне.
            local pen = penalty(nx, ny)
            local ng = g[k] + ((dx ~= 0 and dy ~= 0) and 0.705 or 0.5) + pen
            if not g[nk] or ng < g[nk] then g[nk] = ng from[nk] = {x, y} push(ng + 1.3*h(nx, ny), nx, ny) end
          end
        end end
      end
    end
    local rev = {}
    local c = goal or best
    while c and not (c[1] == sx and c[2] == sy) do rev[#rev+1] = c c = from[key(c[1], c[2])] end
    local C = {{sx, sy}}
    for i = #rev, 1, -1 do C[#C+1] = rev[i] end
    -- Сглаживание: A* по сетке даёт лесенку. Где свободно (не вплотную к препятствиям и не по конвейеру), кусок пути
    -- заменяется двумя прямыми отрезками — наискосок и по прямой: персонаж ходит в восемь сторон, как игрок на WASD.
    local budget = 60000
    local function good(x, y) budget = budget - 1 return free(x, y) and penalty(x, y) == 0 end
    local function legs(a, b, diag_first)
      local dx, dy = b[1]-a[1], b[2]-a[2]
      local ux, uy = dx > 0 and 1 or dx < 0 and -1 or 0, dy > 0 and 1 or dy < 0 and -1 or 0
      local m = math.min(math.abs(dx), math.abs(dy))
      local st = math.max(math.abs(dx), math.abs(dy)) - m
      local wx, wy = math.abs(dx) > math.abs(dy) and ux or 0, math.abs(dy) > math.abs(dx) and uy or 0
      local x, y, mid = a[1], a[2], nil
      for part = 1, 2 do
        local diag = (part == 1) == diag_first
        for _ = 1, diag and m or st do
          local nx, ny = x + (diag and ux or wx), y + (diag and uy or wy)
          if not good(nx, ny) or (diag and not (free(nx, y) and free(x, ny))) then return false end
          x, y = nx, ny
        end
        if part == 1 then mid = {x, y} end
      end
      return mid
    end
    local S, k = {C[1]}, 1
    while k < #C do
      local j, mid = k + 1, nil
      if budget > 0 then
        for t = math.min(#C, k + 80), k + 2, -1 do
          mid = legs(C[k], C[t], true) or legs(C[k], C[t], false)
          if mid then j = t break end
          if budget <= 0 then break end
        end
      end
      if mid then S[#S+1] = mid end
      S[#S+1] = C[j]
      k = j
    end
    local pts = {}
    for _, c in ipairs(S) do
      local q = pts[#pts]
      if not q or q.x ~= c[1]/2 or q.y ~= c[2]/2 then pts[#pts+1] = {x=c[1]/2, y=c[2]/2} end
    end
    local out = {pts[1]}
    for i = 2, #pts do
      local a, b, c = pts[i-1], pts[i], pts[i+1]
      if not c or math.abs((b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x)) > 0.001 or (b.x-a.x)*(c.x-b.x) + (b.y-a.y)*(c.y-b.y) <= 0 then out[#out+1] = b end
    end
    -- Путь запоминается на сервере: команда шага (follow) должна быть короткой, см. FOLLOW.
    storage.vb_path = storage.vb_path or {}
    storage.vb_path[A.bot] = out
    -- A.en — заодно гнёзда и черви, которых персонаж сейчас видит (в 60 клетках): по ним проверяется остаток дальнего маршрута.
    local nests
    if A.en then
      nests = {}
      for _, c in pairs(s.find_entities_filtered{force='enemy', type={'unit-spawner', 'turret'}, position=p0, radius=60, limit=60}) do nests[#nests+1] = {x=r1(c.position.x), y=r1(c.position.y)} end
    end
    return {found=goal ~= nil, near=near, unreachable=goal == nil and n == 0, cells=#C-1, points=out, nests=nests}`,

  // Дальний маршрут (fb-044, fb-046): тот же поиск по узлам в полклетки, что и path, но на весь переход сразу и с большим
  // запасом перебора; без штрафов и сглаживания — по нему path потом ведёт персонажа кусками. Смотрит только то, что видит
  // игрок: открытую карту (и 60 клеток вокруг персонажа) в полосе A.margin клеток вокруг прямой. С A.avoid маршрут держится
  // в 30 клетках от гнёзд и червей, которых сейчас видно (60 клеток от персонажа, радар); к тем, что уже ближе, — не приближается.
  // exhausted — перебрано всё, куда можно дойти, цели там нет; cut_* — во что при этом упирались (край полосы, неоткрытая
  // карта, враги); closest и blocker — докуда дойти можно и что мешает дальше.
  far: `
    local e = bot()
    local s, f = e.surface, e.force
    local p0 = e.position
    local sx, sy = math.floor(p0.x*2+0.5), math.floor(p0.y*2+0.5)
    local gx, gy = math.floor(A.x*2+0.5), math.floor(A.y*2+0.5)
    local function key(x, y) return (x+1000000)*4000000 + (y+1000000) end
    local fc = {}
    local function free(x, y)
      local k = key(x, y)
      local v = fc[k]
      if v == nil then v = s.can_place_entity{name='character', position={x/2, y/2}} fc[k] = v end
      return v
    end
    local M = A.margin*2
    local x0, x1, y0, y1 = math.min(sx, gx)-M, math.max(sx, gx)+M, math.min(sy, gy)-M, math.max(sy, gy)+M
    local chart = {}
    local function known(x, y)
      if math.abs(x-sx) <= 120 and math.abs(y-sy) <= 120 then return true end
      local cx, cy = math.floor(x/64), math.floor(y/64)
      local k = key(cx, cy)
      local v = chart[k]
      if v == nil then v = f.is_chunk_charted(s, {cx, cy}) chart[k] = v end
      return v
    end
    -- Зоны врагов: ячейки 4×4 клетки, центр которых ближе R к гнезду или червю.
    local zone, nests = {}, 0
    if A.avoid then
      local vis = {}
      for _, c in pairs(s.find_entities_filtered{force='enemy', type={'unit-spawner', 'turret'}, area={{x0/2-32, y0/2-32}, {x1/2+32, y1/2+32}}}) do
        local q = c.position
        local d = dist(q, p0)
        local see = d <= 60
        if not see then
          local k = key(math.floor(q.x/32), math.floor(q.y/32))
          if vis[k] == nil then vis[k] = f.is_chunk_visible(s, {math.floor(q.x/32), math.floor(q.y/32)}) end
          see = vis[k]
        end
        if see then
          nests = nests + 1
          local R = math.min(30, d - 4)
          if R > 0 then
            local ax, ay, m = math.floor(q.x/4), math.floor(q.y/4), math.ceil(R/4)
            for i = ax-m, ax+m do for j = ay-m, ay+m do
              if ((i*4+2-q.x)^2 + (j*4+2-q.y)^2)^0.5 <= R then local k = key(i, j) if not zone[k] then zone[k] = {x=r1(q.x), y=r1(q.y)} end end
            end end
          end
        end
      end
    end
    local gz = zone[key(math.floor(A.x/4), math.floor(A.y/4))]
    if gz then return {found=false, enemy_goal={x=gz.x, y=gz.y, dist=r1(dist(gz, A))}, nests=nests} end
    local tol = A.tol
    local md
    for pass = 1, 2 do
      local r = pass == 1 and math.ceil(tol*2) or 12
      if not md then
        for x = gx-r, gx+r do for y = gy-r, gy+r do
          local d = dist({x=x/2, y=y/2}, A)
          if (not md or d < md) and (pass == 2 or d <= tol) and ((x == sx and y == sy) or free(x, y)) then md = d end
        end end
      end
    end
    if md and md > tol then tol = md + 0.01 end
    local cut_box, cut_map, cut_enemy
    local okc = {}
    local function ok(x, y)
      local k = key(x, y)
      local v = okc[k]
      if v ~= nil then return v end
      v = false
      if x < x0 or x > x1 or y < y0 or y > y1 then cut_box = true
      elseif free(x, y) then
        local z = zone[key(math.floor(x/8), math.floor(y/8))]
        if z then cut_enemy = cut_enemy or z
        elseif not known(x, y) then cut_map = true
        else v = true end
      end
      okc[k] = v
      return v
    end
    local function h(x, y) local dx, dy = math.abs(x/2-A.x), math.abs(y/2-A.y) return math.max(dx, dy) + 0.41*math.min(dx, dy) end
    local heap, n = {}, 0
    local function push(fv, x, y)
      n = n + 1
      local i = n
      heap[i] = {fv, x, y}
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
    push(1.5*h(sx, sy), sx, sy)
    local goal, best, bh, expanded = nil, nil, h(sx, sy), 0
    while n > 0 and expanded < A.budget do
      local c = pop()
      local x, y = c[2], c[3]
      local k = key(x, y)
      if not closed[k] then
        closed[k] = true
        expanded = expanded + 1
        if dist({x=x/2, y=y/2}, A) <= tol then goal = {x, y} break end
        if h(x, y) < bh - 0.01 then bh = h(x, y) best = {x, y} end
        for dx = -1, 1 do for dy = -1, 1 do
          local nx, ny = x+dx, y+dy
          local nk = key(nx, ny)
          if (dx ~= 0 or dy ~= 0) and not closed[nk] and ok(nx, ny) and (dx == 0 or dy == 0 or (ok(nx, y) and ok(x, ny))) then
            local ng = g[k] + ((dx ~= 0 and dy ~= 0) and 0.705 or 0.5)
            if not g[nk] or ng < g[nk] then g[nk] = ng from[nk] = {x, y} push(ng + 1.5*h(nx, ny), nx, ny) end
          end
        end end
      end
    end
    if not goal then
      local b = best or {sx, sy}
      local bx, by = b[1]/2, b[2]/2
      local d = dist({x=bx, y=by}, A)
      local blocker
      for t = 1, math.min(24, math.ceil(d*2)) do
        local qx, qy = bx + (A.x-bx)*t/(d*2), by + (A.y-by)*t/(d*2)
        if not s.can_place_entity{name='character', position={qx, qy}} then
          local what = thing(s, {qx, qy})
          if what == 'земля' then what = s.get_tile(qx, qy).name end
          blocker = {x=r1(qx), y=r1(qy), what=what}
          break
        end
      end
      return {found=false, exhausted=n == 0, cut_box=cut_box, cut_map=cut_map, cut_enemy=cut_enemy, closest={x=bx, y=by, dist=r1(d)}, blocker=blocker, expanded=expanded, nests=nests}
    end
    local rev = {}
    local c = goal
    while c and not (c[1] == sx and c[2] == sy) do rev[#rev+1] = c c = from[key(c[1], c[2])] end
    local pts = {{x=sx/2, y=sy/2}}
    for i = #rev, 1, -1 do pts[#pts+1] = {x=rev[i][1]/2, y=rev[i][2]/2} end
    local out, len = {pts[1]}, 0
    for i = 2, #pts do
      local a, b, c = pts[i-1], pts[i], pts[i+1]
      len = len + dist(a, b)
      if not c or math.abs((b.x-a.x)*(c.y-b.y) - (b.y-a.y)*(c.x-b.x)) > 0.001 then out[#out+1] = b end
    end
    return {found=true, len=r1(len), points=out, expanded=expanded, nests=nests}`,

  // Кусаки рядом с персонажем (то, что он видит на экране): сколько и где ближайший.
  foes: `
    local e = bot()
    local best, bd, n = nil, nil, 0
    for _, c in pairs(e.surface.find_entities_filtered{position=e.position, radius=25, force='enemy', type='unit'}) do
      n = n + 1
      local d = dist(c.position, e.position)
      if not bd or d < bd then best, bd = c, d end
    end
    return {count=n, name=best and best.name or nil, nearest=best and P(best.position) or nil, dist=bd and r1(bd) or nil}`,

  look: `
    local e = bot()
    local groups, list = {}, {}
    for _, c in pairs(e.surface.find_entities_filtered{position=e.position, radius=A.radius}) do
      if (not SKIP[c.type] or c.type == 'character-corpse') and c.type ~= 'cliff' and c.prototype.selectable_in_game then
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
    local t = at(e, A.x, A.y, true)
    local r = {name=t.name, type=t.type, pos=P(t.position), dist=r1(dist(t.position, e.position))}
    if t.type == 'resource' then r.amount = t.amount return r end
    if t.type == 'character-corpse' then
      r.items = contents(t.get_inventory(defines.inventory.character_corpse))
      r.note = 'труп персонажа: забрать всё — take_items без item'
      return r
    end
    r.direction = t.supports_direction and dirname(t.direction) or nil
    if t.health then r.health = math.floor(t.health) end
    pcall(function() local rc = t.get_recipe() if rc then r.recipe = rc.name end end)
    r.status = status_of(t)
    if t.type == 'inserter' then
      r.takes_from, r.puts_to = arm(t)
      pcall(function() if t.held_stack.valid_for_read then r.holding = t.held_stack.name end end)
    end
    if BELT[t.type] then r.on_belt = belt_items(t) r.lanes = belt_lanes(t) end
    if t.type == 'underground-belt' then r.underground = t.belt_to_ground_type == 'input' and 'вход под землю' or 'выход из-под земли'
      local o = t.underground_belt_neighbour
      if o then r.paired_with = P(o.position)
      else r.paired_with = t.belt_to_ground_type == 'input' and 'пары нет: впереди по ходу в пределах дальности нужен выход, смотрящий туда же' or 'пары нет: позади по ходу в пределах дальности нужен вход, смотрящий туда же' end
    end
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

  place: PLACE_FN + `
    return place_one(bot(), A)`,

  // Ждать ли ручного крафта: каких предметов из A.items ({предмет: сколько нужно}; с A.recipe — ещё и ингредиентов на
  // A.count штук рецепта) не хватает в инвентаре (short) и стоит ли хоть один из них в очереди ручного крафта (waiting).
  // Промежуточные предметы чужого крафта (prerequisite) не в счёт: их заберёт тот крафт.
  craft_wait: `
    local e = bot()
    local need = {}
    for k, v in pairs(A.items or {}) do need[k] = v end
    if A.recipe then
      local rc = e.force.recipes[A.recipe]
      if rc then for _, i in pairs(rc.ingredients) do if i.type ~= 'fluid' then need[i.name] = (need[i.name] or 0) + i.amount*(A.count or 1) end end end
    end
    local queued = {}
    if e.crafting_queue_size > 0 then
      for _, q in pairs(e.crafting_queue or {}) do
        if not q.prerequisite then
          local rp = prototypes.recipe[type(q.recipe) == 'string' and q.recipe or q.recipe.name]
          if rp then for _, p in pairs(rp.products) do if p.type == 'item' then queued[p.name] = (queued[p.name] or 0) + (p.amount or 1)*q.count end end end
        end
      end
    end
    local short, waiting = {}, false
    for k, v in pairs(need) do
      local have = e.get_item_count(k)
      if have < v then
        short[k] = {have=have, need=v, queued=queued[k] or 0}
        if queued[k] then waiting = true end
      end
    end
    return {short=short, waiting=waiting, queue=e.crafting_queue_size}`,

  // Группа разных построек. За один вызов ставится только то, до чего персонаж дотягивается, и не больше, чем успел бы
  // опытный игрок: тот же предмет, что и прошлая постройка, — 2 тика (протяжка мышью с зажатой кнопкой, 30 в секунду),
  // другой предмет — 12 тиков (сменить предмет в руке и кликнуть, пять в секунду). В запасе — тики, прошедшие с прошлой
  // постройки этой группы (не больше 60); после паузы дольше секунды — одна постройка. Счёт по тикам игры, а не по часам клиента.
  place_many: PLACE_FN + `
    local e = bot()
    storage.vb_pm = storage.vb_pm or {}
    local last = storage.vb_pm[A.bot]
    if type(last) == 'number' then last = {tick=last} end
    local avail, prev = 12, nil
    if last and game.tick - last.tick <= 60 then avail, prev = game.tick - last.tick, last.item end
    local out, far, used, near, left = {}, 0, 0, {}, 0
    for k, it in ipairs(A.items) do
      local d = dist(e.position, it)
      if d > 10 then far = far + 1 else near[k] = d left = left + 1 end
    end
    while left > 0 do
      -- Сначала всё в досягаемости с тем же предметом, что в руке (по порядку списка), потом смена предмета.
      local pick
      for k, it in ipairs(A.items) do
        if near[k] then
          if it.item == prev then pick = k break end
          pick = pick or k
        end
      end
      local it = A.items[pick]
      local cost = it.item == prev and 2 or 12
      if cost > avail then break end
      local ok, r = pcall(place_one, e, it)
      if ok and r.already then out[#out+1] = {i=it.i, ok=true, r=r}
      elseif ok then avail = avail - cost prev = it.item used = used + 1 out[#out+1] = {i=it.i, ok=true, r=r}
      else out[#out+1] = {i=it.i, ok=false, why=tostring(r), near=near[pick] < 2.5} end
      near[pick] = nil left = left - 1
    end
    if used > 0 then storage.vb_pm[A.bot] = {tick=game.tick, item=prev} end
    return {results=out, waiting=left, far=far}`,

  // Шаблоны построек: запомненная расстановка, которую персонаж потом ставит сам из инвентаря (как игрок по чертежу,
  // только руками). Хранятся в storage.vb_tpl, общие для всех ботов; менять и удалять шаблон может только тот, кто сохранил.
  // В шаблоне: предмет, смещение центра постройки от северо-западного угла шаблона, направление, вход/выход подземного
  // конвейера, рецепт сборочного автомата. Сохранить можно только то, что персонаж видит рядом с собой.
  tpl_save: `
    local e = bot()
    storage.vb_tpl = storage.vb_tpl or {}
    local old = storage.vb_tpl[A.name]
    if old and old.by ~= A.bot then fail('шаблон '..A.name..' уже есть, его сохранил '..old.by..': выбери другое имя') end
    if A.x2 - A.x1 > 50 or A.y2 - A.y1 > 50 then fail('область больше 50×50 клеток') end
    for _, c in pairs({{A.x1, A.y1}, {A.x2, A.y1}, {A.x1, A.y2}, {A.x2, A.y2}}) do
      if dist(e.position, {x=c[1], y=c[2]}) > 60 then fail('область должна быть целиком в пределах 60 клеток от персонажа: подойди ближе') end
    end
    local mine = 0
    for _, t in pairs(storage.vb_tpl) do if t.by == A.bot then mine = mine + 1 end end
    if not old and mine >= 20 then fail('у тебя уже 20 шаблонов: удали ненужный (template_delete)') end
    local found, not_saved = {}, {}
    local bx0, by0, bx1, by1
    for _, c in pairs(e.surface.find_entities_filtered{area={{A.x1+0.05, A.y1+0.05}, {A.x2-0.05, A.y2-0.05}}, force=e.force}) do
      if not SKIP[c.type] and c.type ~= 'entity-ghost' and c.type ~= 'tile-ghost' then
        local it = c.prototype.items_to_place_this and c.prototype.items_to_place_this[1]
        if it and (it.count or 1) == 1 then
          local bb = c.bounding_box
          local ax, ay, cx, cy = math.floor(bb.left_top.x+0.01), math.floor(bb.left_top.y+0.01), math.ceil(bb.right_bottom.x-0.01), math.ceil(bb.right_bottom.y-0.01)
          bx0 = math.min(bx0 or ax, ax) by0 = math.min(by0 or ay, ay) bx1 = math.max(bx1 or cx, cx) by1 = math.max(by1 or cy, cy)
          local rec = {item=it.name, ent=c.name, x=c.position.x, y=c.position.y, dir=c.supports_direction and dirname(c.direction) or 'north'}
          if c.type == 'underground-belt' then rec.ug = c.belt_to_ground_type end
          if c.type == 'assembling-machine' then pcall(function() local rc = c.get_recipe() if rc then rec.recipe = rc.name end end) end
          found[#found+1] = rec
        else not_saved[c.name] = (not_saved[c.name] or 0) + 1 end
      end
    end
    if #found == 0 then fail('в области нет построек, которые можно поставить из инвентаря') end
    if #found > 100 then fail('в области '..#found..' построек, в шаблоне можно не больше 100: возьми область меньше') end
    table.sort(found, function(a, b) if a.y ~= b.y then return a.y < b.y end return a.x < b.x end)
    local items, cost = {}, {}
    for i, f in ipairs(found) do
      items[i] = {item=f.item, ent=f.ent, dx=f.x-bx0, dy=f.y-by0, dir=f.dir, ug=f.ug, recipe=f.recipe}
      cost[f.item] = (cost[f.item] or 0) + 1
    end
    storage.vb_tpl[A.name] = {by=A.bot, w=bx1-bx0, h=by1-by0, items=items}
    return {saved=A.name, replaced=old ~= nil, origin={x=bx0, y=by0}, size={w=bx1-bx0, h=by1-by0}, entities=#items, cost=cost, not_saved=not_saved}`,

  // Разметка шаблона на месте: A.x, A.y — клетка северо-западного угла, A.rot — число поворотов на 90° по часовой.
  // Что уже стоит (такая же постройка в той же точке) — в план не попадает. A.check — заодно проверить, свободно ли место.
  tpl_plan: `
    local e = bot()
    local t = (storage.vb_tpl or {})[A.name]
    if not t then fail('нет шаблона '..A.name..' (список шаблонов — template_cost без имени)') end
    local s = e.surface
    local ox, oy = math.floor(A.x), math.floor(A.y)
    local w, h = t.w, t.h
    if A.rot % 2 == 1 then w, h = h, w end
    local can_check = A.check and dist(e.position, {x=ox+w/2, y=oy+h/2}) <= 60
    local out, need, have, turned, blocked, already = {}, {}, {}, {}, {}, 0
    for _, it in ipairs(t.items) do
      local dx, dy, d = it.dx, it.dy, defines.direction[it.dir]
      local ch = t.h
      for k = 1, A.rot do dx, dy = ch - dy, dx ch = (ch == t.h) and t.w or t.h d = (d + 4) % 16 end
      local x, y = ox + dx, oy + dy
      local same
      for _, c in pairs(s.find_entities_filtered{name=it.ent, area={{x-0.1, y-0.1}, {x+0.1, y+0.1}}}) do
        if dist(c.position, {x=x, y=y}) < 0.1 then same = c end
      end
      if same then
        already = already + 1
        if same.supports_direction and same.direction ~= d and #turned < 10 then turned[#turned+1] = {item=it.item, x=x, y=y, stands=dirname(same.direction), template=dirname(d)} end
      else
        need[it.item] = (need[it.item] or 0) + 1
        out[#out+1] = {item=it.item, x=x, y=y, direction=dirname(d), underground=it.ug, recipe=it.recipe}
        if can_check and not s.can_place_entity{name=it.ent, position={x, y}, direction=d, force=e.force, build_check_type=defines.build_check_type.manual} then
          blocked[#blocked+1] = {item=it.item, x=x, y=y}
        end
      end
    end
    for k in pairs(need) do have[k] = e.get_item_count(k) end
    return {items=out, need=need, have=have, already=already, turned=turned, blocked=blocked, checked=can_check and true or false, total=#t.items, origin={x=ox, y=oy}, size={w=w, h=h}}`,

  tpl_info: `
    local e = bot()
    local all = storage.vb_tpl or {}
    if not A.name then
      local list = {}
      for n, t in pairs(all) do list[#list+1] = {name=n, by=t.by, size={w=t.w, h=t.h}, entities=#t.items} end
      table.sort(list, function(a, b) return a.name < b.name end)
      return {templates=list, count=#list}
    end
    local t = all[A.name]
    if not t then fail('нет шаблона '..A.name..' (список шаблонов — template_cost без имени)') end
    local cost, have, missing, layout = {}, {}, {}, {}
    for i, it in ipairs(t.items) do
      cost[it.item] = (cost[it.item] or 0) + 1
      layout[i] = {item=it.item, dx=it.dx, dy=it.dy, direction=it.dir, underground=it.ug, recipe=it.recipe}
    end
    local enough = true
    for k, v in pairs(cost) do
      have[k] = e.get_item_count(k)
      if have[k] < v then missing[k] = v - have[k] enough = false end
    end
    return {name=A.name, by=t.by, size={w=t.w, h=t.h}, entities=#t.items, cost=cost, have=have, missing=missing, enough=enough, layout=layout}`,

  tpl_delete: `
    local t = (storage.vb_tpl or {})[A.name]
    if not t then fail('нет шаблона '..A.name) end
    if t.by ~= A.bot then fail('шаблон '..A.name..' сохранил '..t.by..': удалить его может только он') end
    storage.vb_tpl[A.name] = nil
    return {deleted=A.name}`,

  // План-призраки: призраки построек на карте, как от чертежа в игре (игрок ставит их где угодно на открытой карте,
  // без предметов и мгновенно; строить их потом надо руками из инвентаря — ghost_build идёт через place_many).
  // Планы лежат в storage.vb_ghost[имя] = {by, ents — сами призраки}; дописывать и убирать план может только автор.
  // A.items — список {item, x, y, direction, underground, recipe}; повторный вызов с теми же клетками ничего не дублирует.
  ghost_add: `
    local e = bot()
    local s, f = e.surface, e.force
    storage.vb_ghost = storage.vb_ghost or {}
    local pl = storage.vb_ghost[A.name]
    if pl and pl.by ~= A.bot then fail('план '..A.name..' уже есть, его ведёт '..pl.by..': выбери другое имя') end
    local ents = {}
    if pl then for _, g in pairs(pl.ents) do if g.valid then ents[#ents+1] = g end end end
    if not pl then
      local mine = 0
      for _, p in pairs(storage.vb_ghost) do if p.by == A.bot then mine = mine + 1 end end
      if mine >= 20 then fail('у тебя уже 20 планов: убери ненужный (ghost_clear)') end
    end
    local placed, already, blocked, blocked_count, full = 0, 0, {}, 0, false
    local function no(it, why) blocked_count = blocked_count + 1 if #blocked < 15 then blocked[#blocked+1] = {item=it.item, x=it.x, y=it.y, why=why} end end
    for _, it in ipairs(A.items) do
      local ip = prototypes.item[it.item]
      local pr = ip and ip.place_result
      if not pr then no(it, 'нет такого предмета или его нельзя поставить на землю')
      elseif not f.is_chunk_charted(s, {math.floor(it.x/32), math.floor(it.y/32)}) then no(it, 'карта здесь не открыта')
      else
        local dir = defines.direction[it.direction or 'north']
        local same
        for _, c in pairs(s.find_entities_filtered{area={{it.x-0.1, it.y-0.1}, {it.x+0.1, it.y+0.1}}, force=f}) do
          if (c.name == pr.name or (c.type == 'entity-ghost' and c.ghost_name == pr.name)) and dist(c.position, it) < 0.1 then same = c end
        end
        if same then already = already + 1
        elseif #ents >= 5000 then full = true no(it, 'в плане уже 5000 призраков: заведи план с другим именем')
        elseif not s.can_place_entity{name=pr.name, position={it.x, it.y}, direction=dir, force=f, build_check_type=defines.build_check_type.manual_ghost} then no(it, 'занято или не та поверхность')
        else
          local g = s.create_entity{name='entity-ghost', inner_name=pr.name, position={it.x, it.y}, direction=dir, force=f, expires=false, type=it.underground, raise_built=true}
          if not g then no(it, 'сюда поставить нельзя')
          else
            if it.recipe and g.ghost_type == 'assembling-machine' then
              local rc = f.recipes[it.recipe]
              if rc and rc.enabled then pcall(function() g.set_recipe(rc) end) end
            end
            ents[#ents+1] = g placed = placed + 1
          end
        end
      end
    end
    if #ents > 0 then
      storage.vb_ghost[A.name] = {by=A.bot, ents=ents}
      if storage.vb_ghost_done then storage.vb_ghost_done[A.name] = nil end
    else storage.vb_ghost[A.name] = nil end
    return {placed=placed, already=already, blocked=blocked, blocked_count=blocked_count, in_plan=#ents, full=full}`,

  // Призраки плана A.name и/или в прямоугольнике A.x1..A.y2: сколько чего нужно, что есть в инвентаре, границы;
  // A.limit — сколько призраков приложить списком (ближайшие к персонажу сверху). Без имени и области — список планов.
  // Призраки видны на карте всей команде, поэтому расстояние не ограничено. Заодно чистит планы от построенного.
  ghost_q: `
    local e = bot()
    local s, f = e.surface, e.force
    storage.vb_ghost = storage.vb_ghost or {}
    local function live(n)
      local pl, r = storage.vb_ghost[n], {}
      for _, g in pairs(pl.ents) do if g.valid then r[#r+1] = g end end
      if #r == 0 then
        -- План без призраков исчезает, но имя помним: повторный ghost_build/ghost_list по нему — не ошибка.
        storage.vb_ghost_done = storage.vb_ghost_done or {}
        storage.vb_ghost_done[n] = {by=pl.by, tick=game.tick}
        storage.vb_ghost[n] = nil
      else pl.ents = r end
      return r
    end
    local function box(list)
      local b
      for _, g in pairs(list) do
        local p = g.position
        if not b then b = {x1=p.x, y1=p.y, x2=p.x, y2=p.y} end
        b.x1 = math.min(b.x1, p.x) b.y1 = math.min(b.y1, p.y) b.x2 = math.max(b.x2, p.x) b.y2 = math.max(b.y2, p.y)
      end
      if b then b.x1 = math.floor(b.x1) b.y1 = math.floor(b.y1) b.x2 = math.ceil(b.x2) b.y2 = math.ceil(b.y2) end
      return b
    end
    local names = {}
    for n in pairs(storage.vb_ghost) do names[#names+1] = n end
    table.sort(names)
    if not A.name and not A.x1 then
      local list = {}
      for _, n in ipairs(names) do
        local by = storage.vb_ghost[n].by
        local l = live(n)
        if #l > 0 then list[#list+1] = {name=n, by=by, ghosts=#l, area=box(l)} end
      end
      return {plans=list, count=#list}
    end
    local list = {}
    if A.name then
      if not storage.vb_ghost[A.name] then
        local d = (storage.vb_ghost_done or {})[A.name]
        if d then return {name=A.name, by=d.by, ghosts=0, already_built=true, cost={}, have={}, missing={}, enough=true, items={},
          note='в плане не осталось призраков: всё построено (или призраки убрали с карты), план снят с учёта'} end
      end
      if not storage.vb_ghost[A.name] then fail('нет плана '..A.name..' (список планов — ghost_list без аргументов; полностью построенный план исчезает сам)') end
      for _, g in pairs(live(A.name)) do
        local p = g.position
        if not A.x1 or (p.x >= A.x1 and p.x <= A.x2 and p.y >= A.y1 and p.y <= A.y2) then list[#list+1] = g end
      end
    else
      if A.x2 - A.x1 > 1000 or A.y2 - A.y1 > 1000 then fail('область больше 1000×1000 клеток') end
      list = s.find_entities_filtered{type='entity-ghost', area={{A.x1, A.y1}, {A.x2, A.y2}}, force=f}
    end
    local me = e.position
    local rows, cost, have, missing, enough = {}, {}, {}, {}, true
    for _, g in pairs(list) do
      local its = g.ghost_prototype.items_to_place_this
      local it = its and its[1]
      if it then
        cost[it.name] = (cost[it.name] or 0) + 1
        rows[#rows+1] = {g=g, item=it.name, d=dist(me, g.position)}
      end
    end
    for k, v in pairs(cost) do
      have[k] = e.get_item_count(k)
      if have[k] < v then missing[k] = v - have[k] enough = false end
    end
    table.sort(rows, function(a, b) if a.d ~= b.d then return a.d < b.d end if a.g.position.y ~= b.g.position.y then return a.g.position.y < b.g.position.y end return a.g.position.x < b.g.position.x end)
    local items = {}
    for i = 1, math.min(#rows, A.limit or 0) do
      local g = rows[i].g
      local r = {item=rows[i].item, x=g.position.x, y=g.position.y, direction=g.supports_direction and dirname(g.direction) or 'north'}
      if g.ghost_type == 'underground-belt' then r.underground = g.belt_to_ground_type end
      if g.ghost_type == 'assembling-machine' then pcall(function() local rc = g.get_recipe() if rc then r.recipe = rc.name end end) end
      items[i] = r
    end
    return {name=A.name, by=A.name and storage.vb_ghost[A.name] and storage.vb_ghost[A.name].by or nil, ghosts=#rows, area=box(list), cost=cost, have=have, missing=missing, enough=enough, items=items}`,

  // Убрать призраки своих планов: план A.name целиком или его часть в области; только область — свои планы в ней.
  ghost_clear: `
    bot()
    storage.vb_ghost = storage.vb_ghost or {}
    if A.name then
      local pl = storage.vb_ghost[A.name]
      if not pl then fail('нет плана '..A.name) end
      if pl.by ~= A.bot then fail('план '..A.name..' ведёт '..pl.by..': убрать его может только он') end
    end
    local removed, plans = 0, {}
    for n, pl in pairs(storage.vb_ghost) do
      if pl.by == A.bot and (not A.name or n == A.name) then
        local keep = {}
        for _, g in pairs(pl.ents) do
          if g.valid then
            local p = g.position
            if not A.x1 or (p.x >= A.x1 and p.x <= A.x2 and p.y >= A.y1 and p.y <= A.y2) then g.destroy() removed = removed + 1
            else keep[#keep+1] = g end
          end
        end
        plans[#plans+1] = {name=n, left=#keep}
        if #keep == 0 then storage.vb_ghost[n] = nil else pl.ents = keep end
      end
    end
    table.sort(plans, function(a, b) return a.name < b.name end)
    return {removed=removed, plans=plans}`,

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
    local t = at(e, A.x, A.y, true)
    reach(e, t, 10)
    local invs = {}
    local body = t.type == 'character-corpse'
    if body then invs[1] = t.get_inventory(defines.inventory.character_corpse)
    elseif A.item then for i = 1, t.get_max_inventory_index() do local v = t.get_inventory(i) if v then invs[#invs+1] = v end end
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
    if not next(taken) then fail(body and (A.item and 'в трупе нет '..A.item..' (или в инвентаре нет места)' or 'труп пуст или в инвентаре нет места') or 'забирать нечего') end
    local r = {taken=taken, from=t.name}
    if body then
      r.left_in_corpse = invs[1].get_item_count()
      if r.left_in_corpse > 0 and left > 0 and not A.item then r.note = 'в инвентаре кончилось место: освободи его и забери остальное' end
    end
    return r`,

  // Сколько предметов из списка A.items сейчас в инвентаре персонажа (для отчёта gather).
  gather_have: `
    local e = bot()
    local have = {}
    for _, k in pairs(A.items) do if prototypes.item[k] then have[k] = e.get_item_count(k) end end
    return {have=have}`,

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
      if A.remove and A.position then fail('remove и position вместе не задаются') end
      if A.remove or (A.position and queued(t)) then
      elseif t.researched then res.added = false res.reason = 'уже исследована'
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
    -- Перестановка и удаление в очереди, как перетаскивание и крестик в окне исследований. Очередь всегда идёт
    -- в порядке зависимостей, поэтому вместе с технологией двигаются её соседи по очереди, без которых порядок сломался бы.
    if A.technology and (A.remove or A.position) then
      local t = f.technologies[A.technology]
      local names = {}
      for _, q in pairs(f.research_queue) do names[#names+1] = q.name end
      if not queued(t) then
        if A.remove then res.removed = false res.reason = 'нет в очереди' end
      elseif A.remove then
        -- Убираем и то, что стоит в очереди и зависит от убранного.
        local gone, keep, also = {[t.name]=true}, {}, {}
        for _, n in ipairs(names) do
          if not gone[n] then for _, p in pairs(f.technologies[n].prerequisites) do if gone[p.name] then gone[n] = true end end end
          if gone[n] then if n ~= t.name then also[#also+1] = n end else keep[#keep+1] = n end
        end
        f.research_queue = keep
        res.removed = not queued(t)
        if not res.removed then res.reason = 'игра не приняла' elseif #also > 0 then res.also_removed = also end
      else
        local group = {[t.name]=true}
        if A.position == 'first' then
          -- В начало: вместе с ещё не исследованными предшественниками из очереди.
          local function mark(x) for _, p in pairs(x.prerequisites) do if not p.researched and not group[p.name] then group[p.name] = true mark(p) end end end
          mark(t)
        else
          -- В конец: вместе с теми, кто от неё зависит.
          for _, n in ipairs(names) do
            if not group[n] then for _, p in pairs(f.technologies[n].prerequisites) do if group[p.name] then group[n] = true end end end
          end
        end
        local g, rest, also = {}, {}, {}
        for _, n in ipairs(names) do
          if group[n] then g[#g+1] = n if n ~= t.name then also[#also+1] = n end else rest[#rest+1] = n end
        end
        local list = {}
        if A.position == 'first' then for _, n in ipairs(g) do list[#list+1] = n end for _, n in ipairs(rest) do list[#list+1] = n end
        else for _, n in ipairs(rest) do list[#list+1] = n end for _, n in ipairs(g) do list[#list+1] = n end end
        f.research_queue = list
        local now = {}
        for i, q in pairs(f.research_queue) do now[i] = q.name if q.name == t.name then res.position = i end end
        res.moved = #now == #list
        for i, n in ipairs(list) do if now[i] ~= n then res.moved = false end end
        if not res.moved then res.reason = 'игра не приняла новый порядок' elseif #also > 0 then res.also_moved = also end
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

  // Сводка «что встало»: состояния машин, как значки над ними в игре. Игрок видит их на экране и на карте там, где
  // карта показывается вживую (рядом с собой, под радаром), поэтому дальше 60 клеток смотрим только в таких чанках.
  alerts: `
    local e = bot()
    local f, s = e.force, e.surface
    local MAJOR = {no_fuel=true, no_power=true, low_power=true, not_plugged_in_electric_network=true, no_minable_resources=true,
      missing_science_packs=true, no_ammo=true, no_input_fluid=true, missing_required_fluid=true, fuel_running_out=true}
    local MINOR = {no_ingredients=true, item_ingredient_shortage=true, fluid_ingredient_shortage=true, full_output=true,
      waiting_for_space_in_destination=true, no_recipe=true, no_research_in_progress=true, low_input_fluid=true, full_burnt_result_output=true}
    local TYPES = {'mining-drill', 'furnace', 'assembling-machine', 'lab', 'boiler', 'generator', 'burner-generator', 'reactor',
      'offshore-pump', 'pump', 'inserter', 'rocket-silo', 'ammo-turret', 'electric-turret', 'radar', 'beacon'}
    local vis = {}
    local function visible(p)
      if dist(p, e.position) <= 60 then return true end
      local cx, cy = math.floor(p.x/32), math.floor(p.y/32)
      local k = cx..','..cy
      if vis[k] == nil then vis[k] = f.is_chunk_visible(s, {cx, cy}) end
      return vis[k]
    end
    local groups, major, minor, checked, hidden, low = {}, {}, {}, 0, 0, 0
    for _, c in pairs(s.find_entities_filtered{position=e.position, radius=A.radius, force=f, type=TYPES}) do
      if not visible(c.position) then hidden = hidden + 1
      else
        checked = checked + 1
        local st = status_of(c)
        if st == 'low_power' then low = low + 1 end
        if not MAJOR[st] and not MINOR[st] then
          -- Топливо ещё горит, но в топке больше ничего не лежит: скоро встанет.
          pcall(function() if c.burner and c.burner.remaining_burning_fuel > 0 and c.burner.inventory.is_empty() then st = 'fuel_running_out' end end)
        end
        if MAJOR[st] or MINOR[st] then
          local k = st..'|'..c.name
          local g = groups[k]
          if not g then
            g = {status=st, name=c.name, count=0, all={}}
            groups[k] = g
            local list = MAJOR[st] and major or minor
            list[#list+1] = g
          end
          g.count = g.count + 1
          g.all[#g.all+1] = {pos=P(c.position), dist=r1(dist(c.position, e.position))}
        end
      end
    end
    local function finish(list)
      for _, g in pairs(list) do
        table.sort(g.all, function(a, b) return a.dist < b.dist end)
        g.nearest = {}
        for i = 1, math.min(#g.all, 6) do g.nearest[i] = g.all[i] end
        g.all = nil
      end
      table.sort(list, function(a, b) return a.count > b.count end)
      local out = {}
      for i = 1, math.min(#list, 25) do out[i] = list[i] end
      return out
    end
    local r = {me=P(e.position), radius=A.radius, machines_checked=checked, problems=finish(major), shortage=low > 0}
    if A.idle then r.idle = finish(minor) end
    if hidden > 0 then r.not_visible = hidden end
    return r`,

  // Загрязнение, как слой загрязнения на карте: игрок видит облако на всей открытой карте, а гнёзда и кусак — только там,
  // где карта показывается вживую (рядом с собой, под радаром). Поэтому гнёзда и враги вне такой видимости не выдаются
  // вовсе, даже числом. Один чанк — 32×32 клетки, уровень у чанка один.
  pollution: `
    local e = bot()
    local f, s = e.force, e.surface
    local c = {x=A.x or e.position.x, y=A.y or e.position.y}
    local R = A.radius
    local function mid(cx, cy) return {x=cx*32+16, y=cy*32+16} end
    local vis = {}
    local function chunk_visible(cx, cy)
      local k = cx..','..cy
      if vis[k] == nil then vis[k] = f.is_chunk_visible(s, {cx, cy}) end
      return vis[k]
    end
    local function visible(p) return dist(p, e.position) <= 60 or chunk_visible(math.floor(p.x/32), math.floor(p.y/32)) end
    local cx0, cx1, cy0, cy1 = math.floor((c.x-R)/32), math.floor((c.x+R)/32), math.floor((c.y-R)/32), math.floor((c.y+R)/32)
    local area = {{cx0*32, cy0*32}, {cx1*32+32, cy1*32+32}}
    -- Гнёзда и кусаки, которых сейчас видно, по чанкам.
    local function seen(type)
      local groups, list = {}, {}
      for _, t in pairs(s.find_entities_filtered{area=area, type=type, force='enemy'}) do
        if visible(t.position) then
          local cx, cy = math.floor(t.position.x/32), math.floor(t.position.y/32)
          local k = cx..','..cy
          local g = groups[k]
          if not g then g = {count=0, sx=0, sy=0} groups[k] = g list[#list+1] = g end
          g.count = g.count + 1 g.sx = g.sx + t.position.x g.sy = g.sy + t.position.y
        end
      end
      for _, g in pairs(list) do g.pos = {x=g.sx/g.count, y=g.sy/g.count} end
      return list, groups
    end
    local nests, nest_at = seen('unit-spawner')
    local dirty, charted, unseen, unknown, total, max = {}, 0, 0, 0, 0, nil
    local rows = {}
    for cy = cy0, cy1 do
      local row = {}
      for cx = cx0, cx1 do
        local ch = '?'
        if f.is_chunk_charted(s, {cx, cy}) then
          charted = charted + 1
          local m = mid(cx, cy)
          if not (dist(m, e.position) <= 60 or chunk_visible(cx, cy)) then unseen = unseen + 1 end
          local v = s.get_pollution(m)
          ch = '.'
          if v >= 1 then
            dirty[#dirty+1] = {cx=cx, cy=cy, v=v}
            total = total + v
            if not max or v > max.v then max = {cx=cx, cy=cy, v=v} end
            ch = tostring(math.min(9, math.floor(math.log(v)/math.log(2)) + 1))
          end
          if nest_at[cx..','..cy] then ch = 'N' end
        else unknown = unknown + 1 end
        row[#row+1] = ch
      end
      rows[#rows+1] = table.concat(row)
    end
    -- Расстояние от точки до ближайшего загрязнённого чанка (0 — точка внутри облака).
    local function gap(p)
      local best
      for _, d in pairs(dirty) do
        local dx = math.max(d.cx*32 - p.x, 0, p.x - (d.cx*32+32))
        local dy = math.max(d.cy*32 - p.y, 0, p.y - (d.cy*32+32))
        local g = (dx*dx+dy*dy)^0.5
        if not best or g < best then best = g end
      end
      return best
    end
    local r = {center=P(c), radius=R, chunks_charted=charted}
    if f.is_chunk_charted(s, {math.floor(c.x/32), math.floor(c.y/32)}) then r.here = math.floor(s.get_pollution(c)+0.5) end
    local cloud = {chunks=#dirty, total=math.floor(total+0.5)}
    if max then
      cloud.max = {pollution=math.floor(max.v+0.5), pos=mid(max.cx, max.cy)}
      local x0, x1, y0, y1
      for _, d in pairs(dirty) do
        x0 = math.min(x0 or d.cx, d.cx) x1 = math.max(x1 or d.cx, d.cx) y0 = math.min(y0 or d.cy, d.cy) y1 = math.max(y1 or d.cy, d.cy)
      end
      cloud.x_from, cloud.x_to, cloud.y_from, cloud.y_to = x0*32, x1*32+32, y0*32, y1*32+32
    end
    r.cloud = cloud
    local inside, nearest = 0, nil
    for _, g in pairs(nests) do
      g.pollution = math.floor(s.get_pollution(g.pos)+0.5)
      g.cloud_dist = gap(g.pos)
      if g.cloud_dist == 0 then inside = inside + 1 end
      if g.cloud_dist and (not nearest or g.cloud_dist < nearest) then nearest = g.cloud_dist end
    end
    table.sort(nests, function(a, b)
      local da, db = a.cloud_dist or 1e9, b.cloud_dist or 1e9
      if da ~= db then return da < db end
      if a.pollution ~= b.pollution then return a.pollution > b.pollution end
      return dist(a.pos, c) < dist(b.pos, c)
    end)
    local out = {}
    for i = 1, math.min(#nests, 15) do
      local g = nests[i]
      out[i] = {pos=P(g.pos), spawners=g.count, in_cloud=g.cloud_dist == 0, pollution=g.pollution,
        cloud_dist=g.cloud_dist and math.floor(g.cloud_dist+0.5) or nil, dist=math.floor(dist(g.pos, c)+0.5)}
    end
    r.nests_seen = #nests
    r.nests_in_cloud = inside
    if nearest then r.nearest_nest_to_cloud = math.floor(nearest+0.5) end
    r.nests = out
    local units = seen('unit')
    table.sort(units, function(a, b) return dist(a.pos, c) < dist(b.pos, c) end)
    local en, ecount = {}, 0
    for i, g in ipairs(units) do
      ecount = ecount + g.count
      if i <= 10 then en[#en+1] = {pos=P(g.pos), count=g.count, dist=math.floor(dist(g.pos, c)+0.5)} end
    end
    r.enemies_seen = ecount
    r.enemies = en
    r.chunks_not_visible = unseen
    r.chunks_unexplored = unknown
    pcall(function() r.evolution_percent = r1(game.forces.enemy.get_evolution_factor(s)*100) end)
    pcall(function()
      local st = game.get_pollution_statistics(s)
      local list = {}
      for name in pairs(st.input_counts) do
        local v = st.get_flow_count{name=name, category='input', precision_index=defines.flow_precision_index.one_minute, count=true}
        if v >= 0.05 then list[#list+1] = {name=name, per_minute=r1(v)} end
      end
      table.sort(list, function(a, b) return a.per_minute > b.per_minute end)
      local top = {}
      for i = 1, math.min(#list, 10) do top[i] = list[i] end
      r.sources_per_minute = top
    end)
    if A.map then r.map = {rows=rows, x0=cx0*32, y0=cy0*32} end
    return r`,

  // Карта области символами, клетка — символ: то, что игрок видит на экране и на карте. Точно (вид постройки, направление
  // ленты) — только там, где видно вживую: в 60 клетках от персонажа и в чанках под радаром. На остальной открытой карте —
  // как на карте в игре: вода, руда, деревья, камни, скалы и «какая-то постройка» (#); врагов там не показываем.
  // A.x1, A.y1 — клетка северо-западного угла, A.x2, A.y2 — за юго-восточным (не включая).
  area_map: `
    local e = bot()
    local f, s = e.force, e.surface
    local W, H = A.x2 - A.x1, A.y2 - A.y1
    local chart, vis = {}, {}
    local function charted(x, y)
      local cx, cy = math.floor(x/32), math.floor(y/32)
      local k = cx..','..cy
      if chart[k] == nil then chart[k] = f.is_chunk_charted(s, {cx, cy}) end
      return chart[k]
    end
    local function live(x, y)
      if dist({x=x+0.5, y=y+0.5}, e.position) <= 60 then return true end
      local cx, cy = math.floor(x/32), math.floor(y/32)
      local k = cx..','..cy
      if vis[k] == nil then vis[k] = f.is_chunk_visible(s, {cx, cy}) end
      return vis[k]
    end
    -- В клетке остаётся самое важное: постройка > призрак > дерево, камень, скала > вода > руда.
    local sym, rank = {}, {}
    local function put(x, y, ch, r)
      if x < A.x1 or x >= A.x2 or y < A.y1 or y >= A.y2 then return end
      local k = (y - A.y1)*W + (x - A.x1)
      if (rank[k] or 0) < r then rank[k] = r sym[k] = ch end
    end
    for _, t in pairs(s.find_tiles_filtered{area={{A.x1, A.y1}, {A.x2, A.y2}}, collision_mask='water_tile'}) do put(t.position.x, t.position.y, '~', 2) end
    local ORE = {['iron-ore']='i', ['copper-ore']='c', coal='k', stone='s', ['uranium-ore']='u', ['crude-oil']='o'}
    local ARROW = {north='^', east='>', south='v', west='<'}
    local IGNORE = {unit=true, ['tile-ghost']=true, ['unit-spawner']=false}
    local ores, builds, found = {}, {}, {}
    for _, c in pairs(s.find_entities_filtered{area={{A.x1, A.y1}, {A.x2, A.y2}}}) do
      if not SKIP[c.type] and not IGNORE[c.type] then
        local kind
        if c.type == 'resource' then kind = 'ore' ores[c.name] = true
        elseif c.type == 'tree' then kind = '*'
        elseif c.type == 'cliff' then kind = '%'
        elseif c.type == 'entity-ghost' then if c.force == f then kind = '+' end
        elseif c.force.name == 'enemy' then kind = '!'
        elseif c.type == 'simple-entity' then kind = '@'
        elseif c.prototype.selectable_in_game and next(c.prototype.collision_mask.layers) ~= nil then kind = 'b' builds[c.name] = true end
        if kind then found[#found+1] = {c=c, kind=kind} end
      end
    end
    -- Буквы: руда — строчные, постройки — заглавные (по первой букве имени, если свободна).
    local function letters(names, fixed, pool)
      local list, map, used = {}, {}, {}
      for n in pairs(names) do list[#list+1] = n end
      table.sort(list)
      for _, n in ipairs(list) do if fixed[n] and not used[fixed[n]] then map[n] = fixed[n] used[fixed[n]] = true end end
      for _, n in ipairs(list) do
        if not map[n] then
          local first = pool:find(n:sub(1, 1):upper(), 1, true) or pool:find(n:sub(1, 1):lower(), 1, true)
          local ch = first and pool:sub(first, first)
          if not ch or used[ch] then ch = nil for i = 1, #pool do local q = pool:sub(i, i) if not used[q] then ch = q break end end end
          map[n] = ch or '#'
          used[map[n]] = true
        end
      end
      return map
    end
    local ore_sym = letters(ores, ORE, 'abdefghjlmnpqrtwxyz')
    local b_sym = letters(builds, {pipe='='}, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ')
    local seen, details, counts = {}, {}, {}
    for _, r in ipairs(found) do
      local c, ch, rk = r.c, r.kind, 3
      local bb = c.bounding_box
      local ax, ay, bx, by = math.floor(bb.left_top.x+0.02), math.floor(bb.left_top.y+0.02), math.floor(bb.right_bottom.x-0.02), math.floor(bb.right_bottom.y-0.02)
      local lv = live(math.floor(c.position.x), math.floor(c.position.y))
      if ch == 'ore' then ch, rk = ore_sym[c.name], 1 seen[ch] = 'руда '..c.name
      elseif ch == '+' then rk = 4
      elseif ch == '!' then rk = lv and 5 or 0
      elseif ch == 'b' then
        rk = 5
        if not lv then ch = '#'
        elseif c.type == 'transport-belt' then ch = ARROW[dirname(c.direction)] or '#'
        else
          ch = b_sym[c.name] seen[ch] = c.name
          counts[c.name] = (counts[c.name] or 0) + 1
          if A.details and c.name ~= 'pipe' and #details < 200 then
            local d = {name=c.name, x=c.position.x, y=c.position.y, direction=c.supports_direction and dirname(c.direction) or nil}
            if c.type == 'underground-belt' then d.underground = c.belt_to_ground_type end
            pcall(function() local rc = c.get_recipe() if rc then d.recipe = rc.name end end)
            details[#details+1] = d
          end
        end
      end
      if rk > 0 then
        seen[ch] = seen[ch] or true
        for tx = ax, bx do for ty = ay, by do put(tx, ty, ch, rk) end end
      end
    end
    local rows, free, unknown = {}, 0, 0
    for y = 0, H-1 do
      local row = {}
      for x = 0, W-1 do
        local ch = sym[y*W + x]
        if not charted(A.x1+x, A.y1+y) then ch = '?' unknown = unknown + 1
        elseif not ch then ch = '.' free = free + 1 end
        row[x+1] = ch
      end
      rows[y+1] = table.concat(row)
    end
    local named = {}
    for ch, v in pairs(seen) do if v ~= true then named[#named+1] = {s=ch, name=v} end end
    table.sort(named, function(a, b) return a.s < b.s end)
    local coarse = false
    for _, c in pairs({{A.x1, A.y1}, {A.x2-1, A.y1}, {A.x1, A.y2-1}, {A.x2-1, A.y2-1}}) do if not live(c[1], c[2]) then coarse = true end end
    return {x0=A.x1, y0=A.y1, w=W, h=H, rows=rows, named=named, symbols=seen, free=free, unexplored=unknown, coarse=coarse, buildings=counts, details=A.details and details or nil}`,

  // Маршрут конвейера или трубы от клетки (A.fx, A.fy) до (A.tx, A.ty): только расчёт по тому, что игрок видит на
  // экране и карте (как area_map), ничего не ставит. A* по клеткам, состояние — клетка, направление прихода и признак
  // «здесь выход из-под земли» (после него можно только прямо). Занятое (постройки, деревья, камни, скалы, вода,
  // призраки, неоткрытая карта) обходится или проходится под землёй парой подземных концов. Чужое не задеваем:
  // труба не ложится в клетку, куда смотрит соединение чужой трубы или машины; лента — в клетку, куда везёт чужая лента;
  // подземный участок не пересекает по той же оси чужие подземные концы и не ставит свои концы внутри чужой пары.
  // Начало и конец маршрута от этих запретов свободны: там соединение и нужно.
  route: `
    local e = bot()
    local f, s = e.force, e.surface
    local ip = prototypes.item[A.item]
    local pr = ip and ip.place_result
    if not pr or (pr.type ~= 'transport-belt' and pr.type ~= 'pipe') then fail('route прокладывает только конвейер или трубу: item — например transport-belt, fast-transport-belt, pipe') end
    local pipe = pr.type == 'pipe'
    local ug, ugitem, maxd
    if A.underground then
      if pipe then ug = prototypes.entity['pipe-to-ground'] else pcall(function() ug = pr.related_underground_belt end) end
      if ug then
        pcall(function() maxd = ug.max_underground_distance end)
        if pipe and not maxd then maxd = 10 end
        local it = ug.items_to_place_this
        ugitem = it and it[1] and it[1].name
        if not maxd or not ugitem then ug = nil end
      end
    end
    local m = A.margin
    local x1, y1 = math.min(A.fx, A.tx)-m, math.min(A.fy, A.ty)-m
    local x2, y2 = math.max(A.fx, A.tx)+m+1, math.max(A.fy, A.ty)+m+1
    local H = y2-y1
    local function idx(x, y) if x < x1 or x >= x2 or y < y1 or y >= y2 then return nil end return (x-x1)*H + (y-y1) end
    local chart, vis = {}, {}
    local function charted(x, y)
      local cx, cy = math.floor(x/32), math.floor(y/32)
      local k = cx..','..cy
      if chart[k] == nil then chart[k] = f.is_chunk_charted(s, {cx, cy}) end
      return chart[k]
    end
    local function live(x, y)
      if dist({x=x+0.5, y=y+0.5}, e.position) <= 60 then return true end
      local cx, cy = math.floor(x/32), math.floor(y/32)
      local k = cx..','..cy
      if vis[k] == nil then vis[k] = f.is_chunk_visible(s, {cx, cy}) end
      return vis[k]
    end
    local DV = {[0]={0,-1}, {1,0}, {0,1}, {-1,0}}
    local DN = {[0]='north', 'east', 'south', 'west'}
    local function d4(dir) return dir == defines.direction.north and 0 or dir == defines.direction.east and 1 or dir == defines.direction.south and 2 or dir == defines.direction.west and 3 or nil end
    -- blocked — чем занята клетка; bad — клетка, где наша лента или труба соединится с чужим; ugend — чужой подземный конец
    -- того же вида (значение — ось: 0 север-юг, 1 запад-восток); span[ось] — клетки между концами чужой подземной пары.
    local blocked, bad, ugend, span, coarse = {}, {}, {}, {[0]={}, {}}, false
    local function mark(t, x, y, v) local k = idx(math.floor(x), math.floor(y)) if k then t[k] = v == nil and true or v end end
    local function between(p, q)
      local ax, ay, bx, by = math.floor(p.x), math.floor(p.y), math.floor(q.x), math.floor(q.y)
      if ax == bx then for y = math.min(ay, by)+1, math.max(ay, by)-1 do mark(span[0], ax, y) end
      elseif ay == by then for x = math.min(ax, bx)+1, math.max(ax, bx)-1 do mark(span[1], x, ay) end end
    end
    local function around(ax, ay, bx, by)
      for x = ax, bx do mark(bad, x, ay-1) mark(bad, x, by+1) end
      for y = ay, by do mark(bad, ax-1, y) mark(bad, bx+1, y) end
    end
    for _, t in pairs(s.find_tiles_filtered{area={{x1, y1}, {x2, y2}}, collision_mask='water_tile'}) do mark(blocked, t.position.x, t.position.y, 'вода') end
    local FLUID = {pipe=true, ['pipe-to-ground']=true, ['storage-tank']=true, pump=true}
    for _, c in pairs(s.find_entities_filtered{area={{x1, y1}, {x2, y2}}}) do
      local ty = c.type
      if not SKIP[ty] and ty ~= 'resource' and ty ~= 'unit' and ty ~= 'tile-ghost' then
        local lv = live(math.floor(c.position.x), math.floor(c.position.y))
        local enemy = c.force.name == 'enemy'
        local ghost = ty == 'entity-ghost'
        local what
        if ty == 'tree' then what = 'дерево' elseif ty == 'cliff' then what = 'скала' elseif ty == 'simple-entity' then what = 'камень'
        elseif ghost then if c.force == f then what = 'призрак '..c.ghost_name end
        elseif enemy then if lv then what = 'вражеская постройка' end
        elseif c.prototype.selectable_in_game and next(c.prototype.collision_mask.layers) ~= nil then what = lv and c.name or 'постройка' end
        if what then
          local bb = c.bounding_box
          local ax, ay, bx, by = math.floor(bb.left_top.x+0.02), math.floor(bb.left_top.y+0.02), math.floor(bb.right_bottom.x-0.02), math.floor(bb.right_bottom.y-0.02)
          for tx = ax, bx do for ty2 = ay, by do mark(blocked, tx, ty2, what) end end
          local build = not enemy and ty ~= 'tree' and ty ~= 'cliff' and ty ~= 'simple-entity'
          if build and not lv then
            -- Вид постройки отсюда не виден: трубу рядом с ней не кладём — вдруг это труба.
            coarse = true
            if pipe then around(ax, ay, bx, by) end
          elseif build then
            local t = ghost and c.ghost_type or ty
            local d = d4(c.direction)
            if not pipe then
              local out = false
              if t == 'underground-belt' then pcall(function() out = c.belt_to_ground_type == 'output' end) end
              if d and (t == 'transport-belt' or out) then mark(bad, c.position.x+DV[d][1], c.position.y+DV[d][2])
              elseif d and t == 'splitter' then
                local v = DV[d]
                for _, o in pairs{-0.5, 0.5} do mark(bad, c.position.x+v[1]-v[2]*o, c.position.y+v[2]+v[1]*o) end
              end
              if d and t == 'underground-belt' and ug and (ghost and c.ghost_name or c.name) == ug.name then
                mark(ugend, c.position.x, c.position.y, d % 2)
                -- Парный конец: ближайший такой же конвейер на той же линии (вход ищет выход впереди, выход — вход позади).
                local inp = false
                pcall(function() inp = c.belt_to_ground_type == 'input' end)
                local sg = inp and 1 or -1
                for j = 1, maxd do
                  local o = s.find_entities_filtered{name=ug.name, position={c.position.x+DV[d][1]*j*sg, c.position.y+DV[d][2]*j*sg}}[1]
                  if o and o.direction == c.direction then
                    if (o.belt_to_ground_type == 'input') ~= inp then between(c.position, o.position) end
                    break
                  end
                end
              end
            elseif t == 'pipe-to-ground' then
              -- Подземная труба выходит на поверхность только с той стороны, куда смотрит; пара — ближайший встречный конец позади.
              if d then
                mark(bad, c.position.x+DV[d][1], c.position.y+DV[d][2])
                mark(ugend, c.position.x, c.position.y, d % 2)
                if not ghost then
                  for j = 1, maxd or 10 do
                    local o = s.find_entities_filtered{type='pipe-to-ground', position={c.position.x-DV[d][1]*j, c.position.y-DV[d][2]*j}}[1]
                    local od = o and d4(o.direction)
                    if od and od % 2 == d % 2 then
                      if od == (d+2) % 4 then between(c.position, o.position) end
                      break
                    end
                  end
                end
              else around(ax, ay, bx, by) end
            elseif t == 'pipe' then around(ax, ay, bx, by)
            else
              -- Машина с жидкостными входами (бак, насос, котёл, химзавод, бур...): где именно вход, не разбираем — рядом трубу не кладём.
              local nfb
              pcall(function() nfb = #(ghost and c.ghost_prototype or c.prototype).fluidbox_prototypes end)
              if nfb == nil then nfb = (FLUID[t] or t == 'boiler' or t == 'generator' or t == 'offshore-pump' or t == 'assembling-machine' or t == 'mining-drill' or t == 'fluid-turret') and 1 or 0 end
              if nfb > 0 then around(ax, ay, bx, by) end
            end
          end
        end
      end
    end
    for _, c in pairs({{x1, y1}, {x2-1, y1}, {x1, y2-1}, {x2-1, y2-1}}) do if not live(c[1], c[2]) then coarse = true end end
    local sk, gk = idx(A.fx, A.fy), idx(A.tx, A.ty)
    for _, q in pairs{{A.fx, A.fy, 'начало', sk}, {A.tx, A.ty, 'конец', gk}} do
      if not charted(q[1], q[2]) then fail(q[3]..' маршрута: карта там не открыта') end
      if blocked[q[4]] then fail(q[3]..' маршрута, клетка '..q[1]..','..q[2]..', занято: '..blocked[q[4]]..'. Укажи свободную клетку рядом') end
    end
    local function free(k, x, y) return k and not blocked[k] and charted(x, y) end
    local function surf_ok(k) return k == sk or k == gk or not bad[k] end
    local function ug_ok(k, ax) return not span[ax][k] and (pipe or k == sk or k == gk or not bad[k]) end
    local heap, n = {}, 0
    local function push(v)
      n = n + 1
      local i = n
      heap[i] = v
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
        local l, r, q = i*2, i*2+1, i
        if l <= n and heap[l][1] < heap[q][1] then q = l end
        if r <= n and heap[r][1] < heap[q][1] then q = r end
        if q == i then break end
        heap[q], heap[i] = heap[i], heap[q]
        i = q
      end
      return top
    end
    local function h(x, y) return (math.abs(x-A.tx) + math.abs(y-A.ty))*1.1 end
    local g, from, closed = {}, {}, {}
    for d = 0, 3 do g[sk*8+d*2] = 0 push{h(A.fx, A.fy), 0, A.fx, A.fy, d, 0} end
    local ed = (not pipe) and A.end_dir or nil
    local goal, pops = nil, 0
    local function relax(id0, nx, ny, nk, nd, nf, ng)
      local id = nk*8 + nd*2 + nf
      if not closed[id] and (not g[id] or ng < g[id] - 0.0001) then g[id] = ng from[id] = id0 push{ng + h(nx, ny), ng, nx, ny, nd, nf} end
    end
    while n > 0 do
      local c = pop()
      local gc, x, y, d, fl = c[2], c[3], c[4], c[5], c[6]
      local k = idx(x, y)
      local id = k*8 + d*2 + fl
      if not closed[id] and gc <= g[id] + 0.0001 then
        closed[id] = true
        pops = pops + 1
        if k == gk and (not ed or (fl == 1 and d == ed) or (fl == 0 and d ~= (ed+2) % 4)) then goal = id break end
        if pops > 120000 then break end
        if fl == 1 or surf_ok(k) then
          for nd = 0, 3 do
            if nd == d or (fl == 0 and nd ~= (d+2) % 4) then
              local nx, ny = x+DV[nd][1], y+DV[nd][2]
              local nk = idx(nx, ny)
              if free(nk, nx, ny) then relax(id, nx, ny, nk, nd, 0, gc + 1 + (nd ~= d and 0.2 or 0)) end
            end
          end
        end
        if ug and fl == 0 and ug_ok(k, d % 2) then
          local v = DV[d]
          for j = 2, maxd do
            local ix, iy = x+v[1]*(j-1), y+v[2]*(j-1)
            local ik = idx(ix, iy)
            if not ik or ugend[ik] == d % 2 or not charted(ix, iy) then break end
            local nx, ny = x+v[1]*j, y+v[2]*j
            local nk = idx(nx, ny)
            if free(nk, nx, ny) and ug_ok(nk, d % 2) then relax(id, nx, ny, nk, d, 1, gc + j*1.2 + 2) end
          end
        end
      end
    end
    if not goal then
      -- Не дошли: подскажем, что стоит вокруг концов маршрута.
      fail(pops > 120000 and 'маршрут не найден: слишком сложный обход, раздели путь на части через промежуточные точки' or 'маршрут не найден: конец отрезан (вода, постройки, неоткрытая карта) в пределах полосы поиска; попробуй margin больше или другие клетки начала и конца')
    end
    local st = {}
    local id = goal
    while id do
      local k = math.floor(id/8)
      st[#st+1] = {x=x1+math.floor(k/H), y=y1+k % H, d=math.floor(id/2) % 4, fl=id % 2}
      id = from[id]
    end
    local items, cost, pairs_n, turns = {}, {}, 0, 0
    for i = #st, 1, -1 do
      local c, nx = st[i], st[i-1]
      local it = {x=c.x+0.5, y=c.y+0.5}
      if c.fl == 1 then
        it.item, it.direction = ugitem, DN[c.d]
        if not pipe then it.underground = 'output' end
      elseif nx and nx.fl == 1 then
        pairs_n = pairs_n + 1
        it.item = ugitem
        if pipe then it.direction = DN[(nx.d+2) % 4] else it.direction, it.underground = DN[nx.d], 'input' end
      else
        it.item = A.item
        if not pipe then it.direction = DN[nx and nx.d or ed or c.d] end
        if nx and i < #st and nx.d ~= c.d then turns = turns + 1 end
      end
      cost[it.item] = (cost[it.item] or 0) + 1
      items[#items+1] = it
    end
    local have, missing, enough = {}, {}, true
    for k, v in pairs(cost) do
      have[k] = e.get_item_count(k)
      if have[k] < v then missing[k] = v - have[k] enough = false end
    end
    return {items=items, cells=#items, length=math.abs(A.fx-A.tx)+math.abs(A.fy-A.ty)+1, underground_pairs=pairs_n, turns=turns, cost=cost, have=have, missing=missing, enough=enough, coarse=coarse}`,

  // Где лежит предмет: сундуки, машины (все их слоты; in_output — сколько из этого в выходном), клетки конвейеров.
  // Игрок видит это, наведя мышь: рядом с собой и там, где карта показывается вживую (радар); ленты — только в 60 клетках.
  where_items: `
    local e = bot()
    local f, s = e.force, e.surface
    if not prototypes.item[A.item] then fail('нет предмета '..A.item..' (нужно внутреннее имя, например iron-plate)') end
    local vis = {}
    local function visible(p)
      if dist(p, e.position) <= 60 then return true end
      local cx, cy = math.floor(p.x/32), math.floor(p.y/32)
      local k = cx..','..cy
      if vis[k] == nil then vis[k] = f.is_chunk_visible(s, {cx, cy}) end
      return vis[k]
    end
    local BOX = {container=true, ['logistic-container']=true, ['cargo-wagon']=true, car=true}
    local stores, hidden, total = {}, 0, 0
    for _, c in pairs(s.find_entities_filtered{position=e.position, radius=A.radius, force=f,
      type={'container', 'logistic-container', 'cargo-wagon', 'car', 'furnace', 'assembling-machine', 'lab', 'boiler', 'mining-drill', 'reactor', 'rocket-silo', 'ammo-turret'}}) do
      if not visible(c.position) then hidden = hidden + 1
      else
        local n, out = 0, nil
        pcall(function() for i = 1, c.get_max_inventory_index() do local v = c.get_inventory(i) if v then n = n + v.get_item_count(A.item) end end end)
        if n > 0 then
          if not BOX[c.type] then out = 0 pcall(function() local v = c.get_output_inventory() if v then out = v.get_item_count(A.item) end end) end
          total = total + n
          stores[#stores+1] = {name=c.name, x=c.position.x, y=c.position.y, d=dist(c.position, e.position), count=n, in_output=out}
        end
      end
    end
    -- Трупы персонажей: вещи погибшего лежат в них, пока труп не исчезнет.
    for _, c in pairs(s.find_entities_filtered{position=e.position, radius=A.radius, type='character-corpse'}) do
      if not visible(c.position) then hidden = hidden + 1
      else
        local n = c.get_inventory(defines.inventory.character_corpse).get_item_count(A.item)
        if n > 0 then
          total = total + n
          stores[#stores+1] = {name=c.name, x=c.position.x, y=c.position.y, d=dist(c.position, e.position), count=n}
        end
      end
    end
    table.sort(stores, function(a, b) return a.d < b.d end)
    local list = {}
    for i = 1, math.min(#stores, A.limit) do local r = stores[i] r.dist = r1(r.d) r.d = nil list[i] = r end
    local r = {item=A.item, have=e.get_item_count(A.item), radius=A.radius, places=#stores, total=total, list=list}
    if hidden > 0 then r.not_visible = hidden end
    if A.belts then
      local cells, on, bl = {}, 0, {}
      for _, c in pairs(s.find_entities_filtered{position=e.position, radius=math.min(A.radius, 60), force=f, type={'transport-belt', 'underground-belt', 'splitter'}}) do
        local n = belt_items(c)[A.item]
        if n then on = on + n cells[#cells+1] = {x=c.position.x, y=c.position.y, d=dist(c.position, e.position), count=n} end
      end
      table.sort(cells, function(a, b) return a.d < b.d end)
      for i = 1, math.min(#cells, 8) do local c = cells[i] c.dist = r1(c.d) c.d = nil bl[i] = c end
      r.belts = {cells=#cells, total=on, nearest=bl}
    end
    return r`,

  // Статистика производства команды, как окно производства в игре (P): предметы и жидкости, произведено и потреблено
  // за окно A.window (имя из defines.flow_precision_index), в пересчёте на минуту, и всего за игру.
  production: `
    local e = bot()
    local f, s = e.force, e.surface
    local idx = defines.flow_precision_index[A.window]
    local want
    if A.items then
      want = {}
      for _, n in pairs(A.items) do
        if not prototypes.item[n] and not prototypes.fluid[n] then fail('нет предмета или жидкости '..n..' (нужно внутреннее имя, например iron-plate)') end
        want[n] = true
      end
    end
    local function stat(st, exists)
      local made, used = st.input_counts, st.output_counts
      local names = {}
      if want then for n in pairs(want) do if exists[n] then names[n] = true end end
      else for n in pairs(made) do names[n] = true end for n in pairs(used) do names[n] = true end end
      local list = {}
      for n in pairs(names) do
        local p = st.get_flow_count{name=n, category='input', precision_index=idx, count=true}
        local c = st.get_flow_count{name=n, category='output', precision_index=idx, count=true}
        if want or p > 0 or c > 0 then
          list[#list+1] = {name=n, produced_per_min=r1(p/A.minutes), consumed_per_min=r1(c/A.minutes),
            produced_total=math.floor(made[n] or 0), consumed_total=math.floor(used[n] or 0)}
        end
      end
      table.sort(list, function(a, b) if a.produced_per_min ~= b.produced_per_min then return a.produced_per_min > b.produced_per_min end
        if a.consumed_per_min ~= b.consumed_per_min then return a.consumed_per_min > b.consumed_per_min end return a.name < b.name end)
      local out = {}
      for i = 1, math.min(#list, A.limit) do out[i] = list[i] end
      return out, #list
    end
    local r = {minutes=A.minutes}
    r.items, r.items_count = stat(f.get_item_production_statistics(s), prototypes.item)
    r.fluids, r.fluids_count = stat(f.get_fluid_production_statistics(s), prototypes.fluid)
    return r`,

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
// Команда шага ходьбы. Сервер принимает команду RCON кусками примерно раз в 0,2 с, поэтому длинная команда доходит
// позже, а персонаж между командами идёт вслепую. Здесь нет общей части (PRELUDE), комментариев и отступов, а путь
// лежит на сервере (его кладёт path) — так команда приходит заметно чаще.
const FOLLOW = (`
  local function dist(a, b) return ((a.x-b.x)^2+(a.y-b.y)^2)^0.5 end
  local function bot() local e = storage.vb and storage.vb[A.bot] if e and e.valid and storage.vb_path and storage.vb_path[A.bot] then return e end error('нет пути', 0) end
` + BODY.follow).split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('--')).join('\n');

// ── Одно тело — один исполнитель ──
// Персонажа могут вести сразу несколько источников: главная сессия, саб-агент, собственные скрипты бота через fx.
// Одновременные действия рвут его в разные стороны, поэтому действие, которое двигает персонажа, для каждого
// персонажа выполняется только одно; второму вызову отвечаем отказом с объяснением, а не ставим его в очередь.
const READ_ONLY = new Set(['status', 'look_around', 'find', 'inspect', 'research', 'power', 'belt', 'alerts', 'pollution',
  'area_map', 'route', 'where_items', 'production', 'recipe_info', 'say', 'wait', 'feedback', 'feedback_status', 'read_chat',
  'craft', 'template_save', 'template_cost', 'template_delete', 'ghost_place', 'ghost_list', 'ghost_clear', 'stop']);
const busy = new Map(); // персонаж -> { tool, since }
const stopAsked = new Map(); // персонаж -> когда попросили остановиться
const inBodyAction = new AsyncLocalStorage(); // шаги plan и вложенные вызовы идут под блокировкой внешнего вызова

/** Какие персонажи сейчас выполняют действие в этом процессе. */
export const busyBots = () => [...busy.keys()];

// Вызовы, которым нужно, чтобы игра шла, хотя тело они не занимают (ожидание, крафт).
const NEEDS_TIME = new Set(['wait', 'craft']);
let ticking = 0;
/** Идёт ли сейчас хоть одно действие, ради которого игра не должна стоять на паузе. */
export const gameNeeded = () => busy.size > 0 || ticking > 0;

/** Остановить персонажей, которые идут, хотя их никто не ведёт (вызов оборвался, процесс перезапустили). */
export async function stopOrphans() {
  return lua(`
    local stopped = {}
    local keep = {['mcp-test']=true}
    for _, n in pairs(A.busy) do keep[n] = true end
    for n, e in pairs(storage.vb or {}) do
      if e.valid and not keep[n] and e.walking_state.walking then
        e.walking_state = {walking=false, direction=e.walking_state.direction}
        stopped[#stopped+1] = n
      end
    end
    return stopped`, { busy: busyBots() });
}

export function createFactorioServer(botName, hooks) {
  const hostAborted = hooks.aborted;
  // Действие сворачивается, если так решил владелец вызова (клиент отключился и т. п.) или персонажа попросили остановиться.
  hooks = { ...hooks, aborted: () => hostAborted() || stopAsked.has(botName) };
  const run = (body, args = {}) => lua(body === 'follow' ? FOLLOW : PRELUDE + BODY[body], { bot: botName, ...args });

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
    else chatNew = Array.isArray(r.messages) && r.messages.some(chatStops);
    return chatNew;
  }
  // Какие сообщения чата сворачивают долгое действие. Обычно любые; внутри plan — по его параметру stop_on_chat:
  // чат шумный (боты пишут статусы), и длинный план иначе не доживает до конца.
  let chatMode = 'any';
  const myNames = [botName, botName.replace(/-бот$/i, '')].map((s) => s.toLowerCase()).filter((s) => s.length >= 3);
  const STOP_WORD = /(^|[^\p{L}])(стоп|стой|стойте|остановись|остановитесь|stop)([^\p{L}]|$)/iu;
  /** Сообщение обращено к этому боту (в тексте есть его имя) или просит остановиться. */
  const chatAddressed = (m) => { const t = String(m.text ?? '').toLowerCase(); return STOP_WORD.test(t) || myNames.some((n) => t.includes(n)); };
  const chatStops = (m) => chatMode === 'any' || (chatMode === 'addressed' && chatAddressed(m));
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

  let walkSeq = 0; // новый поход отменяет прежний: двое не могут вести одного персонажа

  /** Идти по пути, который только что нашёл и запомнил на сервере path (FOLLOW). Итог: done | stuck (перестал продвигаться) | lost (снесло с пути) | timeout | interrupted | superseded. */
  // handoff — вернуться, не останавливая персонажа, когда до конца этого куска осталось меньше стольких клеток (дальше
  // поведёт следующий кусок). watch — следить за кусаками: появились в 20 клетках, хотя в начале их не было, — enemies.
  async function follow(points, my, deadline, handoff = 0, watch = null, odo = null) {
    let i = 2;
    let best = Infinity;
    let lastProgress = Date.now();
    // Сколько тиков проходит между двумя командами (задержка RCON бывает и полсекунды): по нему персонаж рассчитывает шаг.
    // Берём худший из двух последних промежутков; первая команда — с запасом.
    let n = 30, lastTick = null, lastGap = 0, sent = Date.now(), gapMs = 0;
    for (;;) {
      const s = await run('follow', { i, n, w: watch ? 1 : undefined });
      gapMs = Date.now() - sent;
      // Пройденный путь — по настоящим позициям персонажа от команды к команде.
      if (odo && s.x !== undefined) { if (odo.x !== undefined) odo.moved += Math.hypot(s.x - odo.x, s.y - odo.y); odo.x = s.x; odo.y = s.y; }
      if (s.done) return { done: true, left: 0 };
      if (my !== walkSeq) return { superseded: true };
      if (hooks.aborted()) return { interrupted: true };
      if (watch) {
        if (!s.en) watch.calm = true;
        else if (watch.calm) return { enemies: true, left: Math.min(best, s.d) };
        else watch.calm = false;
      }
      if (lastTick !== null) { const gap = s.tick - lastTick; n = Math.max(gap, lastGap) + 1; lastGap = gap; }
      lastTick = s.tick;
      // Снесло далеко от пути (например, задержка скакнула) — путь надо искать заново.
      if (s.off > 3) return { lost: true, left: best };
      // Застрял — значит, остаток пути перестал уменьшаться (а не просто стоит: по ленте может и возить туда-сюда).
      if (s.i > i) i = s.i;
      if (s.d < best - 0.05) { best = s.d; lastProgress = Date.now(); }
      if (Date.now() - lastProgress > Math.max(1500, gapMs * 4)) return { stuck: true, left: best };
      if (Date.now() >= deadline) return { timeout: true, left: best };
      if (handoff && s.d < handoff) return { handoff: true, left: s.d, x: s.x, y: s.y };
      await sleep(30);
      sent = Date.now();
    }
  }

  // Ходьба только пешком: ищем путь в обход препятствий (BODY.path) и идём по нему. Дальний путь строится кусками;
  // если что-то помешало по дороге, путь ищется заново с нового места. Не получилось — честно говорим, где
  // остановились: переносить персонажа нельзя. pos в ответе — настоящая позиция после остановки.
  // Обход ограничен (fb-040): если идти пришлось бы втрое дальше, чем по прямой (и больше 30 клеток), персонаж не идёт
  // или останавливается — иначе короткий переход по базе превращается в петлю на сотни клеток. longWay снимает предел.
  //
  // Дальний переход (fb-044, fb-046): если до цели больше 10 клеток, сначала ищется маршрут на весь путь (BODY.far), и
  // персонаж идёт по нему кусками примерно по 30 клеток, не останавливаясь на стыках. Тогда длина обхода известна заранее:
  // без longWay персонаж идёт, если она не больше четырёх прямых (или 60 клеток); если пути нет — говорит, что мешает,
  // и остаётся на месте. Не хватило перебора на дальний маршрут — идёт по-старому, кусками к цели, с прежним пределом обхода.
  // avoid — обходить гнёзда и червей, которых видно, в 30 клетках, и остановиться, если рядом появились кусаки.
  async function walk(x, y, tol = 1.5, longWay = false, avoid = true) {
    const my = ++walkSeq;
    const deadline = Date.now() + 180_000;
    const r1 = (v) => Math.round(v * 10) / 10;
    const at = (q) => `(${Math.round(q.x)}, ${Math.round(q.y)})`;
    const watch = avoid ? { calm: null } : null;
    let out = {};
    let walked = 0, straight0 = null;
    const odo = { moved: 0 };
    let hint = '';
    try {
      let bestEnd = Infinity, lastT = '';
      let stuckAt = null;
      let me = null; // где персонаж сейчас (если известно без лишней команды)
      let dense = null, di = 0, useFar = true, planAt = null, maxPlans = 20;
      // Запас до гнезда n при маршруте, найденном из точки from (как в BODY.far, минус погрешность ячеек).
      const margin = (n, from) => Math.min(30, Math.hypot(n.x - from.x, n.y - from.y) - 4) - 3;
      for (let plans = 0; ; plans++) {
        if (plans >= maxPlans) { out = { fail: 'не дошёл: слишком много обходов' }; break; }
        if (!me) me = await run('pos');
        if (straight0 === null) { straight0 = Math.hypot(me.x - x, me.y - y); odo.x = me.x; odo.y = me.y; }
        if (useFar && !dense && Math.hypot(me.x - x, me.y - y) > 10) {
          if (plans > 0) { const h = await run('stop'); me = { x: h.x, y: h.y }; }
          const c = await run('far', { x, y, tol, avoid, margin: longWay ? 150 : 60, budget: longWay ? 25000 : 10000 });
          const wide = longWay ? '' : ' (искал в 60 клетках в сторону от прямой; long_way=true ищет шире)';
          if (c.enemy_goal) {
            out = { fail: `на пути враги: цель в ${Math.round(c.enemy_goal.dist)} клетках от гнезда или червя у ${at(c.enemy_goal)} — не иду. Если идёшь туда нарочно, повтори с avoid_enemies=false`, enemies: { nest: c.enemy_goal } };
            break;
          }
          if (c.found && Array.isArray(c.points) && c.points.length > 1) {
            const need = walked + c.len;
            if (!longWay && need > Math.max(60, straight0 * 4)) {
              out = { fail: `обход слишком длинный: путь есть, но идти ${Math.round(need)} клеток${walked > 1 ? ` (из них ${Math.round(walked)} уже пройдено)` : ''}, а по прямой было ${Math.round(straight0)} — дорогу перегораживают постройки (трубы, стены, плотные ряды машин), вода или скалы. Если такой обход устраивает, повтори с long_way=true; иначе сделай проход (подземная труба)`, route_len: Math.round(need) };
              break;
            }
            dense = [];
            for (let k = 0; k < c.points.length - 1; k++) {
              const a = c.points[k], b = c.points[k + 1];
              const m = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.y - a.y)));
              for (let t = 0; t < m; t++) dense.push({ x: a.x + (b.x - a.x) * t / m, y: a.y + (b.y - a.y) * t / m });
            }
            dense.push(c.points[c.points.length - 1]);
            di = 0; planAt = me; maxPlans = plans + 20 + Math.ceil(c.len / 5);
          } else if (c.exhausted && c.cut_enemy) {
            out = { fail: `на пути враги: дорогу перекрывают гнёзда или черви у ${at(c.cut_enemy)}, обойти их с запасом 30 клеток нельзя${c.cut_box ? wide : ''}. Стою на месте. Идти несмотря на врагов — avoid_enemies=false`, enemies: { nest: c.cut_enemy } };
            break;
          } else if (c.exhausted && c.cut_box && !longWay) {
            out = { fail: `прохода не нашёл${wide}. Ближе всего можно подойти к ${at(c.closest)} — оттуда до цели ${c.closest.dist}${c.blocker ? `, дальше мешает ${c.blocker.what} у ${at(c.blocker)}` : ''}. Стою на месте: повтори с long_way=true или сделай проход` };
            break;
          } else if (c.exhausted && !c.cut_box && !c.cut_map) {
            out = { fail: `пешком туда не дойти: цель отрезана препятствиями. Ближе всего можно подойти к ${at(c.closest)} — оттуда до цели ${c.closest.dist}${c.blocker ? `, дальше мешает ${c.blocker.what} у ${at(c.blocker)}` : ''}. Стою на месте`, soft: true };
            break;
          } else {
            // Перебора на дальний маршрут не хватило: идём по-старому, а что мешало — пригодится в ответе.
            useFar = false;
            if (c.closest && c.blocker) hint = ` Дальний поиск пути не нашёл: ближе всего подошёл бы к ${at(c.closest)}, дальше мешает ${c.blocker.what} у ${at(c.blocker)}.`;
          }
        }
        // Куда ведёт этот кусок: точка дальнего маршрута на ~30 клеток вперёд либо сама цель.
        let tx = x, ty = y, ttol = tol, final = true;
        if (dense) {
          let bd = Infinity, bi = di;
          for (let k = di; k < Math.min(dense.length, di + 100); k++) {
            const d = Math.hypot(dense[k].x - me.x, dense[k].y - me.y);
            if (d < bd) { bd = d; bi = k; }
          }
          di = bi;
          if (di + 36 < dense.length) { tx = dense[di + 32].x; ty = dense[di + 32].y; ttol = 1; final = false; }
        }
        const tk = `${tx},${ty}`;
        if (tk !== lastT) { lastT = tk; bestEnd = Infinity; }
        const p = await run('path', { x: tx, y: ty, tol: ttol, en: avoid || undefined });
        me = null;
        const points = Array.isArray(p.points) ? p.points : [];
        const near = p.near ? 'в самой точке стоять нельзя (занято), встал как можно ближе' : undefined;
        const end = points[points.length - 1];
        const endDist = end ? Math.hypot(end.x - tx, end.y - ty) : Infinity;
        // По дороге стало видно гнездо, к которому ведёт остаток маршрута: дальний маршрут ищется заново, уже в обход.
        if (avoid && Array.isArray(p.nests) && p.nests.length && points.length) {
          if (dense) {
            const bad = p.nests.find((n) => { const m = margin(n, planAt); return m > 0 && dense.some((q, k) => k >= di && Math.hypot(q.x - n.x, q.y - n.y) < m); });
            if (bad) { dense = null; lastT = ''; continue; }
          } else if (end) {
            const bad = p.nests.find((n) => { const m = margin(n, points[0]); return m > 0 && Math.hypot(end.x - n.x, end.y - n.y) < m; });
            if (bad) { out = { fail: `на пути враги: дорога ведёт к гнезду или червю у ${at(bad)} — дальше не иду. Идти несмотря на врагов — avoid_enemies=false`, enemies: { nest: bad } }; break; }
          }
        }
        // Неполный путь имеет смысл, только пока он приближает к цели, иначе будем ходить кругами.
        if (points.length < 2 || (!p.found && endDist > bestEnd - 1)) {
          // Кусок дальнего маршрута не дался (тесный проход): дальше по-старому, прямо к цели.
          if (!final) { dense = null; useFar = false; lastT = ''; continue; }
          if (p.found) out = { note: near };
          else if (p.unreachable) out = { fail: 'пешком туда не дойти: цель отрезана препятствиями (вода, скалы, постройки). Стою в ближайшей к ней достижимой точке', soft: true };
          else out = { fail: 'не нашёл обход препятствия. Стою в ближайшей к цели точке, до которой нашёл путь; посмотри area_map и иди через промежуточные точки', soft: true };
          break;
        }
        bestEnd = Math.min(bestEnd, endDist);
        let len = 0;
        for (let k = 1; k < points.length; k++) len += Math.hypot(points[k].x - points[k - 1].x, points[k].y - points[k - 1].y);
        // Сколько идти самое меньшее: уже пройденное, этот кусок пути и по прямой от его конца до цели.
        const need = walked + len + (p.found ? 0 : Math.max(0, endDist - tol));
        if (!dense && !longWay && need > Math.max(30, straight0 * 3)) {
          out = { fail: `обход слишком длинный: идти не меньше ${Math.round(need)} клеток${walked > 1 ? ` (из них ${Math.round(walked)} уже пройдено)` : ''}, а по прямой было ${Math.round(straight0)} — дорогу перегораживают постройки (трубы, стены, плотные ряды машин; трубы не перешагивает и игрок). Посмотри area_map и иди через промежуточные точки, сделай проход (подземная труба) или, если длинный обход устраивает, повтори move_to с long_way=true` };
          break;
        }
        const s = await follow(points, my, deadline, final ? 0 : 10, watch, odo);
        walked = odo.moved;
        if (s.handoff) { me = { x: s.x, y: s.y }; continue; }
        if (s.superseded) { out = { interrupted: 'прервано другим действием с ходьбой' }; break; }
        if (s.interrupted) { out = { interrupted: 'прервано новой репликой' }; break; }
        if (s.enemies) {
          await run('stop').catch(() => null);
          const fo = await run('foes').catch(() => ({}));
          out = { fail: `рядом появились враги${fo.nearest ? `: ${fo.count} шт., ближайший (${fo.name}) у ${at(fo.nearest)}, в ${fo.dist} клетках` : ''} — остановился. Следующий move_to пойдёт, даже если они рядом: уходи или защищайся`, enemies: fo };
          break;
        }
        if (s.timeout) { out = { fail: 'ещё не дошёл: вызови ещё раз' }; break; }
        if (s.done && p.found && final) { out = { note: near }; break; }
        if (s.stuck) {
          // Дважды упёрся на одном месте — путь есть только на бумаге (или игра стоит на паузе).
          me = await run('pos');
          if (stuckAt && Math.hypot(me.x - stuckAt.x, me.y - stuckAt.y) < 0.5) { out = { fail: 'упёрся в препятствие и не могу его обойти. Посмотри area_map и иди через промежуточные точки', soft: true }; break; }
          stuckAt = me;
          bestEnd = Infinity;
        }
      }
    } finally {
      if (my === walkSeq) {
        const at = await run('stop').catch(() => null);
        if (at) out.pos = { x: r1(at.x), y: r1(at.y) };
      }
    }
    if (!out.pos) { const at = await run('pos'); out.pos = { x: r1(at.x), y: r1(at.y) }; }
    const res = { pos: out.pos };
    if (out.note) res.note = out.note;
    if (out.interrupted) res.interrupted = out.interrupted;
    const left = r1(Math.hypot(out.pos.x - x, out.pos.y - y));
    // Не дошёл до самой точки, но стоит вплотную (до 4 клеток — всё в досягаемости): это не сбой, а пометка.
    if (out.fail && out.soft && hint) out.fail += hint;
    if (out.fail && out.soft && left <= Math.max(4, tol)) { res.note = `ближе подойти нельзя, до точки ${left}: ${out.fail}`; res.distance_left = left; }
    else if (out.fail) { res.not_reached = out.fail; res.distance_left = left; }
    if (out.enemies) res.enemies = out.enemies;
    if (out.route_len) res.route_len = out.route_len;
    if (straight0 > 0.5 || walked > 0.5) { res.walked = r1(walked); res.straight = r1(straight0 ?? 0); }
    return res;
  }

  /** Подойти, если цель дальше reach. Не дошёл и не дотягивается — ошибка с причиной (враги на пути, нет прохода). */
  async function approach(x, y, reach) {
    const me = await run('pos');
    if (Math.hypot(me.x - x, me.y - y) <= reach) return;
    const w = await walk(x, y, Math.max(1.5, reach - 2));
    if (w.not_reached && Math.hypot(w.pos.x - x, w.pos.y - y) > reach + 1.5) throw new Error(`не дошёл до (${x}, ${y}), стою в (${w.pos.x}, ${w.pos.y}), осталось ${w.distance_left}: ${w.not_reached}`);
  }

  // Ожидание ручного крафта (fb-043): если предмета нет в инвентаре, но он стоит в очереди крафта персонажа, действие
  // ждёт его, как ждал бы игрок, а не падает. q — аргументы BODY.craft_wait. Ответ — сколько секунд ждал, либо null,
  // если ждать нечего (предмета в очереди нет) или ожидание выключено.
  const waitCraftArg = z.number().min(0).max(120).default(30).describe('если предмета нет в инвентаре, но он стоит в твоей очереди ручного крафта — ждать его не дольше стольких секунд (waited_craft_s в ответе); 0 — не ждать');
  async function awaitCraft(q, seconds) {
    if (!(seconds > 0)) return null;
    const start = Date.now();
    let r = await run('craft_wait', q);
    if (!r.waiting) return null;
    while (r.waiting && Date.now() - start < seconds * 1000 && !(await interrupted())) {
      await sleep(500);
      r = await run('craft_wait', q);
    }
    return Math.round((Date.now() - start) / 100) / 10;
  }
  /** Выполнить fn; если он упал из-за нехватки предмета (pattern), а предмет в очереди крафта — дождаться и повторить один раз. */
  async function withCraft(q, seconds, pattern, fn) {
    try { return await fn(); } catch (e) {
      if (!pattern.test(e.message)) throw e;
      const waited = await awaitCraft(q, seconds);
      if (waited === null) throw e;
      const r = await fn();
      if (r && typeof r === 'object') r.waited_craft_s = waited;
      return r;
    }
  }

  /** Добавить призраки items в план name (BODY.ghost_add). Общая часть ghost_place и route. */
  async function ghostAdd(name, items) {
    const out = { plan: name, placed: 0, already: 0, blocked: [], blocked_count: 0, in_plan: 0 };
    // Кусками, чтобы команда оставалась короткой.
    for (let i = 0; i < items.length; i += 50) {
      const r = await run('ghost_add', { name, items: items.slice(i, i + 50) });
      out.placed += r.placed; out.already += r.already; out.blocked_count += r.blocked_count; out.in_plan = r.in_plan;
      if (Array.isArray(r.blocked)) out.blocked.push(...r.blocked);
      if (r.full) break;
    }
    out.blocked = out.blocked.slice(0, 15);
    if (!out.blocked_count) { delete out.blocked; delete out.blocked_count; }
    return out;
  }

  /**
   * Поставить группу построек (BODY.place_many): подходит к первой непоставленной и ставит всё, до чего дотягивается.
   * Общая часть place_many и template_place. В skipped у постройки, которой, похоже, мешает сам персонаж, стоит self.
   */
  async function placeMany(items) {
    let pending = items.map((it, k) => ({ ...it, i: k + 1 }));
    const built = [], skipped = [], left = {};
    let stopped, walkedFor = null;
    const deadline = Date.now() + 200_000;
    while (pending.length) {
      const r = await run('place_many', { items: pending });
      const results = Array.isArray(r.results) ? r.results : [];
      const gone = new Set();
      for (const x of results) {
        const it = pending.find((p) => p.i === x.i);
        gone.add(x.i);
        if (x.ok) { const { left: l, ...rest } = x.r; built.push({ n: x.i, ...rest }); left[it.item] = l; }
        else {
          const self = Boolean(x.near && /сюда поставить нельзя/.test(x.why));
          skipped.push({ n: x.i, item: it.item, x: it.x, y: it.y, why: x.why + (self ? ' — возможно, мешает сам персонаж: он стоит рядом с этой клеткой' : ''), self: self || undefined });
        }
      }
      pending = pending.filter((p) => !gone.has(p.i));
      if (!pending.length) break;
      stopped = await interrupted();
      if (!stopped && Date.now() > deadline) stopped = 'вышло время на один вызов';
      if (stopped) break;
      if (results.length || r.waiting > 0) { await sleep(100); continue; }
      // Всё оставшееся далеко: идём к первой непоставленной. Не дошли — пропускаем её.
      const t = pending[0];
      if (walkedFor === t.i) { skipped.push({ n: t.i, item: t.item, x: t.x, y: t.y, why: 'не смог подойти на расстояние постройки' }); pending.shift(); continue; }
      walkedFor = t.i;
      // Не дошёл — постройка пропустится на следующем круге; враги на пути — дальше не идём вовсе.
      try { await approach(t.x, t.y, 8); } catch (e) { if (/враг/.test(e.message)) { stopped = e.message; break; } }
    }
    return { built, skipped, left, pending: pending.map(({ i, ...it }) => it), stopped: stopped || undefined };
  }

  /** Область из аргументов x, y, x2, y2 (целые клетки, углы в любом порядке) либо пусто, если она не задана. */
  function ghostArea(a) {
    const given = [a.x, a.y, a.x2, a.y2].filter((v) => v !== undefined).length;
    if (given === 0) return {};
    if (given < 4) throw new Error('область — это все четыре числа: x, y, x2, y2');
    return { x1: Math.floor(Math.min(a.x, a.x2)), y1: Math.floor(Math.min(a.y, a.y2)), x2: Math.floor(Math.max(a.x, a.x2)) + 1, y2: Math.floor(Math.max(a.y, a.y2)) + 1 };
  }

  const def = (name, description, shape, handler) => tool(name, description, shape, async (args) => {
    const shown = JSON.stringify(args);
    hooks.activity?.();
    const began = Date.now();
    const took = () => Math.round((Date.now() - began) / 100) / 10;
    try {
      chatBase = null; chatNew = false; chatChecked = 0;
      await chatWaiting();
      let value;
      if (READ_ONLY.has(name) || inBodyAction.getStore()) {
        const timed = NEEDS_TIME.has(name);
        if (timed) ticking++;
        try { value = await handler(args); } finally { if (timed) ticking--; }
      } else {
        const cur = busy.get(botName);
        if (cur) {
          throw new Error(`персонаж занят: его уже ведёт другой вызов (${cur.tool}, идёт ${Math.round((Date.now() - cur.since) / 1000)} с). У персонажа одно тело — два действия сразу не выполняются. Дождись конца, либо останови его инструментом stop и вызови заново. Если это неожиданно — значит, персонажа одновременно ведут саб-агент и скрипт: оставь кого-то одного.`);
        }
        busy.set(botName, { tool: name, since: Date.now() });
        stopAsked.delete(botName);
        try { value = await inBodyAction.run(true, () => handler(args)); } finally { busy.delete(botName); stopAsked.delete(botName); }
      }
      if (memo && name !== 'read_chat' && value && typeof value === 'object' && !Array.isArray(value)) {
        const messages = await takeChat().catch(() => []);
        if (messages.length) value.chat = messages;
      }
      // Сколько секунд занял сам инструмент (ходьба, ожидание, сервер): остальное время между вызовами — раздумья модели.
      if (value && typeof value === 'object' && !Array.isArray(value)) value.took_s = took();
      const result = JSON.stringify(value);
      hooks.log(`🔧 ${botName} ${name}${shown === '{}' ? '' : ' ' + shown} [${took()} с] → ${result.slice(0, 300)}`);
      return { content: [{ type: 'text', text: result }] };
    } catch (e) {
      hooks.log(`🔧 ${botName} ${name} ${shown} [${took()} с] → ❌ ${e.message}`);
      return { content: [{ type: 'text', text: `Ошибка: ${e.message}` }], isError: true };
    }
  });

  const tools = [
    def('stop', 'Остановить персонажа: прервать действие, которое он сейчас выполняет (ходьбу, добычу, стройку, план), кто бы его ни запустил — ты, саб-агент или твой скрипт. Прерванный вызов вернёт то, что успел. Используй по команде «стоп» и перед тем, как перехватить управление персонажем.', {},
      async () => {
        const cur = busy.get(botName);
        if (cur) {
          stopAsked.set(botName, Date.now());
          for (let i = 0; i < 40 && busy.has(botName); i++) await sleep(250);
        }
        const at = await run('stop');
        stopAsked.delete(botName);
        return { stopped: cur ? cur.tool : 'ничего не выполнялось', still_running: busy.has(botName) || undefined, pos: { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 } };
      }),

    def('status', 'Состояние твоего персонажа: позиция, здоровье, инвентарь, очередь крафта, люди в игре и другие боты с координатами.', {}, () => run('status')),

    def('look_around', 'Что находится вокруг персонажа: объекты сгруппированы по типу, с количеством, расстоянием и координатами ближайшего. Для руды — суммарный запас.',
      { radius: z.number().min(1).max(60).default(25).describe('радиус обзора в клетках') },
      (a) => run('look', a)),

    def('find', 'Найти ближайшие объекты по внутреннему имени (iron-ore, copper-ore, coal, stone, tree, stone-furnace, ...) в большом радиусе.',
      { name: z.string(), radius: z.number().min(1).max(1000).default(300) },
      (a) => run('find', a)),

    def('inspect', 'Подробности об объекте в точке: рецепт, состояние, содержимое, топливо, направление. Для манипулятора — откуда берёт (takes_from) и куда кладёт (puts_to), для конвейера — что на нём лежит: всего (on_belt) и по полосам (lanes: left — левая по ходу движения, right — правая); для подземного конвейера — вход это или выход (underground) и где его парный конец (paired_with). Труп персонажа (character-corpse, координаты даёт find) — что в нём лежит (items).', coords, (a) => run('inspect', a)),

    def('move_to', 'Идти в точку или к игроку-человеку. Укажи либо x и y, либо player. Идёт только пешком, сам ищет путь в обход построек, деревьев, воды и скал. В ответе pos — где персонаж стоит на самом деле. Если в самой точке стоять нельзя, встаёт рядом (note). Дальний переход (через всю базу) планируется целиком до первого шага, по открытой карте: промежуточные точки вручную не нужны. Если дойти не удалось — not_reached с причиной и distance_left; когда пути нет вовсе, персонаж остаётся на месте и говорит, докуда дойти можно и что мешает дальше (постройка или вода и её координаты). Если встал вплотную (до 4 клеток), а в саму точку прохода нет — это note, а не not_reached. Обход ограничен: если идти больше чем вчетверо дальше прямой (и больше 60 клеток), персонаж не идёт и отвечает not_reached «обход слишком длинный» с длиной пути (route_len) — тогда повтори с long_way=true или сделай проход. walked — сколько клеток пройдено, straight — сколько было по прямой. Враги: маршрут обходит в 30 клетках гнёзда и червей, которых видно (60 клеток от персонажа, радар), а если обойти нельзя или цель рядом с ними — not_reached «на пути враги»; если по дороге в 20 клетках появились кусаки — персонаж останавливается (not_reached «рядом появились враги», в enemies — сколько и где), следующий вызов уже идёт, чтобы можно было уйти. Так же ходят все инструменты, которые подходят сами (take_items, gather, place и другие). Трубы, как и для игрока, непроходимы (конвейеры проходимы): проход через линию труб — подземная труба. До трёх минут ходьбы на вызов.',
      { x: z.number().optional(), y: z.number().optional(), player: z.string().optional().describe('имя игрока в Factorio'),
        long_way: z.boolean().default(false).describe('true — идти, даже если обход намного длиннее прямой (вокруг озера, длинной стены); путь ищется шире'),
        avoid_enemies: z.boolean().default(true).describe('false — не обходить гнёзда и не останавливаться из-за кусак (идёшь к ним нарочно)') },
      async (a) => {
        let target = a;
        if (a.player) target = await run('player_pos', { player: a.player });
        else if (a.x === undefined || a.y === undefined) throw new Error('нужны x и y либо player');
        return walk(target.x, target.y, a.player ? 2.5 : 1.5, a.long_way, a.avoid_enemies);
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
        wait: z.boolean().default(true).describe('ждать ли готовности'),
        wait_craft_s: z.number().min(0).max(120).default(30).describe('если ингредиентов не хватает даже на одну штуку, но они стоят в твоей очереди ручного крафта (прошлый craft с wait=false) — ждать их не дольше стольких секунд; 0 — не ждать') },
      async (a) => {
        const r = await withCraft({ recipe: a.recipe, count: a.count }, a.wait_craft_s, /не хватает ингредиентов/, () => run('craft', { recipe: a.recipe, count: a.count }));
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

    def('place', 'Поставить одну постройку из инвентаря в точку. Сам подходит (move_to перед этим не нужен). Несколько построек ставь не по одной, а пачкой: place_many, place_line, template_place. Для манипулятора в ответе видно, откуда он берёт (takes_from) и куда кладёт (puts_to). Подземный конвейер: direction у входа и у выхода одинаковый — куда едут предметы; вход это или выход, задаёт underground, а в ответе видно, чем он встал (underground) и с каким концом соединился (paired_with). Если в точке уже стоит такая же постройка с тем же направлением — это не ошибка: already=true, предмет не тратится.',
      { item: z.string().describe('внутреннее имя предмета'), ...coords, direction: z.enum(DIRECTIONS).default('north').describe('куда смотрит постройка: конвейер (и подземный тоже) везёт в эту сторону; манипулятор с этой стороны берёт, а кладёт на противоположную'),
        underground: z.enum(['input', 'output']).optional().describe('только для подземного конвейера: input — вход под землю, output — выход из-под земли. По умолчанию как в игре: выход, если позади по ходу в пределах дальности стоит вход без пары, иначе вход'),
        wait_craft_s: waitCraftArg },
      async (a) => { await approach(a.x, a.y, 8); return withCraft({ items: { [a.item]: 1 } }, a.wait_craft_s, /в инвентаре нет/, () => run('place', a)); }),

    def('place_line', 'Поставить ряд одинаковых построек из инвентаря от точки (x, y) до точки (x2, y2): лента, столбы, трубы, стены. Идёт вдоль ряда и ставит по одной, как игрок с зажатой кнопкой. Занятые клетки пропускает (где уже стоит такая же постройка с тем же направлением — считает сделанным, already), останавливается, когда предметы кончились. С параметром turn ряд идёт с одним поворотом под прямым углом: лента на углу сразу смотрит вдоль второго отрезка. Если действие прервалось, повтори тот же вызов: уже поставленное пропустится.',
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
        let placed = 0, already = 0, left, stopped, last;
        const skipped = [];
        for (let i = 0; i < n; i++) {
          const { x, y } = points[i];
          try {
            await approach(x, y, 8);
            const r = await run('place', { item: a.item, x, y, direction: points[i].direction });
            if (r.already) already++; else placed++;
            left = r.left; last = r.pos;
          } catch (e) {
            if (/в инвентаре нет|нет предмета|нельзя поставить на землю|враг/.test(e.message)) { stopped = e.message.replace(/^Lua: /, ''); break; }
            skipped.push({ x, y, why: e.message.replace(/^Lua: /, '') });
          }
          if (i === n - 1) break;
          stopped = await interrupted();
          if (stopped) break;
          await sleep(150);
        }
        return { placed, already: already || undefined, asked: n, direction, turn_at, then_direction: turn_at ? points[n - 1].direction : undefined, last, left, skipped: skipped.slice(0, 10), skipped_count: skipped.length, stopped: stopped || undefined };
      }),

    def('place_many', 'Поставить группу разных построек из инвентаря одним вызовом: items — список {item, x, y, direction} (до 50), например сборщики, манипуляторы, ленты и столбы одного блока. Персонаж подходит к первой непоставленной постройке и ставит подряд всё, до чего дотягивается с этого места, в темпе опытного игрока: одинаковые предметы подряд — протяжкой, до 30 в секунду, смена предмета в руке — около пяти в секунду; поэтому с одного места сначала ставятся все постройки того же предмета (в порядке списка), потом следующего. За дальними подходит. Порядок важен там, где он важен в игре (вход подземного конвейера раньше выхода) — для одного предмета он сохраняется. Что не встало — в skipped с причиной, остальное ставится дальше. Где уже стоит такая же постройка с тем же направлением — считается сделанным (в built с already=true, число — в already), предмет не тратится. Если действие прервалось, повтори вызов с тем, что в not_done.',
      { items: z.array(z.object({ item: z.string().describe('внутреннее имя предмета'), ...coords,
          direction: z.enum(DIRECTIONS).default('north').describe('как в place: конвейер везёт в эту сторону; манипулятор с этой стороны берёт, а кладёт на противоположную'),
          underground: z.enum(['input', 'output']).optional().describe('только для подземного конвейера, как в place') })).min(1).max(50),
        wait_craft_s: waitCraftArg },
      async (a) => {
        const need = {};
        for (const it of a.items) need[it.item] = (need[it.item] || 0) + 1;
        const waited = await awaitCraft({ items: need }, a.wait_craft_s);
        const r = await placeMany(a.items);
        const already = r.built.filter((b) => b.already).length;
        return { placed: r.built.length - already, already: already || undefined, waited_craft_s: waited ?? undefined, asked: a.items.length, built: r.built, left: r.left, skipped: r.skipped.map(({ self, ...x }) => x), skipped_count: r.skipped.length,
          not_done: r.pending.length ? r.pending : undefined, stopped: r.stopped };
      }),

    def('template_save', 'Запомнить постройки в прямоугольнике как шаблон, чтобы потом ставить такую же группу в других местах (template_place) — как чертёж, только строит сам персонаж из инвентаря. Запоминаются постройки своей команды, которых касается прямоугольник: предмет, место, направление, вход или выход подземного конвейера, рецепт сборочного автомата. Содержимое, топливо, фильтры и настройки разделителей не запоминаются. Область — до 50×50 клеток и до 100 построек, целиком в пределах 60 клеток от персонажа. Шаблоны общие для всех ботов; сохранить заново под тем же именем и удалить может только автор. В ответе origin — северо-западный угол шаблона (от него считается место в template_place) и cost — сколько каких предметов нужно.',
      { name: z.string().min(1).max(40).describe('имя шаблона'), ...coords, x2: z.number().describe('x противоположного угла'), y2: z.number().describe('y противоположного угла') },
      (a) => run('tpl_save', { name: a.name.trim(), x1: Math.floor(Math.min(a.x, a.x2)), y1: Math.floor(Math.min(a.y, a.y2)), x2: Math.floor(Math.max(a.x, a.x2)) + 1, y2: Math.floor(Math.max(a.y, a.y2)) + 1 })),

    def('template_place', 'Поставить шаблон (template_save) из инвентаря: (x, y) — клетка, куда встанет северо-западный угол шаблона (уже после поворота), rotation — поворот по часовой стрелке. Персонаж сам подходит и ставит всё, до чего дотягивается, как place_many: в темпе опытного игрока (одинаковые подряд — до 30 в секунду, смена предмета — около пяти в секунду), за дальними подходит. Постройки, которые уже стоят на своих местах, пропускаются (already_there), так что прерванный вызов можно просто повторить. Занятые клетки пропускаются (skipped с причиной). Если предметов не хватает, ставит, на что хватило, а недостающее — в missing. turned — стоит такая же постройка, но повёрнута иначе (поправь через rotate). С dry_run=true ничего не ставит: показывает, сколько чего нужно, чего не хватает и какие клетки заняты (blocked; виден только участок в 60 клетках от персонажа).',
      { name: z.string().describe('имя шаблона'), ...coords,
        rotation: z.number().default(0).describe('поворот по часовой стрелке в градусах: 0, 90, 180 или 270'),
        dry_run: z.boolean().default(false).describe('только проверить: ничего не ставить') },
      async (a) => {
        if (![0, 90, 180, 270].includes(a.rotation)) throw new Error('rotation — 0, 90, 180 или 270');
        const p = await run('tpl_plan', { name: a.name.trim(), x: a.x, y: a.y, rot: a.rotation / 90, check: a.dry_run });
        const all = Array.isArray(p.items) ? p.items : [];
        // Ставим только то, на что хватает предметов; остальное — в missing.
        const budget = { ...p.have }, missing = {}, todo = [];
        for (const it of all) {
          if ((budget[it.item] || 0) > 0) { budget[it.item]--; todo.push(it); } else missing[it.item] = (missing[it.item] || 0) + 1;
        }
        const head = { template: a.name.trim(), origin: p.origin, rotation: a.rotation, size: p.size, total: p.total, already_there: p.already,
          turned: Array.isArray(p.turned) && p.turned.length ? p.turned : undefined };
        const miss = Object.keys(missing).length ? missing : undefined;
        if (a.dry_run) {
          const blocked = Array.isArray(p.blocked) ? p.blocked : [];
          return { ...head, dry_run: true, to_place: all.length, need: p.need, have: p.have, missing: miss,
            blocked: p.checked ? blocked.slice(0, 15) : undefined, blocked_count: p.checked ? blocked.length : undefined,
            note: p.checked ? undefined : 'место дальше 60 клеток от персонажа: заняты ли клетки, отсюда не видно' };
        }
        let r = { built: [], skipped: [], left: {}, pending: [], stopped: undefined };
        if (todo.length) {
          r = await placeMany(todo);
          // Тем постройкам, которым мешал сам персонаж, даём вторую попытку: отходим за ближайший край шаблона.
          const own = r.skipped.filter((s) => s.self);
          if (own.length && !r.stopped) {
            const b = own[0], o = p.origin, sz = p.size;
            const side = [[b.x - o.x, -1, 0], [o.x + sz.w - b.x, 1, 0], [b.y - o.y, 0, -1], [o.y + sz.h - b.y, 0, 1]].sort((u, v) => u[0] - v[0])[0];
            const step = Math.min(side[0] + 2, 6);
            await walk(b.x + side[1] * step, b.y + side[2] * step, 1);
            const again = await placeMany(own.map((s) => todo[s.n - 1]));
            r.skipped = [...r.skipped.filter((s) => !s.self), ...again.skipped];
            r.built.push(...again.built);
            Object.assign(r.left, again.left);
            r.pending.push(...again.pending);
            r.stopped = again.stopped;
          }
        }
        const by = {};
        for (const x of r.built) by[x.placed] = (by[x.placed] || 0) + 1;
        return { ...head, placed: r.built.length, placed_by_name: by, left: r.left, missing: miss,
          skipped: r.skipped.slice(0, 15).map(({ n, self, ...x }) => x), skipped_count: r.skipped.length,
          not_done: r.pending.length || undefined, stopped: r.stopped,
          completed: !miss && !r.skipped.length && !r.pending.length,
          note: r.pending.length ? 'не всё успел: повтори тот же вызов, уже поставленное пропустится' : undefined };
      }),

    def('template_cost', 'Шаблоны построек. Без name — список всех шаблонов (имя, кто сохранил, размер, число построек). С name — сколько каких предметов нужно на шаблон (cost), сколько их у тебя в инвентаре (have), чего не хватает (missing) и раскладка: предмет, смещение от северо-западного угла, направление.',
      { name: z.string().optional().describe('имя шаблона; без него — список шаблонов') },
      async (a) => {
        const r = await run('tpl_info', { name: a.name?.trim() });
        if (!a.name && !Array.isArray(r.templates)) r.templates = [];
        return r;
      }),

    def('template_delete', 'Удалить свой шаблон построек (сами постройки на карте не трогает).', { name: z.string() },
      (a) => run('tpl_delete', { name: a.name.trim() })),

    def('ghost_place', 'План-призраки: поставить на карту призраки построек, как чертёж в игре, — план виден всем на карте (и людям, и ботам), стройку можно согласовать до начала. Предметы не нужны и ничего не тратится: призрак — только разметка; строит его потом ghost_build из инвентаря. Призраки добавляются в план с именем name; план можно дописывать частями — сколько угодно вызовов под одним именем (до 500 призраков за вызов, до 5000 в плане), так что одним планом размечается целый район. Что ставить: либо items — список {item, x, y, direction, underground, recipe}, либо template — шаблон (template_save), (x, y) — клетка его северо-западного угла после поворота, rotation — поворот. Ставить можно где угодно на открытой карте, идти туда не нужно. Где уже стоит такая же постройка или такой же призрак — пропускается (already), так что повторять вызов безопасно; занятые клетки — в blocked с причиной. Дописывать и убирать план может только автор.',
      { name: z.string().min(1).max(40).describe('имя плана'),
        items: z.array(z.object({ item: z.string().describe('внутреннее имя предмета'), ...coords,
          direction: z.enum(DIRECTIONS).default('north').describe('как в place'),
          underground: z.enum(['input', 'output']).optional().describe('только для подземного конвейера, как в place'),
          recipe: z.string().optional().describe('только для сборочного автомата: рецепт, он задастся при постройке') })).min(1).max(500).optional(),
        template: z.string().optional().describe('имя шаблона вместо items'),
        x: z.number().optional().describe('для template: x клетки северо-западного угла'), y: z.number().optional().describe('для template: y клетки северо-западного угла'),
        rotation: z.number().default(0).describe('для template: поворот по часовой стрелке — 0, 90, 180 или 270') },
      async (a) => {
        let items = a.items;
        if (a.template) {
          if (items) throw new Error('укажи либо items, либо template');
          if (a.x === undefined || a.y === undefined) throw new Error('для template нужны x и y');
          if (![0, 90, 180, 270].includes(a.rotation)) throw new Error('rotation — 0, 90, 180 или 270');
          const p = await run('tpl_plan', { name: a.template.trim(), x: a.x, y: a.y, rot: a.rotation / 90, check: false });
          items = Array.isArray(p.items) ? p.items : [];
        }
        if (!items) throw new Error('укажи items или template');
        const out = await ghostAdd(a.name.trim(), items);
        out.note = 'что нужно на постройку и чего не хватает — ghost_list; строить — ghost_build';
        return out;
      }),

    def('ghost_list', 'План-призраки: что размечено и сколько это стоит. Без аргументов — список планов (имя, автор, сколько призраков осталось, границы). С name и/или областью (x, y, x2, y2) — призраки этого плана или все призраки команды в области, в том числе поставленные людьми: сколько осталось (ghosts), сколько каких предметов нужно (cost), сколько есть у тебя (have), чего не хватает (missing), границы (area). С layout=true — ещё и сами призраки списком, ближайшие к тебе сверху (до 100). Построенные призраки из плана уходят сами; полностью построенный план исчезает из списка, а по имени отвечает already_built=true и ghosts=0.',
      { name: z.string().optional().describe('имя плана'),
        x: z.number().optional(), y: z.number().optional(), x2: z.number().optional().describe('x противоположного угла области'), y2: z.number().optional().describe('y противоположного угла области'),
        layout: z.boolean().default(false).describe('приложить список призраков (до 100 ближайших)') },
      async (a) => {
        const sel = { name: a.name?.trim(), ...ghostArea(a) };
        const r = await run('ghost_q', { ...sel, limit: a.layout ? 100 : 0 });
        if (!sel.name && sel.x1 === undefined) { if (!Array.isArray(r.plans)) r.plans = []; return r; }
        if (!a.layout) delete r.items;
        else if (!Array.isArray(r.items)) r.items = [];
        return r;
      }),

    def('ghost_build', 'План-призраки: построить призраки из инвентаря — план name и/или все призраки команды в области (x, y, x2, y2). Строит тем же способом, что place_many: персонаж сам идёт к ближайшим призракам и ставит всё, до чего дотягивается, в темпе опытного игрока (одинаковые подряд — до 30 в секунду, смена предмета — около пяти в секунду); направление, вход/выход подземного конвейера и рецепт берутся из призрака. Ставит только то, на что есть предметы; чего не хватило — в missing. Что не встало — в skipped с причиной. За один вызов — около трёх минут работы: если остались призраки (ghosts_left) — донеси предметы и повтори тот же вызов. План, в котором призраков уже не осталось (всё построено), — не ошибка: already_built=true.',
      { name: z.string().optional().describe('имя плана'),
        x: z.number().optional(), y: z.number().optional(), x2: z.number().optional().describe('x противоположного угла области'), y2: z.number().optional().describe('y противоположного угла области'),
        wait_craft_s: waitCraftArg },
      async (a) => {
        const sel = { name: a.name?.trim(), ...ghostArea(a) };
        if (!sel.name && sel.x1 === undefined) throw new Error('укажи name или область (x, y, x2, y2)');
        const q0 = await run('ghost_q', { ...sel, limit: 0 });
        if (q0.already_built) return { plan: sel.name, already_built: true, placed: 0, ghosts_left: 0, completed: true, note: q0.note };
        let waited = null;
        if (q0.missing && Object.keys(q0.missing).length) waited = await awaitCraft({ items: q0.cost }, a.wait_craft_s);
        const key = (it) => `${it.item}@${it.x},${it.y}`;
        const tries = new Map(); // призрак → сколько раз не встал; тому, которому мешал сам персонаж, даём вторую попытку
        const built = [], skipped = new Map(), left = {};
        const deadline = Date.now() + 180_000;
        let stopped;
        for (;;) {
          const q = await run('ghost_q', { ...sel, limit: 150 });
          const have = { ...q.have };
          const todo = [];
          for (const it of Array.isArray(q.items) ? q.items : []) {
            if ((tries.get(key(it)) || 0) >= 2 || (have[it.item] || 0) < 1) continue;
            have[it.item]--;
            todo.push(it);
            if (todo.length >= 50) break;
          }
          if (!todo.length) break;
          const r = await placeMany(todo);
          for (const b of r.built) { built.push(b); const it = todo[b.n - 1]; skipped.delete(key(it)); }
          Object.assign(left, r.left);
          for (const s of r.skipped) {
            const k = key(todo[s.n - 1]);
            tries.set(k, (tries.get(k) || 0) + (s.self ? 1 : 2));
            skipped.set(k, { item: s.item, x: s.x, y: s.y, why: s.why });
          }
          stopped = r.stopped || (Date.now() > deadline ? 'вышло время на один вызов' : undefined);
          if (stopped) break;
        }
        const q = await run('ghost_q', { ...sel, limit: 0 }).catch(() => null);
        const by = {};
        for (const x of built) by[x.placed] = (by[x.placed] || 0) + 1;
        const miss = q && q.missing && Object.keys(q.missing).length ? q.missing : undefined;
        const sk = [...skipped.values()];
        return { plan: sel.name, placed: built.length, waited_craft_s: waited ?? undefined, placed_by_name: by, left, ghosts_left: q ? q.ghosts : undefined, missing: miss,
          skipped: sk.slice(0, 15), skipped_count: sk.length, stopped, completed: q ? q.ghosts === 0 : undefined,
          note: q && q.ghosts > 0 && !miss && !sk.length ? 'не всё успел: повтори тот же вызов' : undefined };
      }),

    def('ghost_clear', 'План-призраки: убрать призраки своих планов с карты (постройки не трогает). С name — план целиком, с name и областью (x, y, x2, y2) — только его часть в области, только с областью — призраки всех твоих планов в ней. Чужие планы и призраки, поставленные людьми, не трогаются.',
      { name: z.string().optional().describe('имя плана'),
        x: z.number().optional(), y: z.number().optional(), x2: z.number().optional().describe('x противоположного угла области'), y2: z.number().optional().describe('y противоположного угла области') },
      (a) => {
        const sel = { name: a.name?.trim(), ...ghostArea(a) };
        if (!sel.name && sel.x1 === undefined) throw new Error('укажи name или область (x, y, x2, y2)');
        return run('ghost_clear', sel);
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
      { ...coords, item: z.string(), count: z.number().int().min(1).default(5), wait_craft_s: waitCraftArg },
      async (a) => { await approach(a.x, a.y, 8); return withCraft({ items: { [a.item]: a.count } }, a.wait_craft_s, /в инвентаре нет/, () => run('insert', a)); }),

    def('take_items', 'Забрать предметы из объекта в точке. Без item — всё из выходного слота. С конвейера забирает то, что лежит на этой клетке. Из трупа персонажа (character-corpse — вещи погибшего; координаты даёт find character-corpse) без item забирает всё, что влезет в инвентарь, left_in_corpse — сколько осталось. Сам подходит. Забрать из нескольких мест одним вызовом — gather (источники указываешь сам).',
      { ...coords, item: z.string().optional(), count: z.number().int().min(1).default(1000) },
      async (a) => { await approach(a.x, a.y, 8); return run('take', a); }),

    def('gather', 'Забрать предметы из нескольких мест одним вызовом вместо серии move_to + take_items. Источники указываешь явно: sources — список {x, y, item, count}; персонаж обходит пешком ровно эти места (каждый раз идёт к ближайшему из оставшихся) и забирает из каждого указанный предмет, не больше count (без count — весь, что там есть). Сам источники не ищет и ничего, кроме перечисленного, не трогает: сначала посмотри, где что лежит (where_items, inspect), и не указывай буферы, из которых руками брать нельзя. Берёт так же, как take_items с item: из сундука, из любого слота машины (забирая сырьё или топливо, остановишь её), с клетки ленты, из трупа персонажа. В ответе got — что взял всего, from — по каждому источнику: taken и, если взято меньше count, short; skipped — где не вышло и почему; not_visited — куда не успел; have — сколько этих предметов теперь в инвентаре; complete — взято всё, что просил. До 50 источников и около трёх минут на вызов; прервалось — повтори вызов с оставшимися.',
      { sources: z.array(z.object({ x: z.number(), y: z.number(), item: z.string().describe('внутреннее имя предмета, например iron-plate'),
          count: z.number().int().min(1).max(100000).optional().describe('сколько взять отсюда; без него — всё') })).max(50).optional()
          .describe('откуда и что забрать, например [{"x": 10.5, "y": -3.5, "item": "iron-plate", "count": 200}]') },
      async (a) => {
        if (!a.sources?.length) throw new Error('gather больше не выбирает источники сам: передай sources — список {x, y, item, count}. Где лежит предмет — смотри where_items');
        // Несколько предметов из одного места — одна остановка.
        const stops = new Map();
        for (const s of a.sources) {
          const k = `${s.x},${s.y}`;
          if (!stops.has(k)) stops.set(k, { x: s.x, y: s.y, items: [] });
          stops.get(k).items.push({ item: s.item, count: s.count });
        }
        const rest = [...stops.values()];
        const got = {}, from = [], skipped = [];
        let me = await run('pos');
        let stopped;
        const deadline = Date.now() + 180_000;
        while (rest.length) {
          // Каждый раз идём к ближайшему из оставшихся мест.
          rest.sort((p, q) => Math.hypot(p.x - me.x, p.y - me.y) - Math.hypot(q.x - me.x, q.y - me.y));
          const c = rest.shift();
          let walked = false;
          for (const it of c.items) {
            try {
              if (!walked) { await approach(c.x, c.y, 8); walked = true; }
              const r = await run('take', { x: c.x, y: c.y, item: it.item, count: it.count ?? 100000 });
              const n = (r.taken && !Array.isArray(r.taken) ? r.taken[it.item] : 0) || 0;
              got[it.item] = (got[it.item] || 0) + n;
              from.push({ x: c.x, y: c.y, name: r.from, item: it.item, taken: n, short: it.count && n < it.count ? it.count - n : undefined });
            } catch (e) {
              skipped.push({ x: c.x, y: c.y, item: it.item, why: e.message.replace(/^Lua: /, '') });
              if (!walked) break;
            }
          }
          if (!rest.length) break;
          me = await run('pos');
          stopped = await interrupted();
          if (!stopped && Date.now() > deadline) stopped = 'вышло время на один вызов: повтори его с оставшимися источниками';
          if (stopped) break;
          await sleep(150);
        }
        const names = [...new Set(a.sources.map((s) => s.item))];
        const h = await run('gather_have', { items: names });
        const not_visited = rest.flatMap((c) => c.items.map((it) => ({ x: c.x, y: c.y, item: it.item, count: it.count })));
        return { got, have: h.have && !Array.isArray(h.have) ? h.have : {}, from: from.length ? from : undefined,
          skipped: skipped.length ? skipped : undefined, not_visited: not_visited.length ? not_visited : undefined,
          complete: !skipped.length && !not_visited.length && !from.some((f) => f.short), stopped: stopped || undefined };
      }),

    def('set_recipe', 'Задать рецепт сборочному автомату в точке.', { ...coords, recipe: z.string() },
      async (a) => { await approach(a.x, a.y, 8); return run('set_recipe', a); }),

    def('rotate', 'Повернуть постройку в точке. Манипулятор берёт со стороны direction и кладёт на противоположную; в ответе видно, откуда и куда.', { ...coords, direction: z.enum(DIRECTIONS) },
      async (a) => { await approach(a.x, a.y, 8); return run('rotate', a); }),

    def('research', 'Исследования: текущее, вся очередь (по каждой технологии — какие колбы и сколько на единицу, сколько единиц всего и осталось, секунд на единицу в одной лаборатории) и список доступных. С параметром technology — поставить в очередь: added=true, только если технология действительно появилась в очереди, иначе в reason причина. position — переставить технологию в очереди (и ту, что уже стоит, и только что добавленную): first — в начало, она станет текущей, вместе с ней поднимаются её ещё не исследованные предшественники (also_moved); last — в конец, вместе с теми, кто от неё зависит. remove=true — убрать технологию из очереди; зависящие от неё уходят тоже (also_removed). Накопленный прогресс технологий не пропадает.',
      { technology: z.string().optional(),
        position: z.enum(['first', 'last']).optional().describe('куда переставить technology в очереди'),
        remove: z.boolean().optional().describe('убрать technology из очереди') },
      (a) => {
        if ((a.position || a.remove) && !a.technology) throw new Error('для position и remove укажи technology');
        return run('research', a);
      }),

    def('power', 'Электросеть, как в окне столба: выработка и потребление в кВт по видам машин (среднее за 5 секунд), состояние генераторов и котлов рядом, заряд аккумуляторов и список машин без питания (no_power, low_power, не подключён к сети). Без координат берётся ближайший столб.',
      { x: z.number().optional().describe('координата x столба'), y: z.number().optional().describe('координата y столба'),
        radius: z.number().min(1).max(60).default(40).describe('в каком радиусе от персонажа искать машины без питания') },
      (a) => run('power', a)),

    def('belt', 'Обзор конвейерной линии, проходящей через точку: от начала до конца по участкам (откуда, докуда, направление, длина, что лежит), развилки на разделителях и во что линия упирается. Видно в пределах 60 клеток от персонажа.',
      { ...coords, section: z.number().int().min(1).max(100).default(20).describe('наибольшая длина одного участка в отчёте') },
      (a) => run('belt', a)),

    def('alerts', 'Что на базе встало — одним вызовом, как значки над машинами в игре. problems — серьёзное: нет топлива (no_fuel), топливо догорает и в топке больше ничего нет (fuel_running_out), нет питания или его не хватает (no_power, low_power, not_plugged_in_electric_network), руда под буром кончилась (no_minable_resources), лаборатории не хватает колб (missing_science_packs), нет воды или патронов. idle — простой, который часто нормален: нет ингредиентов, выход полон (full_output, waiting_for_space_in_destination), нет рецепта, лаборатория без исследования. Сгруппировано по состоянию и виду машины: сколько таких и координаты ближайших. shortage — электричества не хватает. Дальше 60 клеток от персонажа видно только там, где карта показывается вживую (радар, игроки); сколько машин осталось вне видимости — not_visible.',
      { radius: z.number().min(1).max(500).default(200).describe('радиус от персонажа в клетках'),
        idle: z.boolean().default(true).describe('показывать ли простой (idle); false — только серьёзные проблемы') },
      async (a) => {
        const r = await run('alerts', a);
        if (r.not_visible) r.note = 'часть машин в радиусе не видна (нет радара): подойди ближе или поставь радар';
        return r;
      }),

    def('pollution', 'Загрязнение, как слой загрязнения на карте, в квадрате вокруг точки (без координат — вокруг персонажа): дошло ли облако до гнёзд врагов. Уровень считается по чанкам 32×32 клетки. here — уровень в самой точке; cloud — облако: сколько чанков загрязнено, где максимум, границы по x и y. nests — гнёзда, которые сейчас видно, сгруппированы по чанкам, самые угрожаемые сверху: in_cloud — облако уже накрыло (гнездо впитывает загрязнение и шлёт атаки), cloud_dist — сколько клеток от гнезда до края облака, pollution — уровень на гнезде; nearest_nest_to_cloud — наименьший такой зазор (0 — уже накрыло). enemies — кусаки, которых сейчас видно, кучками. sources_per_minute — кто сколько загрязняет за последнюю минуту (как вкладка загрязнения в окне производства), evolution_percent — эволюция врагов. Облако видно на всей открытой карте, а гнёзда и кусаки — только в 60 клетках от персонажа и там, где карта показывается вживую (радар, игроки): chunks_not_visible — сколько чанков квадрата так не видно, гнёзда в них не показаны. Куда идёт отряд кусак и какая у него цель, игрок не видит — этого здесь нет.',
      { x: z.number().optional().describe('x центра; по умолчанию — персонаж'), y: z.number().optional().describe('y центра; по умолчанию — персонаж'),
        radius: z.number().min(32).max(500).default(200).describe('полусторона квадрата в клетках'),
        map: z.boolean().default(false).describe('приложить карту: строка — ряд чанков с севера на юг, символ — чанк') },
      async (a) => {
        if ((a.x === undefined) !== (a.y === undefined)) throw new Error('укажи и x, и y либо ни одного');
        const r = await run('pollution', a);
        if (r.map) r.map.legend = 'символ — чанк 32×32; первая строка — y от y0, первый символ — x от x0, дальше на восток и на юг. «.» чисто; 1–9 загрязнение (1 — от 1, каждая ступень вдвое больше, 9 — от 256); N — чанк с видимым гнездом; ? — карта не открыта';
        if (r.chunks_not_visible) r.note = 'гнёзда и кусаки показаны только там, где карту видно вживую; в остальных чанках они могут быть — подойди ближе или поставь радар';
        return r;
      }),

    def('area_map', 'Карта области одним вызовом вместо десятков inspect: прямоугольник (x, y)–(x2, y2) до 64×64 клеток, символ — клетка. rows[j][i] — клетка с x = x0+i, y = y0+j (её центр — +0.5), строки идут с севера на юг. «.» — пусто, можно строить; «~» вода; «*» дерево; «@» камень или обломки; «%» скала; строчные буквы — руда (на руде строить можно); «^ > v <» — конвейер, везёт в эту сторону; «=» труба; заглавные буквы — постройки (большая занимает несколько клеток); «+» призрак постройки (ghost_place); «!» вражеская постройка; «#» какая-то постройка (вид отсюда не видно); «?» карта не открыта. Какие буквы что значат в этой области — в legend, сколько каких построек — buildings. С details=true — ещё и список построек (кроме лент и труб) с точным центром, направлением, рецептом, входом/выходом подземного конвейера (до 200). Вид построек и направление лент видно в 60 клетках от персонажа и под радаром; на остальной открытой карте — только вода, руда, деревья, камни и «#» (тогда в ответе note). Идти никуда не нужно.',
      { ...coords, x2: z.number().describe('x противоположного угла'), y2: z.number().describe('y противоположного угла'),
        details: z.boolean().default(false).describe('приложить список построек с направлением и рецептом') },
      async (a) => {
        const sel = { x1: Math.floor(Math.min(a.x, a.x2)), y1: Math.floor(Math.min(a.y, a.y2)), x2: Math.floor(Math.max(a.x, a.x2)) + 1, y2: Math.floor(Math.max(a.y, a.y2)) + 1 };
        if (sel.x2 - sel.x1 > 64 || sel.y2 - sel.y1 > 64) throw new Error('область больше 64×64 клеток: раздели её на части');
        const r = await run('area_map', { ...sel, details: a.details });
        const FIXED = { '.': 'пусто', '~': 'вода', '*': 'дерево', '@': 'камень или обломки', '%': 'скала', '+': 'призрак постройки', '!': 'вражеская постройка',
          '#': 'постройка, вид не виден', '?': 'карта не открыта', '^': 'конвейер на север', '>': 'конвейер на восток', v: 'конвейер на юг', '<': 'конвейер на запад' };
        const legend = {};
        const rows = Array.isArray(r.rows) ? r.rows : [];
        const text = rows.join('');
        for (const [ch, name] of Object.entries(FIXED)) if (text.includes(ch)) legend[ch] = name;
        for (const n of Array.isArray(r.named) ? r.named : []) legend[n.s] = n.name;
        return { x0: r.x0, y0: r.y0, w: r.w, h: r.h, rows, legend, free: r.free, unexplored: r.unexplored || undefined,
          buildings: r.buildings && !Array.isArray(r.buildings) ? r.buildings : undefined,
          details: a.details ? (Array.isArray(r.details) ? r.details : []) : undefined,
          note: r.coarse ? 'часть области дальше 60 клеток от персонажа и не под радаром: там постройки показаны как «#», без вида и направления, а враги не показаны — подойди ближе за точной картой' : undefined };
      }),

    def('route', 'Маршрут конвейера или трубы от клетки (x, y) до (x2, y2): находит путь в обход построек, деревьев, камней, скал, воды и призраков, а где обойти нельзя или далеко — проходит под землёй (подземный конвейер того же вида или pipe-to-ground, в пределах их дальности). Ничего не ставит и не тратит — это расчёт по тому, что видно на карте; идти никуда не нужно. Чужое не задевает: труба не ложится в клетку, где соединилась бы с чужой трубой или входом машины; лента не ложится туда, куда высыпает чужая лента; подземный участок не путается с чужими подземными концами на той же линии. Начало и конец от этих запретов свободны (там ты и подключаешься), обе клетки должны быть свободны. Ответ: items — список {item, x, y, direction, underground} по порядку от начала к концу, его можно целиком передать в ghost_place или place_many (по 50 штук); segments — то же коротко, прямыми участками; cost / have / missing — сколько чего нужно и чего не хватает. С ghost=имя плана маршрут сразу размечается призраками (как ghost_place), а вместо items приходит только сводка — потом ghost_build. Лента: каждая клетка везёт к следующей, последняя — по ходу или в end_direction. Точно видно в 60 клетках от персонажа и под радаром; дальше постройки — просто препятствия (тогда в ответе note).',
      { item: z.string().default('transport-belt').describe('что прокладываем: конвейер (transport-belt, fast-transport-belt, ...) или pipe'),
        ...coords, x2: z.number().describe('x конечной клетки'), y2: z.number().describe('y конечной клетки'),
        end_direction: z.enum(DIRECTIONS).optional().describe('только для конвейера: куда должна везти последняя клетка (по умолчанию — по ходу маршрута)'),
        underground: z.boolean().default(true).describe('можно ли проходить под землёй; false — только обход по поверхности'),
        margin: z.number().int().min(3).max(40).default(15).describe('на сколько клеток обход может выходить за прямоугольник между началом и концом'),
        ghost: z.string().min(1).max(40).optional().describe('имя плана: сразу поставить маршрут призраками (ghost_place)') },
      async (a) => {
        const q = { item: a.item.trim(), fx: Math.floor(a.x), fy: Math.floor(a.y), tx: Math.floor(a.x2), ty: Math.floor(a.y2),
          end_dir: a.end_direction ? DIRECTIONS.indexOf(a.end_direction) : undefined, underground: a.underground, margin: a.margin };
        if (q.fx === q.tx && q.fy === q.ty) throw new Error('начало и конец — одна и та же клетка');
        if (Math.abs(q.fx - q.tx) > 250 || Math.abs(q.fy - q.ty) > 250) throw new Error('слишком далеко: до 250 клеток по каждой оси, длинный маршрут веди по частям');
        if ((Math.abs(q.fx - q.tx) + 2 * q.margin + 1) * (Math.abs(q.fy - q.ty) + 2 * q.margin + 1) > 60000) throw new Error('слишком большая область поиска: уменьши margin или веди маршрут по частям через промежуточные точки');
        const r = await run('route', q);
        const items = Array.isArray(r.items) ? r.items : [];
        // Прямые участки: подряд идущие клетки с тем же предметом и направлением (подземные концы — каждый отдельно).
        const segments = [];
        for (const it of items) {
          const g = segments[segments.length - 1];
          const dx = g ? it.x - g.to.x : 0, dy = g ? it.y - g.to.y : 0;
          if (g && it.item === q.item && g.item === it.item && g.direction === it.direction && Math.abs(dx) + Math.abs(dy) === 1 && (g.n === 1 || (dx === g.dx && dy === g.dy))) {
            g.dx = dx; g.dy = dy; g.to = { x: it.x, y: it.y }; g.n++;
          } else segments.push({ item: it.item, from: { x: it.x, y: it.y }, to: { x: it.x, y: it.y }, n: 1, direction: it.direction, underground: it.underground });
        }
        for (const g of segments) { delete g.dx; delete g.dy; if (g.n === 1) delete g.to; }
        const obj = (v) => (v && !Array.isArray(v) ? v : {});
        const out = { item: q.item, from: { x: q.fx + 0.5, y: q.fy + 0.5 }, to: { x: q.tx + 0.5, y: q.ty + 0.5 }, cells: r.cells, underground_pairs: r.underground_pairs, turns: r.turns,
          cost: obj(r.cost), have: obj(r.have), missing: obj(r.missing), enough: r.enough, segments };
        if (r.coarse) out.note = 'часть области дальше 60 клеток от персонажа и не под радаром: там постройки учтены только как препятствия (не видно, трубы это или ленты и куда они смотрят) — перед стройкой подойди ближе и пересчитай';
        if (a.ghost) out.ghosts = await ghostAdd(a.ghost.trim(), items);
        else out.items = items;
        return out;
      }),

    def('where_items', 'Где лежит предмет: ближайшие сундуки, печи, сборочные автоматы, лаборатории, буры, вагоны и трупы персонажей (character-corpse), в которых он есть, с количеством, от ближних к дальним — чтобы потом забрать одним вызовом gather, явно указав источники (sources). count — сколько всего в объекте (во всех слотах), in_output — сколько из этого в выходном слоте машины (остальное — её сырьё или топливо: забирая, остановишь её). belts — сколько лежит на конвейерах в 60 клетках и ближайшие клетки лент с ним. have — сколько уже у тебя. Видно в 60 клетках от персонажа и там, где карта показывается вживую (радар, игроки); сколько объектов в радиусе осталось вне видимости — not_visible. Идти никуда не нужно.',
      { item: z.string().describe('внутреннее имя предмета, например iron-plate'),
        radius: z.number().min(1).max(300).default(60).describe('радиус поиска от персонажа'),
        limit: z.number().int().min(1).max(50).default(15).describe('сколько ближайших мест показать'),
        belts: z.boolean().default(true).describe('смотреть ли конвейеры') },
      async (a) => {
        const r = await run('where_items', a);
        if (!Array.isArray(r.list)) r.list = [];
        if (r.belts && !Array.isArray(r.belts.nearest)) r.belts.nearest = [];
        if (r.places > r.list.length) r.note = `показаны ближайшие ${r.list.length} из ${r.places}: остальные — с большим limit`;
        return r;
      }),

    def('production', 'Статистика производства команды, как окно производства в игре: сколько каждого предмета и жидкости произведено и потреблено в минуту (среднее за последние minutes минут) и всего за игру — чтобы искать узкое место по цифрам: сколько колб в минуту, хватает ли схем, плит. Потребление выше производства — предмет проедается из запасов. Без items — самые производимые (limit штук); с items — только названные предметы и жидкости (нулевые тоже). «Произведено» — всё, что вышло из машин, буров и ручного крафта; «потреблено» — ушло в рецепты, лаборатории, топки и постройку.',
      { items: z.array(z.string()).min(1).max(60).optional().describe('внутренние имена предметов и жидкостей, например ["automation-science-pack", "iron-plate", "petroleum-gas"]'),
        minutes: z.number().default(10).describe('окно усреднения: 1, 10 или 60 минут'),
        limit: z.number().int().min(1).max(100).default(40).describe('сколько строк показать без items') },
      async (a) => {
        const window = { 1: 'one_minute', 10: 'ten_minutes', 60: 'one_hour' }[a.minutes];
        if (!window) throw new Error('minutes — 1, 10 или 60');
        const r = await run('production', { items: a.items, minutes: a.minutes, window, limit: a.items ? 200 : a.limit });
        const out = { minutes: r.minutes };
        for (const k of ['items', 'fluids']) {
          out[k] = Array.isArray(r[k]) ? r[k] : [];
          if (r[`${k}_count`] > out[k].length) out[`${k}_not_shown`] = r[`${k}_count`] - out[k].length;
        }
        return out;
      }),

    def('recipe_info','Рецепт по имени рецепта или предмета: ингредиенты, результат, время, открыт ли.', { name: z.string() }, (a) => run('recipe', a)),

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

  // План: те же инструменты подряд одним вызовом. Каждый шаг — обычный вызов со всеми его проверками и скоростью;
  // выигрыш только в том, что между шагами нет круга «ответ → следующий вызов».
  const NOT_IN_PLAN = new Set(['plan', 'feedback', 'feedback_status', 'read_chat']);
  tools.push(def('plan', 'Выполнить подряд несколько обычных действий одним вызовом — главный способ работать быстро: каждый отдельный вызов стоит многих секунд раздумий, а шаги плана идут без пауз, поэтому всё, что известно заранее, собирай в один план (например gather с выбранными источниками → craft → insert_all). steps — список шагов {tool, args}, как отдельные вызовы этих инструментов (например move_to → take_items → craft → move_to → place). Останавливается на первом шаге, который не удался: ошибка, не дошёл (not_reached), вышло время шага; остальные шаги не выполняются (not_done). Шаг с on_fail=continue план не останавливает: он помечается ok=false, его номер попадает в failed_steps, план идёт дальше — ставь так шагам, от которых остальные не зависят (мир мог измениться: постройку снесли, забирать нечего). Шаг, сделавший часть работы (кончился предмет в insert_all, gather взял не всё, ghost_build не хватило предметов), — не сбой: ok=true, partial=true, номер в partial_steps, план идёт дальше; что сделано и чего не хватило — в result шага. Всегда останавливают план новая реплика, stop и сообщение в чате, обращённое к тебе (в нём твоё имя) либо со словом «стоп». Прочие сообщения чата план не останавливают и долгие шаги (mine, wait, craft) не сворачивают — они приходят в поле chat шагов; это настраивает stop_on_chat. В ответе отчёт по каждому шагу. Аргументы всех шагов проверяются до начала. До 50 шагов и примерно пятнадцать минут на план: что не успело — в not_done, вызови план с оставшимися шагами.',
    { steps: z.array(z.object({ tool: z.string().describe('имя инструмента, например move_to'), args: z.record(z.string(), z.any()).default({}).describe('его аргументы'),
        on_fail: z.enum(['stop', 'continue']).default('stop').describe('что делать, если шаг не удался: stop — остановить план; continue — пометить шаг ok=false и идти дальше (для шагов, от которых остальные не зависят: осмотр, заправка, сбор по списку мест)') })).min(1).max(50),
      stop_on_chat: z.enum(['addressed', 'any', 'never']).default('addressed').describe('какие сообщения игрового чата останавливают план: addressed — только с твоим именем или словом «стоп»; any — любое новое; never — никакие') },
    async (a) => {
      const prepared = a.steps.map((s, i) => {
        const t = NOT_IN_PLAN.has(s.tool) ? null : tools.find((x) => x.name === s.tool);
        if (!t) throw new Error(`шаг ${i + 1}: инструмент ${s.tool} в плане использовать нельзя или его нет`);
        const parsed = z.object(t.inputSchema).safeParse(s.args);
        if (!parsed.success) throw new Error(`шаг ${i + 1} (${s.tool}): неверные аргументы — ${parsed.error.issues.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ')}`);
        return { t, args: parsed.data };
      });
      // Сообщения чата, пришедшие ещё до плана, план не останавливают (как и любое долгое действие): отдаём их отдельно.
      const before = memo ? await takeChat().catch(() => []) : [];
      const start = Date.now();
      const done = [];
      let stopped_at, why;
      const skipped_fail = [], partial = [];
      try {
      for (let i = 0; i < prepared.length; i++) {
        if (i > 0) {
          if (hooks.aborted()) why = 'прервано новой репликой';
          else if (Date.now() - start > 900_000) why = 'вышло время на один план (около пятнадцати минут)';
          if (why) { stopped_at = i + 1; break; }
        }
        const { t, args } = prepared[i];
        chatMode = a.stop_on_chat; // на время шага: его долгое действие сворачивают только такие сообщения
        const res = await t.handler(args);
        chatMode = 'any';
        const text = res.content[0].text;
        let result = text;
        if (!res.isError) { try { result = JSON.parse(text); } catch { /* оставляем текстом */ } }
        const step = { step: i + 1, tool: t.name, ok: !res.isError, result };
        done.push(step);
        // failed — шаг не удался (с on_fail=continue план идёт дальше); why — план останавливается в любом случае.
        let failed;
        if (res.isError) failed = 'ошибка';
        else if (result && typeof result === 'object') {
          const cut = result.interrupted || result.stopped;
          if (result.not_reached) failed = 'не дошёл';
          else if (cut && (result.interrupted || /^прервано/.test(cut))) why = `действие свернулось: ${cut}`;
          else if (cut && /^вышло время/.test(cut)) failed = `действие свернулось: ${cut}`;
          // Сделал часть (кончился предмет, нечего больше добывать, чего-то не хватило) — это отчёт, а не сбой шага.
          else if (cut || result.complete === false || result.completed === false) { step.partial = true; partial.push(i + 1); }
          if (!why && Array.isArray(result.chat) && i < prepared.length - 1) {
            if (a.stop_on_chat === 'any') why = 'новое сообщение в чате (оно в поле chat этого шага)';
            else if (a.stop_on_chat === 'addressed' && result.chat.some(chatAddressed)) why = 'в чате сообщение для тебя или просьба остановиться (оно в поле chat этого шага)';
          }
        }
        if (failed) {
          step.ok = false;
          if (!why && a.steps[i].on_fail === 'continue' && !hooks.aborted()) { step.continued = true; skipped_fail.push(i + 1); }
          else why = why || failed;
        }
        if (why) { stopped_at = i + 1; break; }
      }
      } finally { chatMode = 'any'; }
      const not_done = a.steps.slice(done.length).map((s, k) => ({ step: done.length + k + 1, tool: s.tool }));
      return { completed: !why && !skipped_fail.length, steps_ok: done.filter((s) => s.ok).length, steps_total: a.steps.length, stopped_at, why,
        failed_steps: skipped_fail.length ? skipped_fail : undefined, partial_steps: partial.length ? partial : undefined,
        steps: done, not_done: not_done.length ? not_done : undefined,
        chat_before: before.length ? before : undefined };
    }));

  tools.push(def('feedback','Оставить разработчикам заявку на улучшение этих инструментов: чего не хватает, что работает неудобно или неверно. Одна заявка — одна тема, с примером из практики. Заявки разбираются в фоне; читерских возможностей не добавляют. Что с заявкой стало и что ответил разработчик — feedback_status; загляни туда перед новой заявкой, чтобы не повторять уже разобранное.',
    { text: z.string().min(10).max(4000) },
    (a) => ({ ...submitFeedback(botName, a.text), status: 'что с заявкой дальше, покажет feedback_status' })));

  // Обратная связь по заявкам: статус и ответ разработчика. Очередь общая для всех ботов, поэтому перед новой заявкой
  // можно посмотреть и чужие (all=true), чтобы не дублировать.
  const FB_STATUS = { new: 'в очереди', in_progress: 'в работе', done: 'сделано', rejected: 'отклонено', discussion: 'на обсуждении у людей' };
  tools.push(def('feedback_status', 'Что стало с заявками на улучшение (feedback): статус (в очереди / в работе / сделано / отклонено / на обсуждении у людей) и ответ разработчика. По умолчанию — твои заявки, новые сверху, тексты сокращены; с id — одна заявка целиком; с all=true — заявки всех ботов (загляни перед новой заявкой, чтобы не дублировать). В «сделано» ответ говорит, что именно сделано и как называется инструмент.',
    { id: z.string().optional().describe('номер заявки, например fb-016: показать её целиком'),
      all: z.boolean().default(false).describe('показать заявки всех ботов, а не только твои'),
      open_only: z.boolean().default(false).describe('только ещё не разобранные (в очереди и в работе)') },
    (a) => {
      const cut = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t; };
      const view = (i, full) => ({ id: i.id, from: a.all || i.from !== botName ? i.from : undefined, at: i.at, status: FB_STATUS[i.status] || i.status,
        priority: i.priority ? 'приоритет от людей' : undefined, text: full ? i.text : cut(i.text, 160),
        answer: i.note ? (full ? i.note : cut(i.note, 400)) : undefined, answered_at: i.note ? i.updated : undefined });
      const items = readItems();
      if (a.id) {
        const id = a.id.trim().toLowerCase();
        const it = items.find((i) => i.id === id || i.id === `fb-${id.replace(/\D/g, '').padStart(3, '0')}`);
        if (!it) throw new Error(`нет заявки ${a.id}`);
        return view(it, true);
      }
      const mine = items.filter((i) => a.all || i.from === botName);
      const counts = {};
      for (const i of mine) { const s = FB_STATUS[i.status] || i.status; counts[s] = (counts[s] || 0) + 1; }
      const open = (i) => i.status === 'new' || i.status === 'in_progress';
      const list = mine.filter((i) => !a.open_only || open(i)).reverse();
      return { whose: a.all ? 'заявки всех ботов' : `заявки ${botName}`, total: mine.length, counts,
        items: list.slice(0, 30).map((i) => view(i, false)), not_shown: Math.max(0, list.length - 30) || undefined,
        note: list.some((i) => (i.note || '').length > 400 || (i.text || '').length > 160) ? 'тексты сокращены; целиком — feedback_status с id' : undefined };
    }));

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
