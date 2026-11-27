import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameDecoder, encodeFrame, heartbeatPayload, FC_FORWARD } from '../src/protocol/eybond.ts';
import { buildReadHolding, parseReadResponse, crc16 } from '../src/protocol/modbus.ts';

// Real frames captured from the dongle on 2026-11-27 (probe/captures).
const HEARTBEAT_REPLY = '0001000000140101453630303030323330353734303830323838';
const READ_256_REQ = '00170993000a010401030100000ac431';
const READ_256_REPLY = '00170993001b01040103141f401f401f401f401f401f4013881388138813886ccd';
const EMPTY_REPLY = '0004099300020104';

test('decodes heartbeat reply into dongle PN', () => {
  const [f] = new FrameDecoder().push(Buffer.from(HEARTBEAT_REPLY, 'hex'));
  assert.equal(f.fc, 1);
  assert.equal(f.payload.toString('latin1'), 'E60000230574080288');
});

test('encodes a forward frame byte-identical to the one the dongle answered', () => {
  const frame = encodeFrame({ tid: 0x17, devcode: 0x0993, addr: 1, fc: FC_FORWARD, payload: buildReadHolding(1, 0x0100, 10) });
  assert.equal(frame.toString('hex'), READ_256_REQ);
});

test('reassembles frames split across and merged within TCP chunks', () => {
  const all = Buffer.concat([Buffer.from(HEARTBEAT_REPLY, 'hex'), Buffer.from(READ_256_REPLY, 'hex'), Buffer.from(EMPTY_REPLY, 'hex')]);
  const d = new FrameDecoder();
  const frames = [...d.push(all.subarray(0, 5)), ...d.push(all.subarray(5, 40)), ...d.push(all.subarray(40))];
  assert.deepEqual(frames.map((f) => f.tid), [1, 0x17, 4]);
  assert.equal(frames[2].payload.length, 0);
});

test('rejects corrupt length', () => {
  assert.throws(() => new FrameDecoder().push(Buffer.from('000100000000ffff', 'hex')), /Corrupt/);
});

test('parses a real Modbus read response', () => {
  const [f] = new FrameDecoder().push(Buffer.from(READ_256_REPLY, 'hex'));
  const r = parseReadResponse(f.payload, 1, 10);
  assert.deepEqual(r, { kind: 'ok', registers: [8000, 8000, 8000, 8000, 8000, 8000, 5000, 5000, 5000, 5000] });
});

test('empty payload = no response; bad CRC and exceptions are detected', () => {
  assert.deepEqual(parseReadResponse(Buffer.alloc(0), 1, 10), { kind: 'no-response' });
  const [f] = new FrameDecoder().push(Buffer.from(READ_256_REPLY, 'hex'));
  const bad = Buffer.from(f.payload); bad[5] ^= 0xff;
  assert.equal(parseReadResponse(bad, 1, 10).kind, 'invalid');
  assert.equal(parseReadResponse(f.payload, 1, 9).kind, 'invalid');
  const body = Buffer.from([1, 0x83, 2]); const c = crc16(body);
  assert.deepEqual(parseReadResponse(Buffer.concat([body, Buffer.from([c & 0xff, c >> 8])]), 1, 10), { kind: 'exception', code: 2 });
});

test('only read requests can be built, within limits', () => {
  assert.throws(() => buildReadHolding(1, 0, 0), RangeError);
  assert.throws(() => buildReadHolding(1, 0, 101), RangeError);
  assert.equal(buildReadHolding(1, 59, 54)[1], 3);
});

test('heartbeat payload layout', () => {
  const p = heartbeatPayload(new Date(Date.UTC(2026, 10, 27, 3, 50, 44)), 30);
  assert.equal(p.toString('hex'), '1a0b1b03322c001e'); // matches what phase0 sent
});
