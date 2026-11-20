-- Технологии-триггеры (открываются не наукой, а действием: скрафтить предмет, добыть объект).
-- Ручной крафт игра засчитывает только игроку: у персонажа без игрока он в счёт триггера craft-item не идёт.
-- Здесь он засчитывается персонажам ботов по тем же правилам, что в игре: предпосылки технологии уже исследованы,
-- нужное число набрано. Добычу (mine-entity) игра засчитывает персонажу сама; машины, ракеты и платформы — тоже её забота.
-- Триггер build-entity в игре один — сборщик астероидов на космической платформе, ботам туда пока нельзя (fb-073).
local Trig = {}

-- Справочник по прототипам: предмет → технологии с триггером craft-item.
-- Прототипы не меняются, пока идёт игра, поэтому у всех участников он получается одинаковым.
local index

local function build_index()
  index = {craft = {}}
  for name, t in pairs(prototypes.technology) do
    local tr = t.research_trigger
    if tr then
      if tr.type == 'craft-item' and tr.item then
        local item = type(tr.item) == 'table' and tr.item or {name = tr.item}
        -- Руками получается только обычное качество: триггеры на качество выше ботам не засчитываются.
        if item.name and (item.quality == nil or item.quality == 'normal') then
          local l = index.craft[item.name] or {}
          index.craft[item.name] = l
          l[#l + 1] = {tech = name, count = tr.count or 1}
        end
      end
    end
  end
  return index
end

function Trig.init(st)
  st.trig = st.trig or {}
  st.trig.progress = st.trig.progress or {} -- технология → сколько предметов уже скрафчено ботами
  st.trig.queue = st.trig.queue or {}       -- бот → {unit, totals = {рецепт → сколько крафтов в очереди}}
end

-- Триггер считается только у доступной технологии: включена, не исследована, все предпосылки исследованы.
local function open(t)
  if not t or t.researched or not t.enabled then return false end
  for _, pr in pairs(t.prerequisites) do
    if not pr.researched then return false end
  end
  return true
end

local function finish(t)
  storage.agent.trig.progress[t.name] = nil
  t.researched = true
end

--- Бот скрафтил руками count предметов item.
local function crafted(force, item, count)
  local list = (index or build_index()).craft[item]
  if not list then return end
  local progress = storage.agent.trig.progress
  for _, tr in ipairs(list) do
    local t = force.technologies[tr.tech]
    if open(t) then
      local n = (progress[tr.tech] or 0) + count
      if n >= tr.count then finish(t) else progress[tr.tech] = n end
    end
  end
end

local function totals(e)
  local t = {}
  if e.crafting_queue_size > 0 then
    for _, q in pairs(e.crafting_queue) do t[q.recipe] = (t[q.recipe] or 0) + q.count end
  end
  return t
end

--- Запомнить очередь ручного крафта как есть, ничего не засчитывая (после постановки в очередь и после отмены).
function Trig.snapshot(A)
  local e = A.entity
  local queue = storage.agent.trig.queue
  if not (e and e.valid) then queue[A.name] = nil return end
  local cur = totals(e)
  queue[A.name] = next(cur) and {unit = e.unit_number, totals = cur} or nil
end

--- Сверить очередь ручного крафта с запомненной: что из неё ушло — скрафчено. Вызывается по тикам и перед тем,
--- как очередь меняет сам бот (craft, cancel_craft), чтобы отменённое не сошло за сделанное.
function Trig.sync(A)
  local e = A.entity
  local queue = storage.agent.trig.queue
  local prev = queue[A.name]
  if not (e and e.valid) then return end
  local cur = totals(e)
  if prev and prev.unit == e.unit_number then
    for recipe, n in pairs(prev.totals) do
      local d = n - (cur[recipe] or 0)
      local rp = d > 0 and prototypes.recipe[recipe]
      if rp then
        for _, pr in pairs(rp.products) do
          if pr.type == 'item' then
            local amount = pr.amount or pr.amount_min or 0
            if amount > 0 then crafted(e.force, pr.name, amount * d) end
          end
        end
      end
    end
  end
  queue[A.name] = next(cur) and {unit = e.unit_number, totals = cur} or nil
end

--- Очередь крафта пропала вместе с персонажем (гибель): засчитывать нечего.
function Trig.forget(name)
  storage.agent.trig.queue[name] = nil
end

--- Описание триггера технологии для research_info — то, что игрок видит в окне исследований.
function Trig.describe(t)
  local tr = t.prototype.research_trigger
  if not tr then return nil end
  local r = {type = tr.type}
  if tr.type == 'craft-item' and tr.item then
    r.item = type(tr.item) == 'table' and tr.item.name or tr.item
    r.quality = type(tr.item) == 'table' and tr.item.quality or nil
    r.count = tr.count or 1
  elseif tr.type == 'craft-fluid' then
    r.fluid, r.amount = tr.fluid, tr.amount
  elseif tr.type == 'build-entity' and tr.entity then
    r.entity = type(tr.entity) == 'table' and tr.entity.name or tr.entity
    r.quality = type(tr.entity) == 'table' and tr.entity.quality or nil
  elseif tr.type == 'mine-entity' then
    r.entities = tr.entities or (tr.entity and {tr.entity}) or nil
  elseif tr.type == 'send-item-to-orbit' and tr.item then
    r.item = type(tr.item) == 'table' and tr.item.name or tr.item
  end
  return r
end

return Trig
