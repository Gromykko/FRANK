import { describe, it, expect } from 'vitest';
import { findLaunchWindows } from '../../../src/features/planner/findLaunchWindows';
import type { HourlyData } from '../../../src/features/forecast/types';
import type { SafetySettings } from '../../../src/features/safety/presets';

const baseSettings = {
  tripMode: 'custom',
  maxWindSpeedSafe: 5,
  maxWindSpeedCaution: 8,
  minWaterTempSafe: 15,
  minWaterTempCaution: 10,
  maxWaveHeightSafe: 0.5,
  maxWaveHeightCaution: 1.0,
  enableWindSpeed: true,
  enableWindGust: true,
  enableWaveHeight: true,
  enableWaveCaution: true,
  enableWaterTemp: true,
  daylightOnly: true,
  minDuration: 2, // requires 3 consecutive safe hours (0 to 2)
  tidePreference: 'any',
  gustMargin: 3,
  waveCautionMargin: 0.5,
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
  weatherCode: 0,
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
  it('finds a launch window for consecutive safe hours', () => {
    // 3 hours of safe conditions
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
    // 2 hours of safe conditions (duration = 1)
    const data = generateData(2);
    const windows = findLaunchWindows(data, baseSettings, 0);
    
    expect(windows).toHaveLength(0);
  });

  it('breaks windows when safety rating is not safe', () => {
    // 5 hours: 0-1 safe, 2 danger, 3-5 safe
    const data = generateData(6);
    data[2].windSpeed = 10; // Danger
    
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

  it('filters based on tide preference', () => {
    const data = generateData(4);
    // 0: -0.2, 1: -0.2, 2: -0.2, 3: -0.2 (low tide)
    data.forEach(d => d.tideLevel = -0.2);
    
    const settingsHigh = { ...baseSettings, tidePreference: 'high' as const };
    const windowsHigh = findLaunchWindows(data, settingsHigh, 0);
    expect(windowsHigh).toHaveLength(0); // Fails high tide filter
    
    const settingsLow = { ...baseSettings, tidePreference: 'low' as const };
    const windowsLow = findLaunchWindows(data, settingsLow, 0);
    expect(windowsLow).toHaveLength(1); // Passes low tide filter
  });

  it('filters based on incoming tide', () => {
    const data = generateData(4);
    // 0: 0.1, 1: 0.2, 2: 0.3, 3: 0.4 (incoming)
    data.forEach((d, i) => d.tideLevel = i * 0.1);

    const settingsIncoming = { ...baseSettings, tidePreference: 'incoming' as const };
    const windows = findLaunchWindows(data, settingsIncoming, 0);
    expect(windows).toHaveLength(1); // Passes incoming tide filter
  });

  it('produces a low-confidence window for a safe longer-range block', () => {
    // 3 safe hourly samples (one exact window), then one safe 6-hour block.
    const hourly = generateData(3);
    const block: HourlyData = {
      ...baseData,
      time: '2026-07-11T06:00:00Z',
      isLowConfidence: true,
      blockSpanHours: 6,
    };
    const windows = findLaunchWindows([...hourly, block], baseSettings, 0);

    const lowConf = windows.filter((w) => w.lowConfidence);
    expect(lowConf).toHaveLength(1);
    expect(lowConf[0]).toMatchObject({ startIndex: 3, endIndex: 3, duration: 6, lowConfidence: true });
    // The exact hourly window is still found and is not flagged low-confidence.
    expect(windows.some((w) => !w.lowConfidence)).toBe(true);
  });

  it('does not offer a longer-range block window when the block is unsafe', () => {
    const hourly = generateData(3);
    const block: HourlyData = {
      ...baseData,
      time: '2026-07-11T06:00:00Z',
      isLowConfidence: true,
      blockSpanHours: 6,
      windSpeed: 12, // over the danger limit
    };
    const windows = findLaunchWindows([...hourly, block], baseSettings, 0);
    expect(windows.some((w) => w.lowConfidence)).toBe(false);
  });
});

// Location-clock time strings: the planner splits days at the LOCATION's
// midnight (isSameLocationDay, Europe/Copenhagen), so fixtures must carry an
// explicit +02:00 (CEST, July) offset — naive strings parse as machine-local
// time and shift the day boundary on any machine outside GMT+2 (e.g. UTC CI).
const atLocalTimes = (times: string[], overrides: Partial<HourlyData> = {}): HourlyData[] =>
  times.map((time) => ({ ...baseData, ...overrides, time: `${time}+02:00` }));

describe('findLaunchWindows — endpoint rule and window shaping', () => {
  it('an N-hour window needs N+1 safe samples (both endpoints safe)', () => {
    const settings = { ...baseSettings, minDuration: 1 } as SafetySettings;
    // Two safe samples -> one 1-hour window.
    expect(findLaunchWindows(generateData(2), settings, 0)).toMatchObject([
      { startIndex: 0, endIndex: 1, duration: 1 },
    ]);
    // A single safe sample spans no hour interval -> no window.
    expect(findLaunchWindows(generateData(1), settings, 0)).toHaveLength(0);
  });

  it('four consecutive safe samples make one 3-hour window', () => {
    const windows = findLaunchWindows(generateData(4), baseSettings, 0);
    expect(windows).toMatchObject([{ startIndex: 0, endIndex: 3, duration: 3 }]);
  });

  it('splits windows at local midnight', () => {
    const data = atLocalTimes([
      '2026-07-08T21:00:00', '2026-07-08T22:00:00', '2026-07-08T23:00:00',
      '2026-07-09T00:00:00', '2026-07-09T01:00:00', '2026-07-09T02:00:00',
    ]);
    const settings = { ...baseSettings, minDuration: 1 } as SafetySettings;
    const windows = findLaunchWindows(data, settings, 0);
    expect(windows).toMatchObject([
      { startIndex: 0, endIndex: 2, duration: 2 },
      { startIndex: 3, endIndex: 5, duration: 2 },
    ]);
  });

  it('ignores samples before startIndex', () => {
    const settings = { ...baseSettings, minDuration: 1 } as SafetySettings;
    const windows = findLaunchWindows(generateData(5), settings, 2);
    expect(windows).toMatchObject([{ startIndex: 2, endIndex: 4, duration: 2 }]);
  });

  it('caps the result at 12 windows', () => {
    // 14 separate days, each with a 3-sample safe run -> 14 candidate windows.
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

describe('findLaunchWindows — tide preference boundaries', () => {
  const settings1h = { ...baseSettings, minDuration: 1 } as SafetySettings;

  it('high water requires every sample at or above +0.1 m', () => {
    const pass = atLocalTimes(['2026-07-08T10:00:00', '2026-07-08T11:00:00'], { tideLevel: 0.1 });
    expect(findLaunchWindows(pass, { ...settings1h, tidePreference: 'high' }, 0)).toHaveLength(1);

    const fail = atLocalTimes(['2026-07-08T10:00:00', '2026-07-08T11:00:00'], { tideLevel: 0.09 });
    expect(findLaunchWindows(fail, { ...settings1h, tidePreference: 'high' }, 0)).toHaveLength(0);
  });

  it('low water requires every sample at or below -0.1 m', () => {
    const pass = atLocalTimes(['2026-07-08T10:00:00', '2026-07-08T11:00:00'], { tideLevel: -0.1 });
    expect(findLaunchWindows(pass, { ...settings1h, tidePreference: 'low' }, 0)).toHaveLength(1);

    const fail = atLocalTimes(['2026-07-08T10:00:00', '2026-07-08T11:00:00'], { tideLevel: -0.09 });
    expect(findLaunchWindows(fail, { ...settings1h, tidePreference: 'low' }, 0)).toHaveLength(0);
  });

  it('incoming rejects flat and falling water levels', () => {
    const flat = generateData(3); // all tideLevel 0
    expect(findLaunchWindows(flat, { ...baseSettings, tidePreference: 'incoming' }, 0)).toHaveLength(0);

    const falling = generateData(3);
    falling.forEach((d, i) => (d.tideLevel = -i * 0.1));
    expect(findLaunchWindows(falling, { ...baseSettings, tidePreference: 'incoming' }, 0)).toHaveLength(0);
  });

  it('tide preference filters block windows too', () => {
    const block: HourlyData = {
      ...baseData,
      time: '2026-07-11T06:00:00',
      isLowConfidence: true,
      blockSpanHours: 6,
      tideLevel: -0.2,
    };
    const windows = findLaunchWindows([block], { ...baseSettings, tidePreference: 'high' } as SafetySettings, 0);
    expect(windows).toHaveLength(0);
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

  it('a run of two safe blocks sums blockSpanHours into the duration', () => {
    const blocks = [makeBlock('2026-07-11T06:00:00'), makeBlock('2026-07-11T12:00:00')];
    const windows = findLaunchWindows(blocks, baseSettings, 0);
    expect(windows).toMatchObject([
      { startIndex: 0, endIndex: 1, duration: 12, lowConfidence: true },
    ]);
  });

  it('minDuration filters block windows by their summed span', () => {
    const settings6h = { ...baseSettings, minDuration: 6 } as SafetySettings;
    // A 6-hour block exactly meets a 6-hour minimum.
    expect(findLaunchWindows([makeBlock('2026-07-11T06:00:00')], settings6h, 0)).toHaveLength(1);
    // A shorter span is rejected by the same bar hourly windows clear.
    expect(
      findLaunchWindows([makeBlock('2026-07-11T06:00:00', { blockSpanHours: 4 })], settings6h, 0)
    ).toHaveLength(0);
  });

  it('a night block with no sun schedule provided is still offered', () => {
    const windows = findLaunchWindows([makeBlock('2026-07-11T00:00:00')], baseSettings, 0);
    expect(windows).toHaveLength(1);
    expect(windows[0].daylightPartial).toBeUndefined();
  });

  describe('daylight filtering with a sun schedule', () => {
    const sun = {
      sunrise: ['2026-07-11T08:00:00'],
      sunset: ['2026-07-11T20:00:00'],
    };

    it('drops a block run with zero daylight overlap', () => {
      // 00:00-06:00, entirely before the 08:00 sunrise.
      const windows = findLaunchWindows([makeBlock('2026-07-11T00:00:00')], baseSettings, 0, sun);
      expect(windows).toHaveLength(0);
    });

    it('keeps a partially-daylit block run and flags daylightPartial', () => {
      // 06:00-12:00: 4 of 6 hours are after sunrise.
      const windows = findLaunchWindows([makeBlock('2026-07-11T06:00:00')], baseSettings, 0, sun);
      expect(windows).toHaveLength(1);
      expect(windows[0].daylightPartial).toBe(true);
    });

    it('a fully-daylit block run carries no daylightPartial flag', () => {
      // 09:00-15:00, entirely inside 08:00-20:00.
      const windows = findLaunchWindows([makeBlock('2026-07-11T09:00:00')], baseSettings, 0, sun);
      expect(windows).toHaveLength(1);
      expect(windows[0].daylightPartial).toBeUndefined();
    });

    it('daylightOnly off keeps night blocks and never flags them', () => {
      const settings = { ...baseSettings, daylightOnly: false } as SafetySettings;
      const windows = findLaunchWindows([makeBlock('2026-07-11T00:00:00')], settings, 0, sun);
      expect(windows).toHaveLength(1);
      expect(windows[0].daylightPartial).toBeUndefined();
    });
  });
});
