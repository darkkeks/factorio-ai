-- Инвентари объекта по именам слотов его окна. Числовые номера инвентарей у разных видов построек совпадают
-- (первый слот — и сундук, и топливо, и патроны турели), поэтому имя разбирается с учётом вида постройки.
local Inv = {}

local CRAFTER = {['assembling-machine'] = true, furnace = true, ['rocket-silo'] = true}
local MAIN = {
  container = 'chest', ['logistic-container'] = 'chest', ['infinity-container'] = 'chest', ['temporary-container'] = 'chest',
  car = 'car_trunk', ['cargo-wagon'] = 'cargo_wagon', ['spider-vehicle'] = 'spider_trunk', ['character-corpse'] = 'character_corpse',
  roboport = 'roboport_material', ['cargo-landing-pad'] = 'cargo_landing_pad_main', ['space-platform-hub'] = 'hub_main',
  ['linked-container'] = 'linked_container_main',
}
local AMMO = {['ammo-turret'] = 'turret_ammo', ['artillery-turret'] = 'artillery_turret_ammo', ['artillery-wagon'] = 'artillery_wagon_ammo',
  car = 'car_ammo', ['spider-vehicle'] = 'spider_ammo'}

Inv.NAMES = {'fuel', 'burnt', 'input', 'output', 'modules', 'ammo', 'main', 'rocket'}

--- Инвентарь по имени слота или nil, если у этого вида построек такого нет. unknown = true — имя не распознано.
function Inv.named(ent, name)
  local t = ent.type
  if name == 'fuel' then return ent.get_fuel_inventory() end
  if name == 'burnt' then return ent.get_burnt_result_inventory() end
  if name == 'modules' then return ent.get_module_inventory() end
  if name == 'input' then
    if CRAFTER[t] then return ent.get_inventory(defines.inventory.crafter_input) end
    if t == 'lab' then return ent.get_inventory(defines.inventory.lab_input) end
    if t == 'agricultural-tower' then return ent.get_inventory(defines.inventory.agricultural_tower_input) end
    return nil
  end
  if name == 'output' then
    if CRAFTER[t] then return ent.get_inventory(defines.inventory.crafter_output) end
    if t == 'agricultural-tower' then return ent.get_inventory(defines.inventory.agricultural_tower_output) end
    return nil
  end
  if name == 'ammo' then return AMMO[t] and ent.get_inventory(defines.inventory[AMMO[t]]) or nil end
  -- Грузовой отсек ракеты в шахте: появляется, когда ракета собрана; вместимость — по весу.
  if name == 'rocket' then return t == 'rocket-silo' and ent.get_inventory(defines.inventory.rocket_silo_rocket) or nil end
  if name == 'main' then return MAIN[t] and ent.get_inventory(defines.inventory[MAIN[t]]) or nil end
  local id = defines.inventory[name]
  if not id then return nil, true end
  return ent.get_inventory(id)
end

--- Все непустые слоты окна: имя → инвентарь.
function Inv.all(ent)
  local out = {}
  for _, n in ipairs(Inv.NAMES) do
    local i = Inv.named(ent, n)
    if i then out[n] = i end
  end
  return out
end

return Inv
