// Сессия Claude Code одного человека: управляет его персонажем в Factorio через MCP и больше ничего не умеет.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { spawn, execFileSync } from 'node:child_process';
import { query } from '@anthropic-ai/claude-agent-sdk';
import crypto from 'node:crypto';
import { CLAUDE_BIN, CLAUDE_MODEL, STATE_FILE, ROBOT_CONTAINER, MCP_URL, MCP_TOKENS_FILE } from './config.mjs';

// В системном промпте только неизменное ядро: он фиксируется при создании сессии и при возобновлении не обновляется.
// Все правила поведения лежат в файле rules/RULES.md (в контейнере — RULES_PATH); об его изменениях сессиям
// сообщает хозяин сессий (src/sessions.mjs), поэтому правки правил доходят без перезапуска.
export const RULES_PATH = '/home/robot/bots/RULES.md';
const systemPrompt = (human, bot) => `
Ты — игровой помощник в Factorio. Ты управляешь персонажем по имени «${bot}» на общем сервере; твой хозяин —
человек «${human}», он сидит в голосовом канале Discord вместе с другими людьми. У каждого из них свой такой же
помощник со своим персонажем. Голоса у тебя нет: твой текст хозяин читает в чате канала.

Что к тебе приходит:
- «[${human}]: текст» — всё, что твой хозяин сказал вслух, распознанное автоматически. Распознавание ошибается:
  слова искажаются, английские термины записаны кириллицей — восстанавливай смысл по контексту.
- «[игровой чат] Имя: текст» — сообщения других помощников и разработчиков.
- «[система]: текст» — служебные сообщения: им следуй, отвечать на них не нужно (ответь одной точкой).

Твои правила работы лежат в файле ${RULES_PATH}. В начале сессии первым делом прочитай его целиком (инструмент Read)
и свои заметки в $FX_HOME/notes.md, если они есть. Правила меняются: когда придёт сообщение «правила обновились»,
учти перечисленные изменения — они важнее того, как ты работал до этого. Если сомневаешься, как поступить, —
перечитай файл правил.
`.trim();

// Саб-агенты: главная сессия остаётся на связи, а работу руками ведёт фоновый саб-агент с теми же инструментами factorio.
const SUBAGENT_TOOLS = ['Task', 'SendMessage', 'TaskList', 'TaskStop'];
// Собственное окружение бота в контейнере: оболочка и файлы, чтобы писать и запускать свою автоматизацию.
const ENV_TOOLS = ['Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep'];

/** Токен персонажа для MCP по HTTP; если его ещё нет — выдаём. */
export function tokenFor(bot) {
  let tokens = {};
  try { tokens = JSON.parse(fs.readFileSync(MCP_TOKENS_FILE, 'utf8')); } catch { /* файла ещё нет */ }
  let token = Object.keys(tokens).find((t) => tokens[t] === bot);
  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    tokens[token] = bot;
    fs.writeFileSync(MCP_TOKENS_FILE, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }
  return token;
}

export const slug = (name) => name.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '') || 'bot';

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveSession(key, sessionId) {
  const s = loadState();
  s[key] = sessionId;
  s[`${key}:rules`] = 'file';
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

/** Забыть сессию человека: следующий Agent с этим ключом начнёт с чистого контекста. */
export function forgetSession(key) {
  const s = loadState();
  delete s[key];
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 1));
}

/** События: 'text' (законченный текстовый блок), 'turn-end', 'error'. */
export class Agent extends EventEmitter {
  /**
   * @param key   постоянный идентификатор человека (discord id) — по нему возобновляется сессия
   * @param human имя человека
   * @param bot   имя его персонажа
   */
  constructor(key, human, bot) {
    super();
    Object.assign(this, { key, human, bot, token: tokenFor(bot), busy: false, stopped: false });
    const state = loadState();
    this.#run(state[key]);
    if (!state[key]) {
      this.send(`[система]: началась новая сессия. Прочитай правила в ${RULES_PATH} и свои заметки в $FX_HOME/notes.md (если файл есть), посмотри status.`);
    } else if (state[`${key}:rules`] !== 'file') {
      // Сессия создана до переноса правил в файл: её системный промпт устарел и уже не изменится.
      this.send(`[система]: твои правила работы теперь лежат в файле ${RULES_PATH}, а не в системных инструкциях. Прочитай его целиком сейчас (Read) — он важнее прежних инструкций. Когда он изменится, тебе придёт сообщение с перечнем изменений.`);
    }
  }

  /** Передать сессии реплику; если ход уже идёт, она подмешивается в него. */
  send(text) {
    this.busy = true;
    this.push({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, priority: 'next' });
  }

  close() {
    this.stopped = true;
    this.q?.close?.();
    this.finish?.();
    this.#killInContainer();
  }

