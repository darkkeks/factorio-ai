// Голосовой бот для Factorio: каждого человека в канале слушает отдельно и передаёт его реплики
// его собственной сессии Claude, которая управляет его персонажем на сервере. Голосом бот не отвечает,
// всё происходящее пишет в чат канала.
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, entersState, getVoiceConnection, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import OpusScript from 'opusscript';
import * as cfg from './config.mjs';
import { transcribe, fromDiscordPcm, Utterances } from './speech.mjs';
import os from 'node:os';
import path from 'node:path';
import { Agent, forgetSession, slug } from './agent.mjs';
import fs from 'node:fs';
import { createFactorioServer, readChat } from './factorio.mjs';

const stamp = () => new Date().toISOString().slice(11, 23);
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
let channel = null;

// ───────────────────────── Лог: консоль + чат канала ─────────────────────────

const outbox = [];
function log(line) {
  console.log(stamp(), line);
  if (cfg.POST_TO_CHAT) outbox.push(line);
}
// Discord ограничивает частоту сообщений, поэтому строки копим и шлём пачкой.
setInterval(() => {
  if (!outbox.length || !channel?.send) return;
  let text = '';
  while (outbox.length && text.length + Math.min(outbox[0].length, 1800) < 1900) text += outbox.shift().slice(0, 1800) + '\n';
  channel.send({ content: text, allowedMentions: { parse: [] } }).catch((e) => console.log(stamp(), 'не отправилось в чат:', e.message));
}, 1500);

// ───────────────────────── Люди: слух + сессия + персонаж ─────────────────────────

const agents = new Map(); // userId -> Agent; не удаляются при выходе человека из канала
const people = new Map(); // userId -> { name, bot, agent, utt, decoder, stream, lastPacket, silenceFed, gone }

function startAgent(id, name, bot) {
  const agent = new Agent(id, name, bot);
  agent.on('text', (text) => log(`🤖 ${bot}: ${text}`));
  agent.on('error', (e) => log(`⚠️ ${bot}: ${e.message}`));
  agents.set(id, agent);
  return agent;
}

// Сброс сессии по просьбе хозяина: бот сохраняет заметки и создаёт файл RESET в своей папке (см. промпт),
// мы закрываем сессию и начинаем новую с чистого контекста.
setInterval(() => {
  for (const [id, agent] of agents) {
    const flag = path.join(os.homedir(), 'robot/bots', slug(agent.bot), 'RESET');
    if (!fs.existsSync(flag)) continue;
    fs.rmSync(flag, { force: true });
    agent.close();
    forgetSession(id);
    const fresh = startAgent(id, agent.human, agent.bot);
    if (people.has(id)) people.get(id).agent = fresh;
    log(`♻️ ${agent.bot}: сессия сброшена по просьбе хозяина, начата новая`);
  }
}, 2000);

function join(connection, member) {
  if (people.has(member.id) || member.user.bot) return;
  if (cfg.ALLOWED_USERS.length && !cfg.ALLOWED_USERS.includes(member.id)) return;
  // Имя из профиля Discord, а не ник на сервере: ники у людей бывают почти одинаковыми.
  const name = member.user.globalName || member.user.username;
  const p = { name, bot: `${name}-бот`, utt: new Utterances(), decoder: new OpusScript(48000, 2), lastPacket: 0, silenceFed: Infinity, gone: false };
  people.set(member.id, p);

  // Здесь экземпляр инструментов нужен только чтобы создать персонажа; сессия ходит за ними в отдельный процесс MCP.
  const fx = createFactorioServer(p.bot, { log: () => {}, aborted: () => false });
  // Сессия живёт дольше присутствия человека в канале: вышел — бот продолжает начатое, вернулся — та же сессия.
  p.agent = agents.get(member.id) ?? startAgent(member.id, name, p.bot);
  fx.ensure().then(
    (r) => log(`➕ ${name} в канале: персонаж «${p.bot}» на сервере в точке ${r.pos.x}, ${r.pos.y}`),
    (e) => log(`⚠️ ${p.bot}: сервер Factorio недоступен: ${e.message}`),
  );

  p.stream = connection.receiver.subscribe(member.id, { end: { behavior: EndBehaviorType.Manual } });
  p.stream.on('data', (packet) => {
    let pcm;
    try { pcm = p.decoder.decode(packet); } catch { return; }
    p.lastPacket = Date.now();
    p.silenceFed = 0;
    feed(p, fromDiscordPcm(Buffer.from(pcm)));
  });
  p.stream.on('error', (e) => console.log(stamp(), 'receive error', name, e.message));
}

