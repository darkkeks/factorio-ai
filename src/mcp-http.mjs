// Те же инструменты Factorio для внешних клиентов: MCP по HTTP (streamable HTTP, без сессий).
// Каждый токен из mcp-tokens.json привязан к одному персонажу: { "токен": "имя персонажа" }.
// Снаружи доступен как http://h1.darkkeks.me/factorio-mcp/ (nginx в контейнере karoo-apk).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ROOT, VOICE_HEARTBEAT } from './config.mjs';
import { createFactorioServer, stopOrphans, gameNeeded } from './factorio.mjs';

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

// Сессии MCP для клиентов Claude Code внутри контейнера. Нужны ради одного: после перезапуска этого процесса старый
// идентификатор сессии неизвестен, клиент получает 404, подключается заново и перечитывает список инструментов —
// так новые инструменты появляются у работающих ботов без перезапуска их сессий.
const live = new Map(); // id сессии MCP -> { transport, state }

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body ? JSON.parse(body) : undefined;
}

http.createServer(async (req, res) => {
  const bot = botFor(req);
  if (!bot) { res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":"unauthorized"}'); return; }
  // Снаружи запросы приходят через nginx (он добавляет X-Forwarded-For); сессии голосового бота ходят напрямую.
  const external = Boolean(req.headers['x-forwarded-for']);
  const sid = req.headers['mcp-session-id'];
  try {
    // ── Запрос в рамках сессии MCP ──
    if (sid) {
      const s = live.get(sid);
      if (!s) { res.writeHead(404, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message: 'Session not found' }, id: null })); return; }
      // Клиент оборвал запрос (саб-агента остановили) — идущее действие сворачиваем, тело освобождаем.
      res.on('close', () => { if (!res.writableFinished && req.method === 'POST') s.state.abortUntil = Date.now() + 1000; });
      await s.transport.handleRequest(req, res, req.method === 'POST' ? await readBody(req) : undefined);
      return;
    }
    if (req.method !== 'POST') { res.writeHead(405, { allow: 'POST' }).end(); return; }
    const body = await readBody(req);

    // ── Начало сессии: клиент Claude Code из контейнера ──
    if (!external && !Array.isArray(body) && body?.method === 'initialize') {
      const state = { abortUntil: 0 };
      const fx = createFactorioServer(bot, { log: (line) => console.log(stamp(), line), aborted: () => Date.now() < state.abortUntil });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id) => live.set(id, { transport, state }),
      });
      transport.onclose = () => { if (transport.sessionId) live.delete(transport.sessionId); };
      await fx.server.instance.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    // ── Разовый запрос без сессии: внешние клиенты и команда fx ──
    const started = Date.now();
    let gone = false;
    res.on('close', () => { if (!res.writableFinished) gone = true; });
    const fx = createFactorioServer(bot, {
      log: (line) => console.log(stamp(), line),
      // Клиент отключился (скрипт убили) — действие сворачиваем; снаружи ещё и укладываемся в таймауты nginx.
      aborted: () => gone || (external && Date.now() - started > MAX_CALL_MS),
      // Голосовым сессиям чат доставляет хозяин сессий; чтение чата инструментом — только внешним клиентам.
      chatTool: external ? (chatSeen.get(bot) || chatSeen.set(bot, { seq: 0 }).get(bot)) : undefined,
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); fx.server.instance.close(); });
    await fx.server.instance.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (e) {
    console.log(stamp(), `${bot}: ошибка запроса: ${e.message}`);
    if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: e.message }, id: null }));
  }
}).listen(PORT, HOST, () => console.log(stamp(), `MCP Factorio слушает http://${HOST}:${PORT}`));

// Страховка: персонаж, который идёт, хотя ни один вызов его не ведёт (оборванная ходьба, перезапуск этого процесса),
// иначе уходил бы по прямой бесконечно.
setInterval(() => {
  // Игра идёт без людей, только пока хоть один персонаж занят делом (действие, ожидание, крафт). Справочные вызовы
  // её не будят: иначе дозорный скрипт бота, опрашивающий турели, держал бы игру запущенной всю ночь.
  if (gameNeeded()) { try { fs.writeFileSync(VOICE_HEARTBEAT, new Date().toISOString()); } catch { /* не критично */ } }
  stopOrphans().then((names) => { if (Array.isArray(names) && names.length) console.log(stamp(), `остановлена бесхозная ходьба: ${names.join(', ')}`); }, () => {});
}, 3000);
