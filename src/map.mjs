// Веб-карта сервера Factorio (docs/web-map-tz.md): настоящая графика игры, живые метки ботов и игроков, сводка.
// Снаружи: http://h1.darkkeks.me/factorio-map/ (nginx в контейнере karoo-apk).
//
// Картинку даёт клиент-камера — полный клиент игры под Xvfb, подключённый к серверу зрителем (сервис сам его
// запускает и перезапускает). Сервис через RCON командует ему снимать тайлы и раздаёт их зрителям.
// В игре сервис ничего не меняет, кроме одного: переводит игрока-камеру в режим зрителя, чтобы у него не было персонажа.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { ROOT } from './config.mjs';
import { lua } from './rcon.mjs';

const { WebSocketServer } = createRequire(import.meta.url)('ws');

const HOST = process.env.MAP_HOST || '172.25.0.1'; // шлюз docker-сети: виден nginx, не виден из интернета
const PORT = Number(process.env.MAP_PORT || 8766);
const SURFACE = 'nauvis';
const CAMERA = process.env.MAP_CAMERA || 'camera'; // имя игрока-камеры: на карте не показывается
const GAME_DATA = process.env.FACTORIO_DATA || path.join(os.homedir(), 'robot/factorio/space-age-1/factorio/data');
const SERVER_SETTINGS = path.join(os.homedir(), 'robot/factorio/space-age-1/server-settings.json'); // отсюда пароль игры
const GAME_ADDR = process.env.GAME_ADDR || '127.0.0.1:34197';
const CAMERA_DIR = process.env.CAMERA_DIR || path.join(os.homedir(), 'factorio-camera'); // внутри — factorio/ (полная копия игры)
const CAMERA_MANAGE = process.env.CAMERA_MANAGE !== '0';   // 0 — клиент-камеру запускают руками
const CAMERA_CPUS = process.env.CAMERA_CPUS || '6,7';      // ядра, на которых живёт клиент
const CAMERA_WINDOW = '640x480';                           // окно клиента; размер снимков от него не зависит
const CAMERA_START_MS = 240_000;                           // сколько ждать подключения после запуска
const CAMERA_RETRY_MS = 900_000;                           // пауза после неудачного запуска (сервер не пускает); перезапуск сервера её сбрасывает
const SHOT_DIR = 'map-shots';                              // подпапка script-output клиента
const SHOTS = path.join(CAMERA_DIR, 'factorio/script-output', SHOT_DIR);
const TILES = process.env.MAP_TILES || path.join(CAMERA_DIR, 'tiles');
const PID_FILE = path.join(CAMERA_DIR, 'camera.pid');
const WEB = path.join(ROOT, 'src/map-web');

const TILE = 512;              // размер тайла в пикселях
const ZMAX = 5;                // самый подробный уровень: масштаб игры 1, 32 пикселя на клетку
                               // уровень 0 — масштаб 1/32, меньше игра снимать не умеет
const JPEG_QUALITY = 75;
const FRESH_MS = 5_000;        // цель для участков в поле зрения и вокруг ботов и игроков
const SWEEP_MS = 600_000;      // цель полного фонового обхода
const BATCH = 8;               // снимков в одной команде RCON
const PAUSE_MS = 20;           // пауза между пачками
const SHOT_TIMEOUT_MS = 20_000;
const VIEW_TILES = 80;         // сколько тайлов одного зрителя считать приоритетными
const MAX_CLIENTS = 50;

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (v) => (Array.isArray(v) ? v : []); // пустая таблица Lua приходит объектом {}

// ---------- Lua (только чтение) ----------

