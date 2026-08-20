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

// Settings storage deliberately has its own small schema. It is NOT tied to a
// Pages build, service-worker cache, forecast API, payload, or Worker data
// generation: those can all change without changing a user's choices.
//
// The metadata is inline rather than wrapping `settings`. That keeps the
// record backwards-compatible with a previous FRANK shell: an older client
// ignores the unknown metadata field but can still read every setting at its
// familiar top-level path. A future breaking settings format must use an
// explicit migration/expand-contract step before this number is advanced.
export const SETTINGS_STORAGE_SCHEMA_VERSION = 1;
export const SETTINGS_STORAGE_METADATA_KEY = '__frankSettingsStorage';
const SETTINGS_STORAGE_KIND = 'frank-safety-settings';

interface SettingsStorageMetadata {
  kind: typeof SETTINGS_STORAGE_KIND;
  schemaVersion: typeof SETTINGS_STORAGE_SCHEMA_VERSION;
  locationId: string;
}

export interface DecodedStoredSettings {
  settings: SafetySettings;
  // Raw pre-schema records remain supported and are rewritten in the current
  // inline format only after they have parsed and healed successfully.
  needsMigration: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function serializeStoredSettings(
  settings: SafetySettings,
  location: ForecastLocation = CURRENT_LOCATION,
): string {
  const metadata: SettingsStorageMetadata = {
    kind: SETTINGS_STORAGE_KIND,
    schemaVersion: SETTINGS_STORAGE_SCHEMA_VERSION,
    locationId: location.id,
  };
  return JSON.stringify({
    ...(settings as unknown as Record<string, unknown>),
    [SETTINGS_STORAGE_METADATA_KEY]: metadata,
  });
}

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

const TRIP_MODES: readonly SafetySettings['tripMode'][] = ['default', 'beginner', 'pro', 'custom'];
const TIDE_PREFERENCES: readonly SafetySettings['tidePreference'][] = ['any', 'high', 'low', 'incoming'];

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
  // TypeScript types stop at the localStorage boundary. Unknown enum strings
  // must not reach getPresetSettings (where they select no preset) or the
  // planner (where an unknown tide preference silently behaves like "any").
  if (!TRIP_MODES.includes(out.tripMode)) out.tripMode = DEFAULT_SETTINGS.tripMode;
  if (!TIDE_PREFERENCES.includes(out.tidePreference)) out.tidePreference = DEFAULT_SETTINGS.tidePreference;
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
  const isFiniteNumber = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value);
  for (const [id, cap] of Object.entries(out.sectorLimits ?? {})) {
    // Non-numbers are unusable, so drop the override and fall back to this
    // location's curated cap. Finite out-of-range numbers are recoverable:
    // clamp them to exactly what both steppers can represent. In particular,
    // safe must stop one shared gap below 25 so danger never becomes 25.5 and
    // leaves the UI with min > max and permanently disabled controls.
    if (!isFiniteNumber(cap?.safe) || !isFiniteNumber(cap?.caution)) continue;
    const safe = roundToDecimals(clampNumber(cap.safe, 0, 25 - MIN_CAUTION_GAP, 0), 1);
    const requestedCaution = roundToDecimals(clampNumber(cap.caution, 0, 25, 25), 1);
    sectorLimits[id] = {
      safe,
      caution: roundToDecimals(floorCaution(safe, requestedCaution), 1),
    };
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
    maxWindSpeedCaution: roundToDecimals(
      floorCaution(healed.maxWindSpeedSafe, healed.maxWindSpeedSafe + healed.gustMargin),
      1,
    ),
    maxWaveHeightCaution: roundToDecimals(
      Math.max(healed.maxWaveHeightSafe, healed.maxWaveHeightSafe + healed.waveCautionMargin),
      2,
    ),
    minWaterTempCaution: Math.min(healed.minWaterTempSafe, healed.minWaterTempCaution),
  };
}

// Decode both the original raw object and the current versioned record. The
// recognized values remain top-level for backwards compatibility; metadata is
// removed before settings enter React state. A malformed/future envelope is a
// whole-record failure so the caller can preserve its original bytes, while a
// malformed individual setting is still healed independently below.
export function decodeStoredSettings(
  json: string,
  location: ForecastLocation = CURRENT_LOCATION,
): DecodedStoredSettings {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error('Stored settings must be a JSON object');

  const metadata = parsed[SETTINGS_STORAGE_METADATA_KEY];
  let needsMigration = true;
  const raw = { ...parsed };

  if (metadata !== undefined) {
    if (!isRecord(metadata)
      || metadata.kind !== SETTINGS_STORAGE_KIND
      || metadata.schemaVersion !== SETTINGS_STORAGE_SCHEMA_VERSION
      || metadata.locationId !== location.id) {
      throw new Error('Unsupported or misplaced settings storage schema');
    }
    needsMigration = false;
    delete raw[SETTINGS_STORAGE_METADATA_KEY];
  }

  const migrated = migrateLegacySectors(raw, location);
  return {
    settings: healSettings({ ...DEFAULT_SETTINGS, ...migrated } as SafetySettings),
    needsMigration,
  };
}

