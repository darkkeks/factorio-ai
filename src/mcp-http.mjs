// Те же инструменты Factorio для внешних клиентов: MCP по HTTP (streamable HTTP, без сессий).
// Каждый токен из mcp-tokens.json привязан к одному персонажу: { "токен": "имя персонажа" }.
// Снаружи доступен как http://h1.darkkeks.me/factorio-mcp/ (nginx в контейнере karoo-apk).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ROOT, VOICE_HEARTBEAT } from './config.mjs';
import { createFactorioServer, stopOrphans, busyBots } from './factorio.mjs';

const HOST = process.env.MCP_HOST || '172.25.0.1'; // шлюз docker-сети server-stuff_default: виден nginx, не виден из интернета
const PORT = Number(process.env.MCP_PORT || 8765);
const TOKENS_FILE = path.join(ROOT, 'mcp-tokens.json');
// Перед нами два nginx с таймаутом 60 с, поэтому долгие действия сворачиваем раньше: клиент просто вызовет ещё раз.
const MAX_CALL_MS = 40_000;

const stamp = () => new Date().toISOString().slice(11, 23);
const chatSeen = new Map(); // персонаж -> экземпляр с памятью о прочитанном чате

function botFor(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf8')); } catch { /* нет файла — нет доступа */ }
  return Object.hasOwn(tokens, token) && token ? tokens[token] : null;
}

http.createServer(async (req, res) => {
  const bot = botFor(req);
  if (!bot) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
  if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
  const started = Date.now();
  let gone = false;
  res.on('close', () => { if (!res.writableFinished) gone = true; });
  // Снаружи запросы приходят через nginx (он добавляет X-Forwarded-For); сессии голосового бота ходят напрямую.
  const external = Boolean(req.headers['x-forwarded-for']);
  // Пока внешний бот действует, игра не должна стоять на паузе (см. pause-guard в контейнере robot).
  const activity = () => { try { fs.writeFileSync(VOICE_HEARTBEAT, new Date().toISOString()); } catch { /* не критично */ } };
  // Один экземпляр инструментов на персонажа, чтобы read_chat помнил, что уже прочитано.
  const fx = createFactorioServer(bot, {
    log: (line) => console.log(stamp(), line),
    // Клиент отключился (скрипт убили, саб-агента остановили) — действие сворачиваем, тело освобождаем.
    aborted: () => gone || (external && Date.now() - started > MAX_CALL_MS),
    activity,
    // Голосовым сессиям чат доставляет сам голосовой бот; чтение чата инструментом — только внешним клиентам.
    chatTool: external ? (chatSeen.get(bot) || chatSeen.set(bot, { seq: 0 }).get(bot)) : undefined,
  });
  try {
    let body = '';
    for await (const chunk of req) body += chunk;
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); fx.server.instance.close(); });
    await fx.server.instance.connect(transport);
    await transport.handleRequest(req, res, JSON.parse(body));
  } catch (e) {
    console.log(stamp(), `${bot}: ошибка запроса: ${e.message}`);
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: e.message }, id: null }));
  }
}).listen(PORT, HOST, () => console.log(stamp(), `MCP Factorio слушает http://${HOST}:${PORT}`));

// Страховка: персонаж, который идёт, хотя ни один вызов его не ведёт (оборванная ходьба, перезапуск этого процесса),
// иначе уходил бы по прямой бесконечно.
setInterval(() => {
  // Пока хоть один персонаж занят делом, игра не должна вставать на паузу, даже если людей нет.
  if (busyBots().length) { try { fs.writeFileSync(VOICE_HEARTBEAT, new Date().toISOString()); } catch { /* не критично */ } }
  stopOrphans().then((names) => { if (Array.isArray(names) && names.length) console.log(stamp(), `остановлена бесхозная ходьба: ${names.join(', ')}`); }, () => {});
}, 3000);
