import { describe, it, expect } from 'vitest';
import { getPresetSettings, DEFAULT_SETTINGS } from '../../../src/features/safety/presets';
import type { SafetySettings } from '../../../src/features/safety/presets';
import { CURRENT_LOCATION } from '../../../src/config/locations';

const onshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'onshore')!;   // Horsens: safe 5.0, caution 8.0
const offshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'offshore')!; // Horsens: safe 4.5, caution 7.0 (fralandsvind capped lower)

describe('safety presets', () => {
  it('beginner has the exact documented numbers', () => {
    const s = getPresetSettings('beginner');
    expect(s.tripMode).toBe('beginner');
    expect(s.maxWindSpeedSafe).toBe(4.0);
    expect(s.maxWindSpeedCaution).toBe(6.0);
    expect(s.gustMargin).toBe(2.0);
    expect(s.maxWaveHeightSafe).toBe(0.2);
    expect(s.maxWaveHeightCaution).toBe(0.4);
    expect(s.waveCautionMargin).toBe(0.2);
    expect(s.minDuration).toBe(2);
    expect(s.minWaterTempSafe).toBe(15.0);
    expect(s.minWaterTempCaution).toBe(10.0);
    // Presets shift each sector's OWN caps by a per-exposure delta (beginner:
    // onshore −0.5, offshore −1.0), floored at 2.5 / safe+0.5 — preserving any
    // fjord's deliberate cap ordering rather than clamping to an absolute.
    expect(s.sectorLimits.onshore.safe).toBe(Math.max(onshore.safeLimit - 0.5, 2.5));
    expect(s.sectorLimits.onshore.caution).toBe(Math.max(onshore.cautionLimit - 0.5, s.sectorLimits.onshore.safe + 0.5));
    expect(s.sectorLimits.offshore.safe).toBe(Math.max(offshore.safeLimit - 1.0, 2.5));
    expect(s.sectorLimits.offshore.caution).toBe(Math.max(offshore.cautionLimit - 1.0, s.sectorLimits.offshore.safe + 0.5));
  });

  it('default has the exact documented numbers and mirrors DEFAULT_SETTINGS', () => {
    const s = getPresetSettings('default');
    expect(s.tripMode).toBe('default');
    expect(s.maxWindSpeedSafe).toBe(5.5);
    expect(s.maxWindSpeedCaution).toBe(8.0);
    expect(s.gustMargin).toBe(2.5);
    expect(s.maxWaveHeightSafe).toBe(0.3);
    expect(s.maxWaveHeightCaution).toBe(0.6);
    expect(s.waveCautionMargin).toBe(0.3);
    expect(s.minDuration).toBe(2);
    expect(s.minWaterTempSafe).toBe(15.0);
    expect(s.minWaterTempCaution).toBe(10.0);
    // Default sector caps come straight from the location config.
    expect(s.sectorLimits.onshore.safe).toBe(onshore.safeLimit);
    expect(s.sectorLimits.onshore.caution).toBe(onshore.cautionLimit);
    expect(s.sectorLimits.offshore.safe).toBe(offshore.safeLimit);
    expect(s.sectorLimits.offshore.caution).toBe(offshore.cautionLimit);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('pro has the exact documented numbers', () => {
    const s = getPresetSettings('pro');
    expect(s.tripMode).toBe('pro');
    expect(s.maxWindSpeedSafe).toBe(7.0);
    expect(s.maxWindSpeedCaution).toBe(10.0);
    expect(s.gustMargin).toBe(3.0);
    expect(s.maxWaveHeightSafe).toBe(0.5);
    expect(s.maxWaveHeightCaution).toBe(0.8);
    expect(s.waveCautionMargin).toBe(0.3);
    expect(s.minDuration).toBe(1);
    // Pro loosens both exposures by +1.0 on the sector's own caps.
    expect(s.sectorLimits.onshore.safe).toBe(onshore.safeLimit + 1.0);
    expect(s.sectorLimits.onshore.caution).toBe(Math.max(onshore.cautionLimit + 1.0, s.sectorLimits.onshore.safe + 0.5));
    expect(s.sectorLimits.offshore.safe).toBe(offshore.safeLimit + 1.0);
    expect(s.sectorLimits.offshore.caution).toBe(Math.max(offshore.cautionLimit + 1.0, s.sectorLimits.offshore.safe + 0.5));
  });

  it('custom starts from the base numbers with tripMode custom', () => {
    const s = getPresetSettings('custom');
    expect(s.tripMode).toBe('custom');
    expect({ ...s, tripMode: 'default' }).toEqual(DEFAULT_SETTINGS);
  });

  const modes: SafetySettings['tripMode'][] = ['beginner', 'default', 'pro', 'custom'];

  it.each(modes)('%s preset: every safe limit is strictly below its caution/danger pair', (mode) => {
    const s = getPresetSettings(mode);
    expect(s.maxWindSpeedSafe).toBeLessThan(s.maxWindSpeedCaution);
    expect(s.maxWaveHeightSafe).toBeLessThan(s.maxWaveHeightCaution);
    // Water temp is inverted: danger threshold below the safe threshold.
    expect(s.minWaterTempCaution).toBeLessThan(s.minWaterTempSafe);
    for (const cap of Object.values(s.sectorLimits)) {
      expect(cap.safe).toBeLessThan(cap.caution);
    }
    // Margins must be positive for the caution bands to exist.
    expect(s.gustMargin).toBeGreaterThan(0);
    expect(s.waveCautionMargin).toBeGreaterThan(0);
  });

  it('sector caps respect the location clamps (beginner never above location, pro at most +1.0)', () => {
    const beginner = getPresetSettings('beginner');
    expect(beginner.sectorLimits.onshore.safe).toBeLessThanOrEqual(onshore.safeLimit);
    expect(beginner.sectorLimits.onshore.caution).toBeLessThanOrEqual(onshore.cautionLimit);
    expect(beginner.sectorLimits.offshore.safe).toBeLessThanOrEqual(offshore.safeLimit);
    expect(beginner.sectorLimits.offshore.caution).toBeLessThanOrEqual(offshore.cautionLimit);

    const pro = getPresetSettings('pro');
    expect(pro.sectorLimits.onshore.safe).toBeLessThanOrEqual(onshore.safeLimit + 1.0);
    expect(pro.sectorLimits.onshore.caution).toBeLessThanOrEqual(onshore.cautionLimit + 1.0);
    expect(pro.sectorLimits.offshore.safe).toBeLessThanOrEqual(offshore.safeLimit + 1.0);
    expect(pro.sectorLimits.offshore.caution).toBeLessThanOrEqual(offshore.cautionLimit + 1.0);
  });

  it('presets order beginner <= default <= pro on every escalating limit', () => {
    const b = getPresetSettings('beginner');
    const d = getPresetSettings('default');
    const p = getPresetSettings('pro');

    const ascending: (keyof SafetySettings)[] = [
      'maxWindSpeedSafe', 'maxWindSpeedCaution',
      'maxWaveHeightSafe', 'maxWaveHeightCaution',
      'gustMargin',
    ];
    for (const key of ascending) {
      expect(b[key]).toBeLessThanOrEqual(d[key] as number);
      expect(d[key]).toBeLessThanOrEqual(p[key] as number);
    }
    for (const id of Object.keys(d.sectorLimits)) {
      expect(b.sectorLimits[id].safe).toBeLessThanOrEqual(d.sectorLimits[id].safe);
      expect(d.sectorLimits[id].safe).toBeLessThanOrEqual(p.sectorLimits[id].safe);
      expect(b.sectorLimits[id].caution).toBeLessThanOrEqual(d.sectorLimits[id].caution);
      expect(d.sectorLimits[id].caution).toBeLessThanOrEqual(p.sectorLimits[id].caution);
    }
    // Pro accepts shorter windows than beginner/default.
    expect(p.minDuration).toBeLessThanOrEqual(d.minDuration);
    expect(d.minDuration).toBeLessThanOrEqual(b.minDuration);
  });

  it('getPresetSettings returns a fresh copy each call', () => {
    const first = getPresetSettings('default');
    first.maxWindSpeedSafe = 99;
    first.sectorLimits.onshore.safe = 99;
    const second = getPresetSettings('default');
    expect(second.maxWindSpeedSafe).toBe(5.5);
    expect(second.sectorLimits.onshore.safe).toBe(onshore.safeLimit);
  });
});
