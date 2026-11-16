// Фоновый обработчик заявок ботов на улучшение управления игрой (v2/: мод в сохранении и сервер ботов).
//
// Пока в feedback/queue.jsonl есть новые заявки, запускает заходы — на каждый отдельную сессию Claude Code (на хосте,
// в этой папке) с правилами из feedback/WORKER_PROMPT.md. Сессия видит всю очередь, сама выбирает заявку или пачку
// связанных, правит код и проверяет его на тестовом стенде. После сессии обработчик сам прогоняет полную проверку
// (v2/tools/verify.sh), коммитит результат и отправляет на GitHub; при любой неполадке откатывает правки и отдаёт
// заявку людям (статус discussion).
//
// Правки не выходят по одной: правка мода требует перезапуска сервера игры. Поэтому готовые правки копятся в git,
// а на рабочий сервер выходят пакетом (src/release.mjs): автоматически между заходами, не чаще одного выпуска
// в 30 минут (людей в игре предупреждают в чате за 20 секунд), либо сразу по просьбе человека
// (node src/feedback.mjs release). Правки правил доходят до ботов без выпуска.
//
//   tmux new-window -d -t 0: -n feedback-worker 'cd ~/claude/discord-voice && node src/feedback-worker.mjs 2>&1 | tee -a feedback/worker.log'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { readItems, setStatus, markAnnounced, readRelease, submitFeedback, RELEASE_NOW } from './feedback.mjs';
import { pending, release } from './release.mjs';
import { lua } from './rcon.mjs';

const CLAUDE = process.env.WORKER_CLAUDE_BIN || path.join(os.homedir(), 'claude/claude-code/bin/claude');
const MODEL = process.env.WORKER_MODEL || 'claude-fable-5-2';
const TIMEOUT_MS = 60 * 60_000;
// Что сессии можно менять. Всё остальное — не её задача (статус discussion).
const ALLOWED = [/^v2\/mod\//, /^v2\/server\/[^/]+\.mjs$/, /^v2\/tests\/[^/]+\.mjs$/, /^rules\/RULES\.md$/, /^README\.md$/];
const NEEDS_RELEASE = [/^v2\/mod\//, /^v2\/server\//];
const NEEDS_VERIFY = [/^v2\//];
const TOOLS = ['Read', 'Glob', 'Grep',
  'Edit(v2/mod/**)', 'Write(v2/mod/**)', 'Edit(v2/server/*.mjs)', 'Edit(v2/tests/*.mjs)', 'Write(v2/tests/*.mjs)', 'Edit(rules/RULES.md)', 'Edit(README.md)',
  'Bash(node --check *)', 'Bash(v2/tools/reload.sh*)', 'Bash(v2/tools/test-server.sh *)', 'Bash(v2/tools/test-api.sh *)', 'Bash(v2/tools/verify.sh*)',
  'Bash(node v2/tests/*)', 'Bash(node v2/tools/rc.mjs *)', 'Bash(v2/tools/apidoc.py *)', 'Bash(curl -s http://127.0.0.1:8790/*)',
  'Bash(git diff *)', 'Bash(git status *)', 'Bash(git log *)'];
const MIN_RELEASE_GAP_MS = 30 * 60_000; // выпуски — не чаще одного в 30 минут

const log = (...a) => console.log(new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 19).replace('T', ' '), ...a);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const any = (list, f) => list.some((re) => re.test(f));

function runClaude(prompt) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, ['-p', prompt, '--model', MODEL, '--permission-mode', 'dontAsk', '--allowedTools', ...TOOLS, '--output-format', 'json'],
      { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }); });
  });
}

