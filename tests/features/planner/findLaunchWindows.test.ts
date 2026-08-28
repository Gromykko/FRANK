import { describe, it, expect } from 'vitest';
import {
  findLaunchWindows,
  findNearLimitWindows,
} from '../../../src/features/planner/findLaunchWindows';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';
import { analyzeSafetyConditions } from '../../../src/features/safety/analyzeSafetyConditions';

const baseSettings = {
  tripMode: 'custom',
  windLimit: 8,
  waterTempTakeCareBelow: 15,
  waterTempDangerBelow: 10,
  waveLimit: 1,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
  enableWaterTemp: true,
  enableCustomWindDirs: false,
  sectorLimits: {},
  daylightOnly: true,
  minDuration: 2, // requires 3 consecutive within-limit hours (0 to 2)
} as SafetySettings;

const baseData: HourlyData = {
  time: '2026-07-08T12:00:00Z',
  tempAir: 20,
  tempWater: 18,
  windSpeed: 3,
  windGust: 4,
  windDirection: 180,
  waveHeight: 0.2,
  wavePeriod: 3,
  waveDirection: 180,
  tideLevel: 0,
  precipitation: 0,
  symbolCode: 'clearsky_day',
  currentSpeed: 0,
  currentDirection: 0,
  isDay: true,
};

const generateData = (hoursCount: number, startHour: number = 12): HourlyData[] => {
  return Array.from({ length: hoursCount }, (_, i) => ({
    ...baseData,
    time: `2026-07-08T${String(startHour + i).padStart(2, '0')}:00:00Z`,
  }));
};

describe('findLaunchWindows', () => {
  it('finds a launch window for consecutive within-limit hours', () => {
    // 3 hours within every selected limit
    const data = generateData(3);
    const windows = findLaunchWindows(data, baseSettings, 0);
    
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      startIndex: 0,
      endIndex: 2,
      duration: 2
    });
  });

  it('rejects windows shorter than minDuration', () => {
    // 2 within-limit hours (duration = 1)
    const data = generateData(2);
    const windows = findLaunchWindows(data, baseSettings, 0);
    
    expect(windows).toHaveLength(0);
  });

  it('breaks windows when the safety rating is not within limits', () => {
    // 5 hours: 0-1 within limits, 2 not recommended, 3-5 within limits
    const data = generateData(6);
    data[2].windSpeed = 10; // Above the selected maximum
    
    const windows = findLaunchWindows(data, baseSettings, 0);
    
    // First slot: 0-1 (duration 1) -> rejected (minDuration=2)
    // Second slot: 3-5 (duration 2) -> accepted
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      startIndex: 3,
      endIndex: 5,
      duration: 2
    });
  });

  it('produces a low-confidence window for a within-limit longer-range block', () => {
    // 3 within-limit hourly samples (one exact window), then a 6-hour interval
    // whose start and closing endpoint are both independently within limits.
    const hourly = generateData(3);
    const block: HourlyData = {
      ...baseData,
      time: '2026-07-11T06:00:00Z',
      isLowConfidence: true,
      blockSpanHours: 6,
      // MET does not publish gusts for these coarse blocks. That absence is
      // disclosed by the block explanation; the resulting window remains an
      // explicitly low-confidence hint rather than an exact hourly window.
      windGust: Number.NaN,
    };
    const closingEndpoint: HourlyData = {
      ...block,
      time: '2026-07-11T12:00:00Z',
    };
    // Daylight Only needs a sun schedule to judge a block; give it an all-day
    // one so this test stays about low-confidence flagging.
    const allDaySun = { sunrise: ['2026-07-11T00:00:00Z'], sunset: ['2026-07-11T23:59:00Z'] };
    const windows = findLaunchWindows([...hourly, block, closingEndpoint], baseSettings, 0, allDaySun);

    const lowConf = windows.filter((w) => w.lowConfidence);
    expect(lowConf).toHaveLength(1);
    expect(lowConf[0]).toMatchObject({ startIndex: 3, endIndex: 3, duration: 6, lowConfidence: true });
    // The exact hourly window is still found and is not flagged low-confidence.
    expect(windows.some((w) => !w.lowConfidence)).toBe(true);
  });

  it('breaks a window at a gap in the hourly series', () => {
    // The pipeline drops an hour with no marine sample, so array adjacency does
    // not imply the hours are consecutive. A window spanning the hole would
    // both under-report its duration and cover an hour never assessed at all.
    const data = generateData(5);
    data.splice(2, 1); // 10:00, 11:00, [13:00 missing 12:00], 14:00
    const windows = findLaunchWindows(data, { ...baseSettings, minDuration: 1 } as SafetySettings, 0);
    // Whatever windows come back, none may straddle the gap.
    const gapStart = new Date(data[1].time).getTime();
    const gapEnd = new Date(data[2].time).getTime();
    expect(gapEnd - gapStart).toBeGreaterThan(3_600_000);
    expect(windows.every((w) => w.endIndex <= 1 || w.startIndex >= 2)).toBe(true);
  });

  it('does not offer a longer-range block window when the block is unsafe', () => {
    const hourly = generateData(3);
    const block: HourlyData = {
      ...baseData,
      time: '2026-07-11T06:00:00Z',
      isLowConfidence: true,
      blockSpanHours: 6,
      windSpeed: 12, // over the selected maximum
    };
    const windows = findLaunchWindows([...hourly, block], baseSettings, 0);
    expect(windows.some((w) => w.lowConfidence)).toBe(false);
  });
});