const LUA = {
  live: `
    local out = {tick=game.tick, paused=game.tick_paused, bots={}, players={}, chat={}}
    for name, e in pairs(storage.vb or {}) do
      if e.valid then out.bots[#out.bots+1] = {name=name, x=e.position.x, y=e.position.y, surface=e.surface.name} end
    end
    for _, p in pairs(game.connected_players) do
      if p.name ~= A.camera then out.players[#out.players+1] = {name=p.name, x=p.position.x, y=p.position.y, surface=p.surface.name} end
    end
    local cam = game.get_player(A.camera)
    if cam then out.camera = {connected=cam.connected, spectator=cam.controller_type == defines.controllers.spectator} end
    local c = storage.vb_chat
    out.seq = c and c.seq or 0
    if c then for _, m in pairs(c.items) do if m.seq > A.since then out.chat[#out.chat+1] = {seq=m.seq, from=m.from, text=m.text} end end end
    return out`,

  bot: `
    local e = (storage.vb or {})[A.name]
    if not e or not e.valid then return {missing=true} end
    local inv = {}
    local main = e.get_main_inventory()
    if main then for _, s in pairs(main.get_contents()) do inv[s.name] = (inv[s.name] or 0) + s.count end end
    local queue = {}
    if e.crafting_queue then for _, q in pairs(e.crafting_queue) do queue[#queue+1] = {recipe=q.recipe, count=q.count} end end
    return {x=e.position.x, y=e.position.y, health=e.health, max_health=e.max_health, inventory=inv, queue=queue,
      walking=e.walking_state.walking, mining=e.mining_state.mining}`,

  summary: `
    local s, f = game.surfaces[A.surface], game.forces.player
    local out = {research={queue={}}, power={networks=0, production_kw=0, consumption_kw=0}, alerts={}}
    if f.current_research then out.research.current = f.current_research.name out.research.progress = f.research_progress end
    for _, q in pairs(f.research_queue) do out.research.queue[#out.research.queue+1] = q.name end
    local idx, seen = defines.flow_precision_index.five_seconds, {}
    for _, p in pairs(s.find_entities_filtered{type='electric-pole', force=f}) do
      local id = p.electric_network_id
      if id and not seen[id] then
        seen[id] = true
        local st = p.electric_network_statistics
        local function sum(counts, cat)
          local t = 0
          for name in pairs(counts) do t = t + st.get_flow_count{name=name, category=cat, precision_index=idx} * 60 end
          return t / 1000
        end
        out.power.networks = out.power.networks + 1
        out.power.production_kw = out.power.production_kw + sum(st.output_counts, 'output')
        out.power.consumption_kw = out.power.consumption_kw + sum(st.input_counts, 'input')
      end
    end
    local MAJOR = {no_fuel=true, no_power=true, low_power=true, not_plugged_in_electric_network=true, no_minable_resources=true,
      missing_science_packs=true, no_ammo=true, no_input_fluid=true, missing_required_fluid=true}
    local TYPES = {'mining-drill', 'furnace', 'assembling-machine', 'lab', 'boiler', 'generator', 'burner-generator', 'reactor',
      'offshore-pump', 'pump', 'inserter', 'rocket-silo', 'ammo-turret', 'electric-turret', 'radar', 'beacon'}
    local names = {}
    for k, v in pairs(defines.entity_status) do names[v] = k end
    local groups = {}
    for _, c in pairs(s.find_entities_filtered{force=f, type=TYPES}) do
      local st
      pcall(function() st = names[c.status] end)
      if st and MAJOR[st] then
        local k = st..'|'..c.name
        local g = groups[k]
        if not g then g = {status=st, name=c.name, count=0, x=c.position.x, y=c.position.y} groups[k] = g out.alerts[#out.alerts+1] = g end
        g.count = g.count + 1
      end
    end
    return out`,

  chunks: `
    local s, f, out = game.surfaces[A.surface], game.forces.player, {}
    for c in s.get_chunks() do if f.is_chunk_charted(s, c) then out[#out+1] = c.x out[#out+1] = c.y end end
    return out`,

  // Снимки пачкой. Команда выполняется у всех, но рисует и пишет файл только клиент игрока-камеры.
  shots: `
    for _, s in pairs(A.shots) do
      game.take_screenshot{player=A.camera, surface=A.surface, position={s[1], s[2]}, zoom=s[3], resolution={A.size, A.size},
        path=A.dir..'/'..s[4], quality=A.quality, show_entity_info=true, daytime=0, show_gui=false}
    end
    return {n=#A.shots}`,

  // Единственное изменение в игре: камера входит с персонажем, как любой новый игрок, — делаем её зрителем.
  spectate: `
    local p = game.get_player(A.camera)
    if p and p.controller_type ~= defines.controllers.spectator then
      local c = p.character
      p.set_controller{type=defines.controllers.spectator}
      if c and c.valid then c.destroy() end
    end
    return {ok=true}`,
};

