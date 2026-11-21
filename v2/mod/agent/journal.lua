-- Журнал событий: возрастающие номера, последние MAX событий. Событие адресовано персонажу (agent = имя)
-- или всей команде (agent = nil).
local J = {}
J.MAX = 10000

function J.init(st)
  st.journal = st.journal or {seq = 0, first = 1, items = {}}
  st.throttle = st.throttle or {}
  st.chat = st.chat or {seq = 0, items = {}}
  st.tally = st.tally or {}
  st.watch = st.watch or {i = 1, bad = {}, pending = {}}
  st.corpses = st.corpses or {}        -- трупы персонажей ботов: место → {agent, tick, by}
  st.groups = st.groups or {}          -- отряды врагов: номер → {g, at — тик прошлого события, x, y}
end

--- Сообщение игрового чата: в журнал событий и в ленту чата (последние 200 сообщений людей и ботов).
function J.chat(from, text, bot)
  local c = storage.agent.chat
  c.seq = c.seq + 1
  c.items[#c.items + 1] = {seq = c.seq, from = from, text = text, bot = bot or nil, tick = game.tick}
  if #c.items > 200 then table.remove(c.items, 1) end
  J.add('chat', nil, {from = from, text = text, bot = bot or nil})
end

local bell_failed = false -- только чтобы не повторять строку в журнале сервера; на игру не влияет

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
  -- Серверу ботов — датаграммой UDP, сразу: само событие (JSON), чтобы ему не читать журнал по RCON — такое чтение
  -- стоит лишний тик. Большое событие уходит одним номером («звонок»), сервер дочитает его сам. Шлёт только сервер игры
  -- (for_player = 0) и только если он запущен с --enable-lua-udp; иначе вызов ничего не делает и всё работает на опросе.
  local b = storage.agent.bell
  if b and ev.tick - b.seen <= J.BELL_TTL then
    local data = helpers.table_to_json(ev)
    if #data > J.BELL_MAX then data = tostring(j.seq) end
    -- Итог отправки в storage не пишется: у сервера и клиентов он разный. Отказ не должен ронять запись журнала.
    local ok, err = pcall(helpers.send_udp, b.port, data, 0)
    if not ok and not bell_failed then bell_failed = true log('agent: событие по UDP не отправлено: ' .. tostring(err)) end
  end
  return ev
end

J.BELL_TTL = 3600 -- тиков без опроса журнала, после которых звонить некому
J.BELL_MAX = 8000 -- байт: событие длиннее уходит одним номером

--- Порт звонка сообщает сервер ботов при каждом чтении журнала; перестал читать — звонок сам смолкает (BELL_TTL).
function J.bell(port)
  local st = storage.agent
  if type(port) ~= 'number' or port % 1 ~= 0 or port < 1024 or port > 65535 then return end
  local b = st.bell
  if b and b.port == port then b.seen = game.tick
  else st.bell = {port = port, seen = game.tick, at = -1} end
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