// Правки обработчика в рабочей папке: изменённые и новые файлы только там, где сессии разрешено править.
// В этой же папке работают люди и другие сессии: их незакоммиченные файлы (src/ и прочее) обработчик не считает
// своими, не отменяет и не коммитит. Сессия посторонние файлы изменить не может — у неё нет на это прав.
function changes() {
  const out = git('status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean);
  return out.map((l) => l.slice(3).replace(/^"|"$/g, '').split(' -> ').pop()).filter((f) => any(ALLOWED, f));
}

function revert(files) {
  const saved = `feedback/rejected-${Date.now()}.diff`;
  git('add', '-N', '--', ...files); // чтобы новые файлы попали в diff
  fs.writeFileSync(path.join(ROOT, saved), git('diff', '--', ...files));
  git('reset', '-q', '--', ...files);
  const tracked = files.filter((f) => git('ls-files', '--', f).trim());
  if (tracked.length) git('checkout', '--', ...tracked);
  for (const f of files) if (!tracked.includes(f)) fs.rmSync(path.join(ROOT, f), { force: true });
  return saved;
}

// Один заход: сессия видит всю очередь, сама выбирает заявку или пачку связанных и даёт вердикт по каждой разобранной.
async function handle(queue) {
  const all = readItems();
  log(`в очереди ${queue.length}: ${queue.map((i) => i.id + (i.priority ? '!' : '')).join(' ')}`);
  if (changes().length) return log(`незакоммиченные правки в ${changes().join(', ')} — жду, пока их закоммитят`);

  const rules = fs.readFileSync(path.join(ROOT, 'feedback', 'WORKER_PROMPT.md'), 'utf8');
  const resolved = all.filter((i) => ['done', 'rejected', 'discussion'].includes(i.status)).slice(-25)
    .map((i) => `- ${i.id} (${i.from}) ${i.status}: ${i.text.replace(/\s+/g, ' ').slice(0, 120)} → ${(i.note ?? '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
  const open = queue.map((i) => `### ${i.id} от «${i.from}»${i.priority ? ' — ПРИОРИТЕТ ОТ ЛЮДЕЙ' : ''}\n<feedback>\n${i.text.slice(0, 2500)}\n</feedback>`).join('\n\n');
  const { code, out } = await runClaude(`${rules}\n\n## Уже разобранные заявки (для справки; до fb-052 включительно — про прежнюю систему инструментов, её больше нет)\n\n${resolved || 'пока нет'}\n\n## Очередь\n\n${open}`);
  let summary = '';
  try { summary = JSON.parse(out).result ?? ''; } catch { summary = out.slice(-4000); }
  fs.writeFileSync(path.join(ROOT, 'feedback', `session-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`), summary);

  // Вердикты — JSON-массив после последней пометки VERDICTS: в итоговом сообщении.
  let verdicts = [];
  const at = summary.lastIndexOf('VERDICTS:');
  if (at >= 0) {
    const tail = summary.slice(at + 9);
    try { verdicts = JSON.parse(tail.slice(tail.indexOf('['), tail.lastIndexOf(']') + 1)); } catch { /* разбор ниже сочтёт, что вердиктов нет */ }
  }
  const ids = new Set(queue.map((i) => i.id));
  verdicts = (Array.isArray(verdicts) ? verdicts : []).filter((v) => v && ids.has(v.id) && ['done', 'rejected', 'discussion'].includes(v.status))
    .map((v) => ({ id: v.id, status: v.status, note: String(v.note ?? '').slice(0, 4000) }));

  const changed = changes();
  let problem = null;
  let commit = null;
  let needsRelease = false;
  if (!verdicts.length) problem = `сессия не оставила вердиктов (код завершения ${code})`;
  if (changed.length) {
    if (!problem && !verdicts.some((v) => v.status === 'done')) problem = 'код изменён, но ни одна заявка не отмечена выполненной';
    if (!problem && changed.some((f) => any(NEEDS_VERIFY, f))) {
      // Независимая полная проверка на тестовом стенде: свежая копия карты, все наборы.
      log('проверяю правки на тестовом стенде…');
      const r = spawnSync(path.join(ROOT, 'v2/tools/verify.sh'), [], { cwd: ROOT, encoding: 'utf8', timeout: 30 * 60_000 });
      const text = `${r.stdout || ''}${r.stderr || ''}`.trim();
      if (r.status !== 0) problem = `правки не проходят проверку на тестовом стенде: ${text.split('\n').slice(-12).join(' | ').slice(0, 900)}`;
      else log(text.split('\n').filter((l) => /:|ПРОВЕРКА/.test(l)).join(' | '));
    }
    if (problem) {
      // Отменённую работу не выбрасываем: её можно посмотреть и применить руками (git apply).
      problem += `; правки отменены и сохранены в ${revert(changed)}`;
    } else {
      const done = verdicts.filter((v) => v.status === 'done');
      git('add', '--', ...changed);
      // Коммит только своих файлов: чужое, даже добавленное в индекс, в него не попадает.
      git('commit', '-q', '--only', '-m', `feedback ${done.map((v) => v.id).join(', ')}: ${done[0].note.split('\n')[0].slice(0, 90)}\n\n${done.map((v) => `${v.id}: ${v.note}`).join('\n\n')}\n\nОбработано автоматически (src/feedback-worker.mjs).`, '--', ...changed);
      commit = git('rev-parse', 'HEAD').trim();
      needsRelease = changed.some((f) => any(NEEDS_RELEASE, f));
      log(`закоммичено ${commit.slice(0, 10)}: ${changed.join(', ')}${needsRelease ? ' — ждёт выпуска' : ''}`);
    }
  }
  if (problem) {
    // Чтобы заход не повторялся бесконечно, заявки, которые сессия взяла (или первую в очереди), отдаём людям.
    const taken = verdicts.length ? verdicts : [{ id: queue[0].id, note: '' }];
    for (const v of taken) setStatus(v.id, 'discussion', `${problem}. ${v.note}`.trim());
    return log(`заход не удался: ${problem}`);
  }
  for (const v of verdicts) {
    // released: false — правка сделана, но начнёт действовать только после выпуска пакета.
    const extra = v.status === 'done' && commit ? { commit, released: !needsRelease } : {};
    setStatus(v.id, v.status, v.note, undefined, extra);
    log(`${v.id}: ${v.status}${extra.released === false ? ' (ждёт выпуска)' : ''} — ${v.note.replace(/\s+/g, ' ').slice(0, 200)}`);
  }
}

// Всё закоммиченное (и обработчиком, и руками) регулярно уходит на GitHub.
function push() {
  try {
    if (git('rev-parse', 'HEAD').trim() === git('rev-parse', 'origin/master').trim()) return;
    git('push', '-q', 'origin', 'HEAD:master');
    log('отправлено на GitHub');
  } catch (e) {
    log(`не удалось отправить на GitHub: ${String(e.stderr || e.message).trim().slice(0, 200)}`);
  }
}

// Сообщение в игровой чат от имени разработчиков: сессиям ботов оно приходит как «[игровой чат] разработчики: …».
async function say(message) {
  await lua(`
    storage.vb_chat = storage.vb_chat or {seq=0, items={}}
    local c = storage.vb_chat
    c.seq = c.seq + 1
    c.items[#c.items+1] = {seq=c.seq, from=A.from, text=A.message}
    if #c.items > 50 then table.remove(c.items, 1) end
    game.print('[color=0.6,0.8,1]'..A.from..':[/color] '..A.message)
    return {sent=true}`, { from: 'разработчики', message });
}

// О каждом решении по заявке сообщаем в игровой чат ботов.
const STATUS_RU = { done: 'выполнена', rejected: 'отклонена', discussion: 'вынесена на обсуждение людей' };
async function announce() {
  const fresh = readItems().filter((i) => STATUS_RU[i.status] && !i.announced && Date.now() - Date.parse(i.updated) < 3600_000);
  for (const i of fresh) {
    const when = i.status === 'done' && i.released === false ? ' (начнёт действовать со следующим обновлением игры — о нём сообщим)' : '';
    await say(`Заявка ${i.id} от ${i.from} ${STATUS_RU[i.status]}${when}. ${(i.note ?? '').replace(/\s+/g, ' ').slice(0, 600)}`);
    markAnnounced(i.id);
    log(`${i.id}: сообщено в чат`);
  }
}

// Выпуск накопленного пакета — автоматически, между заходами, не чаще одного выпуска в 30 минут.
// Людей в игре перед перезапуском предупреждают в чате (это делает release). Команда человека
// (node src/feedback.mjs release) выпускает сразу, без оглядки на 30 минут.
let lastWait = '';
async function maybeRelease() {
  const force = fs.existsSync(RELEASE_NOW);
  const p = pending();
  if (p.blocked) { if (lastWait !== p.blocked) log(`выпуск остановлен: ${p.blocked}`); lastWait = p.blocked; if (force) fs.rmSync(RELEASE_NOW, { force: true }); return; }
  if (!p.mod && !p.server) { if (force) { fs.rmSync(RELEASE_NOW, { force: true }); log('просили выпустить обновление, но выпускать нечего'); } return; }
  if (changes().length) return; // выпускается только закоммиченное
  const what = `${p.mod ? 'мод' : ''}${p.mod && p.server ? ' и ' : ''}${p.server ? 'сервер ботов' : ''}`;
  if (!force) {
    const rel = readRelease();
    const left = rel.at ? MIN_RELEASE_GAP_MS - (Date.now() - Date.parse(rel.at)) : 0;
    if (left > 0) {
      const why = `с прошлого выпуска прошло меньше 30 минут, выйдет после ${new Date(Date.now() + left).toTimeString().slice(0, 5)}`;
      if (lastWait !== p.head) log(`пакет ждёт выпуска (${what}; ${p.files.length} файлов): ${why}`);
      lastWait = p.head;
      return;
    }
  }
  lastWait = '';
  fs.rmSync(RELEASE_NOW, { force: true });
  log(`выпускаю пакет: ${p.files.join(', ')}${force ? ' (по просьбе человека)' : ''}`);
  const r = await release({ force: true, log });
  if (!r.released) {
    log(`пакет не выпущен: ${r.reason}`);
    if (r.failed) await say(`Обновление управления ботами выпустить не удалось, работает прежняя версия: ${r.reason}`.slice(0, 500)).catch(() => {});
    return;
  }
  log(`пакет выпущен (${what}); заявки: ${r.ids.join(', ') || 'нет'}`);
  await sleep(5000); // сессии ботов переподключаются к чату
  await say(`Вышло обновление управления ботами${r.ids.length ? `: начали действовать правки по заявкам ${r.ids.join(', ')}` : ''}. Описание операций — ${'${FX_URL}'}v2/help.`).catch((e) => log(`не сообщил в чат: ${e.message}`));
}

// Замечания, которые боты успели оставить, пока сервер ботов писал их в свой файл, а не в очередь
// (первая версия операции feedback): переносим в очередь, каждое один раз.
function ingestLegacy() {
  const file = path.join(ROOT, 'v2/server/log/feedback.jsonl');
  const mark = path.join(ROOT, 'feedback/ingested.json');
  let lines = [];
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return; }
  let done = 0;
  try { done = JSON.parse(fs.readFileSync(mark, 'utf8')).lines; } catch { /* ещё не переносили */ }
  for (const l of lines.slice(done)) {
    try {
      const it = JSON.parse(l);
      if (it.text && it.text !== 'проверка') log(`заявка из прежнего файла замечаний: ${submitFeedback(it.from, it.text).accepted} от ${it.from}`);
    } catch (e) { log(`не перенёс замечание: ${e.message}`); }
  }
  if (lines.length !== done) fs.writeFileSync(mark, JSON.stringify({ lines: lines.length }));
}

log(`обработчик заявок запущен, модель ${MODEL}`);
for (;;) {
  try {
    ingestLegacy();
    const queue = readItems().filter((i) => i.status === 'new').sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0)).slice(0, 30);
    if (queue.length) await handle(queue);
    push();
    await announce();
    await maybeRelease();
  } catch (e) {
    log('ошибка обработчика:', e.message);
  }
  await sleep(30_000);
}
