// Фоновый обработчик заявок: пока в feedback/queue.jsonl есть новые заявки, запускает заходы — на каждый отдельную
// сессию Claude Code, которая видит всю очередь и сама выбирает заявку или пачку связанных. Сессия (на хосте, в этой папке), которая дорабатывает src/factorio.mjs по правилам из
// feedback/WORKER_PROMPT.md. Сессии разрешено только читать, править два файла и запускать проверки.
// После сессии обработчик сам проверяет результат, коммитит его в git и перезапускает работающие процессы ботов;
// при любой неполадке откатывает правки и ставит заявке статус discussion.
//   tmux new-window -d -t 0: -n feedback-worker 'cd ~/claude/discord-voice && node src/feedback-worker.mjs 2>&1 | tee -a feedback/worker.log'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { readItems, setStatus, markAnnounced } from './feedback.mjs';
import { lua } from './rcon.mjs';

const CLAUDE = process.env.WORKER_CLAUDE_BIN || path.join(os.homedir(), 'claude/claude-code/bin/claude');
const MODEL = process.env.WORKER_MODEL || 'claude-fable-5-2';
const TIMEOUT_MS = 45 * 60_000;
const ALLOWED_CHANGES = ['src/factorio.mjs', 'README.md'];
const TOOLS = ['Read', 'Glob', 'Grep', 'Edit(src/factorio.mjs)', 'Edit(README.md)',
  'Bash(node --check *)', 'Bash(node src/tool-test.mjs *)', 'Bash(git diff *)', 'Bash(git status *)'];
// Окна tmux, которые нужно перезапустить после изменения инструментов (только если они сейчас запущены).
const RESTART = { 'factorio-mcp': 'run-mcp.sh' }; // голосовой бот перезапускать не нужно: сессии ходят в этот процесс по HTTP

const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace('T', ' '), ...a);
const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

