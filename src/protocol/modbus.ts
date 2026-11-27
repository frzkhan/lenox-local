// Modbus RTU frames carried inside Eybond FC=4 payloads.

export const FC_READ_HOLDING = 3;
/** Max registers per read we allow; the Modbus spec limit is 125. */
export const MAX_READ = 100;

export function crc16(buf: Uint8Array): number {
  let crc = 0xffff;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc;
}

function withCrc(body: Buffer): Buffer {
  const c = crc16(body);
  return Buffer.concat([body, Buffer.from([c & 0xff, c >> 8])]);
}

export function buildReadHolding(slave: number, start: number, count: number): Buffer {
  if (count < 1 || count > MAX_READ) throw new RangeError(`count ${count} out of range 1..${MAX_READ}`);
  if (start < 0 || start + count > 0x10000) throw new RangeError(`start ${start} out of range`);
  return withCrc(Buffer.from([slave, FC_READ_HOLDING, start >> 8, start & 0xff, count >> 8, count & 0xff]));
}

export type ReadResult =
  | { kind: 'ok'; registers: number[] }
  | { kind: 'exception'; code: number }
  | { kind: 'no-response' }
  | { kind: 'invalid'; reason: string };

/** Parse a read-holding-registers response. An empty payload means the inverter didn't answer. */
export function parseReadResponse(payload: Buffer, slave: number, expectedCount: number): ReadResult {
  if (payload.length === 0) return { kind: 'no-response' };
  if (payload.length < 5) return { kind: 'invalid', reason: `too short (${payload.length} bytes)` };
  const crcRx = payload.readUInt16LE(payload.length - 2);
  if (crc16(payload.subarray(0, -2)) !== crcRx) return { kind: 'invalid', reason: 'CRC mismatch' };
  if (payload[0] !== slave) return { kind: 'invalid', reason: `slave ${payload[0]} != ${slave}` };
  if (payload[1] === (FC_READ_HOLDING | 0x80)) return { kind: 'exception', code: payload[2] };
  if (payload[1] !== FC_READ_HOLDING) return { kind: 'invalid', reason: `function ${payload[1]}` };
  const byteCount = payload[2];
  if (byteCount !== expectedCount * 2 || payload.length !== 3 + byteCount + 2)
    return { kind: 'invalid', reason: `byte count ${byteCount}, expected ${expectedCount * 2}` };
  const registers: number[] = [];
  for (let i = 0; i < expectedCount; i++) registers.push(payload.readUInt16BE(3 + i * 2));
  return { kind: 'ok', registers };
}
