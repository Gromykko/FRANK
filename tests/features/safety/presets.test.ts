import { describe, it, expect } from 'vitest';
import {
  GUST_FACTOR,
  NEAR_LIMIT_RATIO,
  getPresetSettings,
  getNearLimitThreshold,
  DEFAULT_SETTINGS,
} from '../../../src/features/safety/presets';
import { hasActiveSafetyChecks } from '../../../src/features/safety/safetyDisplay';
import type { SafetySettings } from '../../../src/features/safety/presets';
import { CURRENT_LOCATION } from '../../../src/config/locations';

const onshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'onshore')!;
const offshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'offshore')!;

describe('safety presets', () => {
  it('derives the automatic caution boundary at 80% and rounds to displayed precision', () => {
    expect(NEAR_LIMIT_RATIO).toBe(0.8);
    expect(getNearLimitThreshold(8, 1)).toBe(6.4);
    // The Intermediate gust maximum is 12.8; 80% is 10.24 and the verdict
    // compares it at the same one-decimal precision shown to the user.
    expect(getNearLimitThreshold(12.8, 1)).toBe(10.2);
    expect(getNearLimitThreshold(0.333, 2)).toBe(0.27);
  });

  it('beginner has the exact documented maximums', () => {
    const s = getPresetSettings('beginner');
    expect(s.tripMode).toBe('beginner');
    expect(s.windLimit).toBe(5.0);
    expect(s.waveLimit).toBe(0.5);
    expect(s.minDuration).toBe(2);
    expect(s.waterTempTakeCareBelow).toBe(15.0);
    expect(s.waterTempDangerBelow).toBe(10.0);
    expect(s.sectorLimits.onshore.maximumAt).toBe(onshore.maximumAt - 0.5);
    expect(s.sectorLimits.offshore.maximumAt).toBe(offshore.maximumAt - 1.0);
  });

  it('default has the exact documented maximums and mirrors DEFAULT_SETTINGS', () => {
    const s = getPresetSettings('default');
    expect(s.tripMode).toBe('default');
    expect(s.windLimit).toBe(8.0);
    expect(s.waveLimit).toBe(1.0);
    expect(s.minDuration).toBe(2);
    expect(s.waterTempTakeCareBelow).toBe(15.0);
    expect(s.waterTempDangerBelow).toBe(10.0);
    expect(s.sectorLimits.onshore.maximumAt).toBe(onshore.maximumAt);
    expect(s.sectorLimits.offshore.maximumAt).toBe(offshore.maximumAt);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('pro has the exact documented maximums', () => {
    const s = getPresetSettings('pro');
    expect(s.tripMode).toBe('pro');
    expect(s.windLimit).toBe(10.0);
    expect(s.waveLimit).toBe(2.0);
    expect(s.minDuration).toBe(1);
    expect(s.sectorLimits.onshore.maximumAt).toBe(onshore.maximumAt + 1.0);
    expect(s.sectorLimits.offshore.maximumAt).toBe(offshore.maximumAt + 1.0);
  });

  it('custom starts from the base numbers with tripMode custom', () => {
    const s = getPresetSettings('custom');
    expect(s.tripMode).toBe('custom');
    expect({ ...s, tripMode: 'default' }).toEqual(DEFAULT_SETTINGS);
  });

  const modes: SafetySettings['tripMode'][] = ['beginner', 'default', 'pro', 'custom'];

  it.each(modes)('%s preset leaves the optional wind-sector rule off', (mode) => {
    const settings = getPresetSettings(mode);
    expect(settings.enableCustomWindDirs).toBe(false);
    expect(Object.keys(settings.sectorLimits)).toEqual(expect.arrayContaining(['onshore', 'offshore']));
  });

  it.each(modes)('%s preset has valid single maximums', (mode) => {
    const s = getPresetSettings(mode);
    expect(s.windLimit).toBeGreaterThan(0);
    expect(s.waveLimit).toBeGreaterThan(0);
    expect(s.waterTempDangerBelow).toBeLessThan(s.waterTempTakeCareBelow);
    for (const cap of Object.values(s.sectorLimits)) {
      expect(cap.maximumAt).toBeGreaterThan(0);
    }
  });

  it.each([
    ['beginner', 4.0, 8.0, 6.4, 0.40],
    ['default', 6.4, 12.8, 10.2, 0.80],
    ['pro', 8.0, 16.0, 12.8, 1.60],
  ] as const)(
    '%s derives its caution boundaries without storing second thresholds',
    (mode, windCautionAt, gustMaximum, gustCautionAt, waveCautionAt) => {
      const settings = getPresetSettings(mode);

      expect(getNearLimitThreshold(settings.windLimit, 1)).toBe(windCautionAt);
      expect(settings.windLimit * GUST_FACTOR).toBe(gustMaximum);
      expect(getNearLimitThreshold(gustMaximum, 1)).toBe(gustCautionAt);
      expect(getNearLimitThreshold(settings.waveLimit, 2)).toBe(waveCautionAt);
      expect(settings).not.toHaveProperty('windTakeCareAt');
      expect(settings).not.toHaveProperty('waveTakeCareAt');
    },
  );

  it('presets order beginner <= default <= pro on every escalating maximum', () => {
    const b = getPresetSettings('beginner');
    const d = getPresetSettings('default');
    const p = getPresetSettings('pro');

    expect(b.windLimit).toBeLessThanOrEqual(d.windLimit);
    expect(d.windLimit).toBeLessThanOrEqual(p.windLimit);
    expect(b.waveLimit).toBeLessThanOrEqual(d.waveLimit);
    expect(d.waveLimit).toBeLessThanOrEqual(p.waveLimit);
    for (const id of Object.keys(d.sectorLimits)) {
      expect(b.sectorLimits[id].maximumAt).toBeLessThanOrEqual(d.sectorLimits[id].maximumAt);
      expect(d.sectorLimits[id].maximumAt).toBeLessThanOrEqual(p.sectorLimits[id].maximumAt);
    }
    expect(p.minDuration).toBeLessThanOrEqual(d.minDuration);
    expect(d.minDuration).toBeLessThanOrEqual(b.minDuration);
  });

  it('getPresetSettings returns a fresh copy each call', () => {
    const first = getPresetSettings('default');
    first.windLimit = 99;
    first.sectorLimits.onshore.maximumAt = 99;
    const second = getPresetSettings('default');
    expect(second.windLimit).toBe(8.0);
    expect(second.sectorLimits.onshore.maximumAt).toBe(onshore.maximumAt);
  });

  it('weather-only leaves no safety check active', () => {
    const s = getPresetSettings('weather');
    expect(s.tripMode).toBe('weather');
    expect(hasActiveSafetyChecks(s)).toBe(false);
    expect(s.daylightOnly).toBe(false);
  });

  it('weather-only keeps the maximums intact for the mode you switch back to', () => {
    const s = getPresetSettings('weather');
    expect(s.windLimit).toBe(DEFAULT_SETTINGS.windLimit);
    expect(s.waveLimit).toBe(DEFAULT_SETTINGS.waveLimit);
    expect(hasActiveSafetyChecks(getPresetSettings('default'))).toBe(true);
  });
});
