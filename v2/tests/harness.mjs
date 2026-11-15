// Крошечный каркас проверок: test('название', async () => {...}), итог и код выхода.
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export function ok(cond, msg) { if (!cond) throw new Error(msg || 'условие не выполнено'); }
export function eq(a, b, msg) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${msg || 'не равно'}: получено ${JSON.stringify(a)}, ожидалось ${JSON.stringify(b)}`); }
export async function run(after) {
  const only = process.argv[2];
  let failed = 0, n = 0;
  for (const t of tests) {
    if (only && !t.name.includes(only)) continue;
    n++;
    const t0 = Date.now();
    try { await t.fn(); console.log(`  ✓ ${t.name} (${Date.now() - t0} мс)`); }
    catch (e) { failed++; console.log(`  ✗ ${t.name}\n      ${e.message}`); }
  }
  console.log(failed ? `\nНЕ ПРОШЛО: ${failed} из ${n}` : `\nвсе ${n} проверок прошли`);
  if (after) await after();
  process.exit(failed ? 1 : 0);
}
