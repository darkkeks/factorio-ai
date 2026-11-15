-- Перенос состояния старой системы (Lua через RCON из src/factorio.mjs) при первом запуске на существующей карте.
--   storage.vb          — персонажи ботов (имя → сущность): принимаются с инвентарём и позицией;
--   storage.vb_ghost    — именованные планы призраков; storage.vb_ghost_done — завершённые планы;
--   storage.vb_marks    — пометки на снос, поставленные ботами;
--   storage.vb_tpl      — шаблоны построек: переводятся в общие чертежи команды;
--   остальное (vb_until, vb_path, vb_dm, vb_pm, vb_rot, vb_ev, vb_dead) — служебное, новой системе не нужно.
-- storage.vb и storage.vb_chat остаются: их читают веб-карта и хозяин сессий, мод держит их в актуальном виде.
local Plans = require('agent.plans')
local BP = require('agent.blueprints')

local L = {}

function L.plans(st)
  local report = {plans = 0, ghosts = 0, done = 0, marks = 0, blueprints = 0, blueprint_errors = {}}
  for name, pl in pairs(storage.vb_ghost or {}) do
    local n = 0
    for _, g in pairs(pl.ents or {}) do
      if g.valid and (g.type == 'entity-ghost' or g.type == 'tile-ghost') then
        Plans.remember(g, name, pl.by)
        n = n + 1
      end
    end
    if n > 0 then
      report.plans = report.plans + 1
      report.ghosts = report.ghosts + n
    end
  end
  for name, d in pairs(storage.vb_ghost_done or {}) do
    if not st.plans[name] then
      st.plans[name] = {by = d.by, tick = d.tick, ents = {}, done = d.tick}
      report.done = report.done + 1
    end
  end
  for _, m in pairs(storage.vb_marks or {}) do
    if m.e and m.e.valid and m.e.to_be_deconstructed() then
      -- У пометки без плана имя плана — по автору: так её по-прежнему можно найти и снять списком.
      Plans.remember(m.e, m.plan or ('снос:' .. tostring(m.by)), m.by)
      report.marks = report.marks + 1
    end
  end
  -- Шаблоны → общие чертежи команды с тем же именем и автором.
  st.blueprints[BP.TEAM] = st.blueprints[BP.TEAM] or {}
  for name, t in pairs(storage.vb_tpl or {}) do
    local list = {}
    for i, it in ipairs(t.items or {}) do
      list[i] = {name = it.ent, x = it.dx, y = it.dy, direction = it.dir, underground = it.ug, recipe = it.recipe}
    end
    local ok, err = pcall(function()
      BP.with(function(stack)
        BP.from_list(stack, list, nil)
        st.blueprints[BP.TEAM][name] = BP.record(stack, t.by)
      end)
    end)
    if ok then report.blueprints = report.blueprints + 1
    else report.blueprint_errors[name] = type(err) == 'table' and err.message or tostring(err) end
  end
  storage.vb_ghost, storage.vb_ghost_done, storage.vb_marks, storage.vb_tpl, storage.vb_kit = nil, nil, nil, nil, nil
  st.legacy_report = report
  log('agent: перенос со старой системы: ' .. serpent.line(report))
  return report
end

return L
