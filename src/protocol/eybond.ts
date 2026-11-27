// Eybond Wi-Fi collector framing (TCP, big-endian):
//   [TID u16][DevCode u16][Len u16 = bytes after the first 6][Addr u8][FC u8][payload...]

export const HEADER_SIZE = 8;
export const FC_HEARTBEAT = 1;
export const FC_FORWARD = 4;
/** Devcode used when forwarding; the dongle accepted both 0x0993 and 0x0994 in Phase 0. */
export const DEFAULT_DEVCODE = 0x0993;
const MAX_FRAME = 4096;

export interface EybondFrame {
  tid: number;
  devcode: number;
  addr: number;
  fc: number;
  payload: Buffer;
}

export function encodeFrame(f: EybondFrame): Buffer {
  const h = Buffer.alloc(HEADER_SIZE);
  h.writeUInt16BE(f.tid & 0xffff, 0);
  h.writeUInt16BE(f.devcode & 0xffff, 2);
  h.writeUInt16BE(HEADER_SIZE - 6 + f.payload.length, 4);
  h.writeUInt8(f.addr & 0xff, 6);
  h.writeUInt8(f.fc & 0xff, 7);
  return Buffer.concat([h, f.payload]);
}

/** Heartbeat sent by the "cloud": UTC date/time + heartbeat interval (seconds). */
export function heartbeatPayload(now = new Date(), intervalSec = 30): Buffer {
  return Buffer.from([
    (now.getUTCFullYear() - 2000) & 0xff,
    now.getUTCMonth() + 1,
    now.getUTCDate(),
    now.getUTCHours(),
    now.getUTCMinutes(),
    now.getUTCSeconds(),
    (intervalSec >> 8) & 0xff,
    intervalSec & 0xff,
  ]);
}

/** Reassembles a TCP byte stream into Eybond frames. */
export class FrameDecoder {
  #buf: Buffer = Buffer.alloc(0);

  /** Feed bytes; returns all complete frames. Throws on a corrupt length (caller should reset the socket). */
  push(chunk: Buffer): EybondFrame[] {
    this.#buf = this.#buf.length ? Buffer.concat([this.#buf, chunk]) : chunk;
    const out: EybondFrame[] = [];
    while (this.#buf.length >= HEADER_SIZE) {
      const total = this.#buf.readUInt16BE(4) + 6;
      if (total < HEADER_SIZE || total > MAX_FRAME) {
        const bad = this.#buf.subarray(0, 16).toString('hex');
        this.#buf = Buffer.alloc(0);
        throw new Error(`Corrupt Eybond frame length ${total} (${bad})`);
      }
      if (this.#buf.length < total) break;
      const f = this.#buf.subarray(0, total);
      this.#buf = this.#buf.subarray(total);
      out.push({
        tid: f.readUInt16BE(0),
        devcode: f.readUInt16BE(2),
        addr: f[6],
        fc: f[7],
        payload: Buffer.from(f.subarray(HEADER_SIZE)),
      });
    }
    return out;
  }
}
