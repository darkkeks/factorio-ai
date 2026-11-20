-- research: очередь исследований команды — добавить, убрать, переставить. Досягаемость не нужна, как у игрока.
local U = require('agent.util')
local Q = require('agent.queue')
local J = require('agent.journal')

local function names(v, what)
  if v == nil then return {} end
  if type(v) == 'string' then return {v} end
  if type(v) ~= 'table' then U.fail('bad_request', what .. ': имя технологии или список имён') end
  return v
end

local function tech(force, name)
  local t = force.technologies[name]
  if not t then U.fail('bad_request', 'нет такой технологии: ' .. tostring(name)) end
  return t
end

local function queue_names(force)
  local out = {}
  for i, t in ipairs(force.research_queue) do out[i] = t.name end
  return out
end

Q.register('research', {
  instant = true, free = true, -- тело не занимает: отдельный запрос исполняется сразу, не дожидаясь очереди
  check = function(p)
    if p.add == nil and p.remove == nil and p.set == nil then U.fail('bad_request', 'нужно add, remove или set') end
  end,
  start = function(A, act)
    local p, force = act.p, A.entity.force
    local skipped = {}
    if p.set ~= nil then
      local list = {}
      for _, n in ipairs(names(p.set, 'set')) do list[#list + 1] = tech(force, n) end
      force.research_queue = list
    end
    for _, n in ipairs(names(p.remove, 'remove')) do
      local t = tech(force, n)
      local keep = {}
      for _, q in ipairs(force.research_queue) do if q.name ~= t.name then keep[#keep + 1] = q end end
      force.research_queue = keep
    end
    for _, n in ipairs(names(p.add, 'add')) do
      local t = tech(force, n)
      if t.researched then skipped[#skipped + 1] = {name = n, reason = 'уже исследована'}
      elseif not t.enabled then skipped[#skipped + 1] = {name = n, reason = 'недоступна'}
      elseif t.prototype.research_trigger then
        skipped[#skipped + 1] = {name = n, reason = 'открывается не наукой, а действием (триггер): смотри trigger в research_info {name}'}
      elseif not force.add_research(t) then skipped[#skipped + 1] = {name = n, reason = 'игра не приняла: не исследованы предпосылки или очередь полна'} end
    end
    local q = queue_names(force)
    J.add('research_queue', nil, {by = A.name, queue = U.list(q)})
    return {queue = U.list(q), current = force.current_research and force.current_research.name or nil, skipped = U.list(skipped)}
  end,
})
