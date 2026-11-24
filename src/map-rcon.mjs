// RCON для веб-карты: Lua-функции хранятся в игре, по сети каждый раз идёт только короткий вызов.
//
// Почему: команду консоли сервер рассылает всем подключённым клиентам (здесь — как минимум клиенту-камере),
// и длинный текст расходится по ~270 байт за тик. Запрос сведений о постройке (5 КБ кода) поэтому выполнялся
// только через 20 тиков — 330 мс, хотя сам код работает за доли миллисекунды. Теперь код один раз кладётся
// в глобальную таблицу web_map (у сервера и у всех клиентов, которые в этот момент в игре), дальше вызов — пара
// сотен байт, один тик. Функции только читают игру, поэтому клиент, вошедший позже и не знающий их, ничего
// не теряет: у него вызов молча падает внутри pcall, а ответ печатает только сервер. После перезапуска сервера
// таблицы нет — вызов отвечает «нет функции», и код отправляется заново.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.mjs';
import { Rcon } from '../v2/server/rcon.mjs';

const CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'rcon.json'), 'utf8'));
const esc = (v) => JSON.stringify(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
const ids = new Map(); // текст кода -> имя функции в игре (по хешу: правка кода — новая функция)
const fnId = (code) => { let id = ids.get(code); if (!id) ids.set(code, id = 'f' + crypto.createHash('md5').update(code).digest('hex').slice(0, 12)); return id; };

/**
 * Функция lua(code, args) с пулом из size соединений: у каждого запроса в полёте — своё соединение
 * (в одном соединении второй ответ подряд ждёт подтверждения первого, ~40 мс). code — тело функции от A.
 */
export function makeLua(name, size = 1) {
  const pool = Array.from({ length: size }, (_, i) => Object.assign(new Rcon({ ...CONF, name: `${name}#${i}`, timeoutMs: 15000 }), { busy: 0 }));
  const call = async (c, id, args) => {
    const out = await c.command(`/silent-command local f = web_map and web_map.${id} if not f then rcon.print('{"missing":true}') return end ` +
      `local ok, res = pcall(f, helpers.json_to_table('${esc(args)}')) rcon.print(helpers.table_to_json({ ok = ok, res = res }))`);
    // Самую первую Lua-команду на карте сервер отклоняет с предупреждением про достижения — тогда ответ пустой.
    return out.trim() ? JSON.parse(out) : { missing: true };
  };
  return async function lua(code, args = {}) {
    const c = pool.reduce((a, b) => (b.busy < a.busy ? b : a));
    c.busy++;
    try {
      const id = fnId(code);
      let r = await call(c, id, args);
      if (r.missing) {
        await c.command(`/silent-command web_map = web_map or {} web_map.${id} = function(A) ${code} end`);
        r = await call(c, id, args);
        if (r.missing) throw new Error('Lua: функция не определилась');
      }
      if (!r.ok) throw new Error(`Lua: ${String(r.res).slice(0, 500)}`);
      return r.res;
    } finally { c.busy--; }
  };
}
