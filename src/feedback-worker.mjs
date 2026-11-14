// Фоновый обработчик заявок: берёт новые заявки из feedback/queue.jsonl по одной и на каждую запускает отдельную
// сессию Claude Code (на хосте, в этой папке), которая дорабатывает src/factorio.mjs по правилам из
// feedback/WORKER_PROMPT.md. Сессии разрешено только читать, править два файла и запускать проверки.
// После сессии обработчик сам проверяет результат, коммитит его в git и перезапускает работающие процессы ботов;
// при любой неполадке откатывает правки и ставит заявке статус discussion.
//   tmux new-window -d -t 0: -n feedback-worker 'cd ~/claude/discord-voice && node src/feedback-worker.mjs 2>&1 | tee -a feedback/worker.log'
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { ROOT } from './config.mjs';
import { readItems, setStatus } from './feedback.mjs';

const CLAUDE = process.env.WORKER_CLAUDE_BIN || path.join(os.homedir(), 'claude/claude-code/bin/claude');
const MODEL = process.env.WORKER_MODEL || 'claude-fable-5-2';
const TIMEOUT_MS = 45 * 60_000;
const ALLOWED_CHANGES = ['src/factorio.mjs', 'README.md'];
const TOOLS = ['Read', 'Glob', 'Grep', 'Edit(src/factorio.mjs)', 'Edit(README.md)', 'Write(feedback/verdict-*.json)',
  'Bash(node --check *)', 'Bash(node src/tool-test.mjs *)', 'Bash(git diff *)', 'Bash(git status *)'];
// Окна tmux, которые нужно перезапустить после изменения инструментов (только если они сейчас запущены).
const RESTART = { 'discord-voice': 'run.sh', 'factorio-mcp': 'run-mcp.sh' };

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

function revert() {
  git('checkout', '--', '.');
}

async function handle(item) {
  log(`${item.id} от ${item.from}: беру в работу`);
  setStatus(item.id, 'in_progress');
  const verdictFile = path.join(ROOT, 'feedback', `verdict-${item.id}.json`);
  fs.rmSync(verdictFile, { force: true });
  if (git('status', '--porcelain', '--untracked-files=no').trim()) {
    setStatus(item.id, 'discussion', 'обработчик не запускался: в рабочей папке есть незакоммиченные правки, их нужно разобрать руками');
    return log(`${item.id}: в репозитории незакоммиченные правки, пропускаю`);
  }

  const rules = fs.readFileSync(path.join(ROOT, 'feedback', 'WORKER_PROMPT.md'), 'utf8');
  const { code, out } = await runClaude(`${rules}\n\n## Заявка ${item.id} от бота «${item.from}»\n\n<feedback>\n${item.text}\n</feedback>`);
  let summary = '';
  try { summary = JSON.parse(out).result ?? ''; } catch { summary = out.slice(-2000); }
  fs.writeFileSync(path.join(ROOT, 'feedback', `session-${item.id}.txt`), summary);

  let verdict = { status: 'discussion', note: `сессия обработчика не оставила вердикт (код завершения ${code})` };
  try {
    const v = JSON.parse(fs.readFileSync(verdictFile, 'utf8'));
    if (['done', 'rejected', 'discussion'].includes(v.status)) verdict = { status: v.status, note: String(v.note ?? '').slice(0, 4000) };
  } catch { /* вердикта нет */ }

  const changed = git('status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean).map((l) => l.slice(3));
  if (changed.length) {
    let problem = null;
    const foreign = changed.filter((f) => !ALLOWED_CHANGES.includes(f));
    if (foreign.length) problem = `изменены посторонние файлы: ${foreign.join(', ')}`;
    if (!problem && verdict.status !== 'done') problem = `код изменён, но вердикт «${verdict.status}»`;
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
      revert();
      verdict = { status: 'discussion', note: `правки отменены: ${problem}. Вердикт сессии был «${verdict.status}»: ${verdict.note}` };
    } else {
      git('add', ...changed);
      git('commit', '-q', '-m', `feedback ${item.id}: ${verdict.note.split('\n')[0].slice(0, 100)}\n\nЗаявка от ${item.from}. Обработано автоматически (src/feedback-worker.mjs).\n\nCo-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`);
      if (changed.includes('src/factorio.mjs')) restart();
    }
  }
  setStatus(item.id, verdict.status, verdict.note);
  log(`${item.id}: ${verdict.status} — ${verdict.note.replace(/\s+/g, ' ').slice(0, 300)}`);
}

function restart() {
  const running = execFileSync('tmux', ['list-windows', '-t', '0:', '-F', '#W'], { encoding: 'utf8' }).split('\n');
  for (const [name, script] of Object.entries(RESTART)) {
    if (!running.includes(name)) continue;
    execFileSync('tmux', ['kill-window', '-t', `0:${name}`]);
    execFileSync('tmux', ['new-window', '-d', '-t', '0:', '-n', name, path.join(ROOT, script)]);
    log(`перезапущено окно ${name}`);
  }
}

log(`обработчик заявок запущен, модель ${MODEL}`);
for (;;) {
  try {
    const next = readItems().find((i) => i.status === 'new');
    if (next) await handle(next);
  } catch (e) {
    log('ошибка обработчика:', e.message);
  }
  await sleep(30_000);
}