describe('near-limit window detection', () => {
  const oneHourSettings = {
    ...baseSettings,
    minDuration: 1,
    daylightOnly: false,
  } as SafetySettings;

  it('keeps amber out of green hourly windows and detects its continuous stretch', () => {
    const data = generateData(5);
    // 80% of the selected 8.0 m/s maximum. This sample is amber, not green.
    data[2].windSpeed = 6.4;

    expect(analyzeSafetyConditions(data[2], oneHourSettings)).toMatchObject({
      rating: 'caution',
      reasons: [expect.objectContaining({ kind: 'near-limit' })],
    });
    expect(findLaunchWindows(data, oneHourSettings, 0)).toMatchObject([
      { startIndex: 0, endIndex: 1, duration: 1 },
      { startIndex: 3, endIndex: 4, duration: 1 },
    ]);
    expect(findNearLimitWindows(data, oneHourSettings, 0)).toMatchObject([
      {
        startIndex: 0,
        endIndex: 4,
        duration: 4,
        kind: 'near-limit',
        reviewIndex: 2,
      },
    ]);
  });

  it('does not turn another caution or a danger result into a near-limit alternative', () => {
    const coldWater = generateData(3);
    coldWater[0].windSpeed = 6.4;
    coldWater[1].tempWater = 14;
    expect(analyzeSafetyConditions(coldWater[1], oneHourSettings).rating).toBe('caution');
    expect(findNearLimitWindows(coldWater, oneHourSettings, 0)).toEqual([]);

    const excessiveWind = generateData(3);
    excessiveWind[0].waveHeight = 0.8;
    excessiveWind[1].windSpeed = 8.1;
    expect(analyzeSafetyConditions(excessiveWind[1], oneHourSettings).rating).toBe('danger');
    expect(findNearLimitWindows(excessiveWind, oneHourSettings, 0)).toEqual([]);
  });

  it('detects a near-limit outlook block and identifies its amber closing sample', () => {
    const makeBlock = (time: string, overrides: Partial<HourlyData> = {}): HourlyData => ({
      ...baseData,
      time,
      isLowConfidence: true,
      blockSpanHours: 6,
      // Gusts are not forecast in this range and are deliberately not treated
      // as missing evidence by the outlook analyser.
      windGust: Number.NaN,
      ...overrides,
    });
    const data = [
      makeBlock('2026-07-11T06:00:00Z'),
      makeBlock('2026-07-11T12:00:00Z', { waveHeight: 0.8 }),
    ];

    expect(findLaunchWindows(data, oneHourSettings, 0)).toEqual([]);
    expect(findNearLimitWindows(data, oneHourSettings, 0)).toMatchObject([
      {
        startIndex: 0,
        endIndex: 0,
        duration: 6,
        lowConfidence: true,
        kind: 'near-limit',
        reviewIndex: 1,
      },
    ]);
  });

  it('returns every near-limit stretch while keeping the rendered green list capped', () => {
    const startMs = Date.parse('2026-07-01T00:00:00Z');
    const data = Array.from({ length: 13 * 4 }, (_, index): HourlyData => {
      const phase = index % 4;
      return {
        ...baseData,
        time: new Date(startMs + index * 3_600_000).toISOString(),
        // Two green endpoints make a one-hour launch window; an amber endpoint
        // extends the count-only near-limit stretch; danger breaks both runs.
        windSpeed: phase === 2 ? 6.4 : phase === 3 ? 8.1 : 3,
      };
    });

    expect(findNearLimitWindows(data, oneHourSettings, 0)).toHaveLength(13);
    expect(findLaunchWindows(data, oneHourSettings, 0)).toHaveLength(12);
  });
});

