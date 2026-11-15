-- Журнал событий: возрастающие номера, последние MAX событий. Событие адресовано персонажу (agent = имя)
-- или всей команде (agent = nil).
local J = {}
J.MAX = 10000

function J.init(st)
  st.journal = st.journal or {seq = 0, first = 1, items = {}}
  st.throttle = st.throttle or {}
end

function J.add(kind, agent, data)
  local j = storage.agent.journal
  local ev = data or {}
  j.seq = j.seq + 1
  ev.seq, ev.type, ev.agent, ev.tick = j.seq, kind, agent, game.tick
  j.items[j.seq] = ev
  while j.seq - j.first >= J.MAX do
    j.items[j.first] = nil
    j.first = j.first + 1
  end
  return ev
end

--- Не чаще раза в `ticks` на ключ: true, если событие пора писать.
function J.due(key, ticks)
  local th = storage.agent.throttle
  local t = th[key]
  if t and game.tick - t < ticks then return false end
  th[key] = game.tick
  return true
end

function J.prune_throttle(max_age)
  local th = storage.agent.throttle
  for k, t in pairs(th) do
    if game.tick - t > max_age then th[k] = nil end
  end
end

--- События с номерами больше since, не более limit штук.
function J.read(since, limit)
  local j = storage.agent.journal
  local out, n = {}, 0
  local from = math.max(since + 1, j.first)
  for s = from, j.seq do
    n = n + 1
    out[n] = j.items[s]
    if n >= limit then break end
  end
  return out, j.seq, j.first
end

return J
