// Очередь заявок на улучшение MCP. Заявки только дописываются в feedback/queue.jsonl (их пишут процессы ботов),
// статусы лежат отдельно в feedback/status.json (их меняет обработчик и люди).
// Статусы: new → in_progress → done | rejected | discussion.
//
// Руками:  node src/feedback.mjs list [статус]
//          node src/feedback.mjs show <id>
//          node src/feedback.mjs set <id> <статус> [примечание]
//          node src/feedback.mjs prio <id>                — разобрать в первую очередь
//          node src/feedback.mjs add <от кого> <текст>
//          node src/feedback.mjs pending                  — заявки, сделанные, но ещё не выпущенные обновлением
//          node src/feedback.mjs release                  — выпустить обновление сейчас, даже если в игре люди
import fs from 'node:fs';
import path from 'node:path';

// Каталог очереди можно переназначить (тестовый стенд не должен писать в рабочую очередь).
const ROOT = path.resolve(import.meta.dirname, '..');
const DIR = process.env.FEEDBACK_DIR || path.join(ROOT, 'feedback');
const QUEUE = path.join(DIR, 'queue.jsonl');
const STATUS = path.join(DIR, 'status.json');
const RELEASE = path.join(DIR, 'release.json');
export const RELEASE_NOW = path.join(DIR, 'release-now'); // файл-просьба выпустить обновление, не дожидаясь, пока люди выйдут
const MAX_OPEN = 30;

export function readItems() {
  let lines = [];
  try { lines = fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean); } catch { /* очереди ещё нет */ }
  let status = {};
  try { status = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { /* статусов ещё нет */ }
  return lines.map((l) => JSON.parse(l)).map((it) => ({ ...it, status: 'new', ...status[it.id] }));
}

export function setStatus(id, status, note, priority, extra = {}) {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { /* первый статус */ }
  // Приоритет ставят люди (команда prio); он сохраняется, пока заявка не разобрана.
  // extra: commit — коммит с правкой; released — false, пока правка не выпущена обновлением (true или нет поля — действует).
  all[id] = { status, note, priority: status === 'new' ? (priority ?? all[id]?.priority) : undefined, updated: new Date().toISOString(), ...extra };
  fs.writeFileSync(STATUS, JSON.stringify(all, null, 1));
}

/** Заявки, правки по которым выпущены обновлением: отметить и вернуть их номера. */
export function markReleased() {
  let all = {};
  try { all = JSON.parse(fs.readFileSync(STATUS, 'utf8')); } catch { return []; }
  const ids = Object.keys(all).filter((id) => all[id].status === 'done' && all[id].released === false);
  for (const id of ids) { all[id].released = true; all[id].released_at = new Date().toISOString(); }
  if (ids.length) fs.writeFileSync(STATUS, JSON.stringify(all, null, 1));
  return ids;
}

/** Что сейчас выпущено: { commit, at, history }. */
export function readRelease() {
  try { return JSON.parse(fs.readFileSync(RELEASE, 'utf8')); } catch { return { commit: null, at: null, history: [] }; }
}
export function writeRelease(r) { fs.writeFileSync(RELEASE, JSON.stringify(r, null, 1)); }

/** Пометить, что о решении по заявке уже сообщили в чат. */
export function markAnnounced(id) {
  const all = JSON.parse(fs.readFileSync(STATUS, 'utf8'));
  if (all[id]) all[id].announced = true;
  fs.writeFileSync(STATUS, JSON.stringify(all, null, 1));
}

export function submitFeedback(from, text) {
  fs.mkdirSync(DIR, { recursive: true });
  const items = readItems();
  if (items.filter((i) => i.status === 'new' || i.status === 'in_progress').length >= MAX_OPEN) {
    throw new Error('очередь заявок переполнена, попробуй позже');
  }
  const id = `fb-${String(items.length + 1).padStart(3, '0')}`;
  fs.appendFileSync(QUEUE, JSON.stringify({ id, from, at: new Date().toISOString(), text }) + '\n');
  return { accepted: id, note: 'заявка в очереди; её разберут в фоне' };
}

if (import.meta.filename === process.argv[1]) {
  const [cmd, a, b, ...rest] = process.argv.slice(2);
  if (cmd === 'set' && a && b) { setStatus(a, b, rest.join(' ') || undefined); console.log(a, '→', b); }
  else if (cmd === 'prio' && a) { setStatus(a, 'new', undefined, true); console.log(a, '→ в очередь с приоритетом'); }
  else if (cmd === 'add' && a && b) console.log(submitFeedback(a, [b, ...rest].join(' ')));
  else if (cmd === 'release') { fs.writeFileSync(RELEASE_NOW, new Date().toISOString()); console.log('обработчик выпустит накопленное обновление, даже если в игре люди: сразу (до 30 секунд), а если он сейчас разбирает заявку — как закончит заход (правки захода войдут в тот же выпуск)'); }
  else if (cmd === 'pending') {
    const p = readItems().filter((i) => i.status === 'done' && i.released === false);
    console.log(p.length ? p.map((i) => `${i.id} ${i.from}: ${i.text.replace(/\s+/g, ' ').slice(0, 80)}`).join('\n') : 'нет заявок, ждущих выпуска', '\nвыпущено:', JSON.stringify(readRelease().commit), readRelease().at);
  }
  else if (cmd === 'show' && a) console.log(readItems().find((i) => i.id === a) ?? 'нет такой заявки');
  else for (const i of readItems().filter((x) => !a || cmd !== 'list' || x.status === a)) {
    console.log(`${i.id}${i.priority ? '!' : ' '} ${(i.status + (i.released === false ? '⏳' : '')).padEnd(11)} ${i.from.padEnd(14)} ${i.text.replace(/\s+/g, ' ').slice(0, 70)}${i.note ? `\n        ↳ ${i.note.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  }
}