// ---------- состояние ----------

const tiles = new Map();   // "z/x/y" -> { z, x, y, ts } — все тайлы, задевающие разведанные чанки; ts — когда снят
let charted = [];          // разведанные чанки: x, y, x, y, …
let pausedAt = 0;          // когда игра встала на паузу (0 — идёт)
const clients = new Set();
let live = { tick: 0, paused: false, bots: [], players: [], ok: false, camera: false };
let summary = null;
let events = [];           // лента: сообщения ботов и решения по заявкам из игрового чата ботов
let chatSeq = 0;
let rendered = 0;

const send = (ws, msg) => { if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify({ ...msg, now: Date.now() }); for (const ws of clients) if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(s); };

// ---------- живой слой, сводка ----------

async function liveLoop() {
  for (;;) {
    try {
      const r = await lua(LUA.live, { camera: CAMERA, since: chatSeq });
      const here = (a) => list(a).filter((p) => p.surface === SURFACE).map((p) => ({ name: p.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2) }));
      if (!live.ok) nextStart = 0; // сервер игры снова отвечает — камеру можно пробовать сразу
      if (r.paused && !pausedAt) pausedAt = Date.now();
      if (!r.paused) pausedAt = 0;
      if (r.camera?.connected && !r.camera.spectator) { await lua(LUA.spectate, { camera: CAMERA }); log('камера переведена в режим зрителя'); }
      live = { tick: r.tick, paused: r.paused, bots: here(r.bots), players: here(r.players), ok: true, camera: !!r.camera?.connected };
      const fresh = list(r.chat).map((m) => ({ seq: m.seq, from: m.from, text: String(m.text).slice(0, 600), at: Date.now() }));
      if (r.seq < chatSeq) { chatSeq = 0; events = []; } // карту сменили
      else if (fresh.length) {
        const first = chatSeq === 0; // история до запуска сервиса: время сообщений неизвестно
        chatSeq = r.seq;
        if (first) fresh.forEach((m) => { m.at = null; });
        events = events.concat(fresh).slice(-100);
        broadcast({ t: 'events', items: fresh });
      } else chatSeq = r.seq;
    } catch (e) {
      if (live.ok) log('живой слой:', e.message);
      live = { ...live, ok: false, camera: false };
    }
    broadcast({ t: 'live', ...live });
    await sleep(1000);
  }
}

async function summaryLoop() {
  for (;;) {
    try {
      const r = await lua(LUA.summary, { surface: SURFACE });
      summary = {
        research: { current: r.research.current ?? null, progress: r.research.progress ?? 0, queue: list(r.research.queue) },
        power: { networks: r.power.networks, production_kw: Math.round(r.power.production_kw), consumption_kw: Math.round(r.power.consumption_kw) },
        alerts: list(r.alerts).sort((a, b) => b.count - a.count).slice(0, 30).map((a) => ({ ...a, x: Math.round(a.x), y: Math.round(a.y) })),
      };
      broadcast({ t: 'summary', summary });
    } catch (e) { log('сводка:', e.message); }
    await sleep(5000);
  }
}

