// Клиент Source RCON для сервера Factorio. Каждое соединение — отдельный объект; команды в одном соединении
// уходят сразу, без ожидания ответа на предыдущую (ответы сопоставляются по номеру пакета).
import net from 'node:net';

export class Rcon {
  constructor({ host = '127.0.0.1', port, password, timeoutMs = 10000, name = 'rcon' }) {
    Object.assign(this, { host, port, password, timeoutMs, name });
    this.sock = null;
    this.connecting = null;
    this.buf = Buffer.alloc(0);
    this.nextId = 1;
    this.waiting = new Map();
  }

  static packet(id, type, body) {
    const b = Buffer.from(body, 'utf8');
    const p = Buffer.alloc(14 + b.length);
    p.writeInt32LE(10 + b.length, 0);
    p.writeInt32LE(id, 4);
    p.writeInt32LE(type, 8);
    b.copy(p, 12);
    return p;
  }

  request(type, body) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      if (this.nextId > 0x7ffffff0) this.nextId = 1;
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('RCON: нет ответа'));
        this.sock?.destroy();
      }, this.timeoutMs);
      this.waiting.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.sock.write(Rcon.packet(id, type, body));
    });
  }

  connect() {
    if (this.sock) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = net.connect(this.port, this.host);
      s.setNoDelay(true);
      let buf = Buffer.alloc(0);
      s.once('error', (e) => { reject(e); });
      s.on('data', (d) => {
        buf = buf.length ? Buffer.concat([buf, d]) : d;
        while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
          const size = buf.readInt32LE(0);
          const id = buf.readInt32LE(4);
          const type = buf.readInt32LE(8);
          const body = buf.toString('utf8', 12, 4 + size - 2);
          buf = buf.subarray(4 + size);
          if (type === 2 && id === -1) {
            for (const w of this.waiting.values()) w.reject(new Error('RCON: неверный пароль'));
            this.waiting.clear();
            continue;
          }
          const w = this.waiting.get(id);
          if (w) { this.waiting.delete(id); w.resolve(body); }
        }
      });
      s.on('close', () => {
        if (this.sock === s) this.sock = null;
        for (const w of this.waiting.values()) w.reject(new Error('RCON: соединение закрыто'));
        this.waiting.clear();
      });
      s.once('connect', async () => {
        this.sock = s;
        try { await this.request(3, this.password); resolve(); } catch (e) { s.destroy(); reject(e); }
      });
    }).finally(() => { this.connecting = null; });
    return this.connecting;
  }

  /** Выполнить консольную команду и вернуть её вывод. */
  async command(text) {
    await this.connect();
    return this.request(2, text);
  }

  close() { this.sock?.destroy(); this.sock = null; }
}
