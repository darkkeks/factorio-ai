// Голосовой бот для Factorio: каждого человека в канале слушает отдельно и передаёт его реплики
// его собственной сессии Claude, которая управляет его персонажем на сервере. Голосом бот не отвечает,
// всё происходящее пишет в чат канала.
import { Client, GatewayIntentBits } from 'discord.js';
import { joinVoiceChannel, entersState, getVoiceConnection, VoiceConnectionStatus, EndBehaviorType } from '@discordjs/voice';
import OpusScript from 'opusscript';
import * as cfg from './config.mjs';
import { transcribe, fromDiscordPcm, Utterances } from './speech.mjs';
import net from 'node:net';
import fs from 'node:fs';
import { createFactorioServer } from './factorio.mjs';

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

const people = new Map(); // userId -> { name, bot, utt, decoder, stream, lastPacket, silenceFed, gone }

// ── Сессии Claude живут в отдельном процессе (src/sessions.mjs); здесь только связь с ним ──
// Благодаря этому перезапуск голосового бота не прерывает сессии и их саб-агентов.
const sessions = (() => {
  let sock = null;
  const send = (obj) => { if (sock?.writable) sock.write(JSON.stringify(obj) + '\n'); };
  const connect = () => {
    const s = net.connect(Number(process.env.SESSIONS_PORT || 8766), '127.0.0.1');
    let buf = '';
    s.on('connect', () => {
      sock = s;
      // После (пере)подключения напоминаем, кто в канале: хозяин сессий мог перезапуститься.
      for (const [id, p] of people) send({ op: 'ensure', id, human: p.name, bot: p.bot });
      send({ op: 'present', ids: [...people.keys()] });
    });
    s.on('data', (d) => {
      buf += d;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        try {
          const ev = JSON.parse(line);
          if (ev.ev === 'text') log(`🤖 ${ev.bot}: ${ev.text}`);
          else if (ev.ev === 'error') log(`⚠️ ${ev.bot}: ${ev.text}`);
          else if (ev.ev === 'reset') log(`♻️ ${ev.bot}: ${ev.text}`);
          else if (ev.ev === 'rules') log(`📜 ${ev.text}`);
        } catch { /* обрывок строки */ }
      }
    });
    s.on('error', () => {});
    s.on('close', () => { if (sock === s) sock = null; setTimeout(connect, 2000); });
  };
  connect();
  return { send, connected: () => Boolean(sock) };
})();

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
  sessions.send({ op: 'ensure', id: member.id, human: name, bot: p.bot });
  sessions.send({ op: 'present', ids: [...people.keys()] });
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
  sessions.send({ op: 'present', ids: [...people.keys()] });
}

// Процедуру сброса передаём прямо в сообщении: возобновлённая сессия работает со старым системным промптом
// (он сохраняется вместе с сессией), поэтому новых инструкций из промпта она не видит.
const RESET_HOWTO = `
[система]: хозяин просит сбросить именно твою сессию (контекст разговора), а не саб-агентов и не скрипты. Сделай так:
1) останови работающего саб-агента; 2) запиши в $FX_HOME/notes.md всё, что понадобится после сброса: устройство базы
и координаты, текущий план и на чём остановился, договорённости с хозяином и другими помощниками, свои скрипты и как
ими пользоваться; 3) ответь хозяину одной строкой, что сбрасываешься; 4) выполни в Bash: touch "$FX_HOME/RESET".
Через пару секунд после этого начнётся новая сессия с чистым контекстом, она прочитает notes.md.`;

function feed(p, samples) {
  for (const seg of p.utt.feed(samples).segments) {
    transcribe(seg).then((text) => {
      if (!text || p.gone) return;
      log(`🎤 ${p.name}: ${text}`);
      // Адресована ли реплика боту, решает сама сессия. Если она занята, реплика встаёт в очередь Claude
      // и будет прочитана, когда модель дойдёт до неё; текущие действия не прерываются.
      // «Сбрось сессию» распознаётся как «брось сессию», «сброс сессии» и т. п. — подсказываем сессии, что имелось в виду.
      const reset = /(с?брос\p{L}*|очист\p{L}*|обнул\p{L}*|перезапуст\p{L}*)\s+(\p{L}+\s+)?(сесси|контекст)/iu.test(text);
      const id = [...people].find(([, v]) => v === p)?.[0];
      if (!sessions.connected()) log('⚠️ нет связи с хозяином сессий — реплика не доставлена');
      sessions.send({ op: 'say', id, text: `[${p.name}]: ${text}` + (reset ? RESET_HOWTO : '') });
    }, (e) => console.log(stamp(), 'stt error', e.message));
  }
}

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
