-- shoot / stop_shooting: стрельба из надетого оружия — так же, как у игрока, зажавшего кнопку огня.
-- Мод только «держит кнопку» (shooting_state персонажа) и наводит прицел; всё остальное делает движок игры: выбирает
-- ближайшего к прицелу врага в дальности оружия, считает темп стрельбы, расход патронов, разброс и урон.
-- Огонь не занимает тело: команда исполняется в том же тике, в который пришла, и не ждёт очереди действий —
-- стрелять можно на ходу, отступая. Держится ограниченное время и продлевается повторной командой: отключившийся
-- бот не остаётся вечной турелью.
local U = require('agent.util')
local Q = require('agent.queue')
local J = require('agent.journal')
local T = require('agent.target')
local Fog = require('agent.fog')
local Equip = require('agent.actions.equip')

local Shoot = {}
local MAX_S, DEFAULT_S = 120, 20
local GUNS, AMMO = defines.inventory.character_guns, defines.inventory.character_ammo

--- Слот оружия: {slot, gun, ammo?, count?, range}; nil — оружия в слоте нет.
local function slot_info(e, i)
  local guns, ammo = e.get_inventory(GUNS), e.get_inventory(AMMO)
  local g = guns[i]
  if not (g and g.valid_for_read) then return nil end
  local r = {slot = i, gun = g.name}
  local ap = g.prototype.attack_parameters
  local range = ap and ap.range or 0
  local a = ammo[i]
  if a and a.valid_for_read then
    r.ammo, r.count = a.name, a.count
    local at = a.prototype.get_ammo_type('player')
    if at and at.range_modifier then range = range * at.range_modifier end
  end
  r.range = U.r2(range)
  return r
end

--- Первый слот с оружием и патронами, начиная с prefer (как игра сама переходит на следующее оружие).
local function loaded_slot(e, prefer)
  local n = #e.get_inventory(GUNS)
  for k = 0, n - 1 do
    local s = slot_info(e, (prefer - 1 + k) % n + 1)
    if s and s.ammo then return s end
  end
  return nil
end

local function release(e)
  if e and e.valid then e.shooting_state = {state = defines.shooting.not_shooting, position = e.position} end
end

--- Закончить стрельбу: отпустить огонь, сообщить итог событием shooting_done.
local function finish(A, reason)
  local f, e = A.fire, A.entity
  if not f then return nil end
  A.fire = nil
  storage.agent.firing[A.name] = nil
  local r = {reason = reason, action_id = f.id, mode = f.mode, killed = f.killed, kills = next(f.kills) and f.kills or nil,
    seconds = U.r2((game.tick - f.started) / 60)}
  if e and e.valid then
    pcall(release, e) -- у гибнущего персонажа состояние уже не меняется
    r.ammo_left = U.contents(e.get_inventory(AMMO))
    r.health = U.r2(e.health)
    r.position = U.pos(e.position)
  end
  J.add('shooting_done', A.name, r)
  return r
end
Shoot.stop = finish

--- Каждый тик, пока огонь зажат: навести прицел и проверить, есть ли чем и по кому стрелять.
function Shoot.tick(A)
  local f, e = A.fire, A.entity
  if not f then storage.agent.firing[A.name] = nil return end
  if not (e and e.valid) then return finish(A, 'died') end
  if game.tick >= f.until_tick then return finish(A, 'duration') end
  local aim
  if f.mode == 'target' then
    local t = f.target
    if not (t and t.valid) then return finish(A, 'target_dead') end
    aim = t.position
  else
    -- Прицел — на ближайшем к точке (или к себе) враге в дальности оружия: игра сама берёт только тех, кто рядом
    -- с прицелом, а не всех в дальности. Это то же, что делает игрок, наводя курсор на ближайшего врага.
    local t = f.aim
    if not (t and t.valid) or game.tick >= (f.aim_tick or 0) then
      local range = f.range or 0
      t = e.surface.find_nearest_enemy{position = f.at or e.position, max_distance = range, force = e.force}
      f.aim, f.aim_tick = t, game.tick + 10
    end
    aim = t and t.valid and t.position or f.at or e.position
  end
  -- Патроны в выбранном слоте кончились: следующее оружие с патронами, как делает игра у человека; нет такого — конец.
  local i = e.selected_gun_index
  local a = e.get_inventory(AMMO)[i]
  if not (a and a.valid_for_read) then
    local s = loaded_slot(e, i)
    if not s then return finish(A, 'no_ammo') end
    e.selected_gun_index = s.slot
    f.switched = (f.switched or 0) + 1
    f.range = s.range
  end
  e.shooting_state = {state = defines.shooting.shooting_enemies, position = aim}
end

