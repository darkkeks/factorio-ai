// Выпуск накопленных правок управления ботами (v2/mod, v2/server) на рабочий сервер — пакетом.
// Правка мода требует перезапуска сервера игры: для ботов он прозрачен, а людей выбивает из игры на несколько секунд,
// поэтому правки выходят не по одной, а пакетом. Когда выпускать, решает обработчик заявок (не чаще одного выпуска
// в 30 минут) или человек (node src/feedback.mjs release); людей в игре предупреждают в чате перед перезапуском.
//
//   node src/release.mjs status          — что выпущено и что ждёт выпуска
//   node src/release.mjs init [коммит]   — принять коммит (по умолчанию HEAD) за уже выпущенный
//   node src/release.mjs now [--force]   — выпустить сейчас (--force — даже если в игре люди)
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { readRelease, writeRelease, markReleased } from './feedback.mjs';
import { lua } from './rcon.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const CAMERA = process.env.MAP_CAMERA || 'camera'; // клиент-камера веб-карты — не человек
const TMUX = '0';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim();

/** Что ждёт выпуска: { head, from, files, mod, server, blocked? }. */
export function pending() {
  const rel = readRelease();
  const head = git('rev-parse', 'HEAD');
  const none = { head, from: rel.commit, files: [], mod: false, server: false };
  if (!rel.commit) return { ...none, blocked: 'не задан выпущенный коммит: node src/release.mjs init' };
  if (rel.commit === head) return none;
  const files = git('diff', '--name-only', rel.commit, head, '--', 'v2/mod', 'v2/server').split('\n').filter(Boolean);
  const p = { head, from: rel.commit, files, mod: files.some((f) => f.startsWith('v2/mod/')), server: files.some((f) => f.startsWith('v2/server/')) };
  // Пакет, который уже не удалось выпустить, повторно не выпускается: нужен новый коммит с исправлением.
  if (rel.failed?.commit === head && (p.mod || p.server)) p.blocked = `этот пакет уже не удалось выпустить (${rel.failed.at}): ${rel.failed.reason}`;
  return p;
}

/** Сколько людей в игре (клиент-камера не считается). */
export async function humans() {
  const r = await lua('local n = 0 for _, p in pairs(game.connected_players) do if p.name ~= A.camera then n = n + 1 end end return {n = n}', { camera: CAMERA });
  return r.n;
}

function restartApi(log) {
  const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'v2/server/config.json'), 'utf8'));
  const running = execFileSync('tmux', ['list-windows', '-t', `${TMUX}:`, '-F', '#W'], { encoding: 'utf8' }).split('\n');
  if (running.includes('factorio-api')) execFileSync('tmux', ['kill-window', '-t', `${TMUX}:factorio-api`]);
  execFileSync('tmux', ['new-window', '-d', '-t', `${TMUX}:`, '-n', 'factorio-api', path.join(ROOT, 'run-api.sh')]);
  log('перезапущено окно factorio-api');
  return `http://${conf.http.host}:${conf.http.port}/v2/help`;
}

async function waitHelp(url) {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(2000) }); if (r.ok && (await r.json()).operations) return true; } catch { /* ещё не поднялся */ }
    await sleep(500);
  }
  return false;
}

/**
 * Выпустить накопленное. force — даже если в игре люди (их предупредят в чате за warnSeconds секунд).
 * Возвращает { released: true, ids, mod, server } или { released: false, reason, failed? }.
 */
export async function release({ force = false, log = console.log, warnSeconds = 20 } = {}) {
  const p = pending();
  if (p.blocked) return { released: false, reason: p.blocked };
  if (!p.mod && !p.server) {
    // Коммиты были, но управление ботами они не трогали: считаем выпущенным.
    if (p.from !== p.head) writeRelease({ ...readRelease(), commit: p.head });
    return { released: false, reason: 'нечего выпускать' };
  }
  if (git('status', '--porcelain', '--untracked-files=no', '--', 'v2')) return { released: false, reason: 'в v2/ незакоммиченные правки' };
  const rel = readRelease();
  const build = p.head.slice(0, 12);
  const fail = (reason) => {
    writeRelease({ ...rel, failed: { commit: p.head, at: new Date().toISOString(), reason } });
    return { released: false, failed: true, reason };
  };
  if (p.mod) {
    let n = 0;
    try { n = await humans(); } catch (e) { return { released: false, reason: `сервер игры не отвечает: ${e.message}` }; }
    if (n > 0 && !force) return { released: false, reason: `в игре люди (${n})` };
    if (n > 0) {
      await lua(`game.print('[color=1,0.6,0.2]Сервер перезапустится через ${warnSeconds} секунд: обновление управления ботами. Перезайти можно сразу.[/color]') return {ok = true}`);
      await sleep(warnSeconds * 1000);
    }
    log(`обновляю мод на сервере игры (сборка ${build})…`);
    const r = spawnSync(path.join(ROOT, 'v2/tools/update-game.sh'), ['--build', build], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
    const out = `${r.stdout || ''}${r.stderr || ''}`.trim();
    log(out.split('\n').slice(-6).join(' | '));
    if (r.status !== 0) return fail(`обновление мода не удалось (код ${r.status}${r.status === 2 ? ', сохранение возвращено из резервной копии' : ''}): ${out.split('\n').slice(-3).join(' | ')}`);
  }
  if (p.server) {
    const url = restartApi(log);
    if (!(await waitHelp(url))) return fail('сервер ботов не поднялся после перезапуска окна factorio-api — смотри api.log');
  }
  const at = new Date().toISOString();
  writeRelease({ commit: p.head, at, history: [...(rel.history || []).slice(-50), { commit: p.head, at, mod: p.mod, server: p.server, files: p.files }] });
  const ids = markReleased();
  return { released: true, ids, mod: p.mod, server: p.server, head: p.head };
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'init') {
    const commit = git('rev-parse', arg || 'HEAD');
    writeRelease({ ...readRelease(), commit, at: new Date().toISOString(), failed: undefined });
    console.log('выпущенным считается', commit);
  } else if (cmd === 'now') {
    console.log(await release({ force: arg === '--force' }));
  } else {
    const p = pending();
    console.log('выпущено:', p.from, readRelease().at || '');
    console.log(p.blocked ? `выпуск остановлен: ${p.blocked}` : (p.mod || p.server)
      ? `ждёт выпуска (${p.mod ? 'мод — перезапуск игры' : ''}${p.mod && p.server ? ', ' : ''}${p.server ? 'сервер ботов' : ''}):\n  ${p.files.join('\n  ')}`
      : 'выпускать нечего');
  }
  process.exit(0);
}