export function parseStoredSettings(json: string): SafetySettings {
  return decodeStoredSettings(json).settings;
}

function persistStoredSettings(storageKey: string, settings: SafetySettings, unreadableRaw: string | null): boolean {
  // Preserve an unreadable/unsupported record before the user's first
  // deliberate replacement. This is best-effort: an unavailable/full storage
  // area must not make the live controls stop responding.
  if (unreadableRaw !== null) {
    try {
      localStorage.setItem(`${storageKey}_corrupt`, unreadableRaw);
    } catch {
      // The authoritative write below may still succeed by replacing bytes in
      // the existing slot, so do not turn a backup quota failure into data loss
      // for the user's new choice.
    }
  }

  try {
    localStorage.setItem(storageKey, serializeStoredSettings(settings));
    return true;
  } catch {
    return false;
  }
}

interface PendingStorageMigration {
  sourceKey: string;
  sourceRaw: string;
  targetRawAtLoad: string | null;
}

function migrationSourceIsUnchanged(targetKey: string, migration: PendingStorageMigration): boolean {
  // localStorage has no compare-and-set primitive. Rechecking both slots just
  // before the migration write is the important half: a slower old/new tab
  // must never overwrite a more recent user edit it did not load.
  return readStorage(migration.sourceKey) === migration.sourceRaw
    && readStorage(targetKey) === migration.targetRawAtLoad;
}

