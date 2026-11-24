-- Карта для операции area: символ на клетку с постоянными обозначениями (легенда — в help, раздел area.legend).
-- Ленты и манипуляторы — стрелками направления, машины — рамкой по размеру с кодом рецепта в центре, статусом из игры
-- в углу и патрубками (буква жидкости: строчная — вход, заглавная — выход) на рамке. Враги и персонажи на карту не
-- рисуются: они не часть клетки (их дают objects и enemies). Коды рецептов постоянные для карты (storage.map_codes).
local M = {}

local STN = {}
for name, v in pairs(defines.entity_status) do STN[v] = name end

local function try(fn)
  local ok, v = pcall(fn)
  if ok then return v end
  return nil
end

-- ── коды рецептов ──
local FIXED = {
  ['automation-science-pack'] = 'R', ['logistic-science-pack'] = 'G', ['military-science-pack'] = 'M', ['chemical-science-pack'] = 'B',
  ['production-science-pack'] = 'P', ['utility-science-pack'] = 'Y', ['space-science-pack'] = 'W',
  ['iron-plate'] = 'I', ['copper-plate'] = 'C', ['steel-plate'] = 'S', ['stone-brick'] = 'K', ['iron-gear-wheel'] = 'g', ['copper-cable'] = 'c',
  ['electronic-circuit'] = 'e', ['advanced-circuit'] = 'a', ['processing-unit'] = 'p', ['inserter'] = 'i', ['transport-belt'] = 'b',
  ['pipe'] = 'l', ['engine-unit'] = 'n', ['electric-engine-unit'] = 'E', ['plastic-bar'] = 'L', ['sulfur'] = 'u', ['battery'] = 'V',
  ['firearm-magazine'] = 'm', ['piercing-rounds-magazine'] = 'N', ['basic-oil-processing'] = 'O', ['advanced-oil-processing'] = 'A',
  ['heavy-oil-cracking'] = 'H', ['light-oil-cracking'] = 'J', ['lubricant'] = 'U', ['sulfuric-acid'] = 'Q', ['rocket-fuel'] = 'F',
  ['low-density-structure'] = 'D', ['flying-robot-frame'] = 'r', ['solid-fuel-from-light-oil'] = 'f', ['iron-stick'] = 's', ['rail'] = 'T',
}
M.FIXED = FIXED
local POOL = {}
for _, ch in ipairs({'Z', 'X', 'v', 'k', 'd', 'h', 'j', 'q', 't', 'w', 'x', 'y', 'z', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  'α', 'β', 'γ', 'δ', 'ε', 'ζ', 'η', 'θ', 'κ', 'λ', 'μ', 'ν', 'ξ', 'π', 'ρ', 'σ', 'τ', 'φ', 'χ', 'ψ', 'ω',
  'Б', 'Г', 'Д', 'Ж', 'З', 'И', 'Л', 'П', 'Ф', 'Ц', 'Ч', 'Ш', 'Э', 'Ю', 'Я', 'б', 'в', 'г', 'д', 'ж', 'з', 'и', 'к', 'л', 'м', 'н', 'п',
  'т', 'ф', 'ц', 'ч', 'ш', 'щ', 'э', 'ю', 'я', 'Ω', 'Σ', 'Π', 'Φ', 'Ψ', 'Λ', 'Θ', 'Δ', 'Γ', 'Ξ'}) do POOL[#POOL + 1] = ch end
local FIXED_SET = {}
for _, c in pairs(FIXED) do FIXED_SET[c] = true end

local function codes()
  storage.map_codes = storage.map_codes or {by_recipe = {}, taken = {}}
  return storage.map_codes
end

--- Код рецепта; новый выдаётся один раз на карту и записывается в fresh[рецепт] = код.
function M.code(rc, fresh)
  local C = codes()
  local c = C.by_recipe[rc]
  if c then return c end
  local f = FIXED[rc]
  if f and not C.taken[f] then c = f
  else
    for _, ch in ipairs(POOL) do
      if not C.taken[ch] and not FIXED_SET[ch] then c = ch break end
    end
    c = c or '?'
  end
  C.by_recipe[rc] = c
  if c ~= '?' then C.taken[c] = rc end
  if fresh then fresh[rc] = c end
  return c
end

function M.all_codes()
  local out = {}
  for rc, c in pairs(codes().by_recipe) do out[c] = rc end
  return out
end

-- ── мелкие постройки ──
local DIR = {[0] = 'n', [4] = 'e', [8] = 's', [12] = 'w'}
local ARROW = {n = '↑', e = '→', s = '↓', w = '←'}
local FAST = {n = '⇧', e = '⇨', s = '⇩', w = '⇦'}
local UG_IN = {n = '△', e = '▷', s = '▽', w = '◁'}
local UG_OUT = {n = '▲', e = '▶', s = '▼', w = '◀'}
local SPL = {n = '⇈', e = '⇉', s = '⇊', w = '⇇'}
local INS = {
  inserter = {n = '⇡', e = '⇢', s = '⇣', w = '⇠'},
  ['fast-inserter'] = {n = '↟', e = '↠', s = '↡', w = '↞'},
  ['long-handed-inserter'] = {n = '⇑', e = '⇒', s = '⇓', w = '⇐'},
  ['burner-inserter'] = {n = '↥', e = '↦', s = '↧', w = '↤'},
  ['bulk-inserter'] = {n = '⤊', e = '⇛', s = '⤋', w = '⇚'},
  ['stack-inserter'] = {n = '⤊', e = '⇛', s = '⤋', w = '⇚'},
}
local SMALL = {
  ['small-electric-pole'] = '+', ['medium-electric-pole'] = '╋', ['iron-chest'] = '■', ['wooden-chest'] = '□', ['steel-chest'] = '▣',
  ['storage-chest'] = '◫', ['passive-provider-chest'] = '◧', ['active-provider-chest'] = '◪', ['requester-chest'] = '◨', ['buffer-chest'] = '◩',
  ['stone-wall'] = '▓', gate = '▒', ['small-lamp'] = '*', ['rail-signal'] = 'ı', ['rail-chain-signal'] = 'ǐ',
  ['pipe-to-ground'] = '╪', pump = '⊕',
}
local SMALL_TYPE = {container = '■', ['logistic-container'] = '◫', wall = '▓', gate = '▒', lamp = '*', ['rail-signal'] = 'ı',
  ['rail-chain-signal'] = 'ǐ', ['pipe-to-ground'] = '╪', pump = '⊕', ['electric-pole'] = '+', tree = '♣', cliff = '‡',
  ['simple-entity'] = '◆', ['arithmetic-combinator'] = '◊', ['decider-combinator'] = '◊', ['constant-combinator'] = '◊',
  ['selector-combinator'] = '◊', ['power-switch'] = '◊', ['programmable-speaker'] = '◊', loader = '▭', ['loader-1x1'] = '▭',
  ['linked-belt'] = '⊶', ['heat-pipe'] = '≡', ['infinity-container'] = '■', ['infinity-pipe'] = '╬'}
local RAIL = {['straight-rail'] = true, ['curved-rail-a'] = true, ['curved-rail-b'] = true, ['half-diagonal-rail'] = true,
  ['legacy-straight-rail'] = true, ['legacy-curved-rail'] = true, ['elevated-straight-rail'] = true, ['elevated-curved-rail-a'] = true,
  ['elevated-curved-rail-b'] = true, ['elevated-half-diagonal-rail'] = true, ['rail-ramp'] = true, ['rail-support'] = true}

-- ── рамки ──
local FRAME = {
  ['assembling-machine'] = {'┌', '─', '┐', '│', '└', '┘'}, furnace = {'╔', '═', '╗', '║', '╚', '╝'},
  ['chemical-plant'] = {'╭', '─', '╮', '│', '╰', '╯'}, ['oil-refinery'] = {'┏', '━', '┓', '┃', '┗', '┛'},
  ['mining-drill'] = {'┌', '┄', '┐', '┆', '└', '┘'}, lab = {'╓', '─', '╖', '║', '╙', '╜'},
  roboport = {'┏', '━', '┓', '┃', '┗', '┛'}, ['rocket-silo'] = {'┏', '━', '┓', '┃', '┗', '┛'},
}
local PLAIN = {'┌', '─', '┐', '│', '└', '┘'}
local LABEL = {['ammo-turret'] = '¤', ['electric-turret'] = '¤', ['fluid-turret'] = '¤', ['artillery-turret'] = '¤', turret = '¤',
  ['electric-pole'] = '⊞', roboport = '⌂', ['storage-tank'] = '◍', boiler = 'ß', generator = '≋', beacon = '✦', radar = '◉',
  ['rocket-silo'] = '⇮', accumulator = '▤', ['solar-panel'] = '▦', ['offshore-pump'] = '⊓', reactor = '☢', ['heat-exchanger'] = 'ß',
  ['burner-generator'] = '≋', ['mining-drill'] = '⊥', lab = 'Λ', ['cargo-wagon'] = 'W', locomotive = 'W', container = '■',
  ['logistic-container'] = '◫'}
-- Статус — значком (не буквой: буквы на карте — руда, коды рецептов и жидкости).
local ST = {no_power = 'ϟ', low_power = 'ϟ', no_fuel = 'ϟ', no_ingredients = '∅', item_ingredient_shortage = '∅',
  fluid_ingredient_shortage = '∅', full_output = '▪', waiting_for_space_in_destination = '▪', no_recipe = '?',
  no_minable_resources = '†', missing_science_packs = '∅', no_research_in_progress = '?', disabled = '-', disabled_by_script = '-',
  marked_for_deconstruction = '×', no_input_fluid = '∅', waiting_for_target_to_be_built = '?'}
local FLUID = {water = 'w', ['crude-oil'] = 'o', ['heavy-oil'] = 'h', ['light-oil'] = 'l', ['petroleum-gas'] = 'g', lubricant = 'u',
  ['sulfuric-acid'] = 'a', steam = 's'}
local ORE = {['iron-ore'] = 'f', ['copper-ore'] = 'u', coal = 'k', stone = 's', ['uranium-ore'] = 'y', ['crude-oil'] = 'o'}
M.ORE = ORE

local function dir4(d) return DIR[d - d % 4] or 'n' end

local function axis(dx, dy)
  if math.abs(dx) > math.abs(dy) then return dx > 0 and 'e' or 'w' end
  return dy > 0 and 's' or 'n'
end

local PIPE = {['nsew'] = '╬', ns = '║', ew = '═', ne = '╚', nw = '╝', se = '╔', sw = '╗', nse = '╠', nsw = '╣', sew = '╦', new = '╩',
  n = '║', s = '║', e = '═', w = '═', [''] = '╬'}

local function pipe_glyph(e)
  local seen = {}
  local p = e.position
  for _, nb in pairs(try(function() return e.get_fluid_box_neighbours(1) end) or {}) do
    local o = nb.entity or nb
    if o and o.valid then
      -- соседняя крупная машина: сторона — по ближайшей точке её коробки
      local bb = o.bounding_box
      local cx = math.max(bb.left_top.x, math.min(p.x, bb.right_bottom.x))
      local cy = math.max(bb.left_top.y, math.min(p.y, bb.right_bottom.y))
      seen[axis(cx - p.x, cy - p.y)] = true
    end
  end
  local k = (seen.n and 'n' or '') .. (seen.s and 's' or '') .. (seen.e and 'e' or '') .. (seen.w and 'w' or '')
  return PIPE[k] or '╬'
end

-- Имя прототипа из строки, прототипа (userdata) или пары {name, quality}: всегда строка или nil.
local function proto_name(x)
  for _ = 1, 3 do
    if x == nil or type(x) == 'string' then return x end
    x = try(function() return x.name end)
  end
  return type(x) == 'string' and x or nil
end

local function recipe_name(e)
  local r = proto_name(try(function() return e.get_recipe() end))
  if r then return r end
  if e.type == 'furnace' then return proto_name(try(function() return e.previous_recipe end)) end
  return nil
end

--- Символы постройки c: вызывает paint(x, y, ch, over) по клеткам. info: {fresh = коды, выданные этим вызовом,
--- live = true, если постройка видна вживую (статус показываем только тогда), w, h — размер с учётом поворота}.
function M.draw(c, t, info, paint)
  local ghost = t == 'entity-ghost'
  local name = ghost and c.ghost_name or c.name
  local ty = ghost and c.ghost_type or t
  local pos = c.position
  local w, h = info.w, info.h
  local x0, y0 = math.floor(pos.x - w / 2 + 0.01), math.floor(pos.y - h / 2 + 0.01)
  local d = dir4(c.direction or 0)
  local ch
  if ty == 'transport-belt' then ch = (name == 'transport-belt' and ARROW or FAST)[d]
  elseif ty == 'underground-belt' then
    local bt = try(function() return c.belt_to_ground_type end)
    ch = (bt == 'output' and UG_OUT or UG_IN)[d]
  elseif ty == 'splitter' or ty == 'lane-splitter' then ch = SPL[d]
  elseif ty == 'inserter' then
    local pp, dp = try(function() return c.pickup_position end), try(function() return c.drop_position end)
    local set = INS[name] or INS.inserter
    ch = (pp and dp) and set[axis(dp.x - pp.x, dp.y - pp.y)] or set[d]
  elseif ty == 'pipe' then ch = ghost and '╬' or pipe_glyph(c)
  elseif RAIL[ty] then
    ch = (ty == 'straight-rail' or ty == 'legacy-straight-rail') and ((d == 'e' or d == 'w') and '=' or '‖') or '≈'
    for i = 0, w - 1 do for j = 0, h - 1 do paint(x0 + i, y0 + j, ch, false) end end
    return
  elseif ty == 'tree' or ty == 'simple-entity' or ty == 'cliff' then ch = SMALL_TYPE[ty]   -- природа любого размера — заливкой
  elseif w == 1 and h == 1 then ch = SMALL[name] or SMALL_TYPE[ty] or '•'
  end
  if ch then
    if ghost then ch = '◌' end
    for i = 0, w - 1 do for j = 0, h - 1 do paint(x0 + i, y0 + j, ch, true) end end
    return
  end
  -- крупная постройка: рамка
  local kind = (name == 'chemical-plant' or name == 'oil-refinery') and name or ty
  local f = FRAME[kind] or PLAIN
  local lab
  if ty == 'assembling-machine' or ty == 'furnace' or ty == 'rocket-silo' then
    local rc = recipe_name(c)
    lab = rc and M.code(rc, info.fresh) or (ty == 'rocket-silo' and '⇮' or '?')
  else lab = LABEL[ty] or '•' end
  local stc
  if info.live and not ghost then
    local s = try(function() return c.status end)
    s = s and STN[s]
    if s and s ~= 'working' and s ~= 'normal' and s ~= 'waiting_for_source_items' then stc = ST[s] end
  end
  local cx, cy = math.floor(w / 2), math.floor(h / 2)
  if w == 2 and h == 2 then cx, cy = 0, 0 end
  if ghost then   -- призрак крупной постройки: заливка ░ с кодом, без рамки
    for i = 0, w - 1 do for j = 0, h - 1 do paint(x0 + i, y0 + j, (i == cx and j == cy) and lab or '░', true) end end
    return
  end
  for i = 0, w - 1 do
    for j = 0, h - 1 do
      local l, r, tp, bt = i == 0, i == w - 1, j == 0, j == h - 1
      local g
      if w == 1 or h == 1 then g = lab
      elseif i == cx and j == cy then g = lab
      elseif tp and l then g = f[1] elseif tp and r then g = f[3] elseif bt and l then g = f[5] elseif bt and r then g = f[6]
      elseif tp or bt then g = f[2] elseif l or r then g = f[4]
      else g = ' ' end
      paint(x0 + i, y0 + j, g, true)
    end
  end
  -- патрубки
  local ports = {}
  local n = try(function() return c.fluids_count end) or 0
  if n > 0 and ty ~= 'storage-tank' then
    for i = 1, n do
      local flt = try(function() return c.get_fluid_filter(i) end)
      local fl = proto_name(flt)
      if not fl then fl = proto_name(try(function() return c.get_fluid(i) end)) end
      for _, pc in pairs(try(function() return c.get_fluid_box_pipe_connections(i) end) or {}) do
        local px, py = math.floor(pc.position.x), math.floor(pc.position.y)
        local g = FLUID[fl or ''] or '?'
        if pc.flow_direction == 'output' then g = g:upper() end
        paint(px, py, g, true)
        ports[px * 65536 + py] = true
      end
    end
  end
  -- статус: правый верхний угол, если там патрубок — первая свободная клетка рамки (углы, затем стороны)
  if stc and (w > 1 and h > 1) then
    local cand = {{x0 + w - 1, y0}, {x0, y0}, {x0 + w - 1, y0 + h - 1}, {x0, y0 + h - 1}}
    for i = 1, w - 2 do cand[#cand + 1] = {x0 + i, y0} cand[#cand + 1] = {x0 + i, y0 + h - 1} end
    for j = 1, h - 2 do cand[#cand + 1] = {x0, y0 + j} cand[#cand + 1] = {x0 + w - 1, y0 + j} end
    for _, cc in ipairs(cand) do
      if not ports[cc[1] * 65536 + cc[2]] and not (w == 2 and h == 2 and cc[1] == x0 and cc[2] == y0) then paint(cc[1], cc[2], stc, true) break end
    end
  end
end

return M
