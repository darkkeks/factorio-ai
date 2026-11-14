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
`;

const BODY = {
  ensure: `local e = bot() return {pos=P(e.position)}`,

  status: `
    local e = bot()
    local players = {}
    for _, p in pairs(game.connected_players) do players[#players+1] = {name=p.name, pos=P(p.position), dist=r1(dist(p.position, e.position))} end
    local bots = {}
    for n, b in pairs(storage.vb) do if b.valid and n ~= A.bot then bots[#bots+1] = {name=n, pos=P(b.position)} end end
    return {me=A.bot, pos=P(e.position), health=math.floor(e.health), inventory=contents(e.get_main_inventory()),
      crafting_queue=e.crafting_queue_size, players_in_game=players, other_bots=bots,
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

  teleport: `
    local e = bot()
    local p = e.surface.find_non_colliding_position('character', {A.x, A.y}, 20, 0.5)
    if not p then fail('рядом с целью нет свободного места') end
    e.walking_state = {walking=false, direction=e.walking_state.direction}
    e.teleport(p)
    return {x=p.x, y=p.y}`,

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
    r.direction = t.supports_direction and t.direction or nil
    if t.health then r.health = math.floor(t.health) end
    pcall(function() local rc = t.get_recipe() if rc then r.recipe = rc.name end end)
    pcall(function() for k, v in pairs(defines.entity_status) do if v == t.status then r.status = k end end end)
    pcall(function() r.crafting_progress = r1(t.crafting_progress) end)
    pcall(function() if t.mining_target then r.mining_target = t.mining_target.name end end)
    local inv = {}
    pcall(function() for i = 1, t.get_max_inventory_index() do local c = contents(t.get_inventory(i)) if next(c) then for k, v in pairs(c) do inv[k] = (inv[k] or 0) + v end end end end)
    r.items = inv
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
    if can < 1 then
      local need = {}
      for _, i in pairs(rc.ingredients) do need[#need+1] = i.name..' x'..i.amount end
      fail('не хватает ингредиентов. На одну штуку нужно: '..table.concat(need, ', '))
    end
    local n = e.begin_crafting{recipe=rc, count=math.min(A.count, can)}
    return {queued=n, asked=A.count}`,

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
    local n = s.create_entity{name=pr.name, position={A.x, A.y}, direction=dir, force=e.force, raise_built=true}
    e.remove_item{name=A.item, count=1}
    return {placed=n.name, pos=P(n.position), direction=A.direction}`,

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
    local n = t.insert{name=A.item, count=math.min(have, A.count)}
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
    return {entity=t.name, direction=A.direction}`,

  research: `
    local f = bot().force
    local started
    if A.technology then
      local t = f.technologies[A.technology]
      if not t then fail('нет технологии '..A.technology) end
      started = f.add_research(t)
    end
    local avail = {}
    for name, t in pairs(f.technologies) do
      if t.enabled and not t.researched and #avail < 40 then
        local ok = true
        for _, p in pairs(t.prerequisites) do if not p.researched then ok = false end end
        if ok then avail[#avail+1] = name end
      end
    end
    return {started=started, current=f.current_research and f.current_research.name or nil, progress=r1(f.research_progress), available=avail}`,

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

  async function walk(x, y, tol = 1.5) {
    const start = Date.now();
    let last = null;
    let lastMoved = Date.now();
    try {
      for (;;) {
        const s = await run('step', { x, y, tol });
        if (s.done) return { pos: { x: Math.round(s.x), y: Math.round(s.y) } };
        if (hooks.aborted()) return { interrupted: 'прервано новой репликой', pos: { x: Math.round(s.x), y: Math.round(s.y) } };
        if (!last || Math.hypot(s.x - last.x, s.y - last.y) > 0.3) { last = s; lastMoved = Date.now(); }
        if (Date.now() - lastMoved > 1500 || Date.now() - start > 90_000) {
          // Упёрся в препятствие или слишком далеко: поиска пути у нас нет, переносим к цели.
          const p = await run('teleport', { x, y });
          return { pos: { x: Math.round(p.x), y: Math.round(p.y) }, note: 'дошёл не пешком: упёрся в препятствие, перенесён к цели' };
        }
        await sleep(120);
      }
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
      const result = JSON.stringify(await handler(args));
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

    def('inspect', 'Подробности об объекте в точке: рецепт, состояние, содержимое, топливо.', coords, (a) => run('inspect', a)),

    def('move_to', 'Идти в точку или к игроку-человеку. Укажи либо x и y, либо player.',
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
          if (hooks.aborted()) { reason = 'прервано новой репликой'; break; }
          if (i < a.count - 1) await sleep(1000);
        }
        return { got, stopped: reason };
      }),

    def('craft', 'Скрафтить предмет руками из инвентаря и дождаться готовности (до двух минут).',
      { recipe: z.string().describe('внутреннее имя рецепта, например iron-gear-wheel'), count: z.number().int().min(1).max(200).default(1) },
      async (a) => {
        const r = await run('craft', a);
        const start = Date.now();
        while (Date.now() - start < 120_000) {
          await sleep(500);
          const p = await run('pos');
          if (p.queue === 0) return { crafted: r.queued, asked: a.count };
          if (hooks.aborted()) return { ...r, note: 'крафт продолжается в фоне, ждать перестал из-за новой реплики' };
        }
        return { ...r, note: 'крафт ещё идёт' };
      }),

    def('place', 'Поставить постройку из инвентаря в точку. Сам подходит.',
      { item: z.string().describe('внутреннее имя предмета'), ...coords, direction: z.enum(DIRECTIONS).default('north').describe('куда смотрит постройка (для конвейеров — куда везёт, для манипулятора — куда кладёт)') },
      async (a) => { await approach(a.x, a.y, 8); return run('place', a); }),

    def('pick_up', 'Снять постройку в точке обратно в инвентарь. Сам подходит.', coords,
      async (a) => { await approach(a.x, a.y, 8); return run('pick_up', a); }),

    def('insert_items', 'Положить предметы из инвентаря в объект в точке (топливо, руду, ингредиенты). Сам подходит.',
      { ...coords, item: z.string(), count: z.number().int().min(1).default(5) },
      async (a) => { await approach(a.x, a.y, 8); return run('insert', a); }),

    def('take_items', 'Забрать предметы из объекта в точке. Без item — всё из выходного слота. Сам подходит.',
      { ...coords, item: z.string().optional(), count: z.number().int().min(1).default(1000) },
      async (a) => { await approach(a.x, a.y, 8); return run('take', a); }),

    def('set_recipe', 'Задать рецепт сборочному автомату в точке.', { ...coords, recipe: z.string() },
      async (a) => { await approach(a.x, a.y, 8); return run('set_recipe', a); }),

    def('rotate', 'Повернуть постройку в точке.', { ...coords, direction: z.enum(DIRECTIONS) },
      async (a) => { await approach(a.x, a.y, 8); return run('rotate', a); }),

    def('research', 'Показать текущее и доступные исследования; с параметром technology — поставить исследование в очередь.',
      { technology: z.string().optional() }, (a) => run('research', a)),

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
        while (Date.now() - start < a.seconds * 1000 && !hooks.aborted()) await sleep(250);
        return { waited: Math.round((Date.now() - start) / 1000) };
      }),
  ];

  tools.push(def('feedback', 'Оставить разработчикам заявку на улучшение этих инструментов: чего не хватает, что работает неудобно или неверно. Одна заявка — одна тема, с примером из практики. Заявки разбираются в фоне; читерских возможностей не добавляют.',
    { text: z.string().min(10).max(4000) },
    (a) => submitFeedback(botName, a.text)));

  if (hooks.chatTool) {
    const memo = hooks.chatTool; // { seq } — живёт дольше одного запроса
    tools.push(def('read_chat', 'Новые сообщения других ботов из игрового чата с прошлого вызова.', {}, async () => {
      const r = await run('chat', { since: memo.seq });
      memo.seq = r.seq;
      return { messages: Array.isArray(r.messages) ? r.messages : [] };
    }));
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
