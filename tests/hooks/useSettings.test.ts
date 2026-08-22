import { describe, it, expect } from 'vitest';
import {
  decodeStoredSettings,
  healSectorCautions,
  parseStoredSettings,
  serializeStoredSettings,
  SETTINGS_STORAGE_METADATA_KEY,
  SETTINGS_STORAGE_SCHEMA_VERSION,
} from '../../src/hooks/useSettings';
import { analyzeSafetyConditions } from '../../src/features/safety/analyzeSafetyConditions';
import { DEFAULT_SETTINGS } from '../../src/features/safety/presets';
import type { SafetySettings } from '../../src/features/safety/presets';
import { CURRENT_LOCATION } from '../../src/config/locations';
import type { HourlyData } from '../../src/features/forecast/types';

function currentRecord(overrides: Record<string, unknown> = {}): string {
  const stored = JSON.parse(serializeStoredSettings(DEFAULT_SETTINGS)) as Record<string, unknown>;
  return JSON.stringify({ ...stored, ...overrides });
}

const baseData: HourlyData = {
  time: '2026-07-08T12:00:00Z', tempAir: 20, tempWater: 18, windSpeed: 3, windGust: 4,
  windDirection: 180, waveHeight: 0.1, wavePeriod: 3, waveDirection: 180, tideLevel: 0,
  precipitation: 0, symbolCode: 'clearsky_day', weatherCode: 0, currentSpeed: 0, currentDirection: 0, isDay: true,
};

describe('healSectorCautions', () => {
  it('lifts an inverted caution cap to safe + 0.5', () => {
    const s = { ...DEFAULT_SETTINGS, sectorLimits: { onshore: { safe: 6, caution: 5 } } } as SafetySettings;
    expect(healSectorCautions(s).sectorLimits.onshore).toEqual({ safe: 6, caution: 6.5 });
  });
});

describe('parseStoredSettings', () => {
  it('heals an inverted general-wind band on load', () => {
    const parsed = parseStoredSettings(currentRecord({
      tripMode: 'custom',
      maxWindSpeedSafe: 8,
      maxWindSpeedCaution: 6,
    }));
    expect(parsed.maxWindSpeedCaution).toBeGreaterThanOrEqual(parsed.maxWindSpeedSafe + 0.5);
  });
});