function leave(userId) {
  const p = people.get(userId);
  if (!p) return;
  people.delete(userId);
  p.gone = true;
  p.stream.destroy();
  p.decoder.delete?.();
  log(`➖ ${p.name} вышел из канала; «${p.bot}» продолжает начатое и ждёт хозяина`);
}

function feed(p, samples) {
  for (const seg of p.utt.feed(samples).segments) {
    transcribe(seg).then((text) => {
      if (!text || p.gone) return;
      log(`🎤 ${p.name}: ${text}`);
      // Адресована ли реплика боту, решает сама сессия. Если она занята, реплика встаёт в очередь Claude
      // и будет прочитана, когда модель дойдёт до неё; текущие действия не прерываются.
      p.agent.send(`[${p.name}]: ${text}`);
    }, (e) => console.log(stamp(), 'stt error', e.message));
  }
}

// Сообщения ботов из игрового чата (в том числе от внешних клиентов MCP) раздаём сессиям остальных персонажей.
let chatSeq = null;
setInterval(async () => {
  try {
    const r = await readChat(chatSeq ?? Number.MAX_SAFE_INTEGER);
    if (chatSeq !== null) {
      for (const m of r.messages) {
        for (const [id, agent] of agents) {
          // Пока хозяина нет в канале, чат будит только занятого бота: иначе дозорные скрипты всю ночь жгли бы ходы впустую.
          if (agent.bot !== m.from && (people.has(id) || agent.busy)) agent.send(`[игровой чат] ${m.from}: ${m.text}`);
        }
      }
    }
    chatSeq = r.seq;
  } catch { /* сервер перезапускается */ }
}, 2000);

// Discord не шлёт пакеты, пока человек молчит, поэтому тишину для детектора пауз дорисовываем сами.
const SILENCE = new Float32Array(320);
setInterval(() => {
  const now = Date.now();
  for (const p of people.values()) {
    if (now - p.lastPacket > 80 && p.silenceFed < 1500) {
      p.silenceFed += 20;
      feed(p, SILENCE);
    }
  }
}, 20);

// ───────────────────────── Подключение ─────────────────────────

const humans = () => channel.members.filter((m) => !m.user.bot);

async function connect() {
  if (getVoiceConnection(channel.guild.id)) return;
  console.log(stamp(), 'захожу в канал', channel.name);
  const connection = joinVoiceChannel({
    channelId: channel.id,
    guildId: channel.guild.id,
    adapterCreator: channel.guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });
  connection.on('error', (e) => console.log(stamp(), 'voice error', e.message));
  connection.on(VoiceConnectionStatus.Disconnected, async () => {
    try {
      await Promise.race([
        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
        entersState(connection, VoiceConnectionStatus.Connecting, 5000),
      ]);
    } catch {
      connection.destroy();
    }
  });
  connection.on(VoiceConnectionStatus.Destroyed, () => {
    for (const id of [...people.keys()]) leave(id);
    console.log(stamp(), 'вышел из канала');
  });
  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
  } catch (e) {
    console.log(stamp(), 'не удалось подключиться к голосу:', e.message);
    connection.destroy();
    return;
  }
  sync();
}

function sync() {
  const connection = getVoiceConnection(channel.guild.id);
  pause();
  if (humans().size === 0) {
    connection?.destroy();
    return;
  }
  if (!connection) return void connect();
  if (connection.state.status !== VoiceConnectionStatus.Ready) return;
  for (const m of humans().values()) join(connection, m);
  for (const id of [...people.keys()]) if (!channel.members.has(id)) leave(id);
}

// Пока в канале есть люди, обновляем файл-сигнал для сторожа паузы в контейнере (robot: ~/bin/pause-guard.py).
// Без сигнала и без игроков на сервере он ставит игру на паузу.
function pause() {
  if (!channel || humans().size === 0) return;
  try { fs.writeFileSync(cfg.VOICE_HEARTBEAT, new Date().toISOString()); } catch (e) { console.log(stamp(), 'не обновился сигнал для сторожа паузы:', e.message); }
}
setInterval(pause, 15_000);

client.once('clientReady', async () => {
  channel = await client.channels.fetch(cfg.VOICE_CHANNEL_ID);
  console.log(stamp(), `вошёл как ${client.user.tag}, канал «${channel.name}», людей в канале: ${humans().size}`);
  sync();
});

client.on('voiceStateUpdate', (before, after) => {
  if (!channel) return;
  if (before.channelId !== channel.id && after.channelId !== channel.id) return;
  if (after.id === client.user.id) return;
  sync();
});

for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(sig, () => {
    if (channel) getVoiceConnection(channel.guild.id)?.destroy();
    client.destroy();
    process.exit(0);
  });
}

client.login(cfg.DISCORD_TOKEN);
