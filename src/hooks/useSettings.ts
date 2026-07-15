import { useCallback, useEffect, useState, useRef } from 'react';
import {
  DEFAULT_SETTINGS,
  getPresetSettings,
  LEGACY_SETTINGS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  CUSTOM_SETTINGS_STORAGE_KEY,
  LEGACY_CUSTOM_SETTINGS_STORAGE_KEY,
} from '../features/safety/presets';
import type { SafetySettings } from '../features/safety/presets';
import { floorCaution } from '../features/safety/presets';
import { CURRENT_LOCATION } from '../config/locations';
import type { ForecastLocation } from '../config/locations';
import { readStorage } from '../utils/storage';

export type { SafetySettings } from '../features/safety/presets';

// Settings saved under the old fixed easterly/westerly model carried 8 flat
// fields; the new model keys caps by sector id. Map easterly*→the onshore
// sector, westerly*→the offshore sector, preserving each user's exact caps (and
// any edited angle, so their verdict never changes). Runs once; new-shape
// settings (already carrying sectorLimits) pass through untouched.
export function migrateLegacySectors(raw: Record<string, unknown>, location: ForecastLocation): Record<string, unknown> {
  if (raw.sectorLimits) return raw;
  if (raw.easterlyLimit === undefined && raw.westerlyLimit === undefined) return raw;

  const onshore = location.windSectors.find((s) => s.exposure === 'onshore') ?? location.windSectors[0];
  const offshore = location.windSectors.find((s) => s.exposure === 'offshore') ?? location.windSectors[1];
  const sectorLimits: Record<string, { safe: number; caution: number }> = {};
  const sectorAngles: Record<string, { min: number; max: number }> = {};

  const carry = (
    sector: ForecastLocation['windSectors'][number] | undefined,
    min: unknown, max: unknown, safe: unknown, caution: unknown
  ) => {
    if (!sector) return;
    if (typeof safe === 'number') {
      const cautionVal = typeof caution === 'number' ? caution : sector.cautionLimit;
      sectorLimits[sector.id] = { safe, caution: floorCaution(safe, cautionVal) };
    }
    // Only record an angle override if the user had actually moved it off the
    // location default — unedited users use pure location geometry.
    if (typeof min === 'number' && typeof max === 'number' && (min !== sector.min || max !== sector.max)) {
      sectorAngles[sector.id] = { min, max };
    }
  };
  carry(onshore, raw.easterlyMin, raw.easterlyMax, raw.easterlyLimit, raw.easterlyCautionLimit);
  carry(offshore, raw.westerlyMin, raw.westerlyMax, raw.westerlyLimit, raw.westerlyCautionLimit);

  const rest = { ...raw };
  for (const key of [
    'easterlyMin', 'easterlyMax', 'easterlyLimit', 'easterlyCautionLimit',
    'westerlyMin', 'westerlyMax', 'westerlyLimit', 'westerlyCautionLimit',
  ]) {
    delete rest[key];
  }
  return {
    ...rest,
    ...(Object.keys(sectorLimits).length ? { sectorLimits } : {}),
    ...(Object.keys(sectorAngles).length ? { sectorAngles } : {}),
  };
}

// A stored profile can hold a sector caution cap below its safe cap (the
// invariant is only enforced while editing); heal on load so the assessment
// never runs with inverted bands.
export function healSectorCautions(s: SafetySettings): SafetySettings {
  if (!s.sectorLimits) return s;
  const sectorLimits: SafetySettings['sectorLimits'] = {};
  for (const [id, cap] of Object.entries(s.sectorLimits)) {
    sectorLimits[id] = { safe: cap.safe, caution: floorCaution(cap.safe, cap.caution) };
  }
  return { ...s, sectorLimits };
}

// Heal every inverted band. An inverted band flips the verdict — e.g. a wave
// "danger" cap below the safe cap makes the caution branch unreachable and
// reports danger for calm water. Wind uses the shared floorCaution gap; waves
// only need caution ≥ safe (the 0.5 m/s wind gap is wrong at wave scale);
// water temp is INVERTED — its danger threshold is the COLDER one, so
// caution ≤ safe. Runs at EVERY entry point (stored-profile parse AND
// saveSettings), so no editor — current or future — can ship an inverted band
// into the assessment.
export function healSettings(s: SafetySettings): SafetySettings {
  const healed = healSectorCautions(s);
  return {
    ...healed,
    maxWindSpeedCaution: floorCaution(healed.maxWindSpeedSafe, healed.maxWindSpeedCaution),
    maxWaveHeightCaution: Math.max(healed.maxWaveHeightSafe, healed.maxWaveHeightCaution),
    minWaterTempCaution: Math.min(healed.minWaterTempSafe, healed.minWaterTempCaution),
  };
}

// Parse a stored blob, migrate legacy sector fields, merge over defaults, heal.
export function parseStoredSettings(json: string): SafetySettings {
  const raw = migrateLegacySectors(JSON.parse(json) as Record<string, unknown>, CURRENT_LOCATION);
  return healSettings({ ...DEFAULT_SETTINGS, ...raw } as SafetySettings);
}

export function useSettings() {
  const customProfileRef = useRef<SafetySettings | null>(null);

  const [settings, setSettings] = useState<SafetySettings>(() => {
    const savedCustom = readStorage(CUSTOM_SETTINGS_STORAGE_KEY) ?? readStorage(LEGACY_CUSTOM_SETTINGS_STORAGE_KEY);
    if (savedCustom) {
      try {
        customProfileRef.current = { ...parseStoredSettings(savedCustom), tripMode: 'custom' };
      } catch {}
    }
    if (!customProfileRef.current) {
      customProfileRef.current = getPresetSettings('custom');
    }

    const saved = readStorage(SETTINGS_STORAGE_KEY) ?? readStorage(LEGACY_SETTINGS_STORAGE_KEY);
    if (saved) {
      try {
        const parsed = parseStoredSettings(saved);
        return parsed.tripMode === 'custom' ? parsed : getPresetSettings(parsed.tripMode);
      } catch {
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
        if (settings.tripMode === 'custom') {
          localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
        }
      } catch {
        // Ignore storage failures so slider interaction stays responsive.
      }
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [settings]);

  const saveSettings = useCallback((newSettings: SafetySettings) => {
    // Heal on the way in (idempotent for the editors, which already maintain
    // the invariants) so an inverted band can never reach the assessment.
    const healed = healSettings(newSettings);
    setSettings(healed);
    if (healed.tripMode === 'custom') {
      customProfileRef.current = healed;
    }
  }, []);

  const setTripMode = useCallback((mode: SafetySettings['tripMode']) => {
    if (mode === 'custom') {
      setSettings(customProfileRef.current ?? getPresetSettings('custom'));
    } else {
      // Leaving custom cancels the debounced write, so flush the profile now
      // or an edit made within the last 250ms never reaches storage
      if (customProfileRef.current) {
        try {
          localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, JSON.stringify(customProfileRef.current));
        } catch {}
      }
      setSettings(getPresetSettings(mode));
    }
  }, []);

  return { settings, saveSettings, setTripMode };
}