// Один заход: сессия видит всю очередь, сама выбирает заявку или пачку связанных и даёт вердикт по каждой разобранной.
async function handle(queue) {
  const all = readItems();
  log(`в очереди ${queue.length}: ${queue.map((i) => i.id + (i.priority ? '!' : '')).join(' ')}`);
  if (git('status', '--porcelain', '--untracked-files=no').trim()) {
    return log('в рабочей папке незакоммиченные правки — жду, пока их закоммитят');
  }

  const rules = fs.readFileSync(path.join(ROOT, 'feedback', 'WORKER_PROMPT.md'), 'utf8');
  const resolved = all.filter((i) => ['done', 'rejected', 'discussion'].includes(i.status)).slice(-25)
    .map((i) => `- ${i.id} (${i.from}) ${i.status}: ${i.text.replace(/\s+/g, ' ').slice(0, 120)} → ${(i.note ?? '').replace(/\s+/g, ' ').slice(0, 220)}`).join('\n');
  const open = queue.map((i) => `### ${i.id} от «${i.from}»${i.priority ? ' — ПРИОРИТЕТ ОТ ЛЮДЕЙ' : ''}\n<feedback>\n${i.text.slice(0, 2500)}\n</feedback>`).join('\n\n');
  const { code, out } = await runClaude(`${rules}\n\n## Уже разобранные заявки (для справки)\n\n${resolved || 'пока нет'}\n\n## Очередь\n\n${open}`);
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

  const changed = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).map((l) => l.slice(3));
  let problem = null;
  if (!verdicts.length) problem = `сессия не оставила вердиктов (код завершения ${code})`;
  if (changed.length) {
    const foreign = changed.filter((f) => !ALLOWED_CHANGES.includes(f));
    if (!problem && foreign.length) problem = `изменены посторонние файлы: ${foreign.join(', ')}`;
    if (!problem && !verdicts.some((v) => v.status === 'done')) problem = 'код изменён, но ни одна заявка не отмечена выполненной';
    if (!problem) {
      try {
        execFileSync('node', ['--check', 'src/factorio.mjs'], { cwd: ROOT, stdio: 'pipe' });
        // Дымовая проверка: модуль загружается и простой инструмент отвечает.
        execFileSync('node', ['src/tool-test.mjs', 'call', 'status'], { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
        execFileSync('node', ['src/tool-test.mjs', 'cleanup'], { cwd: ROOT, stdio: 'pipe', timeout: 60_000 });
      } catch (e) {
        problem = `после правок инструменты не проходят проверку: ${String(e.stdout || e.message).slice(0, 300)}`;
      }
    }
    if (problem) {
      // Отменённую работу не выбрасываем: её можно посмотреть и применить руками (git apply).
      const saved = `feedback/rejected-${Date.now()}.diff`;
      fs.writeFileSync(path.join(ROOT, saved), git('diff'));
      git('checkout', '--', '.');
      problem += `; правки отменены и сохранены в ${saved}`;
    } else {
      const done = verdicts.filter((v) => v.status === 'done');
      git('add', ...changed);
      git('commit', '-q', '-m', `feedback ${done.map((v) => v.id).join(', ')}: ${done[0].note.split('\n')[0].slice(0, 90)}\n\n${done.map((v) => `${v.id}: ${v.note}`).join('\n\n')}\n\nОбработано автоматически (src/feedback-worker.mjs).\n\nCo-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`);
      if (changed.includes('src/factorio.mjs')) restart();
    }
  }
  if (problem) {
    // Чтобы заход не повторялся бесконечно, заявки, которые сессия взяла (или первую в очереди), отдаём людям.
    const taken = verdicts.length ? verdicts : [{ id: queue[0].id, note: '' }];
    for (const v of taken) setStatus(v.id, 'discussion', `${problem}. ${v.note}`.trim());
    return log(`заход не удался: ${problem}`);
  }
  for (const v of verdicts) {
    setStatus(v.id, v.status, v.note);
    log(`${v.id}: ${v.status} — ${v.note.replace(/\s+/g, ' ').slice(0, 200)}`);
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

// О каждом решении по заявке сообщаем в игровой чат ботов: голосовым сессиям оно придёт как «[игровой чат]»,
// внешние клиенты увидят его в read_chat. Сообщаем не сразу после перезапуска ботов, иначе они его пропустят.
let lastRestart = 0;
const STATUS_RU = { done: 'выполнена', rejected: 'отклонена', discussion: 'вынесена на обсуждение людей' };
async function announce() {
  if (Date.now() - lastRestart < 40_000) return;
  const fresh = readItems().filter((i) => STATUS_RU[i.status] && !i.announced && Date.now() - Date.parse(i.updated) < 3600_000);
  for (const i of fresh) {
    const message = `Заявка ${i.id} от ${i.from} ${STATUS_RU[i.status]}. ${(i.note ?? '').replace(/\s+/g, ' ').slice(0, 600)}`;
    await lua(`
      storage.vb_chat = storage.vb_chat or {seq=0, items={}}
      local c = storage.vb_chat
      c.seq = c.seq + 1
      c.items[#c.items+1] = {seq=c.seq, from=A.from, text=A.message}
      if #c.items > 50 then table.remove(c.items, 1) end
      game.print('[color=0.6,0.8,1]'..A.from..':[/color] '..A.message)
      return {sent=true}`, { from: 'разработчики', message });
    markAnnounced(i.id);
    log(`${i.id}: сообщено в чат`);
  }
}

function restart() {
  const running = execFileSync('tmux', ['list-windows', '-t', '0:', '-F', '#W'], { encoding: 'utf8' }).split('\n');
  for (const [name, script] of Object.entries(RESTART)) {
    if (!running.includes(name)) continue;
    execFileSync('tmux', ['kill-window', '-t', `0:${name}`]);
    execFileSync('tmux', ['new-window', '-d', '-t', '0:', '-n', name, path.join(ROOT, script)]);
    lastRestart = Date.now();
    log(`перезапущено окно ${name}`);
  }
}

log(`обработчик заявок запущен, модель ${MODEL}`);
for (;;) {
  try {
    const queue = readItems().filter((i) => i.status === 'new').sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0)).slice(0, 30);
    if (queue.length) await handle(queue);
    push();
    await announce();
  } catch (e) {
    log('ошибка обработчика:', e.message);
  }
  await sleep(30_000);
}