// Строки бота из логов: вызовы инструментов и его собственный текст. Реплики людей (🎤) не отдаём.
function botLog(name) {
  let best = [], bestTime = 0;
  for (const file of ['bot.log', 'mcp.log']) {
    let text, mtime;
    try {
      const fd = fs.openSync(path.join(ROOT, file), 'r');
      const st = fs.fstatSync(fd);
      const buf = Buffer.alloc(Math.min(st.size, 400_000));
      fs.readSync(fd, buf, 0, buf.length, st.size - buf.length);
      fs.closeSync(fd);
      text = buf.toString('utf8');
      mtime = st.mtimeMs;
    } catch { continue; }
    const entries = [];
    let cur = null;
    for (const line of text.split('\n').slice(1)) {
      const m = line.match(/^(\d\d:\d\d:\d\d)\.\d{3} (\S+) (.*)$/);
      if (m) {
        cur = null;
        const tool = m[2] === '🔧' && m[3].startsWith(name + ' '), said = m[2] === '🤖' && m[3].startsWith(name + ': ');
        if (tool || said) { cur = { time: m[1], kind: tool ? 'tool' : 'text', text: m[3].slice(name.length + (tool ? 1 : 2)) }; entries.push(cur); }
      } else if (cur && cur.kind === 'text') cur.text += '\n' + line;
    }
    // Бот пишет либо в один лог, либо в другой; если есть в обоих — берём тот, что свежее.
    if (entries.length && mtime > bestTime) { best = entries; bestTime = mtime; }
  }
  return best.slice(-12).map((e) => ({ time: e.time, kind: e.kind, text: e.text.trim().slice(0, 400) }));
}

async function botInfo(name) {
  const r = await lua(LUA.bot, { name });
  if (r.missing) return null;
  return {
    name, x: r.x, y: r.y, health: Math.round(r.health), max_health: Math.round(r.max_health), walking: r.walking, mining: r.mining,
    inventory: Array.isArray(r.inventory) ? {} : r.inventory, queue: list(r.queue), log: botLog(name),
  };
}

// ---------- подложка: снимки клиента-камеры ----------
// Тайл уровня z — снимок 512×512 с масштабом 2^(z-ZMAX): на ZMAX это 32 пикселя на клетку и 16 клеток на тайл.
// Игра сама пишет готовые JPEG в script-output клиента-камеры, сервис только раскладывает их по местам.

const key = (z, x, y) => `${z}/${x}/${y}`;
const tileFile = (z, x, y) => path.join(TILES, String(z), `${x}_${y}.jpg`);
const span = (z) => 16 * 2 ** (ZMAX - z); // клеток в стороне тайла

function rebuildTileSet(chunkList) {
  const want = new Set();
  for (const [cx, cy] of chunkList) {
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) {
      let x = cx * 2 + dx, y = cy * 2 + dy;
      for (let z = ZMAX; z >= 0; z--) { want.add(key(z, x, y)); x >>= 1; y >>= 1; }
    }
  }
  for (const k of want) {
    if (tiles.has(k)) continue;
    const [z, x, y] = k.split('/').map(Number);
    let ts = 0;
    try { ts = Math.floor(fs.statSync(tileFile(z, x, y)).mtimeMs); } catch { /* ещё не снят */ }
    tiles.set(k, { z, x, y, ts });
  }
  for (const k of tiles.keys()) if (!want.has(k)) tiles.delete(k);
}

async function chunkListLoop() {
  let last = '';
  for (;;) {
    try {
      const flat = list(await lua(LUA.chunks, { surface: SURFACE }));
      if (flat.join() !== last) {
        last = flat.join();
        charted = flat;
        const pairs = [];
        for (let i = 0; i < flat.length; i += 2) pairs.push([flat[i], flat[i + 1]]);
        rebuildTileSet(pairs);
        broadcast({ t: 'chunks', chunks: charted });
      }
    } catch (e) { log('список чанков:', e.message); }
    await sleep(30_000);
  }
}

