#!/usr/bin/env node
// Токены доступа к интерфейсу ботов. Один токен — один персонаж; токен выдаёт администратор, владелец бота
// хранит его у себя. Файл токенов сервер ботов перечитывает сам, перезапуск не нужен.
//   token.mjs add <имя персонажа>      выдать токен (персонаж появится в игре при первом обращении)
//   token.mjs list                     кому выданы токены
//   token.mjs revoke <имя персонажа>   отозвать все токены персонажа (сам персонаж в игре остаётся)
//   token.mjs admin                    выдать токен администратора (операции metrics, show, pause_if_idle)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const confPath = process.env.V2_CONFIG || path.join(HERE, '../server/config.json');
const conf = JSON.parse(fs.readFileSync(confPath, 'utf8'));
const FILE = path.resolve(path.dirname(confPath), conf.tokens || 'tokens.json');
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; } };
const save = (t) => fs.writeFileSync(FILE, JSON.stringify(t, null, 2), { mode: 0o600 });
const url = conf.publicUrl || `http://${conf.http.host}:${conf.http.port}`;

const [cmd, ...rest] = process.argv.slice(2);
const name = rest.join(' ').trim();
const tokens = load();
if (cmd === 'add' && name) {
  if (Object.values(tokens).includes(name)) { console.error(`у персонажа «${name}» уже есть токен; отозвать — revoke, затем add`); process.exit(1); }
  const token = crypto.randomBytes(24).toString('base64url');
  tokens[token] = name;
  save(tokens);
  console.log(`Персонаж: ${name}\nАдрес:    ${url}\nТокен:    ${token}\n\nПроверка:  curl -s -X POST ${url}/v2/status -H "Authorization: Bearer ${token}" -d '{}'\nОписание:  curl -s ${url}/v2/help`);
} else if (cmd === 'admin') {
  const token = crypto.randomBytes(24).toString('base64url');
  tokens[token] = { admin: true };
  save(tokens);
  console.log(`Токен администратора: ${token}`);
} else if (cmd === 'revoke' && name) {
  const hit = Object.keys(tokens).filter((t) => tokens[t] === name);
  for (const t of hit) delete tokens[t];
  save(tokens);
  console.log(hit.length ? `отозвано токенов: ${hit.length} («${name}»)` : `у «${name}» токенов нет`);
} else if (cmd === 'list') {
  for (const [t, v] of Object.entries(tokens)) console.log(`${t.slice(0, 4)}…${t.slice(-3)}  ${typeof v === 'string' ? v : '(администратор)'}`);
} else {
  console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 8).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
  process.exit(1);
}
