-- Пакетное действие: список элементов, над каждым — одна и та же операция. Всё, до чего персонаж дотягивается,
-- исполняется сразу, в одном тике. С approach = true персонаж сам обходит остальные цели (ближайшая следующей).
-- Пакет не принимает игровых решений: цели и количества задаёт бот; недостижимое и невозможное попадает в отчёт.
--
-- Описание пакета (spec):
--   items(A, p)        → список элементов (таблицы); вызывается в start
--   point(A, it)       → позиция цели, дальность; ошибка — элемент пропускается с причиной
--   in_reach(A, it)    → точное правило досягаемости (необязательно; иначе расстояние до позиции ≤ дальности)
--   exec(A, it)        → итог (мгновенная операция)            ┐ одно из двух
--   begin(A, it), step(A, it) → nil | итог (операция по тикам) ┘
--   abort(A, it)       → прервать операцию по тикам
--   brief(it)          → чем элемент назвать в отчёте
local U = require('agent.util')
local Q = require('agent.queue')
local W = require('agent.actions.walk')

local Tour = {}

local function settle(it, ok, res)
  if ok then
    it.state, it.result = 'done', res
    if Tour.on_done then Tour.on_done(it, res) end
  else
    it.state, it.error = 'skipped', {code = res.code, message = res.message, data = res.data}
  end
end

local function report(spec, st, single)
  local items, done, skipped, left = {}, 0, 0, 0
  for i, it in ipairs(st.items) do
    local r = spec.brief and spec.brief(it) or {}
    if it.state == 'done' then
      done = done + 1
      r.ok = true
      for k, v in pairs(it.result or {}) do r[k] = v end
    elseif it.state == 'skipped' then
      skipped = skipped + 1
      r.ok = false
      r.code, r.message = it.error.code, it.error.message
      if it.error.data then r.data = it.error.data end
    else
      left = left + 1
      r.left = true
    end
    items[i] = r
  end
  local rep = {done = done, skipped = skipped, left = left, total = #st.items, items = U.list(items)}
  if st.walked and st.walked > 0 then rep.walked = U.r2(st.walked) end
  return rep
end

local function finish(spec, A, act)
  local st = act.st
  -- Запрос про один объект: его неудача — неудача действия.
  if st.single then
    local it = st.items[1]
    if it.state == 'skipped' then error(it.error, 0) end
    local r = spec.brief and spec.brief(it) or {}
    for k, v in pairs(it.result or {}) do r[k] = v end
    if st.walked and st.walked > 0 then r.walked = U.r2(st.walked) end
    return r
  end
  return report(spec, st)
end

local function run(spec, A, act)
  local st, e = act.st, A.entity
  while true do
    -- 1. операция по тикам над текущим элементом
    if st.cur then
      local it = st.items[st.cur]
      local ok, res = xpcall(spec.step, Q.on_error, A, it, act)
      if ok and res == nil then return nil end
      settle(it, ok, res)
      st.cur = nil
    end
    -- 2. идём к очередной цели
    if st.w then
      local ok, res = xpcall(W.step, Q.on_error, A, act, st.w)
      if ok and res == nil then return nil end
      st.walked = (st.walked or 0) + st.w.walked
      W.halt(A, st.w)
      local it = st.items[st.wi]
      st.w, st.wi = nil, nil
      if not ok then
        if res.code == 'damaged' then error(res, 0) end -- урон прерывает весь пакет: решать боту
        settle(it, false, {code = res.code, message = 'не дошёл до цели: ' .. res.message, data = {position = res.data and res.data.position}})
      else
        it.walked_to = true
      end
    end
    -- 3. всё, до чего дотягиваемся, — сейчас
    local pos = e.position
    local nearest, nd, npt, nreach
    for i, it in ipairs(st.items) do
      if not it.state then
        local ok, pt, reach = xpcall(spec.point, Q.on_error, A, it)
        if not ok then
          settle(it, false, pt)
        else
          local d = U.dist(pos, pt)
          local inr
          if spec.in_reach then inr = spec.in_reach(A, it) else inr = d <= reach end
          if inr then
            if spec.exec then
              local ok2, res = xpcall(spec.exec, Q.on_error, A, it)
              settle(it, ok2, res)
            else
              local ok2, res = xpcall(spec.begin, Q.on_error, A, it, act)
              if not ok2 then settle(it, false, res)
              elseif res ~= nil then settle(it, true, res)
              else
                st.cur = i
                return nil
              end
            end
          elseif it.walked_to then
            -- Подошли, а дотянуться всё равно нельзя: второй раз не ходим.
            settle(it, false, {code = 'out_of_reach', message = 'подошёл, но до цели не дотянуться'})
          elseif not nearest or d < nd then
            nearest, nd, npt, nreach = i, d, pt, reach
          end
        end
      end
    end
    if not nearest then return finish(spec, A, act) end
    if not act.p.approach then
      for _, it in ipairs(st.items) do
        if not it.state then
          settle(it, false, {code = 'out_of_reach', message = 'цель дальше, чем дотягивается персонаж; подойди или укажи approach: true'})
        end
      end
      return finish(spec, A, act)
    end
    -- 4. к ближайшей из оставшихся
    local it = st.items[nearest]
    local ok, w = xpcall(W.new, Q.on_error, A, act, npt, math.max(nreach - 1.5, 0.6), {stop_on_damage = act.p.stop_on_damage})
    if not ok then
      settle(it, false, {code = w.code, message = 'не дошёл до цели: ' .. w.message})
    elseif w.done then
      it.walked_to = true
    else
      st.w, st.wi = w, nearest
      return nil
    end
  end
end

--- Собрать описание действия очереди из описания пакета.
function Tour.action(spec)
  local def = {instant = spec.exec ~= nil}
  def.check = function(p, A)
    if spec.check then spec.check(p, A) end
    if p.approach ~= nil and type(p.approach) ~= 'boolean' then U.fail('bad_request', 'approach — true или false') end
    if p.immediate and p.approach then U.fail('bad_request', 'immediate несовместимо с approach: подход занимает тело') end
  end
  def.start = function(A, act)
    local items, single = spec.items(A, act.p)
    act.st.items, act.st.single = items, single
    if #items == 0 then return {done = 0, skipped = 0, left = 0, total = 0, items = U.EMPTY} end
    return run(spec, A, act)
  end
  def.tick = function(A, act) return run(spec, A, act) end
  def.stop = function(A, act)
    local st = act.st
    if not st then return end
    if st.w then W.halt(A, st.w) end
    if st.cur and spec.abort then spec.abort(A, st.items[st.cur]) end
  end
  def.progress = function(A, act)
    local st, done, total = act.st, 0, 0
    for _, it in ipairs(st.items or {}) do
      total = total + 1
      if it.state then done = done + 1 end
    end
    return {done = done, total = total, walking = st.w and true or false}
  end
  -- Отчёт о сделанном к моменту отмены.
  def.partial = function(A, act)
    if act.st and act.st.items then return report(spec, act.st) end
  end
  return def
end

return Tour
