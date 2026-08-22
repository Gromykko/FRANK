import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FORECAST_PAYLOAD_VERSION } from '../src/features/forecast/types';
import { PAYLOAD_VERSION } from '../worker/providers';
import { hourIndexForNow } from '../src/features/forecast/useForecast';
import { nextHourTideFor } from '../src/features/forecast/displayData';
import { findLaunchWindows } from '../src/features/planner/findLaunchWindows';
import { DEFAULT_SETTINGS } from '../src/features/safety/presets';
import type { SafetySettings } from '../src/features/safety/presets';
import type { HourlyData } from '../src/features/forecast/types';

// Contracts that span two files, or that no other test file naturally owns.
// Every one of these exists because the thing it pins actually broke.

// ---------------------------------------------------------------------------
// The Worker and browser import one dependency-free payload-version source.
// Keep the public Worker alias pinned so a future refactor cannot quietly
// replace it with another literal and recreate the old split-brain contract.
// ---------------------------------------------------------------------------
describe('payload version has one source of truth', () => {
  it('exposes the shared contract through the Worker alias and browser API', () => {
    expect(PAYLOAD_VERSION).toBe(FORECAST_PAYLOAD_VERSION);
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
  const row = (time: string, tideLevel: number, blockSpanHours?: number) =>
    ({ time, tideLevel, ...(blockSpanHours ? { blockSpanHours } : {}) }) as HourlyData;

  it('returns a true hourly neighbour', () => {
    expect(nextHourTideFor([
      row('2026-08-08T12:00:00Z', 0.1),
      row('2026-08-08T13:00:00Z', 0.2),
    ], 0)).toBe(0.2);
  });

  it('refuses a timestamp gap even when both rows are nominally hourly', () => {
    expect(nextHourTideFor([
      row('2026-08-08T10:00:00Z', 0.1),
      row('2026-08-08T13:00:00Z', 0.2),
    ], 0)).toBeUndefined();
  });

  it('refuses either side of a block: its tide is a centre sample hours away', () => {
    expect(nextHourTideFor([
      row('2026-08-08T12:00:00Z', 0.1),
      row('2026-08-08T13:00:00Z', 0.2, 6),
    ], 0)).toBeUndefined();
    expect(nextHourTideFor([
      row('2026-08-08T12:00:00Z', 0.1, 6),
      row('2026-08-08T18:00:00Z', 0.2),
    ], 0)).toBeUndefined();
  });

  it('returns undefined at the end of the series', () => {
    expect(nextHourTideFor([row('2026-08-08T12:00:00Z', 0.1)], 0)).toBeUndefined();
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
  const closingEndpoint = { ...block, time: '2026-08-08T12:00:00Z' };

  it('is refused when Daylight Only is on and no schedule was supplied', () => {
    const settings = { ...DEFAULT_SETTINGS, minDuration: 1, daylightOnly: true } as SafetySettings;
    expect(findLaunchWindows([block, closingEndpoint], settings, 0, undefined)).toEqual([]);
  });

  it('is offered when Daylight Only is off, where the schedule is not needed', () => {
    const settings = { ...DEFAULT_SETTINGS, minDuration: 1, daylightOnly: false } as SafetySettings;
    expect(findLaunchWindows([block, closingEndpoint], settings, 0, undefined)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// A disclosure heading may contain a button; a button may not contain a
// heading. The charts row also needs one equal pointer/keyboard target rather
// than a mouse-only wrapper plus a smaller nested control.
// ---------------------------------------------------------------------------
describe('Detailed Graphs disclosure semantics', () => {
  it('keeps one full-row native button directly inside the h2', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    const heading = app.match(/<h2 className="charts-disclosure-heading">([\s\S]*?)<\/h2>/)?.[1] ?? '';
    expect(heading).toMatch(/^\s*<button/);
    expect(heading).toContain('className={`panel-collapse-header module-head');
    expect(heading).toContain('aria-expanded={showDetailedCharts}');
    expect(heading).not.toContain('<h2');
  });
});

describe('Your Limits disclosure semantics', () => {
  it('does not place its h2 inside an inline span wrapper', () => {
    const panel = readFileSync(resolve(process.cwd(), 'src/components/SafetyLimitsPanel.tsx'), 'utf8');
    expect(panel).toContain('<div className="settings-copy">');
    expect(panel).not.toContain('<span className="settings-copy">');
  });
});

// ---------------------------------------------------------------------------
// A saved theme is applied by a blocking, same-origin head script before the
// React bundle. Because index.html depends on it even offline, the script must
// stay in the release descriptor and service worker's verified static shell.
// ---------------------------------------------------------------------------
describe('pre-paint theme shell contract', () => {
  it('tracks the external script without weakening script CSP', () => {
    const index = readFileSync(resolve(process.cwd(), 'index.html'), 'utf8');
    const serviceWorker = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
    const vite = readFileSync(resolve(process.cwd(), 'vite.config.ts'), 'utf8');

    expect(index).toContain('<script src="/theme-init.js"></script>');
    expect(serviceWorker).toContain("'theme-init.js',");
    expect(vite).toContain('`${APP_BASE}theme-init.js`,');
    expect(vite).toContain('"script-src \'self\'"');
    expect(vite).not.toContain('"script-src \'self\' \'unsafe-inline\'"');
  });
});

// ---------------------------------------------------------------------------
// The timeline and selected snapshot describe the same row. They therefore
// must consume one canonical daylight-aware analysis array rather than call
// the safety engine independently with different context.
// ---------------------------------------------------------------------------
describe('App safety-analysis consistency', () => {
  it('derives matrix statuses and the selected snapshot from allAnalyses', () => {
    const app = readFileSync(resolve(process.cwd(), 'src/App.tsx'), 'utf8');
    expect(app).toContain('const allAnalyses = useMemo');
    expect(app).toContain("{ blockDaylight: { mode: 'whole-period', sun: sunTimes } }");
    // The contract is that the matrix maps over allAnalyses, not that it does so
    // with one exact expression: statuses now pass through getSafetyDisplay so a
    // "limits are off" hour cannot paint green in the timeline while the header
    // calls it a caution. Pinning the literal made an honest fix look like a
    // regression, so pin the property instead.
    expect(app).toContain('allAnalyses.map(');
    expect(app).not.toMatch(/allStatuses[\s\S]{0,200}analyzeSafetyConditions\(/);
    expect(app).toContain('const safety = allAnalyses[selectedHourIndex] ?? allAnalyses[0]!;');
  });
});
