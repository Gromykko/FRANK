import { describe, it, expect } from 'vitest';
import {
  getPresetSettings,
  DEFAULT_SETTINGS,
  getWaveDangerAt,
  getWindDangerAt,
} from '../../../src/features/safety/presets';
import { hasActiveSafetyChecks } from '../../../src/features/safety/safetyDisplay';
import type { SafetySettings } from '../../../src/features/safety/presets';
import { CURRENT_LOCATION } from '../../../src/config/locations';

const onshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'onshore')!;
const offshore = CURRENT_LOCATION.windSectors.find((s) => s.id === 'offshore')!;

describe('safety presets', () => {
  it('beginner has the exact documented numbers', () => {
    const s = getPresetSettings('beginner');
    expect(s.tripMode).toBe('beginner');
    expect(s.windTakeCareAt).toBe(4.0);
    expect(getWindDangerAt(s)).toBe(5.0);
    expect(s.windDangerGap).toBe(1.0);
    expect(s.waveTakeCareAt).toBe(0.2);
    expect(getWaveDangerAt(s)).toBe(0.5);
    expect(s.waveDangerGap).toBe(0.3);
    expect(s.minDuration).toBe(2);
    expect(s.waterTempTakeCareBelow).toBe(15.0);
    expect(s.waterTempDangerBelow).toBe(10.0);
    // Presets shift each sector's OWN caps by a per-exposure delta (beginner:
    // onshore −0.5, offshore −1.0), floored at 2.5 / Take care+0.5 — preserving any
    // fjord's deliberate cap ordering rather than clamping to an absolute.
    expect(s.sectorLimits.onshore.takeCareAt).toBe(Math.max(onshore.takeCareAt - 0.5, 2.5));
    expect(s.sectorLimits.onshore.dangerAt).toBe(Math.max(onshore.dangerAt - 0.5, s.sectorLimits.onshore.takeCareAt + 0.5));
    expect(s.sectorLimits.offshore.takeCareAt).toBe(Math.max(offshore.takeCareAt - 1.0, 2.5));
    expect(s.sectorLimits.offshore.dangerAt).toBe(Math.max(offshore.dangerAt - 1.0, s.sectorLimits.offshore.takeCareAt + 0.5));
  });

  it('default has the exact documented numbers and mirrors DEFAULT_SETTINGS', () => {
    const s = getPresetSettings('default');
    expect(s.tripMode).toBe('default');
    expect(s.windTakeCareAt).toBe(6.0);
    expect(getWindDangerAt(s)).toBe(8.0);
    expect(s.windDangerGap).toBe(2.0);
    expect(s.waveTakeCareAt).toBe(0.3);
    expect(getWaveDangerAt(s)).toBe(1.0);
    expect(s.waveDangerGap).toBe(0.7);
    expect(s.minDuration).toBe(2);
    expect(s.waterTempTakeCareBelow).toBe(15.0);
    expect(s.waterTempDangerBelow).toBe(10.0);
    // Default sector caps come straight from the location config.
    expect(s.sectorLimits.onshore.takeCareAt).toBe(onshore.takeCareAt);
    expect(s.sectorLimits.onshore.dangerAt).toBe(onshore.dangerAt);
    expect(s.sectorLimits.offshore.takeCareAt).toBe(offshore.takeCareAt);
    expect(s.sectorLimits.offshore.dangerAt).toBe(offshore.dangerAt);
    expect(s).toEqual(DEFAULT_SETTINGS);
  });

  it('pro has the exact documented numbers', () => {
    const s = getPresetSettings('pro');
    expect(s.tripMode).toBe('pro');
    expect(s.windTakeCareAt).toBe(8.0);
    expect(getWindDangerAt(s)).toBe(10.0);
    expect(s.windDangerGap).toBe(2.0);
    expect(s.waveTakeCareAt).toBe(0.5);
    expect(getWaveDangerAt(s)).toBe(2.0);
    expect(s.waveDangerGap).toBe(1.5);
    expect(s.minDuration).toBe(1);
    // The visible Advanced profile loosens both exposures by +1.0 on each sector's own caps.
    expect(s.sectorLimits.onshore.takeCareAt).toBe(onshore.takeCareAt + 1.0);
    expect(s.sectorLimits.onshore.dangerAt).toBe(Math.max(onshore.dangerAt + 1.0, s.sectorLimits.onshore.takeCareAt + 0.5));
    expect(s.sectorLimits.offshore.takeCareAt).toBe(offshore.takeCareAt + 1.0);
    expect(s.sectorLimits.offshore.dangerAt).toBe(Math.max(offshore.dangerAt + 1.0, s.sectorLimits.offshore.takeCareAt + 0.5));
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
    // The values remain available so the settings panel can show exactly what
    // opting in would apply.
    expect(Object.keys(settings.sectorLimits)).toEqual(expect.arrayContaining(['onshore', 'offshore']));
  });

  it.each(modes)('%s preset: every Take care limit is strictly below its Danger pair', (mode) => {
    const s = getPresetSettings(mode);
    expect(s.windTakeCareAt).toBeLessThan(getWindDangerAt(s));
    expect(s.waveTakeCareAt).toBeLessThan(getWaveDangerAt(s));
    // Water temp is inverted: Danger is the colder threshold.
    expect(s.waterTempDangerBelow).toBeLessThan(s.waterTempTakeCareBelow);
    for (const cap of Object.values(s.sectorLimits)) {
      expect(cap.takeCareAt).toBeLessThan(cap.dangerAt);
    }
    // Margins must be positive for the caution bands to exist.
    expect(s.windDangerGap).toBeGreaterThan(0);
    expect(s.waveDangerGap).toBeGreaterThan(0);
  });

  it('sector caps respect the location clamps (beginner never above location, pro at most +1.0)', () => {
    const beginner = getPresetSettings('beginner');
    expect(beginner.sectorLimits.onshore.takeCareAt).toBeLessThanOrEqual(onshore.takeCareAt);
    expect(beginner.sectorLimits.onshore.dangerAt).toBeLessThanOrEqual(onshore.dangerAt);
    expect(beginner.sectorLimits.offshore.takeCareAt).toBeLessThanOrEqual(offshore.takeCareAt);
    expect(beginner.sectorLimits.offshore.dangerAt).toBeLessThanOrEqual(offshore.dangerAt);

    const pro = getPresetSettings('pro');
    expect(pro.sectorLimits.onshore.takeCareAt).toBeLessThanOrEqual(onshore.takeCareAt + 1.0);
    expect(pro.sectorLimits.onshore.dangerAt).toBeLessThanOrEqual(onshore.dangerAt + 1.0);
    expect(pro.sectorLimits.offshore.takeCareAt).toBeLessThanOrEqual(offshore.takeCareAt + 1.0);
    expect(pro.sectorLimits.offshore.dangerAt).toBeLessThanOrEqual(offshore.dangerAt + 1.0);
  });

  it('presets order beginner <= default <= pro on every escalating limit', () => {
    const b = getPresetSettings('beginner');
    const d = getPresetSettings('default');
    const p = getPresetSettings('pro');

    const ascending: (keyof SafetySettings)[] = [
      'windTakeCareAt',
      'waveTakeCareAt',
      'windDangerGap',
      'waveDangerGap',
    ];
    for (const key of ascending) {
      expect(b[key]).toBeLessThanOrEqual(d[key] as number);
      expect(d[key]).toBeLessThanOrEqual(p[key] as number);
    }
    expect(getWindDangerAt(b)).toBeLessThanOrEqual(getWindDangerAt(d));
    expect(getWindDangerAt(d)).toBeLessThanOrEqual(getWindDangerAt(p));
    expect(getWaveDangerAt(b)).toBeLessThanOrEqual(getWaveDangerAt(d));
    expect(getWaveDangerAt(d)).toBeLessThanOrEqual(getWaveDangerAt(p));
    for (const id of Object.keys(d.sectorLimits)) {
      expect(b.sectorLimits[id].takeCareAt).toBeLessThanOrEqual(d.sectorLimits[id].takeCareAt);
      expect(d.sectorLimits[id].takeCareAt).toBeLessThanOrEqual(p.sectorLimits[id].takeCareAt);
      expect(b.sectorLimits[id].dangerAt).toBeLessThanOrEqual(d.sectorLimits[id].dangerAt);
      expect(d.sectorLimits[id].dangerAt).toBeLessThanOrEqual(p.sectorLimits[id].dangerAt);
    }
    // The visible Advanced profile accepts shorter windows than Beginner/Intermediate.
    expect(p.minDuration).toBeLessThanOrEqual(d.minDuration);
    expect(d.minDuration).toBeLessThanOrEqual(b.minDuration);
  });

  it('getPresetSettings returns a fresh copy each call', () => {
    const first = getPresetSettings('default');
    first.windTakeCareAt = 99;
    first.sectorLimits.onshore.takeCareAt = 99;
    const second = getPresetSettings('default');
    expect(second.windTakeCareAt).toBe(6.0);
    expect(second.sectorLimits.onshore.takeCareAt).toBe(onshore.takeCareAt);
  });
  // The whole point of the mode is that nothing is judged. If a new enable*
  // flag is ever added and not defaulted off here, this mode would silently
  // keep giving a verdict while claiming to be weather-only - so assert the
  // property, not the individual flags.
  it('weather-only leaves no safety check active', () => {
    const s = getPresetSettings('weather');
    expect(s.tripMode).toBe('weather');
    expect(hasActiveSafetyChecks(s)).toBe(false);
    // daylightOnly counts as a check: leaving it on would keep a verdict on
    // screen and make the mode a no-op.
    expect(s.daylightOnly).toBe(false);
  });

  it('weather-only keeps the thresholds intact for the mode you switch back to', () => {
    const s = getPresetSettings('weather');
    expect(s.windTakeCareAt).toBe(DEFAULT_SETTINGS.windTakeCareAt);
    expect(s.waveTakeCareAt).toBe(DEFAULT_SETTINGS.waveTakeCareAt);
    expect(hasActiveSafetyChecks(getPresetSettings('default'))).toBe(true);
  });
});
