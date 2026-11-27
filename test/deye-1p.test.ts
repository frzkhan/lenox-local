import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { decode, MissingRegisterError, BLOCKS } from '../src/registers/deye-1p.ts';

const raw = JSON.parse(fs.readFileSync(new URL('./fixtures/registers-2026-11-27.json', import.meta.url), 'utf8')) as Record<string, number>;
const cache = new Map(Object.entries(raw).map(([k, v]) => [Number(k), v]));

test('decodes captured registers into plausible, self-consistent values', () => {
  const s = decode(cache);
  assert.equal(s.inverter.serial, '2503180145');
  assert.equal(s.inverter.state, 'normal');
  assert.match(s.inverter.clock!, /^2026-11-27 08:/);
  assert.equal(s.grid.connected, false); // grid was down during capture
  assert.equal(s.battery.state, 'charging');
  assert.ok(s.battery.soc > 0 && s.battery.soc <= 100);
  assert.ok(s.battery.voltage > 40 && s.battery.voltage < 60);
  assert.equal(s.battery.tempC, null); // raw 210 → -79 °C → no sensor
  // physics cross-checks
  assert.ok(Math.abs(s.battery.voltage * s.battery.currentA - s.battery.powerW) < 0.05 * Math.abs(s.battery.powerW));
  for (const pv of s.pv.strings) assert.ok(Math.abs(pv.voltage * pv.current - pv.powerW) < 0.15 * pv.powerW + 50);
  assert.equal(s.pv.powerW, s.pv.strings[0].powerW + s.pv.strings[1].powerW);
});

test('fast blocks alone are enough for a snapshot', () => {
  const fast = new Map<number, number>();
  for (const b of BLOCKS.fast) for (let a = b.start; a < b.start + b.count; a++) fast.set(a, cache.get(a)!);
  const s = decode(fast);
  assert.equal(s.inverter.serial, undefined);
  assert.ok(s.load.powerW >= 0);
});

test('missing registers throw MissingRegisterError', () => {
  assert.throws(() => decode(new Map()), MissingRegisterError);
});
