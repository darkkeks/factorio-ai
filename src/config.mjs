import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const env = process.env;
export const ROOT = path.resolve(import.meta.dirname, '..');
const home = os.homedir();

// Токен и канал по умолчанию берём из уже работающего бота, чтобы не дублировать секрет.
const SOURCE_BOT = env.SOURCE_BOT || path.join(home, 'hypixel-online/main.py');
function fromSourceBot(name) {
  const m = fs.readFileSync(SOURCE_BOT, 'utf8').match(new RegExp(`^${name}\\s*=\\s*['"]?([^'"\\s#]+)`, 'm'));
  if (!m) throw new Error(`${name} не найден в ${SOURCE_BOT}`);
  return m[1];
}

export const DISCORD_TOKEN = env.DISCORD_TOKEN || fromSourceBot('DISCORD_TOKEN');
export const VOICE_CHANNEL_ID = env.VOICE_CHANNEL_ID || fromSourceBot('VOICE_CHANNEL_ID');

// Кого слушаем: список discord user id через запятую; пусто = всех людей в канале.
export const ALLOWED_USERS = (env.ALLOWED_USERS || '').split(',').map((s) => s.trim()).filter(Boolean);

export const POST_TO_CHAT = env.POST_TO_CHAT !== '0';

// Claude Code: у каждого человека своя сессия. Процессы живут в docker-контейнере (см. robot/),
// игрой они управляют HTTP-запросами к серверу ботов из своей оболочки.
export const ROBOT_CONTAINER = env.ROBOT_CONTAINER ?? 'robot';
export const CLAUDE_BIN = env.CLAUDE_BIN || path.join(home, 'claude/claude-code/bin/claude'); // если ROBOT_CONTAINER пуст
export const CLAUDE_MODEL = env.CLAUDE_MODEL || 'claude-opus-5-5';
// Файл-сигнал «в голосовом канале есть люди» в домашней папке контейнера.
export const VOICE_HEARTBEAT = env.VOICE_HEARTBEAT || path.join(home, 'robot/voice-active');
export const STATE_FILE = path.join(ROOT, 'state-factorio.json');

// Речь
export const MODELS = path.join(ROOT, 'models');
export const VAD_SILENCE_S = Number(env.VAD_SILENCE_S || 0.55);

// Сервер ботов — отдельный процесс (v2/server/server.mjs): HTTP с JSON, операции — <адрес>v2/<операция>.
// Сессии и скрипты ботов в контейнере ходят к нему по этому адресу (у них он в переменной FX_URL).
export const API_URL = env.API_URL || 'http://172.25.0.1:8765/';
// Токены персонажей: { "токен": "имя персонажа" }. Имя файла историческое.
export const TOKENS_FILE = path.join(ROOT, 'bot-tokens.json');
