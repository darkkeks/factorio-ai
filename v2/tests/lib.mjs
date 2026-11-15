// Общие помощники тестов: вызовы HTTP-сервера ботов и консоль администратора тестового экземпляра.
import { Rcon } from '../server/rcon.mjs';

export const API = process.env.V2_API || 'http://127.0.0.1:8790';
export const admin = new Rcon({ port: Number(process.env.V2_RCON_PORT || 27115), password: process.env.V2_RCON_PW || 'test' });

export async function call(token, op, body = {}) {
  const t0 = performance.now();
  const r = await fetch(`${API}/v2/${op}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  j.http = r.status;
  j.ms = performance.now() - t0;
  return j;
}

/** Lua на тестовом сервере от имени администратора (только для подготовки и проверки тестов). */
export async function lua(code, args = {}) {
  const cmd = `/silent-command local A = helpers.json_to_table('${JSON.stringify(args).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}') local ok, res = pcall(function() ${code} end) rcon.print(helpers.table_to_json({ok = ok, res = res}))`;
  let out = await admin.command(cmd);
  if (!out.trim()) out = await admin.command(cmd);
  const p = JSON.parse(out);
  if (!p.ok) throw new Error(`Lua: ${p.res}`);
  return p.res;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : NaN; };