// Приоритеты: 1) поле зрения зрителей, 2) окрестности ботов и игроков, 3) фоновый обход.
function pick() {
  const hot = new Set();
  const s = span(ZMAX);
  for (const a of [...live.bots, ...live.players]) {
    // Четыре ближайших тайла самого подробного уровня: 32×32 клетки вокруг.
    const x = Math.round(a.x / s), y = Math.round(a.y / s);
    for (let dx = -1; dx <= 0; dx++) for (let dy = -1; dy <= 0; dy++) hot.add(key(ZMAX, x + dx, y + dy));
  }
  for (const ws of clients) for (const k of ws.view ?? []) hot.add(k);
  const now = Date.now(), due = [];
  for (const [k, t] of tiles) {
    if (live.paused && pausedAt && t.ts > pausedAt) continue; // на паузе картинка не меняется
    const score = (now - t.ts) / (hot.has(k) ? FRESH_MS : SWEEP_MS);
    if (score >= 1) due.push([t.ts === 0 && hot.has(k) ? Infinity : score, t]);
  }
  due.sort((a, b) => b[0] - a[0]);
  return due.slice(0, BATCH).map((d) => d[1]);
}

const jpegDone = (file) => {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size, end = Buffer.alloc(2);
      if (size < 4) return false;
      fs.readSync(fd, end, 0, 2, size - 2);
      return end[0] === 0xff && end[1] === 0xd9;
    } finally { fs.closeSync(fd); }
  } catch { return false; }
};

let shotId = 0, failures = 0;
async function renderBatch(batch) {
  const shots = batch.map((t) => {
    const s = span(t.z);
    return { t, name: `${++shotId}.jpg`, args: [(t.x + 0.5) * s, (t.y + 0.5) * s, 2 ** (t.z - ZMAX)] };
  });
  await lua(LUA.shots, { camera: CAMERA, surface: SURFACE, dir: SHOT_DIR, size: TILE, quality: JPEG_QUALITY, shots: shots.map((s) => [...s.args, s.name]) });
  const deadline = Date.now() + SHOT_TIMEOUT_MS, updates = [];
  let left = shots;
  while (left.length && Date.now() < deadline) {
    await sleep(15);
    left = left.filter((s) => {
      const src = path.join(SHOTS, s.name);
      if (!jpegDone(src)) return true;
      fs.mkdirSync(path.join(TILES, String(s.t.z)), { recursive: true });
      fs.renameSync(src, tileFile(s.t.z, s.t.x, s.t.y));
      s.t.ts = Date.now();
      updates.push([s.t.z, s.t.x, s.t.y, s.t.ts]);
      rendered++;
      return false;
    });
  }
  if (updates.length) broadcast({ t: 'tiles', up: updates });
  if (left.length) {
    failures++;
    log(`снимки не пришли: ${left.length} из ${shots.length} (подряд неудач: ${failures})`);
    for (const s of left) fs.rmSync(path.join(SHOTS, s.name), { force: true });
  } else failures = 0;
}

async function renderLoop() {
  for (;;) {
    const batch = live.ok && live.camera ? pick() : [];
    if (batch.length) {
      try { await renderBatch(batch); } catch (e) { log('перерисовка:', e.message); await sleep(2000); }
    }
    await sleep(batch.length ? PAUSE_MS : 300);
  }
}

// ---------- клиент-камера ----------
// Полный клиент игры под Xvfb, подключённый к серверу зрителем. Сам он после обрыва связи не переподключается
// (остаётся в меню), поэтому сервис следит за ним через RCON и перезапускает.

let camera = null;          // { pid, since }
let cameraSeen = 0;         // когда камера последний раз была в игре
let nextStart = 0;

