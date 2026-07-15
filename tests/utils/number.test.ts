import { describe, it, expect } from 'vitest';
import { clampNumber, roundToDecimals } from '../../src/utils/number';

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