  // Процесс Claude внутри контейнера не умирает вместе с docker exec на хосте: без этого после перезапуска бота
  // старый процесс продолжал бы работать в той же сессии параллельно с новым.
  #killInContainer() {
    const id = loadState()[this.key];
    if (!ROBOT_CONTAINER || !id) return;
    try { execFileSync('docker', ['exec', ROBOT_CONTAINER, 'pkill', '-f', '--', `--resume=${id}`], { stdio: 'ignore' }); } catch { /* такого процесса нет */ }
  }

  async #run(resume) {
    while (!this.stopped) {
      const queue = [];
      let wake = null;
      let done = false;
      this.push = (m) => { queue.push(m); wake?.(); };
      this.finish = () => { done = true; wake?.(); };
      const input = (async function* () {
        while (!done) {
          if (queue.length) yield queue.shift();
          else await new Promise((r) => { wake = r; });
        }
      })();

      let gotInit = false;
      try {
        this.q = query({
          prompt: input,
          options: {
            ...(ROBOT_CONTAINER ? {
              cwd: '/home/robot',
              // Процесс Claude живёт в контейнере; с хоста к нему идут только stdin/stdout.
              pathToClaudeCodeExecutable: 'claude',
              spawnClaudeCodeProcess: ({ args, env, signal }) => {
                this.#killInContainer();
                const pass = ['CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_AGENT_SDK_VERSION'].filter((k) => env[k]).flatMap((k) => ['-e', `${k}=${env[k]}`]);
                pass.push('-e', 'ENABLE_CLAUDEAI_MCP_SERVERS=false');
                // Для собственных скриптов бота: команда fx и прямые запросы к MCP от имени его персонажа.
                pass.push('-e', `FX_URL=${MCP_URL}`, '-e', `FX_TOKEN=${this.token}`, '-e', `FX_BOT=${this.bot}`, '-e', `FX_HOME=/home/robot/bots/${slug(this.bot)}`);
                return spawn('docker', ['exec', '-i', '-w', '/home/robot', ...pass, ROBOT_CONTAINER, 'claude', ...args], { stdio: ['pipe', 'pipe', 'inherit'], signal });
              },
            } : { pathToClaudeCodeExecutable: CLAUDE_BIN }),
            model: CLAUDE_MODEL,
            resume,
            systemPrompt: systemPrompt(this.human, this.bot),
            // Никаких настроек с диска. Встроенные инструменты: саб-агенты и собственное окружение бота в контейнере.
            tools: [...SUBAGENT_TOOLS, ...ENV_TOOLS],
            settingSources: [],
            // Инструменты живут в отдельном процессе: их обновление не требует перезапуска сессий.
            mcpServers: { factorio: { type: 'http', url: MCP_URL, headers: { Authorization: `Bearer ${this.token}` } } },
            strictMcpConfig: true, // никаких коннекторов аккаунта (Docs, почта и т. п.)
            allowedTools: ['mcp__factorio', ...SUBAGENT_TOOLS, ...ENV_TOOLS],
            permissionMode: 'dontAsk',
          },
        });
        for await (const msg of this.q) {
          if (msg.type === 'system' && msg.subtype === 'init') {
            if (!gotInit && process.env.DEBUG_TOOLS) console.log(msg.tools.join(" "));
            if (!gotInit) console.log(`[agent ${this.bot}] сессия ${msg.session_id}, модель ${msg.model}, инструменты кроме factorio: ${msg.tools.filter((t) => !t.startsWith("mcp__factorio__")).join(", ") || "нет"}`);
            gotInit = true;
            saveSession(this.key, msg.session_id);
          } else if (msg.type === 'assistant' && !msg.parent_tool_use_id) {
            for (const block of msg.message.content) {
              // «Точка» — знак «реплика не мне, сказать нечего». Но модель нередко пишет точку и следом содержательный
              // текст — его показываем, сняв точку; фильтрацию по смыслу, если понадобится, делает голосовой бот.
              if (block.type === 'text') {
                const text = block.text.trim().replace(/^[.\s…]+/, '');
                if (/[\p{L}\p{N}]/u.test(text)) this.emit('text', text);
              }
            }
          } else if (msg.type === 'result') {
            this.busy = false;
            this.emit('turn-end');
            if (msg.is_error) this.emit('error', new Error(`ход завершился ошибкой: ${msg.subtype} ${msg.result ?? ''}`));
          }
        }
      } catch (e) {
        if (!this.stopped) this.emit('error', e);
      }
      this.busy = false;
      if (this.stopped) break;
      // Если возобновить старую сессию не удалось — начинаем новую.
      resume = resume && !gotInit ? undefined : loadState()[this.key];
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}