function gamePassword() {
  if (process.env.GAME_PASSWORD !== undefined) return process.env.GAME_PASSWORD;
  try { return JSON.parse(fs.readFileSync(SERVER_SETTINGS, 'utf8')).game_password ?? ''; } catch { return ''; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

function startCamera() {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const bin = path.join(CAMERA_DIR, 'factorio/bin/x64/factorio');
  const args = ['-n', '10', 'taskset', '-c', CAMERA_CPUS, 'xvfb-run', '-a', '-s', `-screen 0 ${CAMERA_WINDOW}x24`,
    bin, '--mp-connect', GAME_ADDR, '--disable-audio', '--window-size', CAMERA_WINDOW];
  const pw = gamePassword();
  if (pw) args.push('--password', pw);
  const env = { ...process.env };
  delete env.LD_LIBRARY_PATH; // чужие библиотеки из окружения ломают системный Mesa
  const out = fs.openSync(path.join(CAMERA_DIR, 'camera.log'), 'a');
  const child = spawn('nice', args, { cwd: CAMERA_DIR, env, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child.unref();
  child.on('exit', (code) => { if (camera?.pid === child.pid) { log(`клиент-камера завершился (код ${code})`); camera = null; nextStart = Date.now() + 20_000; } });
  camera = { pid: child.pid, since: Date.now() };
  fs.writeFileSync(PID_FILE, String(child.pid));
  log(`клиент-камера запущен (группа процессов ${child.pid})`);
}

function stopCamera(why) {
  if (!camera) return;
  log(`останавливаю клиент-камеру: ${why}`);
  try { process.kill(-camera.pid, 'SIGTERM'); } catch { /* уже нет */ }
  const pid = camera.pid;
  setTimeout(() => { try { process.kill(-pid, 'SIGKILL'); } catch { /* уже нет */ } }, 10_000).unref();
  camera = null;
  nextStart = Date.now() + 20_000;
}

async function cameraLoop() {
  if (!CAMERA_MANAGE) return;
  // Клиент мог остаться от прошлого запуска сервиса — подхватываем его.
  try { const pid = Number(fs.readFileSync(PID_FILE, 'utf8')); if (pid && alive(pid)) { camera = { pid, since: Date.now() }; log(`подхватил работающий клиент-камеру (${pid})`); } } catch { /* нет файла */ }
  for (;;) {
    await sleep(5000);
    const now = Date.now();
    if (camera && !alive(camera.pid)) { log('клиент-камера больше не работает'); camera = null; }
    if (live.ok && live.camera) {
      cameraSeen = now;
      if (failures >= 5) { failures = 0; stopCamera('не отдаёт снимки'); }
    } else if (camera) {
      if (cameraSeen > camera.since && now - cameraSeen > 30_000) stopCamera(live.ok ? 'отключился от сервера' : 'сервер игры не отвечает');
      else if (now - camera.since > CAMERA_START_MS) { stopCamera('не подключился за отведённое время'); nextStart = now + CAMERA_RETRY_MS; }
    } else if (live.ok && now >= nextStart) {
      try { startCamera(); } catch (e) { log('не смог запустить клиент-камеру:', e.message); nextStart = now + 60_000; }
    }
  }
}

// ---------- названия на русском из файлов игры ----------

function loadNames() {
  const out = {};
  const want = { 'item-name': 1, 'entity-name': 1, 'fluid-name': 1, 'recipe-name': 1, 'technology-name': 1 };
  let mods = [];
  try { mods = fs.readdirSync(GAME_DATA); } catch { return out; }
  for (const mod of mods) {
    const dir = path.join(GAME_DATA, mod, 'locale/ru');
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.cfg')); } catch { continue; }
    for (const f of files) {
      let section = '';
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        const s = line.match(/^\[(.+)\]\s*$/);
        if (s) { section = s[1]; continue; }
        const m = want[section] && line.match(/^([^=;#]+)=(.+)$/);
        if (m && !/__\d|__[A-Z]/.test(m[2]) && (section !== 'entity-name' || !out[m[1]])) out[m[1].trim()] ??= m[2].trim();
      }
    }
  }
  return out;
}
const NAMES = JSON.stringify(loadNames());

// ---------- HTTP и WebSocket ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const reply = (code, type, body, cache = 'no-cache') => res.writeHead(code, { 'content-type': type, 'cache-control': cache }).end(body);
  try {
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'text/plain', '');
    if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(WEB, 'index.html')));
    if (url.pathname === '/names.json') return reply(200, 'application/json', NAMES, 'max-age=3600');
    const t = url.pathname.match(/^\/tiles\/(\d)\/(-?\d{1,6})\/(-?\d{1,6})\.jpg$/);
    if (t) {
      if (!tiles.get(key(+t[1], +t[2], +t[3]))?.ts) return reply(404, 'text/plain', '');
      let body;
      try { body = fs.readFileSync(tileFile(+t[1], +t[2], +t[3])); } catch { return reply(404, 'text/plain', ''); }
      // Версия в адресе (?v=), поэтому сам файл можно кешировать навсегда.
      return reply(200, 'image/jpeg', body, url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    if (url.pathname === '/api/bot') {
      const name = url.searchParams.get('name') ?? '';
      if (!live.bots.some((b) => b.name === name)) return reply(404, 'application/json', '{"error":"нет такого бота"}');
      const info = await botInfo(name);
      return info ? reply(200, 'application/json', JSON.stringify(info)) : reply(404, 'application/json', '{"error":"нет такого бота"}');
    }
    reply(404, 'text/plain', '');
  } catch (e) {
    log('запрос', url.pathname, e.message);
    if (!res.headersSent) reply(500, 'text/plain', '');
  }
});

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2048 });
wss.on('connection', (ws) => {
  if (clients.size >= MAX_CLIENTS) return ws.close(1013, 'слишком много зрителей');
  clients.add(ws);
  const tl = [];
  for (const t of tiles.values()) tl.push([t.z, t.x, t.y, t.ts]);
  send(ws, { t: 'hello', zmax: ZMAX, tile: TILE, surface: SURFACE, fresh_ms: FRESH_MS, sweep_ms: SWEEP_MS, tiles: tl, chunks: charted, summary, events, live, now: Date.now() });
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data);
      if (m.t !== 'view' || ![m.x1, m.y1, m.x2, m.y2, m.z].every(Number.isFinite)) return;
      const z = Math.max(0, Math.min(ZMAX, Math.round(m.z))), s = span(z);
      const x1 = Math.floor(Math.min(m.x1, m.x2) / s), x2 = Math.floor(Math.max(m.x1, m.x2) / s);
      const y1 = Math.floor(Math.min(m.y1, m.y2) / s), y2 = Math.floor(Math.max(m.y1, m.y2) / s);
      if ((x2 - x1 + 1) * (y2 - y1 + 1) > 4096) return;
      const mx = (x1 + x2) / 2, my = (y1 + y2) / 2, view = [];
      for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) if (tiles.has(key(z, x, y))) view.push([x, y]);
      // Слишком широкий вид целиком за 5 секунд не обновить: приоритет получают тайлы ближе к центру.
      view.sort((a, b) => Math.hypot(a[0] - mx, a[1] - my) - Math.hypot(b[0] - mx, b[1] - my));
      ws.view = view.slice(0, VIEW_TILES).map(([x, y]) => key(z, x, y));
    } catch { /* мусор от клиента игнорируем */ }
  });
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, HOST, () => log(`карта слушает http://${HOST}:${PORT}`));
setInterval(() => { log(`зрителей ${clients.size}, тайлов ${tiles.size}, снято за минуту ${rendered}, камера ${live.camera ? 'в игре' : 'не в игре'}`); rendered = 0; }, 60_000);
// Штатная остановка сервиса останавливает и клиент-камеру; после падения сервиса клиент остаётся, и следующий запуск его подхватит.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (camera) { try { process.kill(-camera.pid, 'SIGTERM'); } catch { /* уже нет */ } fs.rmSync(PID_FILE, { force: true }); }
    process.exit(0);
  });
}
fs.mkdirSync(TILES, { recursive: true });
liveLoop(); chunkListLoop(); summaryLoop(); renderLoop(); cameraLoop();
