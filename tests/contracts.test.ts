import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORECAST_PAYLOAD_VERSION } from '../src/features/forecast/types';
import { hourIndexForNow } from '../src/features/forecast/useForecast';
import { nextHourTideFor } from '../src/features/forecast/displayData';
import { findLaunchWindows } from '../src/features/planner/findLaunchWindows';
import { DEFAULT_SETTINGS } from '../src/features/safety/presets';
import type { SafetySettings } from '../src/features/safety/presets';
import type { HourlyData } from '../src/features/forecast/types';

// Contracts that span two files, or that no other test file naturally owns.
// Every one of these exists because the thing it pins actually broke.

// ---------------------------------------------------------------------------
// The Worker and the client each carry their own copy of the payload version,
// and they MUST stay equal: the stamp is what forces the Worker to rebuild a
// cache its own new code did not produce. Both were hand-bumped 5 -> 6 in one
// session with nothing coupling them, and bumping only the client sets
// workerOutdated for every user until someone notices and deploys the Worker.
// ---------------------------------------------------------------------------
describe('payload version stays coupled across the two files', () => {
  it('PAYLOAD_VERSION in the Worker equals FORECAST_PAYLOAD_VERSION in the client', () => {
    // cwd, not import.meta.url: under the jsdom environment import.meta.url is
    // an http: URL and readFileSync rejects it. Vitest runs from the repo root.
    const worker = readFileSync(resolve(process.cwd(), 'worker/index.js'), 'utf8');
    const match = worker.match(/^const PAYLOAD_VERSION = (\d+);/m);
    expect(match, 'could not find `const PAYLOAD_VERSION = N;` in worker/index.js').not.toBeNull();
    expect(Number(match![1])).toBe(FORECAST_PAYLOAD_VERSION);
  });
});

// ---------------------------------------------------------------------------
// Which row the whole app calls "now": the snapshot, the timeline's start
// column, and findLaunchWindows' startIndex all read it. It used to pick the
// nearest START, which rounds up from :30 onward — so for half of every hour
// the app described an hour that had not begun.
// ---------------------------------------------------------------------------
describe('hourIndexForNow', () => {
  const hour = (iso: string, blockSpanHours?: number) =>
    ({ time: iso, ...(blockSpanHours ? { blockSpanHours } : {}) }) as HourlyData;
  const rows = [
    hour('2026-08-08T12:00:00Z'),
    hour('2026-08-08T13:00:00Z'),
    hour('2026-08-08T14:00:00Z'),
  ];
  const at = (iso: string) => Date.parse(iso);

  it('picks the row containing the clock, not the nearest start', () => {
    expect(hourIndexForNow(rows, at('2026-08-08T13:05:00Z'))).toBe(1);
    // The regression: :55 is nearer 14:00, but 13:00 is the hour we are IN.
    expect(hourIndexForNow(rows, at('2026-08-08T13:55:00Z'))).toBe(1);
    expect(hourIndexForNow(rows, at('2026-08-08T14:00:00Z'))).toBe(2);
  });

  it('falls back to the nearest row when nothing contains the clock', () => {
    // Before the series starts, and after it has run out.
    expect(hourIndexForNow(rows, at('2026-08-08T09:00:00Z'))).toBe(0);
    expect(hourIndexForNow(rows, at('2026-08-09T09:00:00Z'))).toBe(2);
  });

  it('respects a block row spanning several hours', () => {
    const withBlock = [hour('2026-08-08T12:00:00Z'), hour('2026-08-08T13:00:00Z', 6)];
    // 17:00 is five hours past the block's start but still inside its span.
    expect(hourIndexForNow(withBlock, at('2026-08-08T17:00:00Z'))).toBe(1);
  });

  it('survives an empty series and an unparseable timestamp', () => {
    expect(hourIndexForNow([], at('2026-08-08T13:00:00Z'))).toBe(0);
    expect(hourIndexForNow([hour('not a date')], at('2026-08-08T13:00:00Z'))).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The single source of truth for the wind-against-water-level chop rule, read
// by the header verdict, the timeline's per-hour ratings, and the planner. The
// three used to disagree: only the planner refused to treat a 6-hour block's
// centre sample as "next hour", which can invert rising/falling.
// ---------------------------------------------------------------------------
describe('nextHourTideFor', () => {
  const row = (tideLevel: number, blockSpanHours?: number) =>
    ({ time: '2026-08-08T12:00:00Z', tideLevel, ...(blockSpanHours ? { blockSpanHours } : {}) }) as HourlyData;

  it('returns a true hourly neighbour', () => {
    expect(nextHourTideFor([row(0.1), row(0.2)], 0)).toBe(0.2);
  });

  it('refuses a block row: its tide is a centre sample hours away', () => {
    expect(nextHourTideFor([row(0.1), row(0.2, 6)], 0)).toBeUndefined();
  });

  it('returns undefined at the end of the series', () => {
    expect(nextHourTideFor([row(0.1)], 0)).toBeUndefined();
    expect(nextHourTideFor([], 0)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// With Daylight Only on, a block's daylight is unknowable without a sun
// schedule — so it must not be offered at all. Every other block test supplies
// `sun`, which left this guard uncovered despite its own comment recording that
// omitting it once meant a night block could be recommended.
// ---------------------------------------------------------------------------
describe('block windows with no sun schedule', () => {
  const block: HourlyData = {
    time: '2026-08-08T06:00:00Z',
    tempAir: 18, tempWater: 18, windSpeed: 2, windGust: 3, windDirection: 180,
    waveHeight: 0.1, wavePeriod: 3, waveDirection: 180, tideLevel: 0,
    precipitation: 0, symbolCode: 'clearsky_day', weatherCode: 0,
    currentSpeed: 0, currentDirection: 0, isDay: true,
    isLowConfidence: true, blockSpanHours: 6,
  } as HourlyData;

  it('is refused when Daylight Only is on and no schedule was supplied', () => {
    const settings = { ...DEFAULT_SETTINGS, minDuration: 1, daylightOnly: true } as SafetySettings;
    expect(findLaunchWindows([block], settings, 0, undefined)).toEqual([]);
  });

  it('is offered when Daylight Only is off, where the schedule is not needed', () => {
    const settings = { ...DEFAULT_SETTINGS, minDuration: 1, daylightOnly: false } as SafetySettings;
    expect(findLaunchWindows([block], settings, 0, undefined)).toHaveLength(1);
  });
});
