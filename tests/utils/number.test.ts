import { describe, it, expect } from 'vitest';
import { clampNumber, formatLevelCm, roundToDecimals, NO_READING_TEXT } from '../../src/utils/number';

// The Stepper in SafetyLimitsPanel.tsx composes these helpers with its inline
// min/max/step constants (wind 0-25 step 0.5, wave 0.1-3.0 step 0.05, gust
// margin 1-10 step 0.5, wave caution margin 0.05-2.0 step 0.05, water temp
// 5-20 step 1, temp band 1-10 step 1, sector limits 0-25 step 0.5, degrees
// 0-359). The constants themselves live inline in JSX, so the pure math is
// verified here with those values replicated.
describe('clampNumber', () => {
  it('clamps into [min, max]', () => {
    expect(clampNumber(30, 0, 25, 5)).toBe(25);
    expect(clampNumber(-1, 0, 25, 5)).toBe(0);
    expect(clampNumber(12.5, 0, 25, 5)).toBe(12.5);
  });

  it('returns the fallback for non-finite input', () => {
    expect(clampNumber(NaN, 0, 25, 5)).toBe(5);
    expect(clampNumber(Infinity, 0, 25, 5)).toBe(5);
    expect(clampNumber(-Infinity, 0, 25, 5)).toBe(5);
  });
});

describe('roundToDecimals', () => {
  it('kills floating-point drift at the given precision', () => {
    expect(roundToDecimals(0.30000000000000004, 2)).toBe(0.3);
    expect(roundToDecimals(0.146, 2)).toBe(0.15);
    expect(roundToDecimals(0.144, 2)).toBe(0.14);
    expect(roundToDecimals(7.4999, 1)).toBe(7.5);
    expect(roundToDecimals(12, 0)).toBe(12);
  });
});

describe('stepper snap math (as composed in SafetyLimitsPanel)', () => {
  // Replicates Stepper.nudge: snap onto the step grid, clamp, round.
  const nudge = (value: number, dir: 1 | -1, min: number, max: number, step: number, decimals: number) => {
    const snapped = Math.round((value + dir * step) / step) * step;
    return roundToDecimals(clampNumber(snapped, min, max, value), decimals);
  };

  it('repeated 0.05 wave steps never drift off the grid', () => {
    // Wave stepper: min 0.1, max 3.0, step 0.05, 2 decimals.
    let value = 0.1;
    for (let i = 0; i < 20; i++) value = nudge(value, 1, 0.1, 3.0, 0.05, 2);
    expect(value).toBe(1.1); // 0.1 + 20 * 0.05 exactly, no 1.1000000000000003
  });

  it('never steps outside the configured bounds', () => {
    // Wind stepper: min 0, max 25, step 0.5, 1 decimal.
    expect(nudge(25, 1, 0, 25, 0.5, 1)).toBe(25);
    expect(nudge(0, -1, 0, 25, 0.5, 1)).toBe(0);
    // Wave stepper lower bound.
    expect(nudge(0.1, -1, 0.1, 3.0, 0.05, 2)).toBe(0.1);
  });

  it('snaps off-grid values onto the step grid', () => {
    // A persisted 0.33 nudged up on a 0.05 grid lands on 0.4 (round(0.38/0.05)=8).
    expect(nudge(0.33, 1, 0.1, 3.0, 0.05, 2)).toBe(0.4);
  });
});

// Water level is displayed in centimetres everywhere (DMI publishes vandstand
// in whole cm relative to DVR90) while the model and the safety rules keep
// metres. This is the only place that conversion happens.
describe('formatLevelCm', () => {
  it('converts metres to whole signed centimetres', () => {
    expect(formatLevelCm(0.26)).toBe('+26');
    expect(formatLevelCm(-0.14)).toBe('-14');
    expect(formatLevelCm(1.05)).toBe('+105');
  });

  it('rounds after scaling, not before', () => {
    // 0.004 m is 0.4 cm. Rounding the metres first would have made it 0.00 m
    // and then 0 cm by a different route; rounding after scaling keeps the
    // sub-centimetre value honest as "+0" rather than inventing a whole cm.
    expect(formatLevelCm(0.004)).toBe('+0');
    expect(formatLevelCm(0.006)).toBe('+1');
  });

  it('never prints a negative zero', () => {
    // A tiny negative level used to render "-0.00"; a level of "-0" cm reads as
    // a fault rather than as mean water.
    expect(formatLevelCm(-0.001)).toBe('+0');
  });

  it('shows the no-reading dash rather than a fabricated 0', () => {
    expect(formatLevelCm(Number.NaN)).toBe(NO_READING_TEXT);
    expect(formatLevelCm(undefined)).toBe(NO_READING_TEXT);
  });
});
