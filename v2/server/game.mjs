// Связь с модом в игре: запросы /agent по RCON и буфер журнала событий.
// У каждого персонажа своё соединение RCON, у опроса журнала — своё: запросы ботов не стоят в общей очереди.
import { Rcon } from './rcon.mjs';

const EMPTY = '\u0001[]'; // так мод помечает пустые списки (table_to_json превращает пустую таблицу в {})

function fixEmpty(v) {
  if (v === EMPTY) return [];
  if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) v[i] = fixEmpty(v[i]); return v; }
  if (v && typeof v === 'object') { for (const k in v) v[k] = fixEmpty(v[k]); return v; }
  return v;
}

export class GameError extends Error {
  constructor(code, message, data) { super(message); this.code = code; this.data = data; }
}

export class Game {
  constructor({ rcon, pollMs = 100, bufferSize = 20000, log = () => {} }) {
    this.conf = rcon;
    this.pollMs = pollMs;
    this.bufferSize = bufferSize;
    this.log = log;
    this.conns = new Map();   // имя соединения → Rcon
    this.events = [];         // буфер журнала, по возрастанию seq
    this.seq = null;          // последний прочитанный номер; null — журнал ещё не читали
    this.first = 1;           // самый старый номер, который есть у мода
    this.waiters = new Set(); // ожидающие новых событий
    this.info = null;         // ответ ping
    this.ready = false;
    this.lastError = null;
    this.stopped = false;
  }

  conn(name) {
    let c = this.conns.get(name);
    if (!c) { c = new Rcon({ ...this.conf, name }); this.conns.set(name, c); }
    return c;
  }

  /** Запрос к моду. Возвращает result; ошибка мода — GameError(code, message, data). */
  async call(req, connName = req.agent ? `a:${req.agent}` : 'admin') {
    let raw;
    try {
      raw = await this.conn(connName).command('/agent ' + JSON.stringify(req));
    } catch (e) {
      throw new GameError('game_unavailable', `сервер игры недоступен: ${e.message}`);
    }
    let r;
    try { r = JSON.parse(raw); } catch {
      throw new GameError('game_unavailable', `мод не ответил (команда /agent не найдена или игра ответила не JSON): ${raw.trim().slice(0, 200)}`);
    }
    if (!r.ok) throw new GameError(r.error?.code || 'internal', r.error?.message || 'ошибка мода', fixEmpty(r.error?.data));
    this.tick = r.tick;
    return fixEmpty(r.result);
  }

  /** Запрос, меняющий мир: с идентификатором, чтобы повтор после обрыва связи не исполнил действие дважды. */
  async write(req) {
    try {
      return await this.call(req);
    } catch (e) {
      if (e.code !== 'game_unavailable' || req.id == null) throw e;
      await new Promise((r) => setTimeout(r, 300));
      return this.call(req);
    }
  }

  // ── Журнал событий ──
  async start() {
    this.loop();
    // Ждём первого удачного чтения, но не вечно: сервер игры может быть ещё не запущен.
    for (let i = 0; i < 50 && !this.ready; i++) await new Promise((r) => setTimeout(r, 100));
    return this.ready;
  }

  stop() { this.stopped = true; for (const c of this.conns.values()) c.close(); }

  /** Дочитать журнал мода до конца. Вызовы не накладываются: второй ждёт первого и читает дальше. */
  pull() {
    const run = async () => {
      let more = true;
      while (more && !this.stopped) {
        const r = await this.call({ op: 'journal', admin: true, params: { since: this.seq ?? 0, limit: 1000 } }, 'poll');
        if (this.seq !== null && r.seq < this.seq) { // карту откатили: журнал начался заново
          this.log(`журнал мода откатился (${this.seq} → ${r.seq}), буфер сброшен`);
          this.events = [];
          this.seq = null;
          continue;
        }
        this.first = r.first;
        if (r.events.length) {
          for (const ev of r.events) this.events.push(ev);
          this.seq = r.events[r.events.length - 1].seq;
          if (this.events.length > this.bufferSize) this.events.splice(0, this.events.length - this.bufferSize);
          if (this.ready) this.notify(r.events);
        } else if (this.seq === null) {
          this.seq = r.seq;
        }
        more = this.seq < r.seq;
      }
    };
    this.pulling = (this.pulling || Promise.resolve()).catch(() => {}).then(run);
    return this.pulling;
  }

  async loop() {
    while (!this.stopped) {
      try {
        if (!this.ready) {
          this.info = await this.call({ op: 'ping' }, 'poll');
          if (this.info.api !== 2) throw new GameError('incompatible', `несовместимая версия мода: api ${this.info.api}, нужен 2`);
        }
        await this.pull();
        if (!this.ready) { this.ready = true; this.lastError = null; this.log(`мод на связи: версия ${this.info.version}, событий в журнале ${this.events.length}, последний номер ${this.seq}`); }
      } catch (e) {
        if (this.ready || this.lastError !== e.message) this.log(`связь с игрой: ${e.message}`);
        this.lastError = e.message;
        this.ready = false;
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  notify(batch) {
    for (const w of this.waiters) {
      const hit = batch.filter(w.match);
      if (hit.length) w.push(hit);
    }
  }

  /** События из буфера с номером больше since, подходящие под match. */
  since(since, match) {
    const ev = this.events;
    // Двоичный поиск первой записи с seq > since.
    let lo = 0, hi = ev.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ev[mid].seq > since) hi = mid; else lo = mid + 1; }
    const out = [];
    for (let i = lo; i < ev.length; i++) if (match(ev[i])) out.push(ev[i]);
    return out;
  }

  /**
   * Ждать события: сначала из буфера (после since), потом новые. done(накопленные) → true, когда хватит.
   * Возвращает накопленные события; по истечении срока — то, что успело прийти.
   */
  wait({ since, match, done, timeoutMs }) {
    const got = this.since(since, match);
    if (done(got) || timeoutMs <= 0) return Promise.resolve(got);
    return new Promise((resolve) => {
      const w = {
        match,
        push: (hit) => {
          for (const e of hit) got.push(e);
          if (done(got)) finish();
        },
      };
      const finish = () => { clearTimeout(timer); this.waiters.delete(w); resolve(got); };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(w);
    });
  }
}