export function useSettings() {
  const customProfileRef = useRef<SafetySettings | null>(null);
  const customWriteNeededRef = useRef(false);
  const customMigrationRef = useRef<PendingStorageMigration | null>(null);
  const customSlotMissingRef = useRef(false);
  const customWriteAuthorizedRef = useRef(false);
  const customRecoveryAvailableRef = useRef(false);
  const activeWriteNeededRef = useRef(false);
  const activeMigrationRef = useRef<PendingStorageMigration | null>(null);
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
  const activeLoadFailedRef = useRef<string | null>(null);
  // The active choice and the remembered Custom profile are two independent
  // records. A corrupt custom record must not be replaced merely because the
  // user switches from Default to Pro; it becomes replaceable only when a
  // valid active Custom profile can recover it during an intentional mode
  // change, or the user deliberately edits that profile.
  const customLoadFailedRef = useRef<string | null>(null);
  // Whether the user has deliberately changed anything this session.
  const hasEditedRef = useRef(false);

  const [settings, setSettings] = useState<SafetySettings>(() => {
    // The unsuffixed legacy keys predate multi-location and can only have been
    // written by the Horsens-only build. Reading them for every city
    // transplanted inner-fjord caps onto open-water sectors (Aarhus Bugt).
    const legacyOwnsThisLocation = CURRENT_LOCATION.id === DEFAULT_LOCATION_ID;
    const currentSavedCustom = readStorage(CUSTOM_SETTINGS_STORAGE_KEY);
    const legacySavedCustom = currentSavedCustom === null && legacyOwnsThisLocation
      ? readStorage(LEGACY_CUSTOM_SETTINGS_STORAGE_KEY)
      : null;
    const savedCustom = currentSavedCustom ?? legacySavedCustom;
    const savedCustomSourceKey = currentSavedCustom !== null
      ? CUSTOM_SETTINGS_STORAGE_KEY
      : LEGACY_CUSTOM_SETTINGS_STORAGE_KEY;
    customSlotMissingRef.current = currentSavedCustom === null;
    if (savedCustom !== null) {
      try {
        const decoded = decodeStoredSettings(savedCustom);
        customProfileRef.current = { ...decoded.settings, tripMode: 'custom' };
        customRecoveryAvailableRef.current = true;
        if (decoded.needsMigration || savedCustomSourceKey !== CUSTOM_SETTINGS_STORAGE_KEY) {
          customWriteNeededRef.current = true;
          customMigrationRef.current = {
            sourceKey: savedCustomSourceKey,
            sourceRaw: savedCustom,
            targetRawAtLoad: currentSavedCustom,
          };
        }
      } catch {
        customLoadFailedRef.current = savedCustom;
      }
    }
    if (!customProfileRef.current) {
      customProfileRef.current = getPresetSettings('custom');
    }

    const currentSaved = readStorage(SETTINGS_STORAGE_KEY);
    const legacySaved = currentSaved === null && legacyOwnsThisLocation
      ? readStorage(LEGACY_SETTINGS_STORAGE_KEY)
      : null;
    const saved = currentSaved ?? legacySaved;
    const savedSourceKey = currentSaved !== null ? SETTINGS_STORAGE_KEY : LEGACY_SETTINGS_STORAGE_KEY;
    if (saved !== null) {
      try {
        const decoded = decodeStoredSettings(saved);
        const parsed = decoded.settings;
        if (decoded.needsMigration || savedSourceKey !== SETTINGS_STORAGE_KEY) {
          activeWriteNeededRef.current = true;
          activeMigrationRef.current = {
            sourceKey: savedSourceKey,
            sourceRaw: saved,
            targetRawAtLoad: currentSaved,
          };
        }
        if (parsed.tripMode === 'custom') {
          // The active record is itself a valid last-good Custom profile. Use
          // it to recover a missing/corrupt remembered-custom slot rather than
          // replacing the user's limits with the factory Custom preset.
          customProfileRef.current = parsed;
          customRecoveryAvailableRef.current = true;
          if (customSlotMissingRef.current) customWriteNeededRef.current = true;
          return parsed;
        }
        return getPresetSettings(parsed.tripMode);
      } catch {
        activeLoadFailedRef.current = saved;
        return DEFAULT_SETTINGS;
      }
    }
    return DEFAULT_SETTINGS;
  });
  const activeModeRef = useRef(settings.tripMode);
  activeModeRef.current = settings.tripMode;

  useEffect(() => {
    // Never persist over a profile we failed to read on MOUNT. `hasEdited`
    // flips on the first deliberate change (see saveSettings/setTripMode).
    const canWriteActive = activeWriteNeededRef.current
      && (activeLoadFailedRef.current === null || hasEditedRef.current);
    const canWriteCustom = customLoadFailedRef.current === null || customWriteAuthorizedRef.current;
    const shouldWriteCustom = customWriteNeededRef.current;
    if (!canWriteActive && !(canWriteCustom && shouldWriteCustom)) return;

    const write = () => {
      if (canWriteActive) {
        const migration = activeMigrationRef.current;
        if (migration && !migrationSourceIsUnchanged(SETTINGS_STORAGE_KEY, migration)) {
          activeMigrationRef.current = null;
          activeWriteNeededRef.current = false;
        } else if (persistStoredSettings(SETTINGS_STORAGE_KEY, settings, activeLoadFailedRef.current)) {
          activeLoadFailedRef.current = null;
          activeMigrationRef.current = null;
          activeWriteNeededRef.current = false;
        }
      }

      if (canWriteCustom && shouldWriteCustom && customProfileRef.current) {
        // When Custom is active, state is the newest source of truth. When it
        // is inactive, only a successfully decoded legacy custom profile is
        // eligible for the one-time format migration.
        const custom = settings.tripMode === 'custom' ? settings : customProfileRef.current;
        const migration = customMigrationRef.current;
        if (migration && !migrationSourceIsUnchanged(CUSTOM_SETTINGS_STORAGE_KEY, migration)) {
          customMigrationRef.current = null;
          customWriteNeededRef.current = false;
        } else if (persistStoredSettings(CUSTOM_SETTINGS_STORAGE_KEY, custom, customLoadFailedRef.current)) {
          customProfileRef.current = custom;
          customLoadFailedRef.current = null;
          customMigrationRef.current = null;
          customWriteNeededRef.current = false;
          customSlotMissingRef.current = false;
        }
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
    activeMigrationRef.current = null;
    activeWriteNeededRef.current = true;
    // Heal on the way in (idempotent for the editors, which already maintain
    // the invariants) so an inverted band can never reach the assessment.
    const healed = healSettings(newSettings);
    setSettings(healed);
    if (healed.tripMode === 'custom') {
      customProfileRef.current = healed;
      customWriteAuthorizedRef.current = true;
      customRecoveryAvailableRef.current = true;
      customMigrationRef.current = null;
      customWriteNeededRef.current = true;
    }
  }, []);

  const setTripMode = useCallback((mode: SafetySettings['tripMode']) => {
    hasEditedRef.current = true;
    activeMigrationRef.current = null;
    activeWriteNeededRef.current = true;
    if (mode === 'custom') {
      if (customSlotMissingRef.current && customLoadFailedRef.current === null) {
        customWriteNeededRef.current = true;
        customRecoveryAvailableRef.current = true;
      }
      setSettings(customProfileRef.current ?? getPresetSettings('custom'));
    } else {
      // Leaving custom cancels the debounced write, so flush the profile now
      // or an edit made within the last 250ms never reaches storage. A valid
      // active Custom record can also recover a broken remembered-custom slot,
      // but merely viewing fallback Custom defaults cannot erase bad bytes.
      const leavingCustom = activeModeRef.current === 'custom';
      if (leavingCustom && customLoadFailedRef.current !== null && customRecoveryAvailableRef.current) {
        customWriteAuthorizedRef.current = true;
      }
      if (leavingCustom
        && customProfileRef.current
        && (customLoadFailedRef.current === null || customWriteAuthorizedRef.current)
        && persistStoredSettings(
          CUSTOM_SETTINGS_STORAGE_KEY,
          customProfileRef.current,
          customLoadFailedRef.current,
        )) {
        customLoadFailedRef.current = null;
        customMigrationRef.current = null;
        customWriteNeededRef.current = false;
        customSlotMissingRef.current = false;
      }
      setSettings(getPresetSettings(mode));
    }
  }, []);

  return { settings, saveSettings, setTripMode };
}
