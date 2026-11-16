-- Очередь действий персонажа и её исполнение по тикам.
-- Описание действия: {start(A, act) → результат | nil, tick(A, act) → результат | nil, stop(A, act), instant, check(p)}.
-- nil означает «ещё выполняется»; ошибка — U.fail(code, message, data).
local U = require('agent.util')
local J = require('agent.journal')

local Q = {actions = {}}

function Q.register(name, def) Q.actions[name] = def end

local function on_error(err)
  if type(err) == 'table' and err.code then return err end
  log('agent: внутренняя ошибка: ' .. tostring(err) .. '\n' .. debug.traceback())
  return {code = 'internal', message = tostring(err)}
end
Q.on_error = on_error

local function done_event(A, act, ok, res)
  local ev = {action_id = act.id, action = act.type, ok = ok}
  if act.started then ev.ticks = game.tick - act.started end
  if ok then ev.result = res else ev.error = res end
  J.add('action_done', A.name, ev)
  return {action_id = act.id, action = act.type, ok = ok, result = ok and res or nil, error = (not ok) and res or nil}
end

-- Ошибка отмены; для пакетов к ней прикладывается отчёт о сделанном.
local function cancelled(A, act, message, data)
  local def = Q.actions[act.type]
  local err = {code = 'cancelled', message = message, data = data}
  if act.started and def.partial then
    local ok, rep = pcall(def.partial, A, act)
    if ok and rep then
      err.data = err.data or {}
      err.data.report = rep
    end
  end
  return err
end

local function cleanup(A, act)
  local def = Q.actions[act.type]
  if act.started and def.stop and A.entity and A.entity.valid then
    local ok, err = pcall(def.stop, A, act)
    if not ok then log('agent: ошибка в stop ' .. act.type .. ': ' .. tostring(err)) end
  end
end

-- Отменить всё, что стоит в очереди после текущего.
local function drop_rest(A, reason, because)
  local q = A.queue
  A.queue = {}
  for _, a in ipairs(q) do
    local err = cancelled(A, a, reason, because and {because = because} or nil)
    cleanup(A, a)
    done_event(A, a, false, err)
  end
end

local function finish(A, act, ok, res, keep_rest)
  cleanup(A, act)
  table.remove(A.queue, 1)
  local rec = done_event(A, act, ok, res)
  if not ok and act.on_fail ~= 'continue' and not keep_rest then
    drop_rest(A, 'очередь остановлена: действие ' .. act.id .. ' (' .. act.type .. ') не удалось', act.id)
  end
  return rec
end

--- Выполнять очередь, пока очередное действие не окажется долгим. finished — куда складывать итоги (или nil).
function Q.pump(A, finished)
  local st = storage.agent
  while true do
    local act = A.queue[1]
    if not act then break end
    local def = Q.actions[act.type]
    local ok, res
    if not (A.entity and A.entity.valid) then
      ok, res = false, {code = 'dead', message = 'персонаж погиб'}
    elseif act.silent and game.tick - A.seen > act.silent then
      ok, res = false, cancelled(A, act, 'от бота нет запросов дольше cancel_if_silent_s', {silent = true})
    elseif not act.started then
      act.started = game.tick
      act.st = {}
      ok, res = xpcall(def.start, on_error, A, act)
    else
      ok, res = xpcall(def.tick, on_error, A, act)
    end
    if ok and res == nil then break end
    local rec = finish(A, act, ok, res)
    if finished then finished[#finished + 1] = rec end
  end
  if A.queue[1] then
    st.active[A.name] = true
  elseif st.active[A.name] then
    st.active[A.name] = nil
    J.add('queue_empty', A.name, {})
  end
end

--- Отменить текущее действие (или действие с номером id в очереди); остальные продолжаются.
function Q.cancel(A, id)
  for i, act in ipairs(A.queue) do
    if (id == nil and i == 1) or act.id == id then
      if i == 1 then
        finish(A, act, false, cancelled(A, act, 'отменено ботом'), true)
      else
        table.remove(A.queue, i)
        done_event(A, act, false, {code = 'cancelled', message = 'отменено ботом'})
      end
      Q.pump(A)
      return act.id
    end
  end
  return nil
end

--- Очистить очередь целиком вместе с текущим действием.
function Q.clear(A, reason)
  local n = #A.queue
  drop_rest(A, reason or 'очередь очищена ботом')
  Q.pump(A)
  return n
end

--- Поставить действия в очередь. list — массив {type, …параметры, on_fail, cancel_if_silent_s, immediate}.
function Q.enqueue(A, list)
  -- Сначала проверяем всё, чтобы ошибка в третьем действии не оставила в очереди первые два.
  for i, a in ipairs(list) do
    if type(a) ~= 'table' then U.fail('bad_request', 'действие ' .. i .. ': ожидается объект') end
    local def = Q.actions[a.type]
    if not def then U.fail('bad_request', 'действие ' .. i .. ': неизвестный тип ' .. tostring(a.type)) end
    if a.on_fail ~= nil and a.on_fail ~= 'stop' and a.on_fail ~= 'continue' then
      U.fail('bad_request', 'действие ' .. i .. ': on_fail — stop или continue')
    end
    if a.immediate and not def.instant then
      U.fail('bad_request', 'действие ' .. i .. ': immediate допустимо только для мгновенных действий, ' .. a.type .. ' занимает тело')
    end
    if def.check then def.check(a, A) end
  end
  -- Действия, которые тело не занимают (планирование, чат, ручной крафт, исследования): запрос только из них
  -- исполняется сразу, не дожидаясь очереди. В общем списке с действиями тела они идут по порядку списка.
  local all_free = true
  for _, a in ipairs(list) do
    if not Q.actions[a.type].free then all_free = false end
  end
  local queued, finished = {}, {}
  for _, a in ipairs(list) do
    local act = {id = A.next_action, type = a.type, p = a, on_fail = a.on_fail or 'stop'}
    A.next_action = A.next_action + 1
    if a.cancel_if_silent_s then act.silent = math.floor(a.cancel_if_silent_s * 60) end
    queued[#queued + 1] = {action_id = act.id, action = act.type}
    if a.immediate or all_free then
      -- Мгновенное действие вне очереди: исполняется сейчас, с места, где персонаж стоит.
      act.started = game.tick
      act.st = {}
      local ok, res = xpcall(Q.actions[a.type].start, on_error, A, act)
      finished[#finished + 1] = done_event(A, act, ok, res)
    else
      A.queue[#A.queue + 1] = act
    end
  end
  Q.pump(A, finished)
  return queued, finished
end

--- Очередь для показа: [{action_id, action, state, …ход выполнения}].
function Q.view(A)
  local out = {}
  for i, act in ipairs(A.queue) do
    local v = {action_id = act.id, action = act.type, state = (i == 1 and act.started) and 'running' or 'queued'}
    local def = Q.actions[act.type]
    if i == 1 and act.started and def.progress then v.progress = def.progress(A, act) end
    out[i] = v
  end
  return out
end

return Q
