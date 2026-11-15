-- Слежение за ботами для людей — средствами интерфейса игры (без отдельных клиентов для ботов):
--   кнопка «Боты» слева вверху → список: имя, чем занят, очередь, здоровье;
--   «Следить» — карта человека переходит в удалённый обзор и едет за персонажем бота;
--   «Окно» — небольшое окно-камера поверх игры, можно открыть несколько;
--   метки на карте с именами ботов; по желанию человека — действие над головой бота и линия до цели ходьбы.
local U = require('agent.util')

local G = {handlers = {}}

local ACTIONS = {walk_to = 'идёт', mine = 'добывает', place = 'строит', build_ghosts = 'строит по плану', transfer = 'перекладывает',
  configure = 'настраивает', wait = 'ждёт', craft = 'крафтит', say = 'говорит', research = 'исследования'}
local TAG_EVERY = 120
local TEXT_COLOR = {0.8, 0.9, 1}
local LINE_COLOR = {0.4, 0.8, 1, 0.6}

function G.init(st)
  st.gui = st.gui or {players = {}, tags = {}, overlay = {}}
end

local function pstate(index)
  local g = storage.agent.gui
  local s = g.players[index]
  if not s then
    s = {overlay = false, cams = 0}
    g.players[index] = s
  end
  return s
end