--- Убитое персонажем бота, пока он стреляет, идёт в итог стрельбы.
function Shoot.kill(A, victim)
  local f = A and A.fire
  if not f or not (A.entity and A.entity.valid and victim.valid) then return end
  if not A.entity.force.is_enemy(victim.force) then return end
  f.killed = f.killed + 1
  f.kills[victim.name] = (f.kills[victim.name] or 0) + 1
end

--- Для status: что сейчас с огнём.
function Shoot.view(A)
  local f = A.fire
  if not f then return nil end
  return {mode = f.mode, action_id = f.id, seconds_left = U.r2(math.max(0, f.until_tick - game.tick) / 60), killed = f.killed,
    target = f.target and f.target.valid and T.brief(f.target) or nil, at = f.at}
end

Q.register('shoot', {
  instant = true, free = true, -- тело не занимает: исполняется сразу, даже когда персонаж идёт или строит
  check = function(p)
    if p.target ~= nil and type(p.target) ~= 'table' then U.fail('bad_request', 'target: объект {x, y, name?}') end
    if p.at ~= nil then
      if type(p.at) ~= 'table' then U.fail('bad_request', 'at: точка {x, y}') end
      U.arg(p.at.x, 'number', 'at.x')
      U.arg(p.at.y, 'number', 'at.y')
    end
    if p.target ~= nil and p.at ~= nil then U.fail('bad_request', 'либо target, либо at') end
    U.arg(p.slot, 'int', 'slot', true)
    if p.slot and (p.slot < 1 or p.slot > 3) then U.fail('bad_request', 'slot: 1…3') end
    U.arg(p.duration_s, 'number', 'duration_s', true)
    if p.duration_s and (p.duration_s <= 0 or p.duration_s > MAX_S) then U.fail('bad_request', 'duration_s: больше 0 и не больше ' .. MAX_S) end
  end,
  start = function(A, act)
    local p, e = act.p, A.entity
    local s
    if p.slot then
      s = slot_info(e, p.slot)
      if not s then U.fail('no_item', 'в слоте ' .. p.slot .. ' нет оружия', {weapons = Equip.weapons(e)}) end
      if not s.ammo then U.fail('no_item', 'в слоте ' .. p.slot .. ' нет патронов (equip)', {weapons = Equip.weapons(e)}) end
    else
      s = loaded_slot(e, e.selected_gun_index or 1)
      if not s then U.fail('no_item', 'нет оружия с патронами: надень оружие и патроны (equip)', {weapons = Equip.weapons(e)}) end
    end
    local fire = {mode = 'enemies', started = game.tick, until_tick = game.tick + math.floor((p.duration_s or DEFAULT_S) * 60),
      killed = 0, kills = {}, id = act.id, range = s.range}
    local r = {shooting = true, slot = s.slot, gun = s.gun, ammo = s.ammo, ammo_count = s.count, range = s.range,
      seconds = U.r2((fire.until_tick - game.tick) / 60)}
    if p.target then
      local t = T.get(e.surface, p.target)
      if not e.force.is_enemy(t.force) then U.fail('not_allowed', 'стрелять можно только по врагам', {target = T.brief(t)}) end
      if Fog.state(t.surface, e.force, t.position.x, t.position.y) ~= 'visible' then
        U.fail('not_visible', 'цель скрыта туманом войны', {target = p.target})
      end
      fire.mode, fire.target = 'target', t
      local d = U.dist(e.position, t.position)
      r.target = T.brief(t)
      r.target.health = t.health and U.r2(t.health) or nil
      r.distance = U.r2(d)
      r.in_range = d <= s.range
    elseif p.at then
      fire.at = {x = p.at.x, y = p.at.y}
    end
    r.mode = fire.mode
    if A.fire then finish(A, 'replaced') end -- новая команда сменяет прежнюю (и продлевает огонь)
    e.selected_gun_index = s.slot
    A.fire = fire
    storage.agent.firing[A.name] = true
    if game.tick_paused then game.tick_paused = false end -- огонь, как и любое действие, снимает паузу
    Shoot.tick(A) -- кнопка зажата уже в этом тике
    -- Сколько врагов (кусаки, черви, гнёзда) уже в дальности оружия.
    local hostile = {}
    for _, f in pairs(game.forces) do if e.force.is_enemy(f) then hostile[#hostile + 1] = f.name end end
    r.enemies_in_range = #hostile > 0 and e.surface.count_entities_filtered{force = hostile, position = e.position, radius = s.range, is_military_target = true} or 0
    return r
  end,
})

Q.register('stop_shooting', {
  instant = true, free = true,
  check = function() end,
  start = function(A)
    if not A.fire then return {shooting = false, already = true} end
    local r = finish(A, 'stopped')
    r.shooting = false
    return r
  end,
})

return Shoot
