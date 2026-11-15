-- Исполнитель ботов внутри игры: персонажи, очереди действий, журнал событий.
-- Точка входа — консольная команда /agent с JSON-запросом {agent?, op, params?, id?} и JSON-ответом
-- {ok, tick, result | error}. Команда принимается только с консоли сервера (RCON), от игроков — нет.
local U = require('agent.util')
local S = require('agent.state')
local Q = require('agent.queue')
local O = require('agent.ops')
local E = require('agent.events')
local walk = require('agent.actions.walk')
require('agent.actions.basic')
require('agent.actions.build')
require('agent.actions.transfer')
require('agent.actions.mine')
require('agent.actions.craft')
require('agent.actions.configure')
require('agent.actions.research')
require('agent.planning')
require('agent.observe')
require('agent.stats')
local Fog = require('agent.fog')

local M = {events = {}}

local function reply(ok, body)
  local r = {ok = ok, tick = game.tick}
  if ok then r.result = body else r.error = body end
  return helpers.table_to_json(r)
end

local function handle(raw)
  local req = raw and helpers.json_to_table(raw)
  if type(req) ~= 'table' then return reply(false, {code = 'bad_request', message = 'ожидается JSON-объект запроса'}) end
  local op = O.list[req.op]
  if not op then return reply(false, {code = 'unknown_op', message = 'нет такой операции: ' .. tostring(req.op)}) end
  if op.admin and not req.admin then return reply(false, {code = 'forbidden', message = 'операция только для администратора'}) end
  local A
  if req.agent ~= nil then
    if type(req.agent) ~= 'string' or req.agent == '' then return reply(false, {code = 'bad_request', message = 'agent: имя персонажа'}) end
    local ok, res = xpcall(S.agent, Q.on_error, req.agent, true)
    if not ok then return reply(false, res) end
    A = res
  elseif op.agent then
    return reply(false, {code = 'bad_request', message = 'операции нужен персонаж (agent)'})
  end
  local id = req.id
  if A then
    if id ~= nil and op.write then
      id = tostring(id)
      local saved = A.replies.map[id]
      if saved then return saved end
    end
    A.seen = game.tick
  end
  local params = req.params
  if type(params) ~= 'table' then params = {} end
  -- Замер времени исполнения внутри игры (администратору): поле profile в запросе.
  local prof = req.profile and req.admin and helpers.create_profiler() or nil
  local ok, res = xpcall(op.fn, Q.on_error, A, params, req)
  local out = reply(ok, res)
  if prof then
    prof.stop()
    rcon.print({'', 'PROFILE ', prof, ' bytes=' .. #out})
    return nil
  end
  if A and id ~= nil and op.write then
    -- Для повтора храним краткий ответ: итоги действий лежат в журнале событий (action_done).
    S.remember(A, id, (ok and op.compact) and reply(true, op.compact(res)) or out)
  end
  return out
end

-- Каждый обработчик сначала приводит состояние к текущей версии (см. state.lua).
local function guarded(fn)
  return function(ev)
    S.ensure()
    fn(ev)
  end
end

-- Несколько модулей могут слушать одно событие: обработчики складываются в цепочку.
local chains = {}
local function listen(id, fn)
  chains[id] = chains[id] or {}
  table.insert(chains[id], fn)
end
for id, fn in pairs(E.handlers) do listen(id, fn) end
for id, fn in pairs(Fog.handlers) do listen(id, fn) end
for id, list in pairs(chains) do
  M.events[id] = guarded(#list == 1 and list[1] or function(ev)
    for _, fn in ipairs(list) do fn(ev) end
  end)
end
M.events[defines.events.on_script_path_request_finished] = guarded(walk.path_finished)

M.add_commands = function()
  commands.add_command('agent', 'Исполнитель ботов: только с консоли сервера.', function(cmd)
    if cmd.player_index ~= nil then
      local p = game.get_player(cmd.player_index)
      if p then p.print('Команда /agent принимается только с консоли сервера.') end
      return
    end
    S.ensure()
    local out = handle(cmd.parameter)
    if out then rcon.print(out) end
  end)
end

M.on_init = function() S.ensure() end

return M
