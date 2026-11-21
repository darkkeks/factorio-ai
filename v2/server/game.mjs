// Связь с модом в игре: запросы /agent по RCON и буфер журнала событий.
// У каждого персонажа своё соединение RCON, у опроса журнала — своё: запросы ботов не стоят в общей очереди.
import { Rcon } from './rcon.mjs';

const POOL = 4; // соединений RCON на одного бота
const EMPTY ='\u0001[]'; // так мод помечает пустые списки (table_to_json превращает пустую таблицу в {})

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
  constructor({ rcon, pollMs = 100, fastPollMs = 5, bufferSize = 20000, holdMs = 90000, log = () => {} }) {
    this.conf = rcon;
    this.fastPollMs = fastPollMs; // опрос журнала, пока кто-то ждёт итога действия (примерно тик)
    this.urgent = 0;              // сколько запросов сейчас ждут итога действия
    this.kick = null;             // разбудить опрос журнала, не дожидаясь паузы
    this.holdMs = holdMs; // сколько запросы ждут возвращения сервера игры
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

  /**
   * Свободное соединение из нескольких с этим именем. Два ответа подряд в одном соединении игра шлёт двумя
   * сегментами TCP, и второй ждёт подтверждения первого (~40 мс): одновременные запросы одного бота задерживали
   * друг друга. Поэтому у каждого запроса в полёте — своё соединение (до POOL), дальше — наименее занятое.
   */
  free(name) {
    let best = null;
    for (let i = 0; i < POOL; i++) {
      const c = this.conn(i ? `${name}#${i}` : name);
      if (!c.busy) return c; // следующее соединение открывается, только когда прежние заняты
      if (!best || c.busy < best.busy) best = c;
    }
    return best;
  }

  /** Один запрос к моду без повторов. Возвращает result; ошибка мода — GameError(code, message, data). */
  async once(req, connName = req.agent ? `a:${req.agent}` : 'admin') {
    let raw;
    const c = this.free(connName);
    c.busy = (c.busy || 0) + 1;
    try {
      raw = await c.command('/agent ' + JSON.stringify(req));
    } catch (e) {
      throw new GameError('game_unavailable', `сервер игры недоступен: ${e.message}`);
    } finally {
      c.busy--;
    }
    let r;
    try { r = JSON.parse(raw); } catch {
      throw new GameError('game_unavailable', `мод не ответил (команда /agent не найдена или игра ответила не JSON): ${raw.trim().slice(0, 200)}`);
    }
    if (!r.ok) throw new GameError(r.error?.code || 'internal', r.error?.message || 'ошибка мода', fixEmpty(r.error?.data));
    this.tick = r.tick;
    return fixEmpty(r.result);
  }

  /**
   * Запрос к моду. Если сервер игры недоступен (перезапуск, обновление мода), запрос не отклоняется, а ждёт его
   * возвращения до holdMs и исполняется: для бота перезапуск игры выглядит как один медленный ответ.
   * Повтор безопасен: чтение ничего не меняет, а у пишущих запросов есть идентификатор — мод не исполнит их дважды.
   */
  async call(req, connName, holdMs = this.holdMs) {
    const deadline = Date.now() + holdMs;
    for (;;) {
      try {
        return await this.once(req, connName);
      } catch (e) {
        if (e.code !== 'game_unavailable' || Date.now() >= deadline || this.stopped) throw e;
        this.held = (this.held || 0) + 1;
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }

  /** Запрос, меняющий мир: обязательно с идентификатором (см. call). */
  write(req, holdMs) {
    if (req.id == null) throw new Error('пишущий запрос без идентификатора');
    return this.call(req, undefined, holdMs);
  }

  /** Дождаться связи с игрой (до holdMs). */
  async whenReady(holdMs = this.holdMs) {
    const deadline = Date.now() + holdMs;
    while (!this.ready && Date.now() < deadline && !this.stopped) await new Promise((r) => setTimeout(r, 200));
    return this.ready;
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
        const r = await this.once({ op: 'journal', admin: true, params: { since: this.seq ?? 0, limit: 1000 } }, 'poll');
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
          this.notify(r.events);
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
          this.info = await this.once({ op: 'ping' }, 'poll');
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
      // Пока кто-то ждёт итога действия, журнал читается раз в тик: иначе короткое действие (и отмена чужого
      // при replace) отвечало бы с задержкой до pollMs. Новый ожидающий будит опрос сразу (kick).
      await new Promise((r) => {
        const t = setTimeout(r, this.urgent > 0 ? Math.min(this.fastPollMs, this.pollMs) : this.pollMs);
        this.kick = () => { clearTimeout(t); r(); };
      });
      this.kick = null;
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
  wait({ since, match, done, timeoutMs, fast = false }) {
    const got = this.since(since, match);
    if (done(got) || timeoutMs <= 0) return Promise.resolve(got);
    return new Promise((resolve) => {
      if (fast) { this.urgent++; this.kick?.(); }
      const w = {
        match,
        push: (hit) => {
          for (const e of hit) got.push(e);
          if (done(got)) finish();
        },
      };
      const finish = () => { clearTimeout(timer); if (this.waiters.delete(w) && fast) this.urgent--; resolve(got); };
      const timer = setTimeout(finish, timeoutMs);
      this.waiters.add(w);
    });
  }
}
