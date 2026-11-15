local s = game.surfaces.nauvis
local cx, cy, r = CX, CY, R
local rows = {}
for y = cy - r, cy + r do
  local row = {}
  for x = cx - r * 2, cx + r * 2 do
    local ok = s.can_place_entity{name = 'character', position = {x + 0.5, y + 0.5}}
    local ch = ok and '.' or '#'
    if not ok then
      local e = s.find_entities_filtered{area = {{x + 0.1, y + 0.1}, {x + 0.9, y + 0.9}}, limit = 1}[1]
      if e then
        if e.type == 'transport-belt' or e.type == 'underground-belt' or e.type == 'splitter' then ch = '='
        elseif e.type == 'character' then ch = '@'
        elseif e.type == 'tree' then ch = 'T'
        elseif e.type == 'resource' then ch = '.'
        elseif e.type == 'inserter' then ch = 'i'
        elseif e.type == 'pipe' or e.type == 'pipe-to-ground' then ch = 'p'
        elseif e.type == 'electric-pole' then ch = '|' end
      else ch = '~' end
    end
    row[#row + 1] = ch
  end
  rows[#rows + 1] = string.format('%4d ', y) .. table.concat(row)
end
return table.concat(rows, '\n')
