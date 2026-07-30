import { describe, it, expect } from 'vitest';
import { analyzeSafetyConditions } from '../../../src/features/safety/analyzeSafetyConditions';
import { DEFAULT_SETTINGS } from '../../../src/features/safety/presets';
import { parseStoredSettings } from '../../../src/hooks/useSettings';
import { assembleHourlyRow, asNumber, reviveReadings } from '../../../src/features/forecast/normalize';
import { findLaunchWindows } from '../../../src/features/planner/findLaunchWindows';
import type { HourlyData } from '../../../src/features/forecast/types';

// The one property this app must never violate: an hour FRANK could not
// actually assess is never reported as safe. Missing readings make every
// `>=` / `<` comparison false, so without an explicit guard they sail through
// every threshold untouched and come out green.
const goodHour: HourlyData = {
  time: '2026-07-28T12:00:00.000Z',
  tempAir: 20,
  precipitation: 0,
  symbolCode: 'clearsky_day',
  weatherCode: 0,
  windSpeed: 3,
  windDirection: 90,
  windGust: 4,
  waveHeight: 0.1,
  waveDirection: 90,
  wavePeriod: 3,
  tempWater: 18,
  tideLevel: 0,
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
};

const rate = (patch: Partial<Record<keyof HourlyData, unknown>>) =>
  analyzeSafetyConditions({ ...goodHour, ...patch } as HourlyData, DEFAULT_SETTINGS);

describe('missing readings are never rated safe', () => {
  it('rates the fully-populated control hour safe', () => {
    expect(rate({}).rating).toBe('safe');
  });

  for (const field of ['windSpeed', 'windGust', 'windDirection', 'waveHeight', 'tempWater'] as const) {
    it(`does not clear an hour with no ${field}`, () => {
      for (const absent of [NaN, undefined, null]) {
        const result = rate({ [field]: absent });
        expect(result.rating, `${field}=${String(absent)}`).not.toBe('safe');
        expect(result.reasons.some((r) => /cannot clear/i.test(r.text))).toBe(true);
      }
    });
  }

  it('never emits the all-clear alongside a missing reading', () => {
    const result = rate({ waveHeight: NaN });
    expect(result.reasons.some((r) => /within your limits/i.test(r.text))).toBe(false);
  });

  it('still reports a real hazard that it could measure', () => {
    // Wave data is gone, but the wind is a gale — the wind reason must survive.
    const result = rate({ waveHeight: NaN, windSpeed: 25, windGust: 30 });
    expect(result.rating).toBe('danger');
    expect(result.reasons.some((r) => /Wind speed/i.test(r.text))).toBe(true);
  });

  it('does not throw on null readings', () => {
    expect(() => rate({ tempWater: null, waveHeight: null, windSpeed: null })).not.toThrow();
  });

  it('keeps missing hours out of recommended launch windows', () => {
    const hours: HourlyData[] = Array.from({ length: 6 }, (_, i) => ({
      ...goodHour,
      time: `2026-07-28T${String(8 + i).padStart(2, '0')}:00:00.000Z`,
      // The middle of an otherwise perfect run has no wave reading.
      waveHeight: i === 3 ? NaN : 0.1,
    }));
    const windows = findLaunchWindows(hours, { ...DEFAULT_SETTINGS, minDuration: 1, daylightOnly: false }, 0);
    expect(windows.every((w) => w.startIndex > 3 || w.endIndex < 3)).toBe(true);
  });
});

describe('normalize does not fabricate readings', () => {
  it('leaves an absent marine value non-finite instead of 0', () => {
    const row = assembleHourlyRow(
      { time: goodHour.time, timeMs: 0, windSpeed: 3, windDirection: 90, windGust: 4, symbolCode: 'clearsky_day', weatherCode: 0, tempAir: 20 },
      { time: goodHour.time, timeMs: 0 },
      { time: goodHour.time, timeMs: 0 },
      true
    );
    expect(Number.isFinite(row.waveHeight)).toBe(false);
    expect(Number.isFinite(row.tempWater)).toBe(false);
    expect(analyzeSafetyConditions(row, DEFAULT_SETTINGS).rating).not.toBe('safe');
  });

  it('treats an empty string as missing, not as zero', () => {
    expect(asNumber('')).toBeUndefined();
    expect(asNumber('   ')).toBeUndefined();
    expect(asNumber('0')).toBe(0);
  });
});

