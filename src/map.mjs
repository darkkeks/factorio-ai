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
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { ROOT } from './config.mjs';
import { makeLua } from './map-rcon.mjs';
import { layer, entityAt, loadLocale, LAYERS } from './map-inspect.mjs';

const { WebSocketServer } = createRequire(import.meta.url)('ws');
const lua = makeLua('map', 2); // опрос игры и команды камере

const HOST = process.env.MAP_HOST || '172.25.0.1'; // шлюз docker-сети: виден nginx, не виден из интернета
const PORT = Number(process.env.MAP_PORT || 8766);
const SURFACE = 'nauvis';
const CAMERA = process.env.MAP_CAMERA || 'camera'; // имя игрока-камеры: на карте не показывается
const GAME_DATA = process.env.FACTORIO_DATA || path.join(os.homedir(), 'robot/factorio/space-age-1/factorio/data');
const SERVER_SETTINGS = path.join(os.homedir(), 'robot/factorio/space-age-1/server-settings.json'); // отсюда пароль игры
const GAME_ADDR = process.env.GAME_ADDR || '127.0.0.1:34197';
const CAMERA_DIR = process.env.CAMERA_DIR || path.join(os.homedir(), 'factorio-camera'); // внутри — factorio/ (полная копия игры)
const CAMERA_MANAGE = process.env.CAMERA_MANAGE !== '0';   // 0 — клиент-камеру запускают руками
const CAMERA_CPUS = process.env.CAMERA_CPUS || '2-7';      // потоки процессора, на которых живёт клиент
const CAMERA_WINDOW = '1280x720';                          // окно клиента — кадр живого окна; размер снимков от него не зависит
const CAMERA_DISPLAY = process.env.CAMERA_DISPLAY || ':96'; // дисплей Xvfb клиента
const CAMERA_DATA = process.env.CAMERA_DATA || path.join(CAMERA_DIR, 'factorio'); // папка данных клиента (config, script-output)
const CAMERA_ZOOM = 0.75;                                  // масштаб живого окна: 24 пикселя на клетку, 53×30 клеток в кадре
const CAMERA_START_MS = 180_000;                           // сколько ждать подключения после запуска
const CAMERA_SLEEP_MS = Number(process.env.CAMERA_SLEEP_MS || 300_000); // игра на паузе дольше этого — клиент-камеру останавливаем
const CAMERA_RETRY_MS = 900_000;                           // пауза после неудачного запуска (сервер не пускает); перезапуск сервера её сбрасывает
const SHOT_DIR = 'map-shots';                              // подпапка script-output клиента
const SHOTS = path.join(CAMERA_DATA, 'script-output', SHOT_DIR);
const TILES = process.env.MAP_TILES || path.join(CAMERA_DIR, 'tiles');
const PID_FILE = path.join(CAMERA_DIR, 'camera.pid');
const WEB = path.join(ROOT, 'src/map-web');
const SESSIONS = process.env.CLAUDE_SESSIONS || path.join(os.homedir(), 'robot/.claude/projects/-home-robot'); // транскрипты сессий Claude ботов

const TILE = 512;              // размер тайла в пикселях
const ZMAX = 5;                // самый подробный уровень: масштаб игры 1, 32 пикселя на клетку
                               // уровень 0 — масштаб 1/32, меньше игра снимать не умеет
const JPEG_QUALITY = 75;
const FRESH_MS = 5_000;        // цель для участков вокруг ботов и игроков
const VIEW_MS = Number(process.env.MAP_VIEW_MS || 500); // чаще этого то, на что смотрят зрители, не переснимаем; реже — насколько хватает камеры:
                               // она делит свою скорость на всех, поэтому чем меньше зрителей и чем уже их вид, тем чаще обновление
const SWEEP_MS = 600_000;      // цель полного фонового обхода
const BATCH = Number(process.env.MAP_BATCH || 16);               // снимков в одной команде RCON
const PAUSE_MS = 20;           // пауза между пачками
const SHOT_TIMEOUT_MS = 20_000;
const VIEW_TILES = 80;         // сколько тайлов одного зрителя считать приоритетными
const MAX_CLIENTS = 50;
const VIDEO_FPS = 30;
const VIDEO_KBPS = 2000;
const VIDEO_IDLE_MS = 15_000;  // через сколько после ухода последнего зрителя живого окна останавливать кодирование
const AUTO_HOLD_MS = 20_000;   // камера сама не перескакивает между ботами чаще

