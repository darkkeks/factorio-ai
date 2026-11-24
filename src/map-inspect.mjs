// Веб-карта: то, что в игре даёт вид карты (Remote View) — сведения о постройке под курсором и слои карты
// (загрязнение, электросеть, логистика, турели, станции, метки, дроны, сигналы, рецепты, трубы).
// Всё только читает игру через RCON.
import fs from 'node:fs';
import path from 'node:path';
import { makeLua } from './map-rcon.mjs';

// Запросы зрителей (клик по постройке, слои) — на своих соединениях, не в очереди за съёмкой.
const lua = makeLua('map-inspect', 3);

const LUA = {
  // Постройка в точке карты. Как в игре: только там, где чанк сейчас виден (не в тумане войны);
  // из нескольких сущностей под курсором берётся та, что с большим приоритетом выделения, затем меньшая.
  entity: `local s, f = game.surfaces[A.surface], game.forces.player
if not f.is_chunk_visible(s, {math.floor(A.x / 32), math.floor(A.y / 32)}) then return {fog=true} end
local SKIP = {smoke=true, ['smoke-with-trigger']=true, particle=true, projectile=true, explosion=true, fire=true, sticker=true,
  ['flying-text']=true, beam=true, ['highlight-box']=true, ['speech-bubble']=true, corpse=true, ['character-corpse']=true,
  ['item-request-proxy']=true, ['tile-ghost']=true, arrow=true, ['artillery-flare']=true, stream=true, ['particle-source']=true}
local function try(fn) local ok, v = pcall(fn) if ok then return v end end
local e, bp, ba
for _, c in pairs(s.find_entities_filtered{area={{A.x - 1.5, A.y - 1.5}, {A.x + 1.5, A.y + 1.5}}}) do
  local b = c.selection_box
  if not SKIP[c.type] and c.prototype.selectable_in_game and A.x >= b.left_top.x and A.x <= b.right_bottom.x and A.y >= b.left_top.y and A.y <= b.right_bottom.y then
    local pr = c.prototype.selection_priority or 50
    local ar = (b.right_bottom.x - b.left_top.x) * (b.right_bottom.y - b.left_top.y)
    if not e or pr > bp or (pr == bp and ar < ba) then e, bp, ba = c, pr, ar end
  end
end
if not e then return {none=true} end
local p = e.prototype
if e.type == 'entity-ghost' then p = e.ghost_prototype end
local b = e.selection_box
local r = {name=p.name, type=e.type, x=e.position.x, y=e.position.y, box={b.left_top.x, b.left_top.y, b.right_bottom.x, b.right_bottom.y},
  force=e.force.name, ghost=e.type == 'entity-ghost' or nil, tick=game.tick}
r.quality = try(function() return e.quality.name end)
local st = e.status
if st then for k, v in pairs(defines.entity_status) do if v == st then r.status = k end end end
if e.health then r.health = e.health r.max_health = e.max_health end
r.last_user = try(function() return e.last_user.name end)
r.belt_speed = try(function() return p.belt_speed * 480 end)
r.pollution = try(function() return (p.burner_prototype or p.electric_energy_source_prototype).emissions_per_joule.pollution * p.get_max_energy_usage(e.quality) * 3600 end)
r.max_power = try(function() return p.get_max_energy_usage(e.quality) * 60 end)
r.electric = try(function() return p.electric_energy_source_prototype ~= nil end)
if r.electric then r.energy = e.energy r.buffer = try(function() return e.electric_buffer_size end) end
r.amount = try(function() return e.type == 'resource' and e.amount or nil end)
r.backer = try(function() return e.type == 'train-stop' and e.backer_name or nil end)
r.player = try(function() return e.type == 'character' and e.player and e.player.name or nil end)
if e.type == 'character' then for n, c in pairs(storage.vb or {}) do if c == e then r.bot = n end end end
r.generated = try(function() return e.energy_generated_last_tick * 60 end)
r.speed = try(function() return e.crafting_speed end)
r.progress = try(function() return e.crafting_progress end)
r.prod = try(function() return r.speed and e.productivity_bonus or nil end)
r.finished = try(function() return e.products_finished end)
r.mining = try(function() return e.mining_target.name end)
r.mining_progress = try(function() return e.type == 'mining-drill' and e.mining_progress or nil end)
r.held = try(function() local h = e.held_stack if h.valid_for_read then return {h.name, h.count} end end)
r.temperature = try(function() return e.temperature end)
local rec = try(function() return e.get_recipe() end) or try(function() return e.previous_recipe and e.previous_recipe.name and prototypes.recipe[e.previous_recipe.name.name or e.previous_recipe.name] end)
if rec then
  local function side(l) local o = {} for _, x in pairs(l) do o[#o+1] = {x.type, x.name, x.amount or ((x.amount_min or 0) + (x.amount_max or 0)) / 2} end return o end
  r.recipe = {name=rec.name, time=rec.energy, ing=side(rec.ingredients), out=side(rec.products)}
end
local bu = e.burner
if bu then
  r.burner = {remaining=bu.remaining_burning_fuel, heat=bu.heat,
    burning=try(function() local c = bu.currently_burning return c and (c.name.name or c.name) end),
    value=try(function() local c = bu.currently_burning return c and c.name.fuel_value end)}
end
r.inv = {}
for i = 1, try(function() return e.get_max_inventory_index() end) or 0 do
  local inv = e.get_inventory(i)
  if inv and #inv > 0 then
    local c = {}
    for _, it in pairs(inv.get_contents()) do c[#c+1] = {it.name, it.count, it.quality} end
    r.inv[#r.inv+1] = {name=inv.name, size=#inv, items=c}
  end
end
local lines = try(function() return e.get_max_transport_line_index() end) or 0
if lines > 0 then
  local sum, order = {}, {}
  for i = 1, lines do for _, it in pairs(e.get_transport_line(i).get_contents()) do
    if not sum[it.name] then sum[it.name] = 0 order[#order+1] = it.name end
    sum[it.name] = sum[it.name] + it.count
  end end
  r.belt = {}
  for _, n in pairs(order) do r.belt[#r.belt+1] = {n, sum[n]} end
end
r.fluids = {}
for i = 1, try(function() return e.fluids_count end) or 0 do
  local fl = try(function() return e.get_fluid(i) end)
  local lock = try(function() return e.get_fluid_filter(i).name end)
  r.fluids[#r.fluids+1] = {name=fl and fl.name or lock, amount=fl and fl.amount or 0, temp=fl and fl.temperature, cap=try(function() return e.get_fluid_capacity(i) end)}
end
return r`,

  // Рамки выделения всех построек в видимых чанках — чтобы страница сама находила постройку под курсором, как игра.
  // Постройка относится к чанку, в котором её центр. Рамки — в 1/256 клетки (как у самой игры: та же рамка, что при клике). Руда — строкой по клетке на символ.
  // Подвижное (персонажи, роботы, техника, враги) не отдаём: оно устаревает за секунду, его выбирает клик.
  boxes: `
    local s, f, out = game.surfaces[A.surface], game.forces.player, {}
    local SKIP = {smoke=true, ['smoke-with-trigger']=true, particle=true, projectile=true, explosion=true, fire=true, sticker=true,
      ['flying-text']=true, beam=true, ['highlight-box']=true, ['speech-bubble']=true, corpse=true, ['character-corpse']=true,
      ['item-request-proxy']=true, ['tile-ghost']=true, arrow=true, ['artillery-flare']=true, stream=true, ['particle-source']=true,
      character=true, unit=true, ['spider-unit']=true, ['logistic-robot']=true, ['construction-robot']=true, ['combat-robot']=true,
      car=true, ['spider-vehicle']=true, locomotive=true, ['cargo-wagon']=true, ['fluid-wagon']=true, ['artillery-wagon']=true,
      ['item-entity']=true, fish=true, resource=true}
    local floor = math.floor
    for _, c in pairs(A.chunks) do
      local x0, y0 = c[1] * 32, c[2] * 32
      local r = false
      if f.is_chunk_charted(s, c) and f.is_chunk_visible(s, c) then
        r = {n={}, b={}}
        local idx, b = {}, r.b
        for _, e in pairs(s.find_entities_filtered{area={{x0, y0}, {x0 + 32, y0 + 32}}}) do
          local pos = e.position
          if not SKIP[e.type] and pos.x >= x0 and pos.x < x0 + 32 and pos.y >= y0 and pos.y < y0 + 32 then
            local p = e.prototype
            if p.selectable_in_game then
              local n = e.type == 'entity-ghost' and e.ghost_name or e.name
              local k = idx[n]
              if not k then k = #r.n + 1 r.n[k] = n idx[n] = k end
              local sb, m = e.selection_box, #b
              b[m+1] = k b[m+2] = floor(sb.left_top.x * 256 + 0.5) b[m+3] = floor(sb.left_top.y * 256 + 0.5)
              b[m+4] = floor(sb.right_bottom.x * 256 + 0.5) b[m+5] = floor(sb.right_bottom.y * 256 + 0.5) b[m+6] = p.selection_priority or 50
              b[m+7] = e.type == 'entity-ghost' and 1 or 0
            end
          end
        end
        local res, ridx, buf, any = {}, {}, {}, false
        for _, e in pairs(s.find_entities_filtered{area={{x0, y0}, {x0 + 32, y0 + 32}}, type='resource'}) do
          local k = ridx[e.name]
          if not k then k = #res + 1 res[k] = e.name ridx[e.name] = k end
          buf[(floor(e.position.y) - y0) * 32 + (floor(e.position.x) - x0) + 1] = k
          any = true
        end
        if any then
          local str = {}
          for i = 1, 1024 do str[i] = string.char(48 + (buf[i] or 0)) end
          r.rn = res r.r = table.concat(str)
        end
      end
      out[#out+1] = r
    end
    return out`,

  pollution: `
    local s, f, out = game.surfaces[A.surface], game.forces.player, {}
    for c in s.get_chunks() do
      if f.is_chunk_charted(s, c) then
        local v = s.get_pollution({c.x * 32 + 16, c.y * 32 + 16})
        if v > 0.5 then out[#out+1] = c.x out[#out+1] = c.y out[#out+1] = math.floor(v + 0.5) end
      end
    end
    return {chunks=out}`,

  electric: `
    local s, poles, wires = game.surfaces[A.surface], {}, {}
    local id = defines.wire_connector_id.pole_copper
    for _, e in pairs(s.find_entities_filtered{type='electric-pole', force='player'}) do
      local p, n = e.position, #poles
      poles[n+1] = p.x poles[n+2] = p.y poles[n+3] = e.prototype.get_supply_area_distance(e.quality) or 0
      local c = e.get_wire_connectors(false)[id]
      if c then for _, w in pairs(c.connections) do
        local o = w.target.owner
        if o.valid and o.surface == s and (o.unit_number or 0) > e.unit_number then
          local q, m = o.position, #wires
          wires[m+1] = p.x wires[m+2] = p.y wires[m+3] = q.x wires[m+4] = q.y
        end
      end end
    end
    return {poles=poles, wires=wires}`,

  logistics: `
    local s, out = game.surfaces[A.surface], {}
    for _, e in pairs(s.find_entities_filtered{type='roboport', force='player'}) do
      local c = e.logistic_cell
      if c then local p, n = e.position, #out out[n+1] = p.x out[n+2] = p.y out[n+3] = c.logistic_radius out[n+4] = c.construction_radius end
    end
    return {ports=out}`,

  turrets: `
    local s, out = game.surfaces[A.surface], {}
    for _, e in pairs(s.find_entities_filtered{type={'ammo-turret', 'electric-turret', 'fluid-turret'}, force='player'}) do
      local a = e.prototype.attack_parameters
      if a then local p, n = e.position, #out out[n+1] = p.x out[n+2] = p.y out[n+3] = a.range end
    end
    return {turrets=out}`,

  stations: `
    local s, out = game.surfaces[A.surface], {}
    for _, e in pairs(s.find_entities_filtered{type='train-stop', force='player'}) do
      out[#out+1] = {e.position.x, e.position.y, e.backer_name}
    end
    return {stops=out}`,

  tags: `
    local out = {}
    for _, t in pairs(game.forces.player.find_chart_tags(game.surfaces[A.surface])) do
      local i = t.icon
      out[#out+1] = {t.position.x, t.position.y, t.text or '', i and (i.type or 'item') or '', i and i.name or ''}
    end
    return {tags=out}`,

  robots: `
    local s, out = game.surfaces[A.surface], {}
    for _, e in pairs(s.find_entities_filtered{type={'logistic-robot', 'construction-robot'}, force='player'}) do
      local p, n = e.position, #out
      out[n+1] = math.floor(p.x * 4 + 0.5) / 4 out[n+2] = math.floor(p.y * 4 + 0.5) / 4 out[n+3] = e.type == 'logistic-robot' and 1 or 0
    end
    return {robots=out}`,

  signals: `
    local s, out = game.surfaces[A.surface], {}
    for _, e in pairs(s.find_entities_filtered{type={'rail-signal', 'rail-chain-signal'}, force='player'}) do
      local p, n = e.position, #out
      out[n+1] = p.x out[n+2] = p.y out[n+3] = e.signal_state
    end
    return {signals=out, states={open=defines.signal_state.open, closed=defines.signal_state.closed, reserved=defines.signal_state.reserved}}`,

  recipes: `
    local s, out = game.surfaces[A.surface], {}
    for _, e in pairs(s.find_entities_filtered{type={'assembling-machine', 'furnace', 'rocket-silo'}, force='player'}) do
      local ok, r = pcall(function() return e.get_recipe() end)
      if not ok or not r then
        ok, r = pcall(function() local pr = e.previous_recipe return pr and prototypes.recipe[pr.name.name or pr.name] end)
        if not ok then r = nil end
      end
      if r then
        local m = r.products[1]
        pcall(function() m = (r.object_name == 'LuaRecipe' and r.prototype or r).main_product or m end)
        if m then local b = e.bounding_box out[#out+1] = {e.position.x, e.position.y, math.min(b.right_bottom.x - b.left_top.x, b.right_bottom.y - b.left_top.y), m.name} end
      end
    end
    return {machines=out}`,

  pipes: `
    local s, out, links, colors = game.surfaces[A.surface], {}, {}, {}
    for _, e in pairs(s.find_entities_filtered{type={'pipe', 'pipe-to-ground', 'storage-tank', 'pump', 'infinity-pipe'}, force='player'}) do
      local ok, fl = pcall(function() return e.get_fluid(1) end)
      local name = ok and fl and fl.name or ''
      if name ~= '' and not colors[name] then local c = prototypes.fluid[name].base_color colors[name] = {c.r, c.g, c.b} end
      local b = e.bounding_box
      out[#out+1] = {b.left_top.x, b.left_top.y, b.right_bottom.x, b.right_bottom.y, name}
      if e.type == 'pipe-to-ground' then
        local ok2, cs = pcall(function() return e.get_fluid_box_pipe_connections(1) end)
        for _, c in pairs(ok2 and cs or {}) do
          local t = c.target
          if c.connection_type == 'underground' and t and t.valid and (t.unit_number or 0) > e.unit_number then
            links[#links+1] = {e.position.x, e.position.y, t.position.x, t.position.y, name}
          end
        end
      end
    end
    return {pipes=out, links=links, colors=colors}`,
};