describe('a corrupt stored profile cannot disable a safety check', () => {
  it('falls back to the default when a threshold is not a number', () => {
    const parsed = parseStoredSettings('{"tripMode":"custom","maxWindSpeedSafe":"x"}');
    expect(parsed.maxWindSpeedSafe).toBe(DEFAULT_SETTINGS.maxWindSpeedSafe);
    // The whole point: a gale must still rate danger afterwards.
    expect(analyzeSafetyConditions({ ...goodHour, windSpeed: 25, windGust: 30 }, parsed).rating).toBe('danger');
  });

  it('rounds a derived cap so it never prints a float artifact', () => {
    const parsed = parseStoredSettings('{"maxWaveHeightSafe":0.1,"maxWaveHeightCaution":0.30000000000000004}');
    const text = analyzeSafetyConditions({ ...goodHour, waveHeight: 0.35 }, parsed).reasons
      .map((r) => r.text)
      .join(' ');
    expect(text).not.toMatch(/0\.30000000000000004/);
  });
});

// JSON has no NaN. The Worker serializes the payload and the client re-caches
// it in localStorage, so every NO_READING arrives as `null` in production —
// and null behaves as 0 in a comparison, the exact opposite of NaN. Dev fetches
// providers directly and never serializes, so this whole class of bug is
// invisible there. These lock the round trip.
describe('a missing reading survives the JSON round trip', () => {
  const overWire = <T,>(value: T): T => JSON.parse(JSON.stringify(value));

  it('turns NaN into null on the wire (the reason reviveReadings exists)', () => {
    expect(overWire({ waveHeight: NaN }).waveHeight).toBeNull();
    // …and null is not inert the way NaN is. This is the whole hazard: an
    // absent wave height would read as flat calm rather than as unknown.
    const absent = overWire({ waveHeight: NaN }).waveHeight as unknown as number;
    expect(absent <= 0.1).toBe(true);
    expect(Math.min(absent, 4.2)).toBe(0);
    // Whereas the NaN it was serialized from fails the same comparison.
    const inMemory: number = NaN;
    expect(inMemory <= 0.1).toBe(false);
  });

  it('revives readings so a serialized payload rates the same as a live one', () => {
    const live = { ...goodHour, waveHeight: NaN, tempWater: NaN };
    const wire = reviveReadings(overWire({ hourly: [live] })).hourly[0];

    expect(Number.isNaN(wire.waveHeight)).toBe(true);
    expect(analyzeSafetyConditions(wire, DEFAULT_SETTINGS).rating)
      .toBe(analyzeSafetyConditions(live, DEFAULT_SETTINGS).rating);
  });

  it('never describes the sea state it could not read', () => {
    // Wave checks off, so nothing forces caution — the all-clear still must not
    // invent "calm water" from an absent reading.
    const settings = { ...DEFAULT_SETTINGS, enableWaveHeight: false };
    for (const absent of [NaN, null]) {
      const text = analyzeSafetyConditions(
        { ...goodHour, waveHeight: absent } as unknown as HourlyData, settings
      ).reasons.map((r) => r.text).join(' ');
      expect(text, `waveHeight=${String(absent)}`).not.toMatch(/calm water|rough water|ripples|choppy/);
    }
  });

  it('does not invent a gust from the sustained wind', () => {
    const row = assembleHourlyRow(
      { time: goodHour.time, timeMs: 0, windSpeed: 6.1, windDirection: 90, symbolCode: 'clearsky_day', weatherCode: 0, tempAir: 20 },
      { time: goodHour.time, timeMs: 0, tempWater: 18, tideLevel: 0 },
      { time: goodHour.time, timeMs: 0, waveHeight: 0.1 },
      true
    );
    expect(row.windGust).not.toBe(6.1);
    expect(Number.isFinite(row.windGust)).toBe(false);
  });
});
