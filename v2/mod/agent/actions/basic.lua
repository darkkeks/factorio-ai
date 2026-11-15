-- Простые действия: ожидание и чат.
local U = require('agent.util')
local J = require('agent.journal')
local Q = require('agent.queue')

-- wait: N тиков или до условия из закрытого списка.
local CONDITIONS = {
  craft_empty = function(A) return A.entity.crafting_queue_size == 0 end,
  has_item = function(A, p) return A.entity.get_item_count(p.item) >= (p.count or 1) end,
}

Q.register('wait', {
  check = function(p)
    if p['until'] ~= nil then
      if not CONDITIONS[p['until']] then U.fail('bad_request', 'until: craft_empty или has_item') end
      if p['until'] == 'has_item' then
        U.arg(p.item, 'string', 'item')
        if not prototypes.item[p.item] then U.fail('bad_request', 'нет такого предмета: ' .. p.item) end
      end
      U.arg(p.max_ticks, 'int', 'max_ticks', true)
      U.arg(p.ticks, 'int', 'ticks', true)  -- вместе с until ticks — тот же предел, что max_ticks
    else
      U.arg(p.ticks, 'int', 'ticks')
    end
  end,
  start = function(A, act)
    local p = act.p
    if p['until'] and CONDITIONS[p['until']](A, p) then return {waited = 0, met = true} end
    if not p['until'] and p.ticks <= 0 then return {waited = 0} end
    return nil
  end,
  tick = function(A, act)
    local p = act.p
    local waited = game.tick - act.started
    if p['until'] then
      if CONDITIONS[p['until']](A, p) then return {waited = waited, met = true} end
      local limit = p.max_ticks or p.ticks
      if limit and waited >= limit then
        U.fail('timeout', 'условие не выполнилось за ' .. limit .. ' тиков', {waited = waited})
      end
      return nil
    end
    if waited >= p.ticks then return {waited = waited} end
    return nil
  end,
  progress = function(A, act) return {waited = game.tick - act.started} end,
})

-- say: сообщение в игровой чат. Копия кладётся в storage.vb_chat — его читают веб-карта и хозяин сессий.
local function say(A, text)
  storage.vb_chat = storage.vb_chat or {seq = 0, items = {}}
  local c = storage.vb_chat
  c.seq = c.seq + 1
  c.items[#c.items + 1] = {seq = c.seq, from = A.name, text = text}
  if #c.items > 50 then table.remove(c.items, 1) end
  game.print('[color=1,0.8,0.2]' .. A.name .. ':[/color] ' .. text)
  J.chat(A.name, text, true)
end

Q.register('say', {
  instant = true,
  check = function(p)
    U.arg(p.text, 'string', 'text')
    if #p.text > 2000 then U.fail('bad_request', 'сообщение длиннее 2000 байт') end
  end,
  start = function(A, act)
    say(A, act.p.text)
    return {sent = true}
  end,
})