const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(stamp(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = (v) => (Array.isArray(v) ? v : []); // пустая таблица Lua приходит объектом {}

// ---------- Lua (только чтение) ----------

const LUA = {
  live: `
    local out = {tick=game.tick, paused=game.tick_paused, bots={}, players={}, chat={}}
    -- По зерну генерации узнаём, что на сервере другая карта.
    out.map = tostring(game.surfaces[A.surface].map_gen_settings.seed)
    -- Чем занят бот — той же строкой, что мод показывает над его головой (v2/mod/agent/gui.lua, G.describe):
    -- первое действие очереди, цель ходьбы, сколько предметов уже обработано, сколько действий ждёт следом.
    local ACTIONS = {walk_to='идёт', mine='добывает', place='строит', build_ghosts='строит по плану', transfer='перекладывает',
      configure='настраивает', repair='чинит', wait='ждёт', craft='крафтит', say='говорит', research='исследования'}
    local agents = (storage.agent or {}).agents or {}
    local function describe(name, e)
      local A = agents[name]
      if not A then return nil end
      local text
      local act = A.queue and A.queue[1]
      if act then
        text = ACTIONS[act.type] or act.type
        local st = act.st
        if st then
          local w = st.w
          if w and w.goal then text = text .. ' → ' .. math.floor(w.goal.x) .. ', ' .. math.floor(w.goal.y) end
          if st.items then
            local done = 0
            for _, it in ipairs(st.items) do if it.state then done = done + 1 end end
            text = text .. ' ' .. done .. '/' .. #st.items
          end
        end
        if #A.queue > 1 then text = text .. ' (+' .. (#A.queue - 1) .. ')' end
      elseif e.crafting_queue_size > 0 then text = 'крафтит'
      else text = 'свободен' end
      return text
    end
    for name, e in pairs(storage.vb or {}) do
      if e.valid then
        local ok, act = pcall(describe, name, e)
        out.bots[#out.bots+1] = {name=name, x=e.position.x, y=e.position.y, surface=e.surface.name, act=ok and act or nil}
      end
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

  // Разведанные чанки и признак «виден прямо сейчас» (радар, игрок, бот): x, y, 0|1, …
  chunks: `
    local s, f, out = game.surfaces[A.surface], game.forces.player, {}
    for c in s.get_chunks() do
      if f.is_chunk_charted(s, c) then out[#out+1] = c.x out[#out+1] = c.y out[#out+1] = f.is_chunk_visible(s, c) and 1 or 0 end
    end
    return out`,

  // Содержимое чанков для схемы тумана войны: местность (по флагу, она меняется редко) и рамки сущностей
  // в восьмых долях клетки от угла чанка. С флагом no_enemy врагов не отдаём.
  chart: `
    local s = game.surfaces[A.surface]
    local SKIP = {character=true, corpse=true, ['character-corpse']=true, ['item-entity']=true, fish=true, ['entity-ghost']=true,
      ['tile-ghost']=true, ['item-request-proxy']=true, smoke=true, ['smoke-with-trigger']=true, particle=true, projectile=true,
      explosion=true, fire=true, sticker=true, ['flying-text']=true, beam=true, ['highlight-box']=true, ['speech-bubble']=true,
      unit=true, ['spider-unit']=true, car=true, ['spider-vehicle']=true}
    local floor = math.floor
    local res = {}
    for i, c in pairs(A.chunks) do
      local x0, y0 = c[1] * 32, c[2] * 32
      local r = {ents={}, enames={}}
      if c[3] then
        local idx, n, buf = {}, 0, {}
        r.tnames = {}
        for y = y0, y0 + 31 do for x = x0, x0 + 31 do
          local nm = s.get_tile(x, y).name
          local k = idx[nm]
          if not k then n = n + 1 k = n idx[nm] = k r.tnames[k] = nm end
          buf[#buf+1] = string.char(47 + k)
        end end
        r.tiles = table.concat(buf)
      end
      local idx, n, ents = {}, 0, r.ents
      for _, e in pairs(s.find_entities_filtered{area={{x0, y0}, {x0 + 32, y0 + 32}}}) do
        local fc = e.force.name
        if not SKIP[e.type] and not (c[4] and fc == 'enemy') then
          local k = idx[e.name]
          if not k then n = n + 1 k = n idx[e.name] = k r.enames[k] = e.name end
          local b = e.bounding_box
          local m = #ents
          ents[m+1] = k
          ents[m+2] = fc == 'player' and 1 or fc == 'enemy' and 2 or 0
          ents[m+3] = floor((b.left_top.x - x0) * 8 + 0.5)
          ents[m+4] = floor((b.left_top.y - y0) * 8 + 0.5)
          ents[m+5] = floor((b.right_bottom.x - x0) * 8 + 0.5)
          ents[m+6] = floor((b.right_bottom.y - y0) * 8 + 0.5)
        end
      end
      res[i] = r
    end
    return res`,

  // Цвета игровой карты для сущностей и местности.
  protos: `
    local out = {ents={}, tiles={}}
    for _, n in pairs(A.ents) do
      local p = prototypes.entity[n]
      if p then out.ents[n] = {type=p.type, m=p.map_color, f=p.friendly_map_color, e=p.enemy_map_color} end
    end
    for _, n in pairs(A.tiles) do
      local p = prototypes.tile[n]
      if p then out.tiles[n] = p.map_color end
    end
    return out`,

  // Снимки пачкой. Команда выполняется у всех, но рисует и пишет файл только клиент игрока-камеры.
  shots: `
    for _, s in pairs(A.shots) do
      game.take_screenshot{player=A.camera, surface=A.surface, position={s[1], s[2]}, zoom=s[3], resolution={A.size, A.size},
        path=A.dir..'/'..s[4], quality=A.quality, show_entity_info=true, daytime=0, show_gui=false}
    end
    return {n=#A.shots}`,

  // Живое окно: скрыть интерфейс клиента, держать в центре кадра бота или игрока.
  // Меняет только настройки и положение самого игрока-камеры.
  follow: `
    local p = game.get_player(A.camera)
    if not p or not p.connected then return {ok=false} end
    if A.setup then
      local v = p.game_view_settings
      for _, k in pairs({'show_controller_gui', 'show_minimap', 'show_research_info', 'show_alert_gui', 'update_entity_selection',
          'show_side_menu', 'show_map_view_options', 'show_entity_tooltip', 'show_quickbar', 'show_shortcut_bar', 'show_crafting_queue',
          'show_tool_bar', 'show_hotkey_suggestions', 'show_surface_list'}) do pcall(function() v[k] = false end) end
      v.show_entity_info = true
    end
    p.zoom = A.zoom
    p.clear_console()
    local e
    if A.kind == 'bot' then e = (storage.vb or {})[A.name]
    elseif A.kind == 'player' then local t = game.get_player(A.name) e = t and t.connected and t.character or nil end
    if e and e.valid then p.centered_on = e return {ok=true} end
    return {ok=false}`,

  // Камера входит с персонажем, как любой новый игрок, — делаем её зрителем.
  spectate: `
    local p = game.get_player(A.camera)
    if p and p.controller_type ~= defines.controllers.spectator then
      -- На новой карте первый вошедший смотрит вступительный ролик: персонаж на это время отцеплен от игрока
      -- (cutscene_character) и без этого остался бы стоять на месте появления ничьим и неуязвимым.
      local c = p.character or p.cutscene_character
      p.set_controller{type=defines.controllers.spectator}
      if c and c.valid then c.destroy() end
    end
    return {ok=true}`,
};

// ---------- состояние ----------

const tiles = new Map();   // "z/x/y" -> { z, x, y, ts } — все тайлы, задевающие разведанные чанки; ts — когда снят
let pausedAt = 0;          // когда игра встала на паузу (0 — идёт)
const moved = new Map();   // "bot:имя" | "player:имя" -> когда последний раз сдвинулся
const lastPos = new Map();
let target = null;         // за кем следит камера: { kind, name, by: ws | null, since }
let targetSent = '';       // что уже передано клиенту-камере
let targetAt = 0;
const clients = new Set();
let live = { tick: 0, paused: false, bots: [], players: [], ok: false, camera: false, target: null };
let summary = null;
let events = [];           // лента: сообщения ботов и решения по заявкам из игрового чата ботов
let chatSeq = 0;
let rendered = 0, unchanged = 0;

const send = (ws, msg) => { if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(JSON.stringify(msg)); };
const broadcast = (msg) => { const s = JSON.stringify({ ...msg, now: Date.now() }); for (const ws of clients) if (ws.readyState === 1 && ws.bufferedAmount < 4_000_000) ws.send(s); };

// ---------- живой слой, сводка ----------

async function liveLoop() {
  for (;;) {
    try {
      const r = await lua(LUA.live, { camera: CAMERA, since: chatSeq, surface: SURFACE });
      checkMap(r.map, r.tick);
      const here = (a) => list(a).filter((p) => p.surface === SURFACE).map((p) => ({ name: p.name, x: +p.x.toFixed(2), y: +p.y.toFixed(2), ...(p.act ? { act: String(p.act).slice(0, 80) } : {}) }));
      if (!live.ok && quickFails < 3) nextStart = 0; // сервер игры снова отвечает — камеру можно пробовать сразу
      if (r.paused && !pausedAt) pausedAt = Date.now();
      if (!r.paused) pausedAt = 0;
      if (r.camera?.connected && !r.camera.spectator) { await lua(LUA.spectate, { camera: CAMERA }); log('камера переведена в режим зрителя'); }
      const was = live.camera;
      live = { tick: r.tick, paused: r.paused, bots: here(r.bots), players: here(r.players), ok: true, camera: !!r.camera?.connected, target: live.target, sleep: sleeping };
      if (live.camera && !was) targetSent = ''; // камера только что вошла: настроить заново
      await aimCamera();
      if (live.camera && viewers.size && !encoder) startVideo();
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

// За кем следит камера: за тем, кого выбрал зритель (последний выбор главнее), иначе — за тем, кто сейчас движется.
async function aimCamera() {
  const now = Date.now();
  const all = [...live.bots.map((a) => ({ ...a, kind: 'bot' })), ...live.players.map((a) => ({ ...a, kind: 'player' }))];
  for (const a of all) {
    const k = `${a.kind}:${a.name}`, p = lastPos.get(k);
    if (!p || p.x !== a.x || p.y !== a.y) { if (p) moved.set(k, now); lastPos.set(k, { x: a.x, y: a.y }); }
  }
  const has = (t) => t && all.some((a) => a.kind === t.kind && a.name === t.name);
  if (target?.by && (!clients.has(target.by) || !has(target))) target = null;
  if (!target?.by) {
    const holding = has(target) && now - target.since < AUTO_HOLD_MS;
    const stillMoving = has(target) && now - (moved.get(`${target.kind}:${target.name}`) ?? 0) < 5000;
    if (!holding && !stillMoving) {
      const best = all.map((a) => ({ a, at: moved.get(`${a.kind}:${a.name}`) ?? 0 })).sort((x, y) => y.at - x.at || (x.a.kind === 'bot' ? -1 : 1))[0];
      if (best && !(has(target) && best.at === 0)) { if (!has(target) || best.a.name !== target.name || best.a.kind !== target.kind) target = { kind: best.a.kind, name: best.a.name, by: null, since: now }; }
      else if (!has(target)) target = null;
    }
  }
  live.target = target ? { kind: target.kind, name: target.name, manual: !!target.by } : null;
  if (!live.camera || !target) return;
  const id = `${target.kind}:${target.name}`;
  // Повторяем раз в 10 секунд: персонаж мог погибнуть и появиться заново, а заодно чистим чат с экрана клиента.
  if (id === targetSent && now - targetAt < 10_000) return;
  const r = await lua(LUA.follow, { camera: CAMERA, kind: target.kind, name: target.name, zoom: CAMERA_ZOOM, setup: targetSent === '' });
  if (r.ok) { if (id !== targetSent) log(`камера следит за ${target.name}${target.by ? ' (выбор зрителя)' : ''}`); targetSent = id; targetAt = now; }
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
  // Вызовы инструментов пишет сервер ботов (api.log), до него — bot.log; текст бота — bot.log.
  const read = (file, want) => {
    let text;
    try {
      const full = path.join(ROOT, file), size = fs.statSync(full).size;
      text = readRange(full, Math.max(0, size - 400_000), size).toString('utf8');
    } catch { return []; }
    const entries = [];
    let cur = null;
    for (const line of text.split('\n').slice(1)) {
      const m = line.match(/^(\d\d:\d\d:\d\d)\.\d{3} (\S+) (.*)$/);
      if (m) {
        cur = null;
        const tool = m[2] === '🔧' && m[3].startsWith(name + ' '), said = m[2] === '🤖' && m[3].startsWith(name + ': ');
        if ((tool && want.tool) || (said && want.text)) { cur = { time: m[1], kind: tool ? 'tool' : 'text', text: m[3].slice(name.length + (tool ? 1 : 2)) }; entries.push(cur); }
      } else if (cur && cur.kind === 'text') cur.text += '\n' + line;
    }
    return entries.slice(-12);
  };
  let tools = [];
  for (const file of ['api.log', 'bot.log']) { tools = read(file, { tool: true }); if (tools.length) break; }
  // В логах только время суток: сортируем по нему, а записи «из будущего» (вчерашние, до полуночи) ставим первыми.
  const nowT = new Date().toISOString().slice(11, 19);
  const order = (e) => (e.time > nowT ? '0' : '1') + e.time;
  return [...tools, ...read('bot.log', { text: true })].sort((x, y) => (order(x) < order(y) ? -1 : 1)).slice(-12)
    .map((e) => ({ time: e.time, kind: e.kind, text: e.text.trim().slice(0, 400) }));
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

// Туман войны — как в клиенте игры и на сервере, а не в браузере:
//   чанк виден сейчас (радар, игрок, бот) — живая графика из снимка;
//   разведан, но не виден — затемнённая схема в цветах игровой карты, какой она была, когда чанк видели последний раз;
//   не разведан — чёрное.
// Тайл, где видимых чанков нет, камера не снимает вовсе; смешанный тайл склеивается из снимка и схемы.

const chunks = new Map();  // "x,y" -> { x, y, vis, snap (32×32×3, цвет клетки), snapV, snapTs, tiles, tnames, tilesTs }
const colors = { ents: new Map(), tiles: new Map() };
const ckey = (x, y) => `${x},${y}`;
const FOG_DIM = 0.6;       // туман темнее живой карты
const SNAP_MS = 20_000;    // как часто обновлять схему видимых чанков: настолько она «отстаёт» в момент ухода в туман
const BLACK = [0, 0, 0];

const tileRange = (t) => { const s = span(t.z); return { x0: Math.floor(t.x * s / 32), x1: Math.floor(((t.x + 1) * s - 1) / 32), y0: Math.floor(t.y * s / 32), y1: Math.floor(((t.y + 1) * s - 1) / 32) }; };
function tileState(t) {
  const r = tileRange(t), parts = [];
  let vis = 0, total = 0, ready = true;
  for (let cy = r.y0; cy <= r.y1; cy++) for (let cx = r.x0; cx <= r.x1; cx++) {
    const c = chunks.get(ckey(cx, cy));
    total++;
    if (!c) parts.push('u');
    else if (c.vis) { vis++; parts.push('v'); }
    else { parts.push('f' + c.snapV); if (!c.snap) ready = false; }
  }
  // ready — у всех чанков в тумане уже есть схема; sig — из чего тайл должен быть собран.
  return { vis, total, ready, sig: crypto.createHash('md5').update(parts.join(',')).digest('hex').slice(0, 16) };
}
// Чанк изменился (видимость или схема) — тайлы всех уровней над ним нужно собрать заново.
function touchChunk(c) {
  const seen = new Set();
  for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) {
    let x = c.x * 2 + dx, y = c.y * 2 + dy;
    for (let z = ZMAX; z >= 0; z--) {
      const k = key(z, x, y);
      if (!seen.has(k)) {
        seen.add(k);
        let t = tiles.get(k);
        if (!t) { t = { z, x, y, ts: 0, sig: null, fog: false }; tiles.set(k, t); }
        t.dirty = true;
        t.vis = tileState(t).vis;
      }
      x >>= 1; y >>= 1;
    }
  }
}

async function chunkListLoop() {
  for (;;) {
    try {
      const flat = list(await lua(LUA.chunks, { surface: SURFACE }));
      for (let i = 0; i < flat.length; i += 3) {
        const k = ckey(flat[i], flat[i + 1]), vis = flat[i + 2] === 1;
        let c = chunks.get(k);
        if (!c) { c = { x: flat[i], y: flat[i + 1], vis: null, snap: null, snapV: 0, snapTs: 0, tiles: null, tnames: null, tilesTs: 0 }; chunks.set(k, c); }
        if (c.vis !== vis) { c.vis = vis; touchChunk(c); }
      }
      chunksKnown = true;
    } catch (e) { log('список чанков:', e.message); }
    await sleep(3000);
  }
}
let chunksKnown = false; // видимость чанков уже получена от игры

// --- схема чанка ---

async function learnColors(ents, tileNames) {
  const e = ents.filter((n) => !colors.ents.has(n)), t = tileNames.filter((n) => !colors.tiles.has(n));
  if (!e.length && !t.length) return;
  const r = await lua(LUA.protos, { ents: e, tiles: t });
  for (const n of e) colors.ents.set(n, r.ents?.[n] ?? null);
  for (const n of t) { const c = r.tiles?.[n]; colors.tiles.set(n, c ? [c.r, c.g, c.b] : BLACK); }
}

const LAYER = { resource: 0, tree: 1, 'simple-entity': 1, cliff: 1 };
function drawSnap(c, r) {
  const snap = Buffer.alloc(32 * 32 * 3);
  if (c.tiles) {
    const pal = c.tnames.map((n) => colors.tiles.get(n) ?? BLACK);
    for (let i = 0; i < 1024; i++) { const col = pal[c.tiles.charCodeAt(i) - 48] ?? BLACK; snap[i * 3] = col[0]; snap[i * 3 + 1] = col[1]; snap[i * 3 + 2] = col[2]; }
  }
  const names = list(r.enames), flat = list(r.ents), boxes = [];
  for (let i = 0; i < flat.length; i += 6) {
    const p = colors.ents.get(names[flat[i] - 1]);
    if (!p) continue;
    const col = flat[i + 1] === 1 ? (p.f ?? p.m) : flat[i + 1] === 2 ? (p.e ?? p.m) : (p.m ?? p.f);
    if (col) boxes.push({ col, layer: LAYER[p.type] ?? 2, x1: Math.floor(flat[i + 2] / 8), y1: Math.floor(flat[i + 3] / 8), x2: Math.ceil(flat[i + 4] / 8), y2: Math.ceil(flat[i + 5] / 8) });
  }
  boxes.sort((a, b) => a.layer - b.layer);
  for (const b of boxes) {
    const a = (b.col.a ?? 255) / 255;
    for (let y = Math.max(0, b.y1); y < Math.min(32, Math.max(b.y2, b.y1 + 1)); y++) for (let x = Math.max(0, b.x1); x < Math.min(32, Math.max(b.x2, b.x1 + 1)); x++) {
      const o = (y * 32 + x) * 3;
      snap[o] = snap[o] * (1 - a) + b.col.r * a; snap[o + 1] = snap[o + 1] * (1 - a) + b.col.g * a; snap[o + 2] = snap[o + 2] * (1 - a) + b.col.b * a;
    }
  }
  return snap;
}

// Схему обновляем, только пока чанк виден: ушёл в туман — остаётся такой, какой его видели в последний раз.
// Чанки, которые сервис ни разу не застал видимыми, получают схему один раз и без врагов: что там сейчас, команда не знает.
async function chartLoop() {
  for (;;) {
    let batch = [];
    if (live.ok && chunksKnown) {
      const now = Date.now(), all = [...chunks.values()];
      batch = all.filter((c) => !c.snap).sort((a, b) => (b.vis ? 1 : 0) - (a.vis ? 1 : 0)).slice(0, 6);
      if (!batch.length) batch = all.filter((c) => c.vis && now - c.snapTs > SNAP_MS).sort((a, b) => a.snapTs - b.snapTs).slice(0, 6);
      if (batch.length) {
        try {
          const res = list(await lua(LUA.chart, { surface: SURFACE, chunks: batch.map((c) => [c.x, c.y, !c.tiles || now - c.tilesTs > 600_000, !c.vis]) }));
          await learnColors([...new Set(res.flatMap((r) => list(r.enames)))], [...new Set(res.flatMap((r) => list(r.tnames)))]);
          batch.forEach((c, i) => {
            const r = res[i];
            if (!r) return;
            if (r.tiles) { c.tiles = r.tiles; c.tnames = list(r.tnames); c.tilesTs = now; }
            const snap = drawSnap(c, r);
            c.snapTs = now;
            if (c.snap && snap.equals(c.snap)) return;
            c.snap = snap; c.snapV++; fogChanged = true;
            if (!c.vis) touchChunk(c);
          });
        } catch (e) { log('схема чанков:', e.message); await sleep(2000); }
      }
    }
    await sleep(batch.length ? 120 : 1000);
  }
}
let fogChanged = false;

// --- сборка тайлов ---

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function pngChunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'latin1'); data.copy(out, 8);
  let c = -1;
  for (let i = 4; i < 8 + data.length; i++) c = CRC[(c ^ out[i]) & 0xff] ^ (c >>> 8);
  out.writeUInt32BE((c ^ -1) >>> 0, 8 + data.length);
  return out;
}
function encodePng(rgb) {
  const row = TILE * 3, raw = Buffer.alloc((row + 1) * TILE);
  for (let y = 0; y < TILE; y++) rgb.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row);
  const head = Buffer.alloc(13);
  head.writeUInt32BE(TILE, 0); head.writeUInt32BE(TILE, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from('\x89PNG\r\n\x1a\n', 'latin1'), pngChunk('IHDR', head), pngChunk('IDAT', zlib.deflateSync(raw, { level: 4 })), pngChunk('IEND', Buffer.alloc(0))]);
}

/** Картинка тумана для тайла: bpp=3 — тайл целиком в тумане; bpp=4 — накладка на снимок, прозрачная над видимыми чанками. */
function fogImage(t, bpp) {
  const img = Buffer.alloc(TILE * TILE * bpp), s = span(t.z), p = TILE / s, r = tileRange(t), gx0 = t.x * s, gy0 = t.y * s;
  if (bpp === 4) for (let i = 3; i < img.length; i += 4) img[i] = 255; // по умолчанию — непрозрачное чёрное
  for (let cy = r.y0; cy <= r.y1; cy++) for (let cx = r.x0; cx <= r.x1; cx++) {
    const c = chunks.get(ckey(cx, cy));
    if (!c || (!c.vis && !c.snap)) continue; // не разведано или схемы ещё нет — чёрное
    const ax = Math.max(cx * 32, gx0), bx = Math.min(cx * 32 + 32, gx0 + s), ay = Math.max(cy * 32, gy0), by = Math.min(cy * 32 + 32, gy0 + s);
    for (let gy = ay; gy < by; gy++) for (let gx = ax; gx < bx; gx++) {
      const so = ((gy - cy * 32) * 32 + (gx - cx * 32)) * 3;
      const cr = c.vis ? 0 : c.snap[so] * FOG_DIM, cg = c.vis ? 0 : c.snap[so + 1] * FOG_DIM, cb = c.vis ? 0 : c.snap[so + 2] * FOG_DIM, al = c.vis ? 0 : 255;
      for (let py = (gy - gy0) * p; py < (gy - gy0 + 1) * p; py++) {
        let o = (py * TILE + (gx - gx0) * p) * bpp;
        for (let px = 0; px < p; px++) { img[o] = cr; img[o + 1] = cg; img[o + 2] = cb; if (bpp === 4) img[o + 3] = al; o += bpp; }
      }
    }
  }
  return img;
}

// ts — когда тайл последний раз сверен с игрой, ver — когда его картинка последний раз изменилась (версия файла в адресе).
// Если новый снимок совпал с прежним байт в байт, зрителю незачем качать его заново: меняется только ts.
function publish(t, st, fog, updates, changed = true) {
  t.ts = Date.now(); t.sig = st.sig; t.fog = fog; t.vis = st.vis; t.dirty = false;
  if (changed || !t.ver) t.ver = t.ts;
  updates.push([t.z, t.x, t.y, t.ts, fog ? 1 : 0, t.ver]);
  indexChanged = true;
}
let indexChanged = false;
function writeTile(t, data) {
  fs.mkdirSync(path.join(TILES, String(t.z)), { recursive: true });
  const file = tileFile(t.z, t.x, t.y);
  fs.writeFileSync(file + '.tmp', data);
  fs.renameSync(file + '.tmp', file);
}

// Тайлы без видимых чанков: рисуем сами, камера не нужна.
async function fogLoop() {
  for (;;) {
    const updates = [];
    let done = 0;
    if (chunksKnown) {
      for (const t of tiles.values()) {
        if (!t.dirty || t.vis > 0) continue;
        const st = tileState(t);
        if (st.vis > 0) { t.vis = st.vis; continue; }
        if (!st.ready) continue;                          // схемы ещё подгружаются
        if (st.sig === t.sig) { t.dirty = false; continue; } // уже собран именно так
        writeTile(t, encodePng(fogImage(t, 3)));
        publish(t, st, true, updates);
        if (++done >= 12) break;                          // не занимаем процесс надолго
      }
    }
    if (updates.length) broadcast({ t: 'tiles', up: updates });
    await sleep(done ? 30 : 500);
  }
}

// Приоритеты камеры: 0) тайл нужно пересобрать, 1) поле зрения зрителей, 2) окрестности ботов и игроков, 3) фоновый обход.
function pick() {
  const hot = new Set();
  const s = span(ZMAX);
  for (const a of [...live.bots, ...live.players]) {
    // Четыре ближайших тайла самого подробного уровня: 32×32 клетки вокруг.
    const x = Math.round(a.x / s), y = Math.round(a.y / s);
    for (let dx = -1; dx <= 0; dx++) for (let dy = -1; dy <= 0; dy++) hot.add(key(ZMAX, x + dx, y + dy));
  }
  const viewed = new Set();
  for (const ws of clients) for (const k of ws.view ?? []) viewed.add(k);
  const now = Date.now(), due = [];
  for (const [k, t] of tiles) {
    if (!(t.vis > 0)) continue;                             // целиком в тумане — не снимаем
    if (t.dirty) { due.push([viewed.has(k) ? Infinity : 1e9, t, viewed.has(k)]); continue; }
    if (live.paused && pausedAt && t.ts > pausedAt) continue; // на паузе картинка не меняется
    const want = viewed.has(k) ? VIEW_MS : hot.has(k) ? FRESH_MS : SWEEP_MS;
    const score = (now - t.ts) / want;
    if (score >= 1) due.push([score, t, viewed.has(k)]);
  }
  due.sort((a, b) => b[0] - a[0]);
  // Зрители могут занять камеру целиком, поэтому четверть каждой пачки оставлена остальному
  // (участки вокруг ботов и фоновый обход); незанятые места достаются тем, кому есть что снимать.
  const seen = due.filter((d) => d[2]), rest = due.filter((d) => !d[2]);
  const keep = Math.min(rest.length, Math.max(BATCH / 4, BATCH - seen.length));
  return [...rest.slice(0, keep), ...seen.slice(0, BATCH - keep)].map((d) => d[1]);
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

// Наложить картинку тумана на снимок (ffmpeg): возвращает JPEG.
function overlay(shotFile, rgba) {
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', ['-loglevel', 'error', '-i', shotFile, '-f', 'rawvideo', '-pix_fmt', 'rgba', '-video_size', `${TILE}x${TILE}`, '-i', 'pipe:0',
      '-filter_complex', 'overlay', '-frames:v', '1',
      // Без прореживания цвета (4:4:4): иначе мелкие цветные пятна схемы (гнёзда — 3×3 пикселя на дальнем уровне) расплываются.
      '-pix_fmt', 'yuvj444p', '-q:v', '2', '-f', 'mjpeg', 'pipe:1'], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'ignore'] });
    const out = [];
    ff.stdout.on('data', (d) => out.push(d));
    ff.on('error', reject);
    ff.on('close', (code) => (code === 0 && out.length ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg: код ${code}`))));
    ff.stdin.on('error', () => {});
    ff.stdin.end(rgba);
  });
}

// Снимок готов: смотрим, что в тайле видно прямо сейчас, и публикуем только это.
async function finishShot(t, src, updates) {
  const st = tileState(t);
  try {
    if (st.vis === 0) { t.vis = 0; t.dirty = true; return; }           // пока снимали, всё ушло в туман — соберёт fogLoop
    const data = st.vis === st.total ? fs.readFileSync(src) : await overlay(src, fogImage(t, 4));
    const hash = crypto.createHash('md5').update(data).digest('hex');
    const same = hash === t.hash && st.sig === t.sig && !t.fog;
    if (same) unchanged++; else { writeTile(t, data); t.hash = hash; }
    publish(t, st, false, updates, !same);
    rendered++;
  } catch (e) { log(`тайл ${key(t.z, t.x, t.y)}:`, e.message); }
  finally { fs.rmSync(src, { force: true }); }
}

// Имена снимков не повторяются между запусками сервиса: иначе файл, оставшийся от прошлого запуска или опоздавший
// после тайм-аута, однажды совпадает по имени с новым заказом и попадает не в свой тайл.
const SHOT_RUN = Date.now().toString(36);
let shotId = 0, failures = 0;
async function renderBatch(batch) {
  const shots = batch.map((t) => {
    const s = span(t.z);
    return { t, name: `${SHOT_RUN}-${++shotId}.jpg`, args: [(t.x + 0.5) * s, (t.y + 0.5) * s, 2 ** (t.z - ZMAX)] };
  });
  await lua(LUA.shots, { camera: CAMERA, surface: SURFACE, dir: SHOT_DIR, size: TILE, quality: JPEG_QUALITY, shots: shots.map((s) => [...s.args, s.name]) });
  const deadline = Date.now() + SHOT_TIMEOUT_MS, updates = [], work = [];
  let left = shots;
  while (left.length && Date.now() < deadline) {
    await sleep(15);
    left = left.filter((s) => {
      const src = path.join(SHOTS, s.name);
      if (!jpegDone(src)) return true;
      work.push(finishShot(s.t, src, updates));
      return false;
    });
  }
  await Promise.all(work);
  if (updates.length) broadcast({ t: 'tiles', up: updates });
  if (left.length) {
    failures++;
    log(`снимки не пришли: ${left.length} из ${shots.length} (подряд неудач: ${failures})`);
    for (const s of left) fs.rmSync(path.join(SHOTS, s.name), { force: true });
  } else failures = 0;
  // Опоздавшие и чужие снимки: всё, что лежит в папке дольше минуты, уже никому не нужно.
  if (shotId % 400 < BATCH) {
    try { for (const f of fs.readdirSync(SHOTS)) { const full = path.join(SHOTS, f); if (Date.now() - fs.statSync(full).mtimeMs > 60_000) fs.rmSync(full, { force: true }); } } catch { /* папки ещё нет */ }
  }
}

async function renderLoop() {
  for (;;) {
    const batch = live.ok && live.camera && chunksKnown && (!CAMERA_MANAGE || camera?.joined) ? pick() : [];
    if (batch.length) {
      try { await renderBatch(batch); } catch (e) { log('перерисовка:', e.message); await sleep(2000); }
    }
    await sleep(batch.length ? PAUSE_MS : 300);
  }
}

// --- то, что переживает перезапуск сервиса: схемы чанков и из чего собран каждый тайл ---

const FOG_BIN = path.join(TILES, 'fog.bin'), FOG_IDX = path.join(TILES, 'fog.json'), TILE_IDX = path.join(TILES, 'index.json');
// ---------- смена карты ----------
// На сервере карту иногда меняют или откатывают из резервной копии. Тогда всё накопленное (тайлы, схемы тумана
// войны) — от другой карты, и его надо выбросить. Карту узнаём по зерну генерации; откат — по тому, что время
// игры ушло назад больше чем на час (при обычном перезапуске сервера теряется не больше минут автосохранения).
const MAP_ID = path.join(TILES, 'map.json');
const ROLLBACK_TICKS = 216_000;
let mapId = null, mapTick = 0;
try { ({ id: mapId, tick: mapTick } = JSON.parse(fs.readFileSync(MAP_ID, 'utf8'))); } catch { /* ещё не записано */ }
function checkMap(id, tick) {
  if (!id) return;
  const why = mapId === null ? 'карта кеша неизвестна' : id !== mapId ? `другая карта (зерно ${mapId} → ${id})` : tick < mapTick - ROLLBACK_TICKS ? `карту откатили (тик ${mapTick} → ${tick})` : '';
  mapTick = tick;
  if (!why) return;
  mapId = id;
  log(`${why} — кеш карты сброшен: тайлов ${tiles.size}, схем чанков ${chunks.size}`);
  tiles.clear(); chunks.clear(); colors.ents.clear(); colors.tiles.clear();
  chunksKnown = false; fogChanged = false; indexChanged = false;
  events = []; chatSeq = 0; summary = null;
  fs.rmSync(TILES, { recursive: true, force: true });
  fs.mkdirSync(TILES, { recursive: true });
  fs.writeFileSync(MAP_ID, JSON.stringify({ id: mapId, tick: mapTick }));
  broadcast({ t: 'reset' }); // открытые страницы перезагрузятся и получат пустую карту
}

function saveState() {
  try {
    if (mapId) fs.writeFileSync(MAP_ID, JSON.stringify({ id: mapId, tick: mapTick }));
    if (fogChanged) {
      const have = [...chunks.values()].filter((c) => c.snap);
      fs.writeFileSync(FOG_BIN + '.tmp', Buffer.concat(have.map((c) => c.snap)));
      fs.writeFileSync(FOG_IDX + '.tmp', JSON.stringify(have.map((c) => [c.x, c.y, c.snapV])));
      fs.renameSync(FOG_BIN + '.tmp', FOG_BIN); fs.renameSync(FOG_IDX + '.tmp', FOG_IDX);
      fogChanged = false;
    }
    if (indexChanged) {
      const idx = {};
      for (const [k, t] of tiles) if (t.sig) idx[k] = [t.ts, t.sig, t.fog ? 1 : 0, t.ver || t.ts];
      fs.writeFileSync(TILE_IDX + '.tmp', JSON.stringify(idx));
      fs.renameSync(TILE_IDX + '.tmp', TILE_IDX);
      indexChanged = false;
    }
  } catch (e) { log('сохранение состояния карты:', e.message); }
}
function loadState() {
  try {
    const idx = JSON.parse(fs.readFileSync(FOG_IDX, 'utf8')), bin = fs.readFileSync(FOG_BIN);
    idx.forEach(([x, y, v], i) => chunks.set(ckey(x, y), { x, y, vis: null, snap: Buffer.from(bin.subarray(i * 3072, i * 3072 + 3072)), snapV: v, snapTs: 0, tiles: null, tnames: null, tilesTs: 0 }));
    for (const [k, [ts, sig, fog, ver]] of Object.entries(JSON.parse(fs.readFileSync(TILE_IDX, 'utf8')))) {
      const [z, x, y] = k.split('/').map(Number);
      // Тайлы из снимков после запуска переснимаем (dirty): так случайно испорченный тайл не живёт дольше одного запуска.
      if (fs.existsSync(tileFile(z, x, y))) tiles.set(k, { z, x, y, ts, ver: ver || ts, sig, fog: !!fog, vis: 0, dirty: !fog });
    }
    log(`загружено: схем чанков ${chunks.size}, тайлов ${tiles.size}`);
  } catch { /* первый запуск: всё соберётся заново */ }
}

// ---------- клиент-камера ----------
// Полный клиент игры под Xvfb, подключённый к серверу зрителем. Сам он после обрыва связи не переподключается
// (остаётся в меню), поэтому сервис следит за ним и перезапускает. Сервер игры перезапускают часто, так что
// возвращаться надо быстро: обрыв видим сразу по логу клиента, новый клиент запускаем, не дожидаясь сервера
// (с кешем спрайтов он грузится секунд за двенадцать и ещё десять сам ждёт ответа сервера), Xvfb не трогаем.

let camera = null;          // { pid, since, joined, logPos }
let cameraSeen = 0;         // когда камера последний раз была в игре
let nextStart = 0;
let dying = null;           // { pid, at } — прежний клиент ещё завершается
let quickFails = 0;         // неудачные входы подряд
const CAMERA_LOG = path.join(CAMERA_DIR, 'camera.log');

function gamePassword() {
  if (process.env.GAME_PASSWORD !== undefined) return process.env.GAME_PASSWORD;
  try { return JSON.parse(fs.readFileSync(SERVER_SETTINGS, 'utf8')).game_password ?? ''; } catch { return ''; }
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const cleanEnv = () => { const env = { ...process.env }; delete env.LD_LIBRARY_PATH; return env; }; // чужие библиотеки из окружения ломают системный Mesa

// Xvfb живёт дольше клиента: его не нужно ждать при перезапуске, и видеокодер не теряет дисплей.
function xvfbPid() { try { const pid = Number(fs.readFileSync(`/tmp/.X${CAMERA_DISPLAY.slice(1)}-lock`, 'utf8')); return pid && alive(pid) ? pid : 0; } catch { return 0; } }
// Если запущен X-сервер на встроенной графике (служба factorio-camera-display, ~/factorio-camera/xorg), клиент рисует
// на видеокарте; иначе — прежний Xvfb с программным рендером. Выбор делается при каждом запуске клиента.
const GPU_DISPLAY = process.env.CAMERA_GPU_DISPLAY || ':95', GPU_XAUTH = path.join(CAMERA_DIR, 'xorg/Xauthority');
let display = { DISPLAY: CAMERA_DISPLAY }; // окружение дисплея текущего клиента
function pickDisplay() {
  const gpu = process.env.CAMERA_GPU !== '0' && fs.existsSync(`/tmp/.X11-unix/X${GPU_DISPLAY.slice(1)}`) && fs.existsSync(GPU_XAUTH);
  // vblank_mode=0: монитора нет, и ожидание «кадровой развёртки» тормозило бы клиент до пары кадров в секунду.
  display = gpu ? { DISPLAY: GPU_DISPLAY, XAUTHORITY: GPU_XAUTH, vblank_mode: '0' } : { DISPLAY: CAMERA_DISPLAY };
  return gpu;
}
function ensureXvfb() {
  if (pickDisplay()) return false;
  if (xvfbPid()) return false;
  const out = fs.openSync(CAMERA_LOG, 'a');
  spawn('Xvfb', [CAMERA_DISPLAY, '-screen', '0', `${CAMERA_WINDOW}x24`, '-nolisten', 'tcp'], { env: cleanEnv(), detached: true, stdio: ['ignore', out, out] }).unref();
  fs.closeSync(out);
  return true;
}

function startCamera() {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const args = ['-n', '10', 'taskset', '-c', CAMERA_CPUS, path.join(CAMERA_DIR, 'factorio/bin/x64/factorio'), '--mp-connect', GAME_ADDR, '--disable-audio', '--window-size', CAMERA_WINDOW];
  if (process.env.CAMERA_CONFIG) args.push('--config', process.env.CAMERA_CONFIG);
  const pw = gamePassword();
  if (pw) args.push('--password', pw);
  let logPos = 0;
  try { logPos = fs.statSync(CAMERA_LOG).size; } catch { /* лога ещё нет */ }
  const out = fs.openSync(CAMERA_LOG, 'a');
  const child = spawn('nice', args, { cwd: CAMERA_DIR, env: { ...cleanEnv(), ...display }, detached: true, stdio: ['ignore', out, out] });
  fs.closeSync(out);
  child.unref();
  child.on('exit', (code) => { if (camera?.pid === child.pid) { log(`клиент-камера завершился (код ${code})`); camera = null; nextStart = Date.now() + 3000; } });
  camera = { pid: child.pid, since: Date.now(), joined: false, logPos };
  fs.writeFileSync(PID_FILE, String(child.pid));
  log(`клиент-камера запущен (группа процессов ${child.pid}, дисплей ${display.DISPLAY}${display.XAUTHORITY ? ' — видеокарта' : ' — программный рендер'})`);
}

function stopCamera(why, retryIn = 0) {
  if (!camera) return;
  log(`останавливаю клиент-камеру: ${why}`);
  try { process.kill(-camera.pid, 'SIGTERM'); } catch { /* уже нет */ }
  dying = { pid: camera.pid, at: Date.now() };
  camera = null;
  live.camera = false; failures = 0;
  nextStart = Date.now() + retryIn;
}

// Что клиент написал в лог с прошлой проверки: обрыв связи и неудачный вход видны там сразу.
function cameraLogNews() {
  try {
    const size = fs.statSync(CAMERA_LOG).size;
    if (size <= camera.logPos) return '';
    const text = readRange(CAMERA_LOG, camera.logPos, size).toString('utf8');
    camera.logPos = size;
    return text;
  } catch { return ''; }
}

async function cameraLoop() {
  if (!CAMERA_MANAGE) return;
  // Клиент мог остаться от прошлого запуска сервиса — подхватываем его.
  try {
    const pid = Number(fs.readFileSync(PID_FILE, 'utf8'));
    if (pid && alive(pid)) { camera = { pid, since: Date.now(), joined: false, adopted: true, logPos: fs.statSync(CAMERA_LOG).size }; log(`подхватил работающий клиент-камеру (${pid})`); }
  } catch { /* нет файла */ }
  if (camera) {
    // На каком дисплее работает подхваченный клиент — из его окружения (нужно кодировщику живого окна).
    try {
      const env = Object.fromEntries(fs.readFileSync(`/proc/${camera.pid}/environ`, 'utf8').split('\0').map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1)]; }));
      if (env.DISPLAY) display = env.XAUTHORITY ? { DISPLAY: env.DISPLAY, XAUTHORITY: env.XAUTHORITY } : { DISPLAY: env.DISPLAY };
    } catch { /* процесс уже ушёл */ }
  }
  for (;;) {
    await sleep(1000);
    const now = Date.now();
    if (dying) {
      if (!alive(dying.pid)) dying = null;
      else if (now - dying.at > 5000) { try { process.kill(-dying.pid, 'SIGKILL'); } catch { /* уже нет */ } }
      if (dying) continue; // новый клиент — только когда прежний ушёл
    }
    if (camera && !alive(camera.pid)) { log('клиент-камера больше не работает'); camera = null; }
    // Игра давно на паузе, всё снято, живое окно никто не смотрит — клиенту нечего делать, а процессор он ест
    // постоянно. Останавливаем его и запускаем снова, когда игра пойдёт или кто-то откроет живое окно.
    if (live.ok) {
      const idle = live.paused && pausedAt && now - pausedAt > CAMERA_SLEEP_MS && !viewers.size && chunksKnown && pick().length === 0;
      if (idle && !sleeping) { sleeping = true; live.sleep = true; log('игра давно на паузе — клиент-камера остановлен до её продолжения'); stopCamera('игра на паузе'); }
      else if (!idle && sleeping) { sleeping = false; live.sleep = false; nextStart = 0; log(`клиент-камера нужен снова (${!live.paused ? 'игра идёт' : viewers.size ? 'открыто живое окно' : 'есть что снять'})`); }
    }
    if (sleeping) continue;
    if (camera) {
      // О входе и обрыве судим по логу самого клиента: ответ сервера по RCON в момент перезапуска бывает устаревшим.
      const news = cameraLogNews();
      if (!camera.joined && /to\(InGame\)/.test(news)) { camera.joined = true; cameraSeen = now; quickFails = 0; log(`камера в игре через ${Math.round((now - camera.since) / 1000)} с после запуска клиента`); }
      if (camera.adopted && !camera.joined && live.ok && live.camera) { camera.joined = true; cameraSeen = now; } // подхваченный клиент вошёл ещё до нас
      if (camera.joined && live.ok && live.camera) cameraSeen = now;
      if (/from\(InGame\) to\(/.test(news)) stopCamera('сервер разорвал связь');                       // сервер перезапускают
      else if (!camera.joined && /to\(InitializationFailed\)|Connection refused|to\(Disconnected\)/.test(news)) {
        // Не вошёл. Первый раз — сервер, скорее всего, ещё поднимается: повторим, как только он ответит по RCON.
        quickFails++;
        stopCamera(`не вошёл на сервер (подряд: ${quickFails})`, quickFails >= 3 ? CAMERA_RETRY_MS : 0);
        waitServer = true;
      } else if (camera.joined && live.ok && !live.camera && now - cameraSeen > 15_000) stopCamera('сервер не видит камеру среди игроков');
      else if (!camera.joined && now - camera.since > CAMERA_START_MS) stopCamera('не подключился за отведённое время', CAMERA_RETRY_MS);
      else if (camera.joined && failures >= 5) { failures = 0; stopCamera('не отдаёт снимки'); }
    } else if (now >= nextStart && (!waitServer || live.ok)) {
      waitServer = false;
      try { if (ensureXvfb()) await sleep(1000); startCamera(); } catch (e) { log('не смог запустить клиент-камеру:', e.message); nextStart = now + 60_000; }
    }
  }
}
let waitServer = false; // после неудачного входа ждём, пока сервер ответит по RCON
let sleeping = false;   // клиент-камера остановлен, потому что игра давно на паузе

// ---------- живое окно: видео из окна клиента-камеры ----------
// ffmpeg снимает дисплей клиента и отдаёт H.264 во фрагментированном MP4; каждый фрагмент начинается с ключевого кадра,
// поэтому зрителя можно подключить с любого фрагмента. Кодируем, только пока живое окно кто-то смотрит.

const viewers = new Set(); // WebSocket зрителей живого окна
let encoder = null, videoInit = null, videoIdle = null;

function startVideo() {
  if (encoder || !live.camera) return;
  const gop = Math.round(VIDEO_FPS / 2);
  const env = { ...process.env, ...display };
  delete env.LD_LIBRARY_PATH;
  encoder = spawn('ffmpeg', ['-loglevel', 'error', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(VIDEO_FPS), '-video_size', CAMERA_WINDOW, '-i', display.DISPLAY,
    '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
    '-g', String(gop), '-keyint_min', String(gop), '-sc_threshold', '0', '-b:v', `${VIDEO_KBPS}k`, '-maxrate', `${VIDEO_KBPS * 1.5}k`, '-bufsize', `${VIDEO_KBPS}k`,
    '-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const me = encoder;
  let buf = Buffer.alloc(0), head = [], moof = null;
  videoInit = null;
  me.stdout.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d;
    while (buf.length >= 8) {
      const size = buf.readUInt32BE(0), type = buf.toString('latin1', 4, 8);
      if (size < 8 || buf.length < size) break;
      const box = buf.subarray(0, size);
      buf = buf.subarray(size);
      if (type === 'moof') { if (!videoInit) videoInit = Buffer.concat(head); moof = box; }
      else if (type === 'mdat' && moof) {
        const frag = Buffer.concat([moof, box]);
        moof = null;
        for (const ws of viewers) {
          if (ws.readyState !== 1 || ws.bufferedAmount > 3_000_000) continue; // не успевает — пропускаем фрагмент
          if (!ws.started) { ws.send(videoInit); ws.started = true; }
          ws.send(frag);
        }
      } else if (!videoInit) head.push(box);
    }
  });
  me.stderr.on('data', (d) => log('ffmpeg:', String(d).trim().slice(0, 300)));
  me.on('exit', (code) => {
    if (encoder !== me) return;
    encoder = null;
    log(`кодирование живого окна остановлено (код ${code})`);
    for (const ws of viewers) ws.started = false;
    if (viewers.size) setTimeout(startVideo, 3000); // камера перезапускается — пробуем снова
  });
  log('кодирование живого окна запущено');
}

function stopVideo() {
  const me = encoder;
  encoder = null;
  if (me) { me.kill('SIGTERM'); log('живое окно никто не смотрит — кодирование остановлено'); }
}

// ---------- названия на русском из файлов игры ----------

function loadNames(lang) {
  const out = {};
  const want = { 'item-name': 1, 'entity-name': 1, 'fluid-name': 1, 'recipe-name': 1, 'technology-name': 1 };
  let mods = [];
  try { mods = fs.readdirSync(GAME_DATA); } catch { return out; }
  for (const mod of mods) {
    const dir = path.join(GAME_DATA, mod, 'locale', lang);
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
// Русские названия — для показа, английские — для ссылок на вики (страницы там называются по-английски).
// Для окна сведений о постройке — описания построек и названия состояний («Работает», «Нет топлива»).
const LOCALE = loadLocale(GAME_DATA, 'ru', ['entity-description', 'entity-status']);
const NAMES = JSON.stringify({ ru: loadNames('ru'), en: loadNames('en'), desc: LOCALE['entity-description'], status: LOCALE['entity-status'] });
const MAP_BUTTONS = path.join(CAMERA_DIR, 'factorio/data/core/graphics/icons/mip/side-map-menu-buttons.png'); // кнопки слоёв карты из игры

// ---------- сессии Claude ботов ----------
// Транскрипты лежат в SESSIONS: <id>.jsonl — главная сессия, <id>/subagents/agent-<agentId>.jsonl (+ .meta.json) — субагенты.
// Какая сессия чьего бота — из строк «[agent Имя] сессия <id>» в bot.log. Реплики людей не отдаём (страница публичная).

// Чья сессия — выясняем тремя независимыми способами и запоминаем навсегда (state-map.json), чтобы сессия
// не пропадала из списка, когда один из источников меняется:
//   1) запущенные процессы claude: имя бота в переменной FX_BOT, id сессии в --resume (самый надёжный, но только для живых);
//   2) строки «[agent Имя] сессия <id>» в bot.log и sessions.log (последняя строка главнее: бота могли переименовать);
//   3) сам транскрипт: в записи с системным промптом сказано «персонажем по имени «…»» — это имя на момент создания
//      сессии, поэтому им только заполняем пробелы, когда в логах сессии нет.
const owners = new Map();      // id сессии -> { bot, rank } — rank: 3 процесс, 2 лог, 1 транскрипт
const scanned = new Map();     // id сессии -> сколько байт транскрипта уже просмотрено
const logPos = new Map();      // файл лога -> сколько уже прочитано
const botSessions = new Map(); // бот -> Set(id сессии), строится из owners
const running = new Set();     // сессии, у которых сейчас есть процесс claude
let ownersChanged = false, lastScan = 0;

function learn(id, bot, rank) {
  const cur = owners.get(id);
  if (cur && (cur.rank > rank || (cur.bot === bot && cur.rank === rank))) return;
  if (cur?.bot !== bot) log(`сессия ${id} — ${bot}${cur ? ` (было: ${cur.bot})` : ''}, источник: ${['', 'транскрипт', 'лог', 'процесс'][rank]}`);
  owners.set(id, { bot, rank });
  ownersChanged = true;
  botSessions.clear();
  for (const [sid, o] of owners) { if (!botSessions.has(o.bot)) botSessions.set(o.bot, new Set()); botSessions.get(o.bot).add(sid); }
}

function scanProcesses() {
  running.clear();
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return; }
  for (const pid of pids) {
    try {
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      if (!cmd.startsWith('claude\0')) continue;
      const id = cmd.match(/--resume[=\0]([0-9a-f-]{36})/)?.[1], bot = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').match(/(?:^|\0)FX_BOT=([^\0]+)/)?.[1];
      if (id && bot) { learn(id, bot, 3); running.add(id); }
    } catch { /* процесс завершился или чужой */ }
  }
}

function scanTranscripts() {
  let files = [];
  try { files = fs.readdirSync(SESSIONS).filter((f) => f.endsWith('.jsonl')); } catch { return; }
  for (const f of files) {
    const id = f.slice(0, -6), file = path.join(SESSIONS, f);
    try {
      const size = fs.statSync(file).size;
      let pos = scanned.get(id) ?? 0, bot = null, tail = '';
      if (size < pos) pos = 0;
      if (size === pos) continue;
      // Читаем кусками; незаконченную строку дочитаем в следующий раз.
      while (pos < size) {
        const buf = readRange(file, pos, Math.min(size, pos + 8_000_000)), text = tail + buf.toString('latin1');
        const cut = text.lastIndexOf('\n') + 1;
        for (const line of text.slice(0, cut).split('\n')) {
          if (!line.includes('"type":"api-request-shape"')) continue;
          const m = Buffer.from(line, 'latin1').toString('utf8').match(/персонажем по имени «([^»"\\]{1,60})»/);
          if (m) bot = m[1];
        }
        tail = text.slice(cut);
        pos += buf.length;
      }
      scanned.set(id, size - Buffer.byteLength(tail, 'latin1'));
      ownersChanged = true;
      if (bot) learn(id, bot, 1);
    } catch { /* файл исчез */ }
  }
}

function scanLogs() {
  for (const name of ['bot.log', 'sessions.log']) {
    try {
      const file = path.join(ROOT, name), size = fs.statSync(file).size;
      let pos = logPos.get(name) ?? 0;
      if (size < pos) pos = 0;
      if (size === pos) continue;
      const text = readRange(file, pos, size).toString('utf8');
      logPos.set(name, size);
      for (const m of text.matchAll(/\[agent ([^\]\n]+)\] сессия ([0-9a-f-]{36})/g)) learn(m[2], m[1], 2);
    } catch { /* лога нет */ }
  }
}

function scanBotLog() { // историческое имя: обновить сведения о сессиях (не чаще раза в 2 секунды)
  if (Date.now() - lastScan < 2000) return;
  lastScan = Date.now();
  scanLogs(); scanTranscripts(); scanProcesses();
  if (ownersChanged) saveMapState();
}

// Архив: сессии и субагенты, которые зрители убрали с глаз. Общий для всех. Вместе с реестром сессий — в state-map.json.
const MAP_STATE = path.join(ROOT, 'state-map.json');
let archived = new Set(); // "id сессии" | "id сессии/id субагента"
try {
  const st = JSON.parse(fs.readFileSync(MAP_STATE, 'utf8'));
  archived = new Set(st.archived ?? []);
  for (const [id, o] of Object.entries(st.sessions ?? {})) owners.set(id, { bot: o[0], rank: o[1] });
  for (const [id, n] of Object.entries(st.scanned ?? {})) scanned.set(id, n);
  for (const [sid, o] of owners) { if (!botSessions.has(o.bot)) botSessions.set(o.bot, new Set()); botSessions.get(o.bot).add(sid); }
} catch { /* файла ещё нет */ }
function saveMapState() {
  const sessions = {};
  for (const [id, o] of owners) sessions[id] = [o.bot, o.rank];
  fs.writeFileSync(MAP_STATE + '.tmp', JSON.stringify({ archived: [...archived], sessions, scanned: Object.fromEntries(scanned) }, null, 1));
  fs.renameSync(MAP_STATE + '.tmp', MAP_STATE);
  ownersChanged = false;
}
function setArchived(key, on) {
  if (on) archived.add(key); else archived.delete(key);
  saveMapState();
}

let secrets = null;
function redact(text) {
  if (!secrets) {
    secrets = [];
    try { secrets.push(JSON.parse(fs.readFileSync(path.join(ROOT, 'rcon.json'), 'utf8')).password); } catch { /* нет файла */ }
    secrets.push(gamePassword());
    try { secrets.push(...Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'bot-tokens.json'), 'utf8')))); } catch { /* нет файла */ }
    secrets = secrets.filter((x) => x && x.length >= 6);
  }
  let out = text.replace(/sk-ant-[\w-]{8,}/g, '•••').replace(/(Bearer\s+)[\w.~+/-]{12,}/gi, '$1•••').replace(/("?(?:access|refresh)_?[tT]oken"?\s*[:=]\s*"?)[\w.~+/-]{12,}/g, '$1•••');
  for (const x of secrets) out = out.split(x).join('•••');
  return out;
}
const clip = (v, n) => { const t = redact(typeof v === 'string' ? v : JSON.stringify(v ?? '')); return t.length > n ? `${t.slice(0, n)}… (ещё ${t.length - n} символов)` : t; };

function sessionFile(id, agent) { return agent ? path.join(SESSIONS, id, 'subagents', `agent-${agent}.jsonl`) : path.join(SESSIONS, `${id}.jsonl`); }
function readRange(file, from, to) {
  const fd = fs.openSync(file, 'r');
  try { const buf = Buffer.alloc(to - from); fs.readSync(fd, buf, 0, buf.length, from); return buf; } finally { fs.closeSync(fd); }
}

// Субагенты сессии: метаданные и кто кого запустил (по id вызова инструмента Agent).
const treeCache = new Map(); // id сессии -> { key, nodes, byTool }
function sessionTree(id) {
  const dir = path.join(SESSIONS, id, 'subagents');
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.meta.json')); } catch { /* субагентов не было */ }
  const metas = names.map((f) => {
    const agent = f.slice(6, -10);
    let meta = {}, st = null;
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { /* пишется прямо сейчас */ }
    try { st = fs.statSync(sessionFile(id, agent)); } catch { /* ещё нет */ }
    return { agent, meta, size: st?.size ?? 0, mtime: st ? Math.floor(st.mtimeMs) : 0 };
  });
  const key = metas.map((m) => `${m.agent}:${m.size}:${m.meta.finished ? 1 : 0}`).join(',');
  const cached = treeCache.get(id);
  if (cached?.key === key) return cached;
  const parents = cached?.parents ?? new Map(); // agent -> родитель ('' — главная сессия); раз найденный родитель не меняется
  const deep = metas.filter((m) => (m.meta.spawnDepth ?? 1) > 1 && !parents.has(m.agent));
  if (deep.length) {
    for (const cand of metas) {
      let text = '';
      try { text = fs.readFileSync(sessionFile(id, cand.agent), 'utf8'); } catch { continue; }
      for (const d of deep) if (d !== cand && d.meta.toolUseId && text.includes(`"id":"${d.meta.toolUseId}"`)) parents.set(d.agent, cand.agent);
    }
  }
  const now = Date.now();
  const nodes = metas.sort((a, b) => a.mtime - b.mtime).map((m) => ({
    agent: m.agent, parent: (m.meta.spawnDepth ?? 1) > 1 ? parents.get(m.agent) ?? '' : '', description: clip(m.meta.description ?? '', 200),
    type: m.meta.agentType ?? '', model: m.meta.model ?? '', finished: !!m.meta.finished, mtime: m.mtime,
    // «Работает» — не отмечен завершённым и писал в лог недавно (после убитой сессии отметка не появляется никогда).
    running: !m.meta.finished && now - m.mtime < 300_000,
  }));
  // Отметку архива ставим при выдаче: она меняется независимо от файлов.
  const byTool = new Map(metas.filter((m) => m.meta.toolUseId).map((m) => [m.meta.toolUseId, m.agent]));
  const res = { key, nodes, byTool, parents };
  treeCache.set(id, res);
  return res;
}

function recordEvents(r, byTool, isAgent, out) {
  const ts = r.timestamp ? Date.parse(r.timestamp) : null, c = r.message?.content;
  if (r.type === 'user') {
    if (typeof c === 'string') {
      if (isAgent) out.push({ k: 'task', ts, text: clip(c, 6000) });                       // задание субагенту от родителя
      else if (/^\[(система|игровой чат)\]/.test(c)) out.push({ k: 'note', ts, text: clip(c, 3000) });
      else if (/^<[a-z-]+>/.test(c)) out.push({ k: 'note', ts, text: clip(c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(), 1500) }); // уведомления о субагентах
      else out.push({ k: 'human', ts });                                                    // реплика человека — без текста
    } else if (Array.isArray(c)) {
      for (const b of c) {
        if (b.type !== 'tool_result') continue;
        const text = typeof b.content === 'string' ? b.content : Array.isArray(b.content) ? b.content.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : '';
        out.push({ k: 'result', id: b.tool_use_id, ts, error: !!b.is_error, text: clip(text, 6000) });
      }
    }
  } else if (r.type === 'assistant' && Array.isArray(c)) {
    for (const b of c) {
      if (b.type === 'text' && b.text.trim()) out.push({ k: 'text', ts, text: clip(b.text, 8000) });
      else if (b.type === 'tool_use') {
        const ev = { k: 'tool', id: b.id, ts, name: b.name.replace(/^mcp__factorio__/, ''), input: clip(JSON.stringify(b.input ?? {}, null, 1), 4000) };
        if (byTool.has(b.id)) ev.agent = byTool.get(b.id);
        out.push(ev);
      }
    }
  }
}

/** Кусок лога: после смещения after (новое) либо перед смещением before (старое; без параметров — хвост). */
function sessionLog(id, agent, after, before) {
  const file = sessionFile(id, agent), size = fs.statSync(file).size, { byTool } = sessionTree(id);
  const parse = (buf, out) => { for (const line of buf.toString('utf8').split('\n')) { if (line.length < 2 || !/"type":"(user|assistant)"/.test(line)) continue; try { recordEvents(JSON.parse(line), byTool, !!agent, out); } catch { /* обрывок строки */ } } };
  if (after != null && after <= size) {
    if (size - after > 4_000_000) return sessionLog(id, agent, null, null); // слишком отстали — отдаём хвост
    const buf = readRange(file, after, size), cut = buf.lastIndexOf(10) + 1, events = [];
    parse(buf.subarray(0, cut), events);
    return { events, end: after + cut };
  }
  let end = Math.min(before ?? size, size), events = [];
  if (before == null && end > 0) {
    // Хвост: последняя строка может дописываться прямо сейчас — заканчиваем на последнем переводе строки.
    const from = Math.max(0, end - 1_000_000);
    end = from + readRange(file, from, end).lastIndexOf(10) + 1;
  }
  let start = end;
  // Читаем назад кусками, пока не наберётся достаточно событий.
  for (let read = 0; start > 0 && events.length < 60 && read < 16_000_000;) {
    const from = Math.max(0, start - 1_000_000), buf = readRange(file, from, start);
    const skip = from === 0 ? 0 : buf.indexOf(10) + 1; // первая строка куска может быть обрезана
    read += buf.length;
    if (from > 0 && skip === 0) { start = from; continue; } // одна строка длиннее куска — идём дальше назад
    const part = [];
    parse(buf.subarray(skip), part);
    events = part.concat(events);
    start = from + skip;
  }
  return { events, start, end };
}

function sessionList(bot) {
  scanBotLog();
  let current = new Set();
  try { current = new Set(Object.values(JSON.parse(fs.readFileSync(path.join(ROOT, 'state-factorio.json'), 'utf8')))); } catch { /* нет файла */ }
  const out = [];
  for (const id of botSessions.get(bot) ?? []) {
    let st;
    try { st = fs.statSync(sessionFile(id)); } catch { continue; }
    let title = '';
    try { const tail = readRange(sessionFile(id), Math.max(0, st.size - 300_000), st.size).toString('utf8'); const m = [...tail.matchAll(/"type":"ai-title","aiTitle":"((?:[^"\\]|\\.)*)"/g)].pop(); if (m) title = JSON.parse(`"${m[1]}"`); } catch { /* без названия */ }
    out.push({ id, archived: archived.has(id), title: clip(title, 120), mtime: Math.floor(st.mtimeMs), created: Math.floor(st.birthtimeMs), current: current.has(id) || running.has(id), active: Date.now() - st.mtimeMs < 120_000 });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  if (out.length && !out.some((x) => x.current)) out[0].current = true;
  return out;
}

// ---------- иконки предметов из файлов игры ----------
// В прототипах игры ищем пары «name = …, icon = …»; чего там нет — по имени файла в graphics/icons.

function loadIcons() {
  const out = new Map();
  const data = path.join(CAMERA_DIR, 'factorio/data');
  const walk = (dir, fn) => { let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; } for (const e of ents) { const f = path.join(dir, e.name); if (e.isDirectory()) walk(f, fn); else fn(f); } };
  let mods = [];
  try { mods = fs.readdirSync(data); } catch { return out; }
  const byFile = new Map();
  for (const mod of mods) {
    walk(path.join(data, mod, 'graphics/icons'), (f) => { if (f.endsWith('.png')) { const n = path.basename(f, '.png'); if (!byFile.has(n) || mod === 'base') byFile.set(n, f); } });
    walk(path.join(data, mod, 'prototypes'), (f) => {
      if (!f.endsWith('.lua')) return;
      const isItem = /item/.test(path.relative(data, f));
      const re = /name\s*=\s*"([a-z0-9-]+)"\s*,([\s\S]{0,400}?)\bicon\s*=\s*"__([a-z-]+)__\/(graphics\/icons\/[^"]+\.png)"/g;
      for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
        if (/\bname\s*=/.test(m[2])) continue; // иконка уже другого прототипа
        const file = path.join(data, m[3], m[4]);
        if ((!out.has(m[1]) || isItem) && fs.existsSync(file)) out.set(m[1], file);
      }
    });
  }
  for (const [n, f] of byFile) if (!out.has(n)) out.set(n, f);
  return out;
}
const ICONS = loadIcons();

// ---------- HTTP и WebSocket ----------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const reply = (code, type, body, cache = 'no-cache') => res.writeHead(code, { 'content-type': type, 'cache-control': cache }).end(body);
  try {
    if (req.method === 'POST' && url.pathname === '/api/session/archive') {
      // Убрать сессию или субагента в архив либо вернуть. Доступно любому зрителю: это только отметка, данные не удаляются.
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 2000) return reply(413, 'text/plain', ''); }
      const m = JSON.parse(body);
      scanBotLog();
      const agent = String(m.agent ?? '');
      if (!botSessions.get(String(m.bot))?.has(m.id) || !/^[a-f0-9]{0,40}$/.test(agent)) return reply(404, 'application/json', '{"error":"нет такой сессии"}');
      if (agent && !sessionTree(m.id).nodes.some((n) => n.agent === agent)) return reply(404, 'application/json', '{"error":"нет такого субагента"}');
      setArchived(agent ? `${m.id}/${agent}` : m.id, !!m.archived);
      log(`архив: ${m.bot} ${m.id}${agent ? '/' + agent : ''} → ${m.archived ? 'в архив' : 'из архива'}`);
      return reply(200, 'application/json', '{"ok":true}');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return reply(405, 'text/plain', '');
    if (url.pathname === '/') return reply(200, 'text/html; charset=utf-8', fs.readFileSync(path.join(WEB, 'index.html')));
    const ic = url.pathname.match(/^\/icon\/([a-z0-9-]{1,80})\.png$/);
    if (ic) {
      const file = ICONS.get(ic[1]);
      return file ? reply(200, 'image/png', fs.readFileSync(file), 'public, max-age=604800') : reply(404, 'text/plain', '', 'max-age=3600');
    }
    if (url.pathname === '/names.json') return reply(200, 'application/json', NAMES, 'max-age=3600');
    const t = url.pathname.match(/^\/tiles\/(\d)\/(-?\d{1,6})\/(-?\d{1,6})\.jpg$/);
    if (t) {
      if (!tiles.get(key(+t[1], +t[2], +t[3]))?.sig) return reply(404, 'text/plain', ''); // ещё не собран с учётом тумана
      let body;
      try { body = fs.readFileSync(tileFile(+t[1], +t[2], +t[3])); } catch { return reply(404, 'text/plain', ''); }
      const type = body[0] === 0x89 ? 'image/png' : 'image/jpeg'; // тайлы тумана — PNG, снимки — JPEG
      // Версия в адресе (?v=), поэтому сам файл можно кешировать навсегда.
      return reply(200, type, body, url.searchParams.has('v') ? 'public, max-age=31536000, immutable' : 'no-cache');
    }
    if (url.pathname.startsWith('/api/session')) {
      const q = url.searchParams, bot = q.get('bot') ?? '';
      const json = (v) => reply(200, 'application/json', JSON.stringify(v));
      if (url.pathname === '/api/sessions') return json(sessionList(bot));
      const id = q.get('id') ?? '', agent = q.get('agent') ?? '';
      scanBotLog();
      if (!botSessions.get(bot)?.has(id) || !/^[a-f0-9]{0,40}$/.test(agent)) return reply(404, 'application/json', '{"error":"нет такой сессии"}');
      if (url.pathname === '/api/session/tree') return json({ nodes: sessionTree(id).nodes.map((n) => ({ ...n, archived: archived.has(`${id}/${n.agent}`) })), now: Date.now() });
      if (url.pathname === '/api/session/log') {
        const num = (k) => (q.has(k) && /^\d{1,15}$/.test(q.get(k)) ? Number(q.get(k)) : null);
        try { return json(sessionLog(id, agent, num('after'), num('before'))); } catch { return reply(404, 'application/json', '{"error":"нет такого лога"}'); }
      }
    }
    if (url.pathname === '/ui/map-buttons.png') return reply(200, 'image/png', fs.readFileSync(MAP_BUTTONS), 'public, max-age=604800');
    if (url.pathname === '/api/entity') {
      // Сведения о постройке в точке карты — как при наведении курсора в игре.
      const x = Number(url.searchParams.get('x')), y = Number(url.searchParams.get('y'));
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 2e6 || Math.abs(y) > 2e6) return reply(400, 'application/json', '{"error":"нужны x и y"}');
      return reply(200, 'application/json', JSON.stringify(await entityAt(x, y, SURFACE)));
    }
    if (url.pathname === '/api/layers') {
      // Слои карты: ?l=electric,pollution — только известные имена, каждый слой кешируется.
      const want = [...new Set((url.searchParams.get('l') ?? '').split(','))].filter((l) => LAYERS.includes(l));
      const out = {};
      await Promise.all(want.map(async (l) => { try { out[l] = await layer(l, SURFACE); } catch { /* слой придёт в следующий раз */ } }));
      return reply(200, 'application/json', JSON.stringify(out));
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

const wss = new WebSocketServer({ noServer: true, maxPayload: 2048 });
const wssVideo = new WebSocketServer({ noServer: true, maxPayload: 64 });
server.on('upgrade', (req, socket, headUp) => {
  const p = new URL(req.url, 'http://x').pathname;
  const target = p === '/ws' ? wss : p === '/video' ? wssVideo : null;
  if (!target) return socket.destroy();
  target.handleUpgrade(req, socket, headUp, (ws) => target.emit('connection', ws, req));
});
wssVideo.on('connection', (ws) => {
  if (viewers.size >= MAX_CLIENTS) return ws.close(1013, 'слишком много зрителей');
  viewers.add(ws);
  clearTimeout(videoIdle);
  startVideo();
  const gone = () => {
    viewers.delete(ws);
    if (!viewers.size) { clearTimeout(videoIdle); videoIdle = setTimeout(() => { if (!viewers.size) stopVideo(); }, VIDEO_IDLE_MS); }
  };
  ws.on('close', gone);
  ws.on('error', gone);
});
wss.on('connection', (ws) => {
  if (clients.size >= MAX_CLIENTS) return ws.close(1013, 'слишком много зрителей');
  clients.add(ws);
  const tl = [];
  for (const t of tiles.values()) if (t.sig) tl.push([t.z, t.x, t.y, t.ts, t.fog ? 1 : 0, t.ver || t.ts]);
  send(ws, { t: 'hello', zmax: ZMAX, tile: TILE, surface: SURFACE, fresh_ms: FRESH_MS, sweep_ms: SWEEP_MS, cam: { w: 1280 / 32 / CAMERA_ZOOM, h: 720 / 32 / CAMERA_ZOOM }, tiles: tl, summary, events, live, now: Date.now() });
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(data);
      if (m.t === 'follow') {
        // Зритель выбрал, за кем следить камере живого окна (null — отпустить, камера выбирает сама).
        if (m.name == null) { if (target?.by === ws) target = null; return; }
        const kind = m.kind === 'player' ? 'player' : 'bot';
        if ((kind === 'bot' ? live.bots : live.players).some((a) => a.name === m.name)) target = { kind, name: m.name, by: ws, since: Date.now() };
        return;
      }
      if (m.t === 'view' && m.none) { ws.view = []; return; } // вкладка зрителя скрыта: ради неё камеру не гоняем
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
setInterval(() => { log(`зрителей ${clients.size}, тайлов ${tiles.size}, снято за минуту ${rendered} (без изменений ${unchanged}), камера ${live.camera ? 'в игре' : 'не в игре'}`); rendered = 0; unchanged = 0; }, 60_000);
// Штатная остановка сервиса останавливает и клиент-камеру; после падения сервиса клиент остаётся, и следующий запуск его подхватит.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    saveState();
    if (encoder) encoder.kill('SIGTERM');
    if (camera) { try { process.kill(-camera.pid, 'SIGTERM'); } catch { /* уже нет */ } fs.rmSync(PID_FILE, { force: true }); }
    const x = xvfbPid();
    if (x) { try { process.kill(x, 'SIGTERM'); } catch { /* уже нет */ } }
    process.exit(0);
  });
}
// Перезапуск сервиса без остановки камеры (после правок кода): kill -USR2 $(pgrep -f '^node src/map.mjs');
// новый процесс подхватит камеру по camera.pid. Процесс НЕЛЬЗЯ искать по порту 8766: тот же номер порта
// (на 127.0.0.1) слушает хозяин сессий ботов src/sessions.mjs, и сигнал, посланный «всем на 8766», обрывает сессии ботов.
process.on('SIGUSR2', () => { saveState(); if (encoder) encoder.kill('SIGTERM'); process.exit(0); });
fs.mkdirSync(TILES, { recursive: true });
loadState();
setInterval(saveState, 60_000);
liveLoop(); chunkListLoop(); chartLoop(); fogLoop(); summaryLoop(); renderLoop(); cameraLoop();
