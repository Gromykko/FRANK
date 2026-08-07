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
import { floorCaution, MIN_CAUTION_GAP } from '../features/safety/presets';
import { CURRENT_LOCATION, DEFAULT_LOCATION_ID } from '../config/locations';
import type { ForecastLocation } from '../config/locations';
import { readStorage } from '../utils/storage';
import { clampNumber, roundToDecimals } from '../utils/number';

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

// Every numeric threshold, and the rounding they are stored at. A stored
// profile is untrusted input: it survives app versions, can be hand-edited, and
// `{...DEFAULT_SETTINGS, ...parsedJson}` will happily overwrite a number with a
// string. A non-numeric cap poisons every comparison against it (`x >= "high"`
// and `x >= NaN` are both false), which silently DISABLES that safety check and
// reports "Good to go" — so each one falls back to its default instead.
// Rounding here also kills the 0.1 + 0.2 = 0.30000000000000004 artifact that
// derived caps otherwise carry into the reason text and back into storage.
//
// `min`/`max` mirror the bounds the Stepper controls already enforce. Type
// alone was not enough: any FINITE number used to pass, so a stored
// `maxWindSpeedSafe: 999` (a stale profile, a hand-edit, a future writer that
// skips the Stepper) made `windSpeed >= 999` permanently false. The check reads
// as enabled, `activeSafetyChecks` sees nothing switched off, and FRANK reports
// "Good to go" in a gale. Clamping closes the door the NaN guard left open.
const NUMERIC_LIMITS: { key: keyof SafetySettings; decimals: number; min: number; max: number }[] = [
  { key: 'maxWindSpeedSafe', decimals: 1, min: 0.5, max: 25 },
  { key: 'maxWindSpeedCaution', decimals: 1, min: 0, max: 35 },
  { key: 'minWaterTempSafe', decimals: 1, min: 0, max: 25 },
  { key: 'minWaterTempCaution', decimals: 1, min: 0, max: 25 },
  { key: 'maxWaveHeightSafe', decimals: 2, min: 0.1, max: 3.0 },
  { key: 'maxWaveHeightCaution', decimals: 2, min: 0.1, max: 5.0 },
  { key: 'gustMargin', decimals: 1, min: 1, max: 10 },
  { key: 'waveCautionMargin', decimals: 2, min: 0.05, max: 2.0 },
  { key: 'minDuration', decimals: 0, min: 1, max: 12 },
];

// Every boolean toggle, for the same reason as the numbers above. `??` in the
// engine only rescues null/undefined, so a stored `0` or `""` reads as "check
// disabled" — and with the other toggles still on, `activeSafetyChecks` never
// shows the "limits are off" escape hatch. Only the falsy direction is
// dangerous, and it was the one direction nothing guarded.
const BOOLEAN_FLAGS = [
  'enableWindSpeed', 'enableWindGust', 'enableWaveHeight', 'enableWaveCaution',
  'enableWaterTemp', 'enableCustomWindDirs', 'daylightOnly',
] as const;

function coerceNumericLimits(s: SafetySettings): SafetySettings {
  const out = { ...s };
  for (const { key, decimals, min, max } of NUMERIC_LIMITS) {
    // clampNumber already returns the fallback for non-finite input.
    (out[key] as number) = roundToDecimals(
      clampNumber(out[key] as number, min, max, DEFAULT_SETTINGS[key] as number),
      decimals
    );
  }
  for (const flag of BOOLEAN_FLAGS) {
    if (typeof out[flag] !== 'boolean') (out[flag] as boolean) = DEFAULT_SETTINGS[flag];
  }
  // Angles are the one field `??` in resolveSectors can't defend: a string
  // survives it and `"abc" >= 90` is false, so the sector silently never
  // matches and its stricter directional cap vanishes. Drop anything that
  // isn't a real bearing so the curated geometry is used instead.
  if (out.sectorAngles) {
    const sectorAngles: NonNullable<SafetySettings['sectorAngles']> = {};
    for (const [id, angle] of Object.entries(out.sectorAngles)) {
      const inRange = (v: unknown) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v < 360;
      if (inRange(angle?.min) && inRange(angle?.max)) sectorAngles[id] = { min: angle.min, max: angle.max };
    }
    out.sectorAngles = sectorAngles;
  }
  // Sector caps come from the same untrusted blob and feed the same comparisons.
  const sectorLimits: SafetySettings['sectorLimits'] = {};
  const inCapRange = (value: unknown, max: number) =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= max;
  for (const [id, cap] of Object.entries(out.sectorLimits ?? {})) {
    // A sector whose caps are unusable is DROPPED rather than clamped, so
    // resolveSectors falls back to this location's curated values — the right
    // fallback here is the fjord's own cap, not one global default.
    //
    // Range, not just type: these were the last thresholds exempt from the
    // bounds check, so a stored `{ safe: 999, caution: 999 }` was accepted and
    // silently switched that direction's cap off while the UI still showed it.
    if (!inCapRange(cap?.safe, 25) || !inCapRange(cap?.caution, 25 + MIN_CAUTION_GAP)) continue;
    sectorLimits[id] = { safe: roundToDecimals(cap.safe, 1), caution: roundToDecimals(cap.caution, 1) };
  }
  out.sectorLimits = sectorLimits;
  return out;
}