describe('versioned settings storage', () => {
  it('round-trips current records without changing valid or additive fields', () => {
    const raw = {
      ...DEFAULT_SETTINGS,
      tripMode: 'custom' as const,
      maxWindSpeedSafe: 4.2,
      gustMargin: 1.8,
      tidePreference: 'incoming' as const,
      futureCompatibleField: { retain: true },
    };

    const storedJson = serializeStoredSettings(raw);
    const decoded = decodeStoredSettings(storedJson);
    expect(decoded.settings).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.2,
      maxWindSpeedCaution: 6,
      gustMargin: 1.8,
      tidePreference: 'incoming',
      futureCompatibleField: { retain: true },
    });

    const storedRecord = JSON.parse(storedJson) as Record<string, unknown>;
    expect(storedRecord.maxWindSpeedSafe).toBe(4.2);
    expect(storedRecord.gustMargin).toBe(1.8);
    expect(storedRecord.tidePreference).toBe('incoming');
    expect(storedRecord.futureCompatibleField).toEqual({ retain: true });
    expect(storedRecord[SETTINGS_STORAGE_METADATA_KEY]).toEqual({
      kind: 'frank-safety-settings',
      schemaVersion: SETTINGS_STORAGE_SCHEMA_VERSION,
      locationId: CURRENT_LOCATION.id,
    });

    const reread = decodeStoredSettings(serializeStoredSettings(decoded.settings));
    expect(reread.settings).toEqual(decoded.settings);
  });

  it('keeps settings and metadata in one shallow additive record', () => {
    const stored = JSON.parse(serializeStoredSettings({
      ...DEFAULT_SETTINGS,
      tripMode: 'custom',
      maxWindSpeedSafe: 3.7,
    })) as Record<string, unknown>;

    expect(stored.tripMode).toBe('custom');
    expect(stored.maxWindSpeedSafe).toBe(3.7);
    expect(stored).not.toHaveProperty('settings');
  });

  it('rejects a missing or future schema and a record belonging to another location', () => {
    const stored = JSON.parse(serializeStoredSettings(DEFAULT_SETTINGS)) as Record<string, unknown>;
    const metadata = stored[SETTINGS_STORAGE_METADATA_KEY] as Record<string, unknown>;

    expect(() => decodeStoredSettings(JSON.stringify(DEFAULT_SETTINGS))).toThrow(/Unsupported or misplaced/);

    expect(() => decodeStoredSettings(JSON.stringify({
      ...stored,
      [SETTINGS_STORAGE_METADATA_KEY]: { ...metadata, schemaVersion: 2 },
    }))).toThrow(/Unsupported or misplaced/);

    expect(() => decodeStoredSettings(JSON.stringify({
      ...stored,
      [SETTINGS_STORAGE_METADATA_KEY]: { ...metadata, locationId: 'another-fjord' },
    }))).toThrow(/Unsupported or misplaced/);
  });

  it('rejects non-object records without weakening per-field healing', () => {
    expect(() => decodeStoredSettings('null')).toThrow(/JSON object/);
    expect(() => decodeStoredSettings('[]')).toThrow(/JSON object/);

    const decoded = decodeStoredSettings(currentRecord({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.4,
      minDuration: 'broken',
      daylightOnly: false,
    }));
    expect(decoded.settings.maxWindSpeedSafe).toBe(4.4);
    expect(decoded.settings.minDuration).toBe(DEFAULT_SETTINGS.minDuration);
    expect(decoded.settings.daylightOnly).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A stored profile is untrusted input: it outlives app versions, can be
// hand-edited, and `{...DEFAULT_SETTINGS, ...JSON.parse(blob)}` will happily
// overwrite a number with anything. Each case below silently DISABLED a safety
// check before it was guarded.
// ---------------------------------------------------------------------------
describe('parseStoredSettings hardening', () => {
  const parse = (o: Record<string, unknown>) => parseStoredSettings(currentRecord({ tripMode: 'custom', ...o }));

  it('clamps an absurd-but-finite threshold instead of accepting it', () => {
    // 999 is finite, so the type guard passed it. `windSpeed >= 999` is then
    // permanently false: the check reads as ON, nothing warns, and FRANK
    // reports "Good to go" in a gale.
    const parsed = parse({ maxWindSpeedSafe: 999 });
    expect(parsed.maxWindSpeedSafe).toBeLessThanOrEqual(25);
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 30 }, parsed).rating).toBe('danger');
  });

  // The mirror image of the 999 case above, and the one that was still open:
  // a threshold clamped DOWN far enough stops checking too. Water temp was the
  // only limit whose validated floor reached a value that can never fire, so a
  // stale or hand-edited profile switched off cold shock - the deadliest hazard
  // on this coast - while the toggle still read as on and no "limits are off"
  // disclosure appeared.
  it('clamps a water-temp floor that would disable the cold-shock check', () => {
    const parsed = parse({ minWaterTempCaution: 0, minWaterTempSafe: 0 });
    expect(parsed.minWaterTempCaution).toBeGreaterThanOrEqual(5);
    expect(parsed.enableWaterTemp).toBe(true);
    expect(
      analyzeSafetyConditions({ ...baseData, tempWater: 3.2 }, parsed).rating,
    ).not.toBe('safe');
  });

  it('derives the wind danger cap from safe + gustMargin so the panel cannot promise a threshold the engine ignores', () => {
    // The settings panel and the manual both state one rule: danger = safe
    // limit + your margin. Storing the danger cap independently let a profile
    // display "8.0" while the engine still waited for 12.
    const parsed = parse({ maxWindSpeedSafe: 5.5, gustMargin: 2.5, maxWindSpeedCaution: 12 });
    expect(parsed.maxWindSpeedCaution).toBe(8);
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 10 }, parsed).rating).toBe('danger');
  });

  it('derives the wave danger cap the same way', () => {
    const parsed = parse({ maxWaveHeightSafe: 0.3, waveCautionMargin: 0.3, maxWaveHeightCaution: 2.5 });
    expect(parsed.maxWaveHeightCaution).toBeCloseTo(0.6, 10);
  });

  it('restores a boolean toggle stored as a falsy non-boolean', () => {
    // `settings.enableWindSpeed ?? true` only rescues null/undefined, so a
    // stored 0 turned the wind check off — while the other toggles stayed on,
    // so the "limits are off" notice never appeared either.
    const parsed = parse({ enableWindSpeed: 0 });
    expect(parsed.enableWindSpeed).toBe(true);
    expect(analyzeSafetyConditions({ ...baseData, windSpeed: 30 }, parsed).rating).toBe('danger');
  });

  it('restores unknown enum strings instead of passing them into preset/planner branching', () => {
    const parsed = parse({ tripMode: 'expert', tidePreference: 'surging' });
    expect(parsed.tripMode).toBe(DEFAULT_SETTINGS.tripMode);
    expect(parsed.tidePreference).toBe(DEFAULT_SETTINGS.tidePreference);
  });

  it('clamps sector caps to the range both UI steppers can represent', () => {
    const parsed = parse({
      sectorLimits: {
        onshore: { safe: 25, caution: 25.5 },
        offshore: { safe: -4, caution: 999 },
      },
    });

    expect(parsed.sectorLimits.onshore).toEqual({ safe: 24.5, caution: 25 });
    expect(parsed.sectorLimits.offshore).toEqual({ safe: 0, caution: 25 });
  });

});
