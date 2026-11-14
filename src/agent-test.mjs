// Проверка без Discord: node src/agent-test.mjs "Имя" "реплика" ["реплика 2" ...]
import { Agent } from './agent.mjs';
import { createFactorioServer } from './factorio.mjs';
const [human, ...lines] = process.argv.slice(2);
const bot = `${human}-бот`;
const fx = createFactorioServer(bot, { log: (l) => console.log(l), aborted: () => false });
// Игра должна идти: нужен игрок на сервере или свежий ~/robot/voice-active (см. pause-guard).
console.log('персонаж:', await fx.ensure());
const a = new Agent(`test-${human}`, human, bot, fx.server);
const t0 = Date.now();
a.on('text', (t) => console.log(`🤖 ${bot}: ${t}`));
a.on('error', (e) => console.log('[error]', e.message));
a.on('turn-end', async () => {
  console.log(`[turn-end ${((Date.now() - t0) / 1000).toFixed(1)} с]`);
  if (lines.length) a.send(`[${human}]: ${lines.shift()}`);
  else { a.close(); process.exit(0); }
});
a.send(`[${human}]: ${lines.shift()}`);
setTimeout(() => process.exit(1), 400000);
