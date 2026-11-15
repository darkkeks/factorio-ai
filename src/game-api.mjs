// Доступ к серверу ботов (v2/server): токены персонажей и вызов операций от имени персонажа.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { API_URL, TOKENS_FILE } from './config.mjs';

/** Токен персонажа; если его ещё нет — выдаём. Файл токенов сервер ботов перечитывает сам. */
export function tokenFor(bot) {
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { /* файла ещё нет */ }
  let token = Object.keys(tokens).find((t) => tokens[t] === bot);
  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    tokens[token] = bot;
    fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
  return token;
}

/** Операция сервера ботов от имени персонажа: gameCall('Имя-бот', 'status'). Ошибка — исключение с её текстом. */
export async function gameCall(bot, op, body = {}) {
  const r = await fetch(new URL(`v2/${op}`, API_URL), {
    method: 'POST',
    headers: { authorization: `Bearer ${tokenFor(bot)}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error?.message || `HTTP ${r.status}`);
  return j;
}
