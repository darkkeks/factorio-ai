// Минимальный клиент Source RCON для сервера Factorio: одно соединение, команды строго по очереди.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.mjs';

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'rcon.json'), 'utf8'));
let sock = null;
let buf = Buffer.alloc(0);
let nextId = 1;
const waiting = new Map(); // id -> { resolve, reject }

function packet(id, type, body) {
  const b = Buffer.from(body, 'utf8');
  const p = Buffer.alloc(14 + b.length);
  p.writeInt32LE(10 + b.length, 0);
  p.writeInt32LE(id, 4);
  p.writeInt32LE(type, 8);
  b.copy(p, 12);
  return p;
}

function request(type, body) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { waiting.delete(id); reject(new Error('RCON: нет ответа')); sock?.destroy(); }, 15000);
    waiting.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    sock.write(packet(id, type, body));
  });
}

function connect() {
  return new Promise((resolve, reject) => {
    const s = net.connect(conf.port, conf.host);
    s.once('error', reject);
    s.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const size = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const body = buf.toString('utf8', 12, 4 + size - 2);
        buf = buf.subarray(4 + size);
        if (type === 2 && id === -1) for (const w of waiting.values()) w.reject(new Error('RCON: неверный пароль'));
        const w = waiting.get(id);
        if (w) { waiting.delete(id); w.resolve(body); }
      }
    });
    s.on('close', () => {
      if (sock === s) sock = null;
      for (const w of waiting.values()) w.reject(new Error('RCON: соединение закрыто'));
      waiting.clear();
    });
    s.once('connect', async () => {
      sock = s;
      buf = Buffer.alloc(0);
      try { await request(3, conf.password); resolve(); } catch (e) { reject(e); }
    });
  });
}

let chain = Promise.resolve();
/** Выполнить консольную команду на сервере и вернуть её вывод. */
export function rcon(command) {
  const p = chain.then(async () => {
    if (!sock) await connect();
    return request(2, command);
  });
  chain = p.catch(() => {});
  return p;
}

/** Выполнить Lua на сервере; скрипт должен вернуть таблицу, она придёт объектом. */
export async function lua(code, args = {}) {
  // Именно silent-command: обычная /c дублирует весь код в чат игрокам.
  const command = `/silent-command local A = helpers.json_to_table('${JSON.stringify(args).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}') local ok, res = pcall(function() ${code} end) rcon.print(helpers.table_to_json({ ok = ok, res = res }))`;
  let out = await rcon(command);
  // Самую первую Lua-команду на карте сервер отклоняет с предупреждением про достижения — повторяем.
  if (!out.trim()) out = await rcon(command);
  let parsed;
  try { parsed = JSON.parse(out); } catch { throw new Error(`Factorio: ${out.trim().slice(0, 500) || 'пустой ответ'}`); }
  if (!parsed.ok) throw new Error(`Lua: ${String(parsed.res).slice(0, 500)}`);
  return parsed.res;
}
