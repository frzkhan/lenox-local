// Deye / Sunsynk single-phase hybrid register map (read-only subset).
// Source: kellerza/sunsynk src/sunsynk/definitions/single_phase.py, cross-checked against
// this Lenox unit's Phase 0 capture (PV V*I ≈ W, battery V*I ≈ W, clock = local time).

export type RegisterCache = ReadonlyMap<number, number>;

/** Register blocks to poll. `fast` every poll cycle, `slow` occasionally. */
export interface Block { start: number; count: number }
export const BLOCKS: { fast: readonly Block[]; slow: readonly Block[] } = {
  fast: [
    { start: 59, count: 54 }, // 59..112  state, day energy, temps, faults, PV V/I
    { start: 150, count: 45 }, // 150..194 grid, inverter, load, battery, PV power
  ],
  slow: [
    { start: 0, count: 25 }, // 0..24 device type, serial, rated power, clock
  ],
};

const s16 = (v: number) => (v > 0x7fff ? v - 0x10000 : v);
/** Two registers, low word first (sunsynk convention). */
const u32 = (lo: number, hi: number) => lo + hi * 0x10000;
const round = (v: number, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;
const temp = (v: number) => round((v - 1000) * 0.1, 1);

const STATES: Record<number, string> = { 0: 'standby', 1: 'self-check', 2: 'normal', 3: 'alarm', 4: 'fault' };

export interface Snapshot {
  time: string;
  inverter: {
    state: string;
    stateCode: number;
    serial?: string;
    ratedPowerW?: number;
    clock?: string;
    outputVoltage: number;
    outputFrequency: number;
    powerW: number;
    tempDcTransformerC: number;
    tempRadiatorC: number;
    faultCodes: number[];
  };
  pv: { strings: { voltage: number; current: number; powerW: number }[]; powerW: number };
  battery: { voltage: number; soc: number; powerW: number; currentA: number; tempC: number | null; state: 'charging' | 'discharging' | 'idle' };
  grid: { connected: boolean; voltage: number; frequency: number; powerW: number; ctPowerW: number };
  load: { powerW: number; frequency: number };
  today: EnergyCounters;
  /** Lifetime counters from the inverter. */
  total: EnergyCounters;
}

export interface EnergyCounters { pvKWh: number; loadKWh: number; gridImportKWh: number; gridExportKWh: number; batteryChargeKWh: number; batteryDischargeKWh: number }

export class MissingRegisterError extends Error {}

export function decode(cache: RegisterCache, now = new Date()): Snapshot {
  const r = (a: number) => {
    const v = cache.get(a);
    if (v === undefined) throw new MissingRegisterError(`register ${a} not read`);
    return v;
  };
  const opt = (a: number) => cache.get(a);

  const strings = [
    { voltage: round(r(109) * 0.1, 1), current: round(r(110) * 0.1, 1), powerW: r(186) },
    { voltage: round(r(111) * 0.1, 1), current: round(r(112) * 0.1, 1), powerW: r(187) },
  ];
  // Sunsynk convention: battery power/current positive = discharging.
  const batPower = s16(r(190));
  const batTempRaw = r(182);
  const batTemp = temp(batTempRaw);

  let serial: string | undefined;
  if ([3, 4, 5, 6, 7].every((a) => cache.has(a))) {
    serial = [3, 4, 5, 6, 7].map((a) => String.fromCharCode(r(a) >> 8, r(a) & 0xff)).join('').replace(/\0/g, '').trim();
  }
  let clock: string | undefined;
  const c22 = opt(22), c23 = opt(23), c24 = opt(24);
  if (c22 !== undefined && c23 !== undefined && c24 !== undefined) {
    const p = (n: number) => String(n).padStart(2, '0');
    clock = `20${p(c22 >> 8)}-${p(c22 & 0xff)}-${p(c23 >> 8)} ${p(c23 & 0xff)}:${p(c24 >> 8)}:${p(c24 & 0xff)}`;
  }
  const r16 = opt(16), r17 = opt(17);

  return {
    time: now.toISOString(),
    inverter: {
      state: STATES[r(59)] ?? `unknown(${r(59)})`,
      stateCode: r(59),
      serial,
      ratedPowerW: r16 !== undefined && r17 !== undefined ? round(u32(r16, r17) * 0.1, 0) : undefined,
      clock,
      outputVoltage: round(r(154) * 0.1, 1),
      outputFrequency: round(r(193) * 0.01, 2),
      powerW: s16(r(175)),
      tempDcTransformerC: temp(r(90)),
      tempRadiatorC: temp(r(91)),
      faultCodes: [103, 104, 105, 106].map(r),
    },
    pv: { strings, powerW: strings.reduce((a, s) => a + s.powerW, 0) },
    battery: {
      voltage: round(r(183) * 0.01, 2),
      soc: r(184),
      powerW: batPower,
      currentA: round(s16(r(191)) * 0.01, 2),
      // raw 0 or values below -40 °C mean "no sensor" (this unit reports raw 210 → -79 °C)
      tempC: batTempRaw === 0 || batTemp < -40 ? null : batTemp,
      state: batPower > 20 ? 'discharging' : batPower < -20 ? 'charging' : 'idle',
    },
    grid: {
      connected: r(194) !== 0,
      voltage: round(r(150) * 0.1, 1),
      frequency: round(r(79) * 0.01, 2),
      powerW: s16(r(169)),
      ctPowerW: s16(r(172)),
    },
    load: { powerW: s16(r(178)), frequency: round(r(192) * 0.01, 2) },
    today: {
      pvKWh: round(r(108) * 0.1, 1),
      loadKWh: round(r(84) * 0.1, 1),
      gridImportKWh: round(r(76) * 0.1, 1),
      gridExportKWh: round(r(77) * 0.1, 1),
      batteryChargeKWh: round(r(70) * 0.1, 1),
      batteryDischargeKWh: round(r(71) * 0.1, 1),
    },
    total: {
      pvKWh: round(u32(r(96), r(97)) * 0.1, 1),
      loadKWh: round(u32(r(85), r(86)) * 0.1, 1),
      gridImportKWh: round(u32(r(78), r(80)) * 0.1, 1),
      gridExportKWh: round(u32(r(81), r(82)) * 0.1, 1),
      batteryChargeKWh: round(u32(r(72), r(73)) * 0.1, 1),
      batteryDischargeKWh: round(u32(r(74), r(75)) * 0.1, 1),
    },
  };
}
