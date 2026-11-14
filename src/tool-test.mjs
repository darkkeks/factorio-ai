// Ручная проверка инструментов на живом сервере от имени отдельного тестового персонажа «mcp-test».
//   node src/tool-test.mjs list
//   node src/tool-test.mjs call <инструмент> '<json-аргументы>'
//   node src/tool-test.mjs cleanup          — убрать тестового персонажа с карты
// Игра должна идти (кто-то на сервере или в голосовом канале), иначе действия не продвигаются.
import { createFactorioServer } from './factorio.mjs';
import { lua } from './rcon.mjs';

const BOT = 'mcp-test';
const [cmd, name, json] = process.argv.slice(2);
const fx = createFactorioServer(BOT, { log: () => {}, aborted: () => false, chatTool: { seq: 0 } });
try {
  if (cmd === 'list') console.log(fx.toolNames.join('\n'));
  else if (cmd === 'call') console.log((await fx.call(name, json ? JSON.parse(json) : {})).content[0].text);
  else if (cmd === 'cleanup') console.log(await lua(`local e = storage.vb and storage.vb[A.bot] if e and e.valid then e.destroy() end if storage.vb then storage.vb[A.bot] = nil end if storage.vb_kit then storage.vb_kit[A.bot] = nil end return {removed=true}`, { bot: BOT }));
  else console.log('использование: list | call <инструмент> [json] | cleanup');
} catch (e) {
  console.log('ОШИБКА:', e.message);
  process.exitCode = 1;
}
process.exit();
