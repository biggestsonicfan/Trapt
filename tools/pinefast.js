/**
 * Minimal, fast PINE client for PCSX2.
 *
 * The bundled PineClient.readMemory issues one MsgRead8 per byte, which is
 * hopeless for scanning megabytes.  PINE lets a single message carry many
 * commands back to back and answers with one status byte followed by every
 * result concatenated, so batching MsgRead64 pulls 8 KB per round trip.
 *
 *   Request : [u32 size incl. itself][cmd][cmd]...
 *   MsgRead64 = 0x03, payload [u8 op][u32 addr]  -> 8 bytes of result
 *   Reply   : [u32 size incl. itself][u8 status][data][data]...
 */
import net from 'node:net';

const MsgRead64 = 0x03;
const MsgWrite64 = 0x07;

export class Pine {
  constructor(host = '127.0.0.1', port = 28011) { this.host = host; this.port = port; }

  connect() {
    return new Promise((resolve, reject) => {
      this.sock = net.createConnection({ host: this.host, port: this.port }, resolve);
      this.sock.setNoDelay(true);
      this.sock.once('error', reject);
    });
  }
  close() { this.sock?.destroy(); this.sock = null; }

  _send(payload, expectBytes) {
    return new Promise((resolve, reject) => {
      const head = Buffer.alloc(4);
      head.writeUInt32LE(payload.length + 4);
      let acc = Buffer.alloc(0);
      const to = setTimeout(() => { cleanup(); reject(new Error('PINE timeout')); }, 15000);
      const onData = (d) => {
        acc = Buffer.concat([acc, d]);
        if (acc.length < 4) return;
        const size = acc.readUInt32LE(0);
        if (acc.length < size) return;
        cleanup();
        if (acc[4] !== 0) return reject(new Error(`PINE status 0x${acc[4].toString(16)}`));
        resolve(acc.subarray(5, size));
      };
      const onErr = (e) => { cleanup(); reject(e); };
      const cleanup = () => { clearTimeout(to); this.sock.off('data', onData); this.sock.off('error', onErr); };
      this.sock.on('data', onData);
      this.sock.on('error', onErr);
      this.sock.write(Buffer.concat([head, payload]));
    });
  }

  /** Read `length` bytes from `addr`. Length is rounded up to 8. */
  async read(addr, length) {
    const words = Math.ceil(length / 8);
    const out = Buffer.alloc(words * 8);
    const PER = 1024;                       // 8 KB of payload per round trip
    for (let i = 0; i < words; i += PER) {
      const n = Math.min(PER, words - i);
      const req = Buffer.alloc(n * 5);
      for (let k = 0; k < n; k++) {
        req[k * 5] = MsgRead64;
        req.writeUInt32LE((addr + (i + k) * 8) >>> 0, k * 5 + 1);
      }
      const res = await this._send(req);
      if (res.length < n * 8) throw new Error(`short PINE reply: ${res.length} < ${n * 8}`);
      res.copy(out, i * 8, 0, n * 8);
    }
    return out.subarray(0, length);
  }

  async write64(addr, valueBigInt) {
    const req = Buffer.alloc(13);
    req[0] = MsgWrite64;
    req.writeUInt32LE(addr >>> 0, 1);
    req.writeBigUInt64LE(BigInt(valueBigInt), 5);
    await this._send(req);
  }
}