// Heal every inverted band. An inverted band flips the verdict — e.g. a wave
// "danger" cap below the safe cap makes the caution branch unreachable and
// reports danger for calm water. Wind uses the shared floorCaution gap; waves
// only need caution ≥ safe (the 0.5 m/s wind gap is wrong at wave scale);
// water temp is INVERTED — its danger threshold is the COLDER one, so
// caution ≤ safe. Runs at EVERY entry point (stored-profile parse AND
// saveSettings), so no editor — current or future — can ship an inverted band
// into the assessment. Type coercion runs first, so the healing below can
// assume it is comparing real numbers.
export function healSettings(s: SafetySettings): SafetySettings {
  const healed = healSectorCautions(coerceNumericLimits(s));
  return {
    ...healed,
    // DERIVED, not merely floored. The settings panel, the ZoneBar, and the
    // manual all state one rule — "danger = safe limit + your margin", with no
    // separate danger control for average wind or waves. Storing the danger cap
    // independently and only flooring it at safe + 0.5 let the two drift: a
    // profile carrying safe 5.5 / danger 12 / margin 2.5 was TOLD 8.0 was the
    // red line while the engine still waited for 12. Deriving it here gives the
    // threshold one source of truth. Every built-in preset already satisfies
    // this exactly (5.5+2.5=8, 4+2=6, 7+3=10; 0.3+0.3=0.6, 0.2+0.2=0.4,
    // 0.5+0.3=0.8), so no preset user's verdict moves — only a drifted stored
    // profile is pulled back, and always toward the stricter number.
    maxWindSpeedCaution: floorCaution(healed.maxWindSpeedSafe, healed.maxWindSpeedSafe + healed.gustMargin),
    maxWaveHeightCaution: Math.max(healed.maxWaveHeightSafe, healed.maxWaveHeightSafe + healed.waveCautionMargin),
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
  // The raw bytes of a stored profile we could not parse, or null. A failed load
  // must NOT be silently replaced: the debounced write below fires on mount too,
  // so falling back to defaults used to stamp them over the unreadable blob
  // 250ms later — a beginner's 4.0 m/s cap became the 5.5 m/s default,
  // permanently, with no trace.
  //
  // But it must not block the user's own edits either. Holding the write open
  // indefinitely meant every later change was silently dropped and reverted on
  // each launch. So: mount never overwrites, and the first deliberate edit
  // stashes the unreadable bytes under a _corrupt key (the only thing they were
  // ever worth — a future build might parse them) and then writes normally.
  const loadFailedRef = useRef<string | null>(null);
  // Whether the user has deliberately changed anything this session.
  const hasEditedRef = useRef(false);

  const [settings, setSettings] = useState<SafetySettings>(() => {
    // The unsuffixed legacy keys predate multi-location and can only have been
    // written by the Horsens-only build. Reading them for every city
    // transplanted inner-fjord caps onto open-water sectors (Aarhus Bugt).
    const legacyOwnsThisLocation = CURRENT_LOCATION.id === DEFAULT_LOCATION_ID;
    const savedCustom = readStorage(CUSTOM_SETTINGS_STORAGE_KEY)
      ?? (legacyOwnsThisLocation ? readStorage(LEGACY_CUSTOM_SETTINGS_STORAGE_KEY) : null);
    if (savedCustom) {
      try {
        customProfileRef.current = { ...parseStoredSettings(savedCustom), tripMode: 'custom' };
      } catch {}
    }
    if (!customProfileRef.current) {
      customProfileRef.current = getPresetSettings('custom');
    }

    const saved = readStorage(SETTINGS_STORAGE_KEY)
      ?? (legacyOwnsThisLocation ? readStorage(LEGACY_SETTINGS_STORAGE_KEY) : null);
    if (saved) {
      try {
        const parsed = parseStoredSettings(saved);
        return parsed.tripMode === 'custom' ? parsed : getPresetSettings(parsed.tripMode);
      } catch {
        loadFailedRef.current = saved;
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  });

  useEffect(() => {
    // Never persist over a profile we failed to read on MOUNT. `hasEdited`
    // flips on the first deliberate change (see saveSettings/setTripMode).
    if (loadFailedRef.current !== null && !hasEditedRef.current) return;

    const write = () => {
      // First deliberate write after a failed load: keep the unreadable bytes
      // aside rather than destroying them, then proceed normally.
      if (loadFailedRef.current !== null) {
        try {
          localStorage.setItem(`${SETTINGS_STORAGE_KEY}_corrupt`, loadFailedRef.current);
        } catch {
          // Best effort; losing the corrupt copy must not block the real write.
        }
        loadFailedRef.current = null;
      }
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
        if (settings.tripMode === 'custom') {
          localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
        }
      } catch {
        // Ignore storage failures so slider interaction stays responsive.
      }
    };

    const timeoutId = window.setTimeout(write, 250);
    // An edit made in the last 250ms before the phone is pocketed (tab hidden,
    // bfcache, iOS killing the page) would otherwise never reach storage —
    // exactly when someone adjusts a limit at the launch site. setTripMode
    // already flushes for this reason; the main write needs it too.
    const flush = () => { window.clearTimeout(timeoutId); write(); };
    window.addEventListener('pagehide', flush);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('pagehide', flush);
    };
  }, [settings]);

  const saveSettings = useCallback((newSettings: SafetySettings) => {
    hasEditedRef.current = true;
    // Heal on the way in (idempotent for the editors, which already maintain
    // the invariants) so an inverted band can never reach the assessment.
    const healed = healSettings(newSettings);
    setSettings(healed);
    if (healed.tripMode === 'custom') {
      customProfileRef.current = healed;
    }
  }, []);

  const setTripMode = useCallback((mode: SafetySettings['tripMode']) => {
    hasEditedRef.current = true;
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