local function sorted_agents()
  local list = {}
  for name, A in pairs(storage.agent.agents) do list[#list + 1] = A end
  table.sort(list, function(a, b) return a.name < b.name end)
  return list
end

--- Чем занят бот — короткой строкой.
function G.describe(A)
  local e = A.entity
  if not (e and e.valid) then return 'нет персонажа' end
  local act = A.queue[1]
  local text
  if act then
    text = ACTIONS[act.type] or act.type
    local st = act.st
    if st then
      local w = st.w
      if w and w.goal then text = text .. ' → ' .. math.floor(w.goal.x) .. ', ' .. math.floor(w.goal.y) end
      if st.items then
        local done = 0
        for _, it in ipairs(st.items) do if it.state then done = done + 1 end end
        text = text .. ' ' .. done .. '/' .. #st.items
      end
    end
    if #A.queue > 1 then text = text .. ' (+' .. (#A.queue - 1) .. ')' end
  elseif e.crafting_queue_size > 0 then
    text = 'крафтит'
  else
    text = 'свободен'
  end
  return text
end

-- ── Кнопка и список ──
local function ensure_button(player)
  local top = player.gui.top
  if not top.agent_toggle then
    top.add{type = 'button', name = 'agent_toggle', caption = 'Боты', tooltip = 'Список ботов: чем заняты, следить, окно-камера'}
  end
end

local function fill_list(player)
  local frame = player.gui.left.agent_list
  if not frame then return end
  local agents = sorted_agents()
  local t = frame.agent_table
  -- Таблица пересобирается, когда меняется состав ботов.
  if not t or t.tags.count ~= #agents then
    if t then t.destroy() end
    t = frame.add{type = 'table', name = 'agent_table', column_count = 5, tags = {count = #agents}}
    for i, A in ipairs(agents) do
      t.add{type = 'label', name = 'n' .. i, caption = A.name, style = 'caption_label'}
      local l = t.add{type = 'label', name = 'a' .. i, caption = ''}
      l.style.minimal_width = 170
      t.add{type = 'label', name = 'h' .. i, caption = ''}
      t.add{type = 'button', name = 'f' .. i, caption = 'Следить', tags = {agent_do = 'follow', agent = A.name},
        tooltip = 'Карта поедет за ботом. Выйти из обзора — Esc.'}
      t.add{type = 'button', name = 'c' .. i, caption = 'Окно', tags = {agent_do = 'camera', agent = A.name},
        tooltip = 'Окно-камера поверх игры'}
    end
  end
  for i, A in ipairs(agents) do
    local e = A.entity
    local alive = e and e.valid
    t['n' .. i].caption = A.name
    t['a' .. i].caption = G.describe(A)
    t['h' .. i].caption = alive and (math.floor(e.health) .. ' hp') or '—'
    t['f' .. i].enabled = alive and true or false
    t['c' .. i].enabled = alive and true or false
    t['f' .. i].tags = {agent_do = 'follow', agent = A.name}
    t['c' .. i].tags = {agent_do = 'camera', agent = A.name}
  end
end

local function toggle_list(player)
  local left = player.gui.left
  if left.agent_list then
    left.agent_list.destroy()
    return
  end
  local frame = left.add{type = 'frame', name = 'agent_list', caption = 'Боты', direction = 'vertical'}
  frame.add{type = 'checkbox', name = 'agent_overlay', caption = 'Показывать действия и цели ходьбы на карте',
    state = pstate(player.index).overlay}
  fill_list(player)
end

-- ── Окно-камера ──
local function open_camera(player, A)
  local e = A.entity
  if not (e and e.valid) then return end
  local s = pstate(player.index)
  s.cams = s.cams + 1
  local name = 'agent_cam_' .. s.cams
  local frame = player.gui.screen.add{type = 'frame', name = name, direction = 'vertical', tags = {agent_cam = A.name}}
  frame.location = {460 + (s.cams % 5) * 30, 60 + (s.cams % 5) * 30}
  local bar = frame.add{type = 'flow', direction = 'horizontal'}
  bar.drag_target = frame
  local title = bar.add{type = 'label', caption = A.name, style = 'frame_title', ignored_by_interaction = true}
  local filler = bar.add{type = 'empty-widget', style = 'draggable_space_header', ignored_by_interaction = true}
  filler.style.horizontally_stretchable = true
  filler.style.height = 24
  bar.add{type = 'button', caption = '−', tags = {agent_do = 'zoom', delta = -1}, tooltip = 'Дальше', style = 'tool_button'}
  bar.add{type = 'button', caption = '+', tags = {agent_do = 'zoom', delta = 1}, tooltip = 'Ближе', style = 'tool_button'}
  bar.add{type = 'sprite-button', sprite = 'utility/close', style = 'frame_action_button', tags = {agent_do = 'close'}, tooltip = 'Закрыть'}
  local cam = frame.add{type = 'camera', name = 'cam', position = e.position, surface_index = e.surface.index, zoom = 0.5}
  cam.style.width = 360
  cam.style.height = 260
  cam.entity = e
  frame.add{type = 'label', name = 'what', caption = G.describe(A)}
end

local function window_of(element)
  local el = element
  while el and el.valid do
    if el.tags and el.tags.agent_cam then return el end
    el = el.parent
  end
end

G.handlers[defines.events.on_gui_click] = function(ev)
  local el = ev.element
  if not (el and el.valid) then return end
  local player = game.get_player(ev.player_index)
  if el.name == 'agent_toggle' then
    toggle_list(player)
    return
  end
  local tags = el.tags
  local what = tags and tags.agent_do
  if not what then return end
  if what == 'follow' or what == 'camera' then
    local A = storage.agent.agents[tags.agent]
    if not (A and A.entity and A.entity.valid) then return end
    if what == 'follow' then player.centered_on = A.entity else open_camera(player, A) end
  elseif what == 'close' then
    local w = window_of(el)
    if w then w.destroy() end
  elseif what == 'zoom' then
    local w = window_of(el)
    if w and w.cam then
      local z = w.cam.zoom * (tags.delta > 0 and 1.4 or 1 / 1.4)
      w.cam.zoom = math.max(0.1, math.min(3, z))
    end
  end
end

G.handlers[defines.events.on_gui_checked_state_changed] = function(ev)
  local el = ev.element
  if not (el and el.valid) or el.name ~= 'agent_overlay' then return end
  pstate(ev.player_index).overlay = el.state
  G.sync_overlay()
end

G.handlers[defines.events.on_player_created] = function(ev)
  ensure_button(game.get_player(ev.player_index))
end
G.handlers[defines.events.on_player_joined_game] = function(ev)
  ensure_button(game.get_player(ev.player_index))
end

--- Кнопка у всех уже существующих игроков (после замены сценария в сохранении).
function G.setup_players()
  for _, p in pairs(game.players) do ensure_button(p) end
end

-- ── Действие над головой и линия до цели: видны тем, кто включил галочку ──
function G.sync_overlay()
  local st = storage.agent
  local viewers = {}
  for index, s in pairs(st.gui.players) do
    local p = game.get_player(index)
    if s.overlay and p and p.connected then viewers[#viewers + 1] = p end
  end
  local ov = st.gui.overlay
  for name, A in pairs(st.agents) do
    local e = A.entity
    local o = ov[name]
    if not (e and e.valid) or #viewers == 0 then
      if o then
        if o.text and o.text.valid then o.text.destroy() end
        if o.line and o.line.valid then o.line.destroy() end
        ov[name] = nil
      end
    else
      if not o then
        o = {}
        ov[name] = o
      end
      local text = G.describe(A)
      if not (o.text and o.text.valid) or o.unit ~= e.unit_number then
        if o.text and o.text.valid then o.text.destroy() end
        o.text = rendering.draw_text{text = text, target = {entity = e, offset = {0, -3.3}}, surface = e.surface, color = TEXT_COLOR,
          alignment = 'center', scale = 1, players = viewers}
        o.unit = e.unit_number
      else
        o.text.text = text
        o.text.players = viewers
      end
      local act = A.queue[1]
      local w = act and act.st and act.st.w
      if w and w.goal then
        if o.line and o.line.valid then
          o.line.to = w.goal
          o.line.players = viewers
        else
          o.line = rendering.draw_line{from = e, to = w.goal, surface = e.surface, color = LINE_COLOR, width = 2,
            dash_length = 0.4, gap_length = 0.3, players = viewers}
        end
      elseif o.line then
        if o.line.valid then o.line.destroy() end
        o.line = nil
      end
    end
  end
end

-- ── Метки на карте: подвижная метка с именем у каждого бота ──
local function sync_tags()
  local st = storage.agent
  local tags = st.gui.tags
  for name, A in pairs(st.agents) do
    local e = A.entity
    local t = tags[name]
    if not (e and e.valid) then
      if t and t.tag and t.tag.valid then t.tag.destroy() end
      tags[name] = nil
    else
      local pos = e.position
      if not t or not (t.tag and t.tag.valid) or U.dist(pos, t) > 3 or t.surface ~= e.surface.index then
        if t and t.tag and t.tag.valid then t.tag.destroy() end
        local tag = e.force.add_chart_tag(e.surface, {position = pos, text = name, icon = {type = 'virtual', name = 'signal-info'}})
        tags[name] = {tag = tag, x = pos.x, y = pos.y, surface = e.surface.index}
      end
    end
  end
  for name, t in pairs(tags) do
    if not st.agents[name] then
      if t.tag and t.tag.valid then t.tag.destroy() end
      tags[name] = nil
    end
  end
end

--- Открыть человеку список, окно-камеру или слежение (то же, что его нажатия; для администратора и проверок).
function G.show(player, what, A)
  ensure_button(player)
  if what == 'list' then
    if not player.gui.left.agent_list then toggle_list(player) end
  elseif what == 'overlay' then
    pstate(player.index).overlay = true
    if player.gui.left.agent_list then player.gui.left.agent_list.agent_overlay.state = true end
    G.sync_overlay()
  elseif what == 'camera' then
    open_camera(player, A)
  elseif what == 'follow' then
    player.centered_on = A.entity
  end
end

--- Раз в полсекунды: обновить открытые списки, окна-камеры, надписи; раз в две секунды — метки на карте.
function G.tick(tick)
  local st = storage.agent
  for _, p in pairs(game.connected_players) do
    if p.gui.left.agent_list then fill_list(p) end
    for _, w in pairs(p.gui.screen.children) do
      local name = w.tags and w.tags.agent_cam
      if name then
        local A = st.agents[name]
        local e = A and A.entity
        if e and e.valid then
          if w.cam.entity ~= e then w.cam.entity = e end
          w.what.caption = G.describe(A)
        else
          w.what.caption = 'нет персонажа'
        end
      end
    end
  end
  if next(st.gui.overlay) or next(st.gui.players) then G.sync_overlay() end
  if tick % TAG_EVERY == 0 then sync_tags() end
end

return G