describe('findLaunchWindows — water level is informational', () => {
  it('returns identical exact-hour windows for high, low, changing, or missing levels', () => {
    const baseline = generateData(4);
    const expected = findLaunchWindows(baseline, baseSettings, 0);
    const levelSeries = [
      [0.4, 0.4, 0.4, 0.4],
      [-0.4, -0.4, -0.4, -0.4],
      [-0.3, -0.1, 0.1, 0.3],
      [0.3, 0.1, -0.1, -0.3],
      [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
    ];

    for (const levels of levelSeries) {
      const data = baseline.map((hour, index) => ({ ...hour, tideLevel: levels[index] }));
      expect(findLaunchWindows(data, baseSettings, 0), String(levels)).toEqual(expected);
    }
  });

  it('returns the same outlook window regardless of centre or range levels', () => {
    const makeBlock = (time: string, tideLevel: number, tideLevelMin: number, tideLevelMax: number): HourlyData => ({
      ...baseData,
      time,
      tideLevel,
      tideLevelMin,
      tideLevelMax,
      isLowConfidence: true,
      blockSpanHours: 6,
    });
    const settings = { ...baseSettings, daylightOnly: false } as SafetySettings;
    const expected = findLaunchWindows([
      makeBlock('2026-07-11T06:00:00Z', 0, -0.1, 0.1),
      makeBlock('2026-07-11T12:00:00Z', 0, -0.1, 0.1),
    ], settings, 0);
    const missing = findLaunchWindows([
      makeBlock('2026-07-11T06:00:00Z', Number.NaN, Number.NaN, Number.NaN),
      makeBlock('2026-07-11T12:00:00Z', Number.NaN, Number.NaN, Number.NaN),
    ], settings, 0);
    const extreme = findLaunchWindows([
      makeBlock('2026-07-11T06:00:00Z', -0.8, -1.2, 0.6),
      makeBlock('2026-07-11T12:00:00Z', 0.9, -0.4, 1.3),
    ], settings, 0);

    expect(missing).toEqual(expected);
    expect(extreme).toEqual(expected);
  });
});

// Location-clock fixtures carry an explicit +02:00 (CEST, July) offset so a
// midnight-crossing invariant means the same thing on any CI machine.
const atLocalTimes = (times: string[], overrides: Partial<HourlyData> = {}): HourlyData[] =>
  times.map((time) => ({ ...baseData, ...overrides, time: `${time}+02:00` }));

describe('findLaunchWindows — endpoint rule and window shaping', () => {
  it('an N-hour window needs N+1 within-limit samples (both endpoints included)', () => {
    const settings = { ...baseSettings, minDuration: 1 } as SafetySettings;
    // Two within-limit samples -> one 1-hour window.
    expect(findLaunchWindows(generateData(2), settings, 0)).toMatchObject([
      { startIndex: 0, endIndex: 1, duration: 1 },
    ]);
    // A single sample spans no hour interval -> no window.
    expect(findLaunchWindows(generateData(1), settings, 0)).toHaveLength(0);
  });

  it('four consecutive within-limit samples make one 3-hour window', () => {
    const windows = findLaunchWindows(generateData(4), baseSettings, 0);
    expect(windows).toMatchObject([{ startIndex: 0, endIndex: 3, duration: 3 }]);
  });

  it('keeps a within-limit 22:00–02:00 run continuous across local midnight', () => {
    const data = atLocalTimes([
      '2026-07-08T22:00:00', '2026-07-08T23:00:00',
      '2026-07-09T00:00:00', '2026-07-09T01:00:00', '2026-07-09T02:00:00',
    ]);
    const settings = { ...baseSettings, minDuration: 4, daylightOnly: false } as SafetySettings;
    const windows = findLaunchWindows(data, settings, 0);
    expect(windows).toMatchObject([
      { startIndex: 0, endIndex: 4, duration: 4 },
    ]);
  });

  it('ignores samples before startIndex', () => {
    const settings = { ...baseSettings, minDuration: 1 } as SafetySettings;
    const windows = findLaunchWindows(generateData(5), settings, 2);
    expect(windows).toMatchObject([{ startIndex: 2, endIndex: 4, duration: 2 }]);
  });

  it('counts only the actual time remaining in the current hour', () => {
    const nowMs = Date.parse('2026-07-08T12:59:00Z');
    const settings1h = { ...baseSettings, minDuration: 1 } as SafetySettings;
    const windows = findLaunchWindows(generateData(3), settings1h, 0, undefined, nowMs);

    expect(windows).toHaveLength(1);
    expect(windows[0].effectiveStartMs).toBe(nowMs);
    expect(windows[0].duration).toBeCloseTo(61 / 60, 10);

    // Nominally 12:00-14:00 looked like two hours; at 12:59 only 61 minutes
    // remain, so it cannot clear a two-hour minimum.
    expect(findLaunchWindows(generateData(3), baseSettings, 0, undefined, nowMs)).toEqual([]);
  });

  it('caps the result at 12 windows', () => {
    // 14 separate days, each with a 3-sample within-limit run -> 14 candidates.
    const days = Array.from({ length: 14 }, (_, d) => String(d + 1).padStart(2, '0'));
    const data = atLocalTimes(
      days.flatMap((day) => [
        `2026-07-${day}T10:00:00`,
        `2026-07-${day}T11:00:00`,
        `2026-07-${day}T12:00:00`,
      ])
    );
    const settings = { ...baseSettings, minDuration: 1 } as SafetySettings;
    expect(findLaunchWindows(data, settings, 0)).toHaveLength(12);
  });
});

describe('findLaunchWindows — longer-range block windows', () => {
  const makeBlock = (time: string, overrides: Partial<HourlyData> = {}): HourlyData => ({
    ...baseData,
    time,
    isLowConfidence: true,
    blockSpanHours: 6,
    ...overrides,
  });

  // Span/duration tests are not about daylight, so they pass an all-day sun
  // schedule to keep the Daylight Only rule out of the way.
  const allDaySun = { sunrise: ['2026-07-11T00:00:00'], sunset: ['2026-07-11T23:59:00'] };

  it('a run of two within-limit blocks sums blockSpanHours into the duration', () => {
    const blocks = [
      makeBlock('2026-07-11T06:00:00'),
      makeBlock('2026-07-11T12:00:00'),
      makeBlock('2026-07-11T18:00:00'),
    ];
    const windows = findLaunchWindows(blocks, baseSettings, 0, allDaySun);
    expect(windows).toMatchObject([
      { startIndex: 0, endIndex: 1, duration: 12, lowConfidence: true },
    ]);
  });

  it('minDuration filters block windows by their summed span', () => {
    const settings6h = { ...baseSettings, minDuration: 6 } as SafetySettings;
    // A covered 6-hour interval exactly meets a 6-hour minimum.
    expect(findLaunchWindows([
      makeBlock('2026-07-11T06:00:00'),
      makeBlock('2026-07-11T12:00:00'),
    ], settings6h, 0, allDaySun)).toHaveLength(1);
    // A shorter span is rejected by the same bar hourly windows clear.
    expect(
      findLaunchWindows([
        makeBlock('2026-07-11T06:00:00', { blockSpanHours: 4 }),
        makeBlock('2026-07-11T10:00:00', { blockSpanHours: 4 }),
      ], settings6h, 0, allDaySun)
    ).toHaveLength(0);
  });

  it('withholds an unclosed block and a block closed by a failing endpoint', () => {
    const start = makeBlock('2026-07-11T06:00:00');
    const unsafeEndpoint = makeBlock('2026-07-11T12:00:00', { windSpeed: 12 });

    expect(findLaunchWindows([start], { ...baseSettings, daylightOnly: false }, 0)).toEqual([]);
    expect(findLaunchWindows([start, unsafeEndpoint], { ...baseSettings, daylightOnly: false }, 0)).toEqual([]);
  });

  it('requires the closing endpoint at the exact block boundary', () => {
    const start = makeBlock('2026-07-11T06:00:00');
    const lateEndpoint = makeBlock('2026-07-11T12:20:00');

    expect(findLaunchWindows(
      [start, lateEndpoint],
      { ...baseSettings, daylightOnly: false },
      0,
    )).toEqual([]);
  });

  it('keeps contiguous outlook intervals continuous across local midnight', () => {
    const blocks = [
      makeBlock('2026-07-08T18:00:00+02:00'),
      makeBlock('2026-07-09T00:00:00+02:00'),
      makeBlock('2026-07-09T06:00:00+02:00'),
    ];
    const settings = { ...baseSettings, minDuration: 12, daylightOnly: false } as SafetySettings;

    expect(findLaunchWindows(blocks, settings, 0)).toMatchObject([
      { startIndex: 0, endIndex: 1, duration: 12, lowConfidence: true },
    ]);
  });

  it('withholds block windows entirely when Daylight Only is on but no sun schedule is known', () => {
    // Without sunrise/sunset there is no way to tell how much of a 6-hour block
    // is daylight, and a block is never itself marked as night — so offering it
    // could recommend a launch window that is entirely in the dark.
    expect(findLaunchWindows([
      makeBlock('2026-07-11T00:00:00'),
      makeBlock('2026-07-11T06:00:00'),
    ], baseSettings, 0)).toHaveLength(0);
    // With the rule off, the same block is offered as before.
    const off = { ...baseSettings, daylightOnly: false } as SafetySettings;
    expect(findLaunchWindows([
      makeBlock('2026-07-11T00:00:00'),
      makeBlock('2026-07-11T06:00:00'),
    ], off, 0)).toHaveLength(1);
  });

  describe('daylight filtering with a sun schedule', () => {
    const sun = {
      sunrise: ['2026-07-11T08:00:00'],
      sunset: ['2026-07-11T20:00:00'],
    };

    it('drops a block run with zero daylight overlap', () => {
      // 00:00-06:00, entirely before the 08:00 sunrise.
      const windows = findLaunchWindows([
        makeBlock('2026-07-11T00:00:00'),
        makeBlock('2026-07-11T06:00:00'),
      ], baseSettings, 0, sun);
      expect(windows).toHaveLength(0);
    });

    it('keeps a partially-daylit block run and flags daylightPartial', () => {
      // 06:00-12:00: 4 of 6 hours are after sunrise.
      const block = makeBlock('2026-07-11T06:00:00');
      // The same block is Caution when the matrix describes its whole period,
      // but the planner deliberately defers daylight so it can offer the
      // weather/marine portion clipped to complete daylight hours.
      expect(analyzeSafetyConditions(block, baseSettings, undefined, {
        blockDaylight: { sun },
      }).rating).toBe('caution');
      const windows = findLaunchWindows([block, makeBlock('2026-07-11T12:00:00')], baseSettings, 0, sun);
      expect(windows).toHaveLength(1);
      expect(windows[0].daylightPartial).toBe(true);
    });

    it('a fully-daylit block run carries no daylightPartial flag', () => {
      // 09:00-15:00, entirely inside 08:00-20:00.
      const windows = findLaunchWindows([
        makeBlock('2026-07-11T09:00:00'),
        makeBlock('2026-07-11T15:00:00'),
      ], baseSettings, 0, sun);
      expect(windows).toHaveLength(1);
      expect(windows[0].daylightPartial).toBeUndefined();
    });

    it('daylightOnly off keeps night blocks and never flags them', () => {
      const settings = { ...baseSettings, daylightOnly: false } as SafetySettings;
      const windows = findLaunchWindows([
        makeBlock('2026-07-11T00:00:00'),
        makeBlock('2026-07-11T06:00:00'),
      ], settings, 0, sun);
      expect(windows).toHaveLength(1);
      expect(windows[0].daylightPartial).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// MET's outlook blocks sit at 00/06/12/18Z = 02:00 / 08:00 / 14:00 / 20:00
// local in CEST, so a block straddling sunrise or sunset is the normal case for
// roughly a third of the year. Blocks are never rated nighttime, so a calm one
// rates within limits, and it used to be offered as a full 6-hour window on the
// strength of any daylight at all, while Daylight Only was ON.
// ---------------------------------------------------------------------------
describe('outlook blocks under Daylight Only', () => {
  // 2026-10-04: the 00Z block covers 02:00-08:00 local, sunrise ~07:28.
  const nightBlock: HourlyData = {
    ...baseData,
    time: '2026-10-04T00:00:00Z',
    isLowConfidence: true,
    blockSpanHours: 6,
  };
  const sun = { sunrise: ['2026-10-04T05:28:00Z'], sunset: ['2026-10-04T16:55:00Z'] };
  const withClosingEndpoint = (block: HourlyData): HourlyData[] => [
    block,
    {
      ...block,
      time: new Date(Date.parse(block.time) + (block.blockSpanHours ?? 6) * 3_600_000).toISOString(),
    },
  ];

  it('refuses a block whose daylight is a sliver of its span', () => {
    // Only 07:00-08:00 local is daylight, and 07:00 is before sunrise, so the
    // paddleable slice is empty. Offering 5h20m of darkness under the setting
    // that exists to prevent it is the failure being guarded here.
    const settings = { ...baseSettings, minDuration: 2, daylightOnly: true } as SafetySettings;
    expect(findLaunchWindows(withClosingEndpoint(nightBlock), settings, 0, sun)).toEqual([]);
  });

  it('applies minDuration to the paddleable hours, not the nominal span', () => {
    // The 18Z block covers 20:00-02:00 local with sunset 18:55 -> no daylight
    // marks at all. Even minDuration 1 must not produce a window.
    const eveningBlock = { ...nightBlock, time: '2026-10-04T18:00:00Z' };
    const settings = { ...baseSettings, minDuration: 1, daylightOnly: true } as SafetySettings;
    expect(findLaunchWindows(withClosingEndpoint(eveningBlock), settings, 0, sun)).toEqual([]);
  });

  it('reports a partly-daylit block as its daylight slice, and the slice is what duration counts', () => {
    // The 06Z block covers 08:00-14:00 local, fully inside 07:28-18:55.
    const dayBlock = { ...nightBlock, time: '2026-10-04T06:00:00Z' };
    const settings = { ...baseSettings, minDuration: 2, daylightOnly: true } as SafetySettings;
    const windows = findLaunchWindows(withClosingEndpoint(dayBlock), settings, 0, sun);
    expect(windows).toHaveLength(1);
    // Fully daylit: the whole span counts, and no slice is stored.
    expect(windows[0]).toMatchObject({ duration: 6, lowConfidence: true });
    expect(windows[0].daylightPartial).toBeUndefined();
  });

  it('stores the slice on a genuinely partial block so the card cannot re-derive it differently', () => {
    // The 12Z block covers 14:00-20:00 local; sunset is 18:55. The 18:00-19:00
    // hour is NOT wholly daylight, so the display must stop at 18:00.
    const eveningBlock = { ...nightBlock, time: '2026-10-04T12:00:00Z' };
    const settings = { ...baseSettings, minDuration: 2, daylightOnly: true } as SafetySettings;
    const windows = findLaunchWindows(withClosingEndpoint(eveningBlock), settings, 0, sun);
    expect(windows).toHaveLength(1);
    expect(windows[0].daylightPartial).toBe(true);
    // 14:00 through 18:00 local = 4 complete daylight hours out of 6.
    expect(windows[0].duration).toBe(4);
    expect(windows[0].daylightStartMs).toBe(Date.parse('2026-10-04T12:00:00Z'));
    expect(windows[0].daylightEndMs).toBe(Date.parse('2026-10-04T16:00:00Z'));
  });

  it('applies minDuration after excluding the hour that crosses sunset', () => {
    const eveningBlock = { ...nightBlock, time: '2026-10-04T12:00:00Z' };
    const settings = { ...baseSettings, minDuration: 5, daylightOnly: true } as SafetySettings;
    expect(findLaunchWindows(withClosingEndpoint(eveningBlock), settings, 0, sun)).toEqual([]);
  });

  it('daylightOnly off still offers the whole block', () => {
    const settings = { ...baseSettings, minDuration: 2, daylightOnly: false } as SafetySettings;
    const windows = findLaunchWindows(withClosingEndpoint(nightBlock), settings, 0, sun);
    expect(windows).toHaveLength(1);
    expect(windows[0].duration).toBe(6);
  });
});

// A rating is a description; a recommendation is advice. When every personal
// limit is switched off the analyser has nothing left to judge against and the
// header says so ("limits are off, raw forecast only") - but the planner used
// the raw rating and went on proposing windows, so the one surface that tells a
// paddler "go now" was the one surface that had stopped checking.
describe('findLaunchWindows with every limit disabled', () => {
  const limitsOff = {
    ...baseSettings,
    enableWindSpeed: false,
    enableWindGust: false,
    enableWaveHeight: false,
    enableWaterTemp: false,
    enableCustomWindDirs: false,
    daylightOnly: false,
  } as SafetySettings;

  it('recommends nothing rather than recommending a gale', () => {
    const gale = generateData(6).map((hour) => ({
      ...hour,
      windSpeed: 20,
      windGust: 26,
      tempWater: 4,
    }));
    expect(findLaunchWindows(gale, limitsOff, 0)).toHaveLength(0);
  });

  it('recommends nothing even when the raw conditions are genuinely calm', () => {
    // Still correct: with nothing being checked we cannot vouch for any hour,
    // and silence is the honest output.
    expect(findLaunchWindows(generateData(6), limitsOff, 0)).toHaveLength(0);
    expect(findLaunchWindows(generateData(6), baseSettings, 0).length).toBeGreaterThan(0);
  });
});