// Как часто перечитывать слой, пока на него кто-то смотрит.
const TTL = { robots: 2000, signals: 2000 };
const DEFAULT_TTL = 5000;
export const LAYERS = ['logistics', 'electric', 'turrets', 'pollution', 'stations', 'tags', 'robots', 'signals', 'recipes', 'pipes'];

const cache = new Map(); // слой -> { at, data, pending }
/** Данные слоя карты; одновременные запросы зрителей делят один запрос к игре. */
export async function layer(name, surface) {
  let c = cache.get(name);
  if (!c) cache.set(name, c = { at: 0, data: null, pending: null });
  if (c.data && Date.now() - c.at < (TTL[name] || DEFAULT_TTL)) return c.data;
  c.pending ??= lua(LUA[name], { surface }).then((d) => { c.data = d; c.at = Date.now(); return d; }).finally(() => { c.pending = null; });
  try { return await c.pending; } catch (e) { if (c.data) return c.data; throw e; }
}

/** Рамки выделения в чанках [[cx, cy], …]; для чанка вне видимости — false. */
export function boxes(chunks, surface) { return lua(LUA.boxes, { surface, chunks }); }

const entCache = new Map(); // "x,y" -> { at, p }
/** Постройка в точке карты (с точностью до 1/8 клетки); ответ живёт 200 мс. */
export function entityAt(x, y, surface) {
  x = Math.round(x * 8) / 8; y = Math.round(y * 8) / 8;
  const k = `${x},${y}`, now = Date.now();
  for (const [key, v] of entCache) if (now - v.at > 200) entCache.delete(key);
  let c = entCache.get(k);
  if (!c) { c = { at: now, p: lua(LUA.entity, { surface, x, y }) }; c.p.catch(() => {}); entCache.set(k, c); }
  return c.p;
}

/** Разделы файлов перевода игры: { раздел: { ключ: строка } }. Строки с подстановками (__1__) пропускаются. */
export function loadLocale(dataDir, lang, sections) {
  const out = Object.fromEntries(sections.map((s) => [s, {}]));
  let mods = [];
  try { mods = fs.readdirSync(dataDir); } catch { return out; }
  for (const mod of mods) {
    const dir = path.join(dataDir, mod, 'locale', lang);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.cfg')); } catch { continue; }
    for (const f of files) {
      let section = '';
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        const s = line.match(/^\[(.+)\]\s*$/);
        if (s) { section = s[1]; continue; }
        const m = out[section] && line.match(/^([^=;#]+)=(.+)$/);
        if (m && !/__\d|__[A-Z]/.test(m[2])) out[section][m[1].trim()] ??= m[2].trim();
      }
    }
  }
  return out;
}
