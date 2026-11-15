-- Имя плана — метка на призраках и на пометках сноса и замены. По имени бот смотрит остаток и стоимость,
-- строит или отменяет часть плана. Сами призраки и пометки — сущности игры; здесь только «что к какому плану».
--   storage.agent.plans[имя] = {by = автор, tick = когда создан, ents = {ключ → сущность}, done = тик завершения}
--   storage.agent.plan_of[ключ] = имя
local U = require('agent.util')

local P = {}

function P.init(st)
  st.plans = st.plans or {}
  st.plan_of = st.plan_of or {}
end

local function key(e)
  return e.unit_number or (e.name .. '@' .. e.position.x .. ',' .. e.position.y)
end

--- Отнести сущность (призрак, помеченную постройку, дерево) к плану.
function P.remember(e, plan, by)
  if not plan then return end
  local st = storage.agent
  local pl = st.plans[plan]
  if not pl then
    pl = {by = by, tick = game.tick, ents = {}}
    st.plans[plan] = pl
  end
  pl.done = nil
  local k = key(e)
  pl.ents[k] = e
  st.plan_of[k] = plan
end

function P.of(e)
  return storage.agent.plan_of[key(e)]
end

--- Убрать сущность из учёта (перед оживлением призрака, после снятия пометки). Возвращает имя плана.
function P.forget(e)
  local st = storage.agent
  local k = key(e)
  local plan = st.plan_of[k]
  if not plan then return nil end
  st.plan_of[k] = nil
  local pl = st.plans[plan]
  if pl then pl.ents[k] = nil end
  return plan
end

-- Относится ли сущность к плану до сих пор: призрак существует, пометка не снята.
local function alive(e)
  if not e.valid then return false end
  if e.type == 'entity-ghost' or e.type == 'tile-ghost' then return true end
  return e.to_be_deconstructed() or e.to_be_upgraded()
end

--- Живые сущности плана; заодно чистит исчезнувшие (построено, снесено, пометка снята).
function P.entities(plan)
  local st = storage.agent
  local pl = st.plans[plan]
  local out = {}
  if not pl then return out end
  for k, e in pairs(pl.ents) do
    if alive(e) then
      out[#out + 1] = e
    else
      pl.ents[k] = nil
      st.plan_of[k] = nil
    end
  end
  if #out == 0 and not pl.done then pl.done = game.tick end
  return out
end

--- Владеет ли бот планом (чужой план менять нельзя, смотреть и строить — можно).
function P.owned(plan, by)
  local pl = storage.agent.plans[plan]
  return pl == nil or pl.by == nil or pl.by == by
end

function P.check_owner(plan, by)
  if not P.owned(plan, by) then
    U.fail('not_allowed', 'план ' .. plan .. ' создал ' .. tostring(storage.agent.plans[plan].by) .. ': менять его может только автор')
  end
end

--- Забыть завершённые планы старше max_age тиков.
function P.prune(max_age)
  local st = storage.agent
  for name, pl in pairs(st.plans) do
    if pl.done and game.tick - pl.done > max_age and next(pl.ents) == nil then st.plans[name] = nil end
  end
end

return P
