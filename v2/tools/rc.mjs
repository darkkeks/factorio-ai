#!/usr/bin/env node
// Консоль администратора для тестового сервера: rc.mjs '<команда>' | rc.mjs -l '<lua>' (печатает rcon.print).
// Адрес: V2_RCON_PORT / V2_RCON_PW (по умолчанию тестовый экземпляр 27115 / test).
import { Rcon } from '../server/rcon.mjs';
const r = new Rcon({ port: Number(process.env.V2_RCON_PORT || 27115), password: process.env.V2_RCON_PW || 'test' });
let [a, b] = process.argv.slice(2);
if (a === '-f') { const fs = await import('node:fs'); a = '-l'; b = fs.readFileSync(b, 'utf8'); }
const cmd = a === '-l' ? `/silent-command local ok, res = pcall(function() ${b} end) if not ok then rcon.print('LUA ERROR: ' .. tostring(res)) elseif res ~= nil then rcon.print(type(res) == 'table' and helpers.table_to_json(res) or tostring(res)) end` : a;
let out = await r.command(cmd);
if (!out.trim() && a === '-l') out = await r.command(cmd);
process.stdout.write(out.endsWith('\n') ? out : out + '\n');
r.close();
