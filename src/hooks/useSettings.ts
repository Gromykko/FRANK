import { useCallback, useEffect, useState, useRef } from 'react';
import {
  DEFAULT_SETTINGS,
  getPresetSettings,
  SETTINGS_STORAGE_KEY,
  CUSTOM_SETTINGS_STORAGE_KEY,
} from '../features/safety/presets';
import type { SafetySettings } from '../features/safety/presets';
import { floorCaution, MIN_CAUTION_GAP } from '../features/safety/presets';
import { CURRENT_LOCATION } from '../config/locations';
import type { ForecastLocation } from '../config/locations';
import { readStorage } from '../utils/storage';
import { clampNumber, roundToDecimals } from '../utils/number';

export type { SafetySettings } from '../features/safety/presets';

// Settings storage deliberately has its own small schema. It is NOT tied to a
// Pages build, service-worker cache, forecast API, payload, or Worker data
// generation: those can all change without changing a user's choices.
//
// Metadata stays beside the settings rather than wrapping them. The shallow
// shape preserves additive fields through read/write cycles, while the schema
// marker lets us reject records from another location or an incompatible
// future format. A future breaking format needs an explicit migration before
// this number advances.
export const SETTINGS_STORAGE_SCHEMA_VERSION = 1;
export const SETTINGS_STORAGE_METADATA_KEY = '__frankSettingsStorage';
const SETTINGS_STORAGE_KIND = 'frank-safety-settings';

interface SettingsStorageMetadata {
  kind: typeof SETTINGS_STORAGE_KIND;
  schemaVersion: typeof SETTINGS_STORAGE_SCHEMA_VERSION;
  locationId: string;
}

type SettingsFieldKey = Exclude<keyof SafetySettings, 'sectorLimits'>;

interface SettingsPatch {
  fields: Partial<Omit<SafetySettings, 'sectorLimits'>>;
  // null is an explicit deletion. The current editor only adds/updates sector
  // caps, but retaining deletion semantics keeps a future "reset this sector"
  // control from reviving a value written by another tab.
  sectorLimits: Record<string, SafetySettings['sectorLimits'][string] | null>;
}

interface PendingSettingsMutation {
  // Preset/mode changes intentionally replace the whole profile. Ordinary
  // limit edits stay field-level so two tabs changing independent controls can
  // converge instead of the last whole-record write silently winning.
  replacement: SafetySettings | null;
  patch: SettingsPatch;
}

const SETTINGS_FIELD_KEYS: SettingsFieldKey[] = [
  'maxWindSpeedSafe',
  'maxWindSpeedCaution',
  'minWaterTempSafe',
  'minWaterTempCaution',
  'maxWaveHeightSafe',
  'maxWaveHeightCaution',
  'enableCustomWindDirs',
  'tripMode',
  'daylightOnly',
  'minDuration',
  'tidePreference',
  'gustMargin',
  'waveCautionMargin',
  'enableWindSpeed',
  'enableWindGust',
  'enableWaveHeight',
  'enableWaveCaution',
  'enableWaterTemp',
];

function emptySettingsPatch(): SettingsPatch {
  return { fields: {}, sectorLimits: {} };
}

function emptyPendingSettingsMutation(): PendingSettingsMutation {
  return { replacement: null, patch: emptySettingsPatch() };
}

function settingsPatch(previous: SafetySettings, next: SafetySettings): SettingsPatch {
  const patch = emptySettingsPatch();
  const fields = patch.fields as Record<string, unknown>;
  for (const key of SETTINGS_FIELD_KEYS) {
    if (!Object.is(previous[key], next[key])) fields[key] = next[key];
  }

  const sectorIds = new Set([
    ...Object.keys(previous.sectorLimits ?? {}),
    ...Object.keys(next.sectorLimits ?? {}),
  ]);
  for (const id of sectorIds) {
    const before = previous.sectorLimits?.[id];
    const after = next.sectorLimits?.[id];
    if (!after) {
      if (before) patch.sectorLimits[id] = null;
    } else if (!before || before.safe !== after.safe || before.caution !== after.caution) {
      patch.sectorLimits[id] = { ...after };
    }
  }
  return patch;
}

function mergeSettingsPatches(current: SettingsPatch, incoming: SettingsPatch): SettingsPatch {
  return {
    fields: { ...current.fields, ...incoming.fields },
    sectorLimits: { ...current.sectorLimits, ...incoming.sectorLimits },
  };
}

function applySettingsPatch(base: SafetySettings, patch: SettingsPatch): SafetySettings {
  const sectorLimits = { ...(base.sectorLimits ?? {}) };
  for (const [id, cap] of Object.entries(patch.sectorLimits)) {
    if (cap === null) delete sectorLimits[id];
    else sectorLimits[id] = { ...cap };
  }
  return healSettings({ ...base, ...patch.fields, sectorLimits });
}

function applyPendingMutation(base: SafetySettings, mutation: PendingSettingsMutation): SafetySettings {
  return mutation.replacement
    ? healSettings(mutation.replacement)
    : applySettingsPatch(base, mutation.patch);
}

function queueSettingsPatch(
  mutation: PendingSettingsMutation,
  previous: SafetySettings,
  next: SafetySettings,
): PendingSettingsMutation {
  const patch = settingsPatch(previous, next);
  if (mutation.replacement) {
    return { replacement: applySettingsPatch(mutation.replacement, patch), patch: emptySettingsPatch() };
  }
  return { replacement: null, patch: mergeSettingsPatches(mutation.patch, patch) };
}

function sameSettings(left: SafetySettings, right: SafetySettings): boolean {
  for (const key of SETTINGS_FIELD_KEYS) {
    if (!Object.is(left[key], right[key])) return false;
  }
  const leftIds = Object.keys(left.sectorLimits ?? {});
  const rightIds = Object.keys(right.sectorLimits ?? {});
  if (leftIds.length !== rightIds.length) return false;
  return leftIds.every((id) => {
    const a = left.sectorLimits[id];
    const b = right.sectorLimits[id];
    return Boolean(b) && a.safe === b.safe && a.caution === b.caution;
  });
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
  // Floor 5, matching the Stepper, and NOT 0. Every other limit here clamps to
  // a value that still checks something; a water-temp floor of 0 makes
  // `temp < 0` unsatisfiable, so a stale or hand-edited profile switches off
  // cold shock - the deadliest hazard on this coast - while `enableWaterTemp`
  // stays true and no "limits are off" disclosure fires. Disabling the rule is
  // what the toggle is for.
  { key: 'minWaterTempSafe', decimals: 1, min: 5, max: 25 },
  { key: 'minWaterTempCaution', decimals: 1, min: 5, max: 25 },
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

const TRIP_MODES: readonly SafetySettings['tripMode'][] = ['default', 'beginner', 'pro', 'custom', 'weather'];
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
    // threshold one source of truth. Every built-in preset satisfies this
    // exactly (6+2=8, 4+1=5, 8+2=10; 0.3+0.7=1, 0.2+0.3=0.5,
    // 0.5+1.5=2), so selecting or reloading a built-in mode cannot make the
    // displayed threshold disagree with the engine.
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

// Only the current location-scoped schema is readable. A missing, malformed,
// future, or misplaced marker is a whole-record failure so the caller can
// preserve the original bytes; malformed individual settings inside a valid
// record are still healed independently below.
export function decodeStoredSettings(
  json: string,
  location: ForecastLocation = CURRENT_LOCATION,
) {
  const parsed: unknown = JSON.parse(json);
  if (!isRecord(parsed)) throw new Error('Stored settings must be a JSON object');

  const metadata = parsed[SETTINGS_STORAGE_METADATA_KEY];
  if (!isRecord(metadata)
    || metadata.kind !== SETTINGS_STORAGE_KIND
    || metadata.schemaVersion !== SETTINGS_STORAGE_SCHEMA_VERSION
    || metadata.locationId !== location.id) {
    throw new Error('Unsupported or misplaced settings storage schema');
  }

  const raw = { ...parsed };
  delete raw[SETTINGS_STORAGE_METADATA_KEY];
  return {
    settings: healSettings({ ...DEFAULT_SETTINGS, ...raw } as SafetySettings),
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

export function useSettings() {
  const customProfileRef = useRef<SafetySettings | null>(null);
  const activeMutationRef = useRef<PendingSettingsMutation>(emptyPendingSettingsMutation());
  const customMutationRef = useRef<PendingSettingsMutation>(emptyPendingSettingsMutation());
  const customWriteNeededRef = useRef(false);
  const customSlotMissingRef = useRef(false);
  const customWriteAuthorizedRef = useRef(false);
  const customRecoveryAvailableRef = useRef(false);
  const activeWriteNeededRef = useRef(false);
  // The raw bytes of a stored profile we could not parse, or null. A failed load
  // must NOT be silently replaced: the debounced write below fires on mount too,
  // so falling back to defaults used to stamp them over the unreadable blob
  // 250ms later — a beginner's 4.0 m/s cap became the 6.0 m/s default,
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
    const savedCustom = readStorage(CUSTOM_SETTINGS_STORAGE_KEY);
    customSlotMissingRef.current = savedCustom === null;
    if (savedCustom !== null) {
      try {
        const decoded = decodeStoredSettings(savedCustom);
        customProfileRef.current = { ...decoded.settings, tripMode: 'custom' };
        customRecoveryAvailableRef.current = true;
      } catch {
        customLoadFailedRef.current = savedCustom;
      }
    }
    if (!customProfileRef.current) {
      customProfileRef.current = getPresetSettings('custom');
    }

    const saved = readStorage(SETTINGS_STORAGE_KEY);
    if (saved !== null) {
      try {
        const decoded = decodeStoredSettings(saved);
        const parsed = decoded.settings;
        if (parsed.tripMode === 'custom') {
          // The active record is itself a valid last-good Custom profile. Use
          // it to recover a missing/corrupt remembered-custom slot rather than
          // replacing the user's limits with the factory Custom preset.
          customProfileRef.current = parsed;
          customRecoveryAvailableRef.current = true;
          if (customSlotMissingRef.current) {
            customWriteNeededRef.current = true;
            customMutationRef.current = { replacement: parsed, patch: emptySettingsPatch() };
          }
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
  // The active choice and remembered Custom profile are separate records and
  // can fail independently (for example, replacing the existing active value
  // may fit while creating/growing the Custom slot exceeds quota). Never let a
  // successful active write clear the warning for an unsaved Custom profile.
  const [activeSaveFailed, setActiveSaveFailed] = useState(false);
  const [customSaveFailed, setCustomSaveFailed] = useState(false);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const activeModeRef = useRef(settings.tripMode);
  activeModeRef.current = settings.tripMode;

  const applyLiveSettings = useCallback((next: SafetySettings) => {
    const previous = settingsRef.current;
    settingsRef.current = next;
    activeModeRef.current = next.tripMode;
    if (!sameSettings(previous, next)) setSettings(next);
  }, []);

  const commitActiveNow = useCallback((): SafetySettings | null => {
    // Never persist over a profile we failed to read on MOUNT. `hasEdited`
    // flips on the first deliberate change (see saveSettings/setTripMode).
    if (!activeWriteNeededRef.current
      || (activeLoadFailedRef.current !== null && !hasEditedRef.current)) return null;

    let base = settingsRef.current;
    const latestRaw = readStorage(SETTINGS_STORAGE_KEY);
    if (latestRaw !== null) {
      try {
        base = decodeStoredSettings(latestRaw).settings;
        activeLoadFailedRef.current = null;
      } catch {
        // A record may have become corrupt after this tab mounted. A deliberate
        // local edit is still allowed to replace it, but preserve the newest
        // unreadable bytes under _corrupt just like the mount-time path.
        activeLoadFailedRef.current = latestRaw;
      }
    }

    const candidate = applyPendingMutation(base, activeMutationRef.current);
    const saved = persistStoredSettings(SETTINGS_STORAGE_KEY, candidate, activeLoadFailedRef.current);
    // A silent failure here is the dangerous kind. The panel and the verdict
    // both use the new value immediately, so a user who lowers their wind cap at
    // the launch site sees it take effect while the next session restores an
    // older, looser value.
    setActiveSaveFailed(!saved);
    if (!saved) return null;

    activeLoadFailedRef.current = null;
    activeWriteNeededRef.current = false;
    activeMutationRef.current = emptyPendingSettingsMutation();
    if (candidate.tripMode === 'custom') {
      customProfileRef.current = candidate;
      customRecoveryAvailableRef.current = true;
    }
    applyLiveSettings(candidate);
    return candidate;
  }, [applyLiveSettings]);

  const commitCustomNow = useCallback((preferredBase?: SafetySettings | null): SafetySettings | null => {
    if (!customWriteNeededRef.current || !customProfileRef.current) return null;
    if (customLoadFailedRef.current !== null && !customWriteAuthorizedRef.current) return null;

    const latestRaw = readStorage(CUSTOM_SETTINGS_STORAGE_KEY);
    let storedBase: SafetySettings | null = null;
    if (latestRaw !== null) {
      try {
        storedBase = { ...decodeStoredSettings(latestRaw).settings, tripMode: 'custom' };
        customLoadFailedRef.current = null;
      } catch {
        customLoadFailedRef.current = latestRaw;
        if (!customWriteAuthorizedRef.current) return null;
      }
    }

    // While Custom is active, the active record is the canonical newest view;
    // use its cross-tab merge for the remembered slot too. When inactive, merge
    // directly against the latest remembered Custom record.
    const liveCustom = preferredBase?.tripMode === 'custom'
      ? preferredBase
      : settingsRef.current.tripMode === 'custom'
        ? settingsRef.current
        : null;
    const base = liveCustom ?? storedBase ?? customProfileRef.current;
    const candidate = {
      ...applyPendingMutation(base, customMutationRef.current),
      tripMode: 'custom' as const,
    };
    if (!persistStoredSettings(CUSTOM_SETTINGS_STORAGE_KEY, candidate, customLoadFailedRef.current)) {
      setCustomSaveFailed(true);
      return null;
    }

    setCustomSaveFailed(false);
    customProfileRef.current = candidate;
    customLoadFailedRef.current = null;
    customWriteNeededRef.current = false;
    customSlotMissingRef.current = false;
    customMutationRef.current = emptyPendingSettingsMutation();
    if (settingsRef.current.tripMode === 'custom') applyLiveSettings(candidate);
    return candidate;
  }, [applyLiveSettings]);

  const commitAllNow = useCallback(() => {
    const active = commitActiveNow();
    commitCustomNow(active);
  }, [commitActiveNow, commitCustomNow]);

  const commitWithCrossTabLock = useCallback(async () => {
    const lockManager = globalThis.navigator?.locks;
    if (!lockManager) {
      commitAllNow();
      return;
    }
    try {
      await lockManager.request(`frank-settings:${CURRENT_LOCATION.id}`, () => commitAllNow());
    } catch {
      // Web Locks are a concurrency enhancement. A browser that exposes a
      // broken/blocked lock manager must still retain the synchronous guarded
      // persistence path used before this feature existed.
      commitAllNow();
    }
  }, [commitAllNow]);

  useEffect(() => {
    const canWriteActive = activeWriteNeededRef.current
      && (activeLoadFailedRef.current === null || hasEditedRef.current);
    const canWriteCustom = customWriteNeededRef.current
      && (customLoadFailedRef.current === null || customWriteAuthorizedRef.current);
    if (!canWriteActive && !canWriteCustom) return;

    const timeoutId = window.setTimeout(() => { void commitWithCrossTabLock(); }, 250);
    // An edit made in the last 250ms before the phone is pocketed (tab hidden,
    // bfcache, iOS killing the page) would otherwise never reach storage —
    // exactly when someone adjusts a limit at the launch site. setTripMode
    // already flushes for this reason; the main write needs it too.
    // Page teardown cannot wait for an async lock request; merge synchronously
    // against the newest bytes as the final best-effort flush.
    const flush = () => { window.clearTimeout(timeoutId); commitAllNow(); };
    window.addEventListener('pagehide', flush);

    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener('pagehide', flush);
    };
  }, [settings, commitAllNow, commitWithCrossTabLock]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.newValue === null) return;
      if (event.storageArea && event.storageArea !== window.localStorage) return;

      if (event.key === SETTINGS_STORAGE_KEY) {
        let incoming: SafetySettings;
        try {
          incoming = decodeStoredSettings(event.newValue).settings;
        } catch {
          // Another writer's corrupt/future record must not poison live safety
          // state or authorize this tab to replace bytes it cannot understand.
          return;
        }
        activeLoadFailedRef.current = null;
        const next = activeWriteNeededRef.current
          ? applyPendingMutation(incoming, activeMutationRef.current)
          : incoming.tripMode === 'custom'
            ? incoming
            : getPresetSettings(incoming.tripMode);
        if (next.tripMode === 'custom') {
          customProfileRef.current = next;
          customRecoveryAvailableRef.current = true;
        }
        applyLiveSettings(next);
        return;
      }

      if (event.key === CUSTOM_SETTINGS_STORAGE_KEY) {
        let incoming: SafetySettings;
        try {
          incoming = { ...decodeStoredSettings(event.newValue).settings, tripMode: 'custom' };
        } catch {
          return;
        }
        customLoadFailedRef.current = null;
        let nextCustom = customWriteNeededRef.current
          ? applyPendingMutation(incoming, customMutationRef.current)
          : incoming;
        nextCustom = { ...nextCustom, tripMode: 'custom' };
        customProfileRef.current = nextCustom;
        customRecoveryAvailableRef.current = true;

        if (settingsRef.current.tripMode === 'custom') {
          const nextActive = activeWriteNeededRef.current
            ? applyPendingMutation(nextCustom, activeMutationRef.current)
            : nextCustom;
          applyLiveSettings(nextActive);
        }
      }
    };

    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [applyLiveSettings]);

  const saveSettings = useCallback((newSettings: SafetySettings) => {
    hasEditedRef.current = true;
    activeWriteNeededRef.current = true;
    // Heal on the way in (idempotent for the editors, which already maintain
    // the invariants) so an inverted band can never reach the assessment.
    const healed = healSettings(newSettings);
    const previous = settingsRef.current;
    activeMutationRef.current = activeLoadFailedRef.current !== null
      ? { replacement: healed, patch: emptySettingsPatch() }
      : queueSettingsPatch(activeMutationRef.current, previous, healed);
    settingsRef.current = healed;
    activeModeRef.current = healed.tripMode;
    setSettings(healed);
    if (healed.tripMode === 'custom') {
      customProfileRef.current = healed;
      customWriteAuthorizedRef.current = true;
      customRecoveryAvailableRef.current = true;
      customWriteNeededRef.current = true;
      customMutationRef.current = previous.tripMode !== 'custom' || customLoadFailedRef.current !== null
        ? { replacement: healed, patch: emptySettingsPatch() }
        : queueSettingsPatch(customMutationRef.current, previous, healed);
    }
  }, []);

  const setTripMode = useCallback((mode: SafetySettings['tripMode']) => {
    hasEditedRef.current = true;
    activeWriteNeededRef.current = true;
    if (mode === 'custom') {
      const custom = customProfileRef.current ?? getPresetSettings('custom');
      activeMutationRef.current = { replacement: custom, patch: emptySettingsPatch() };
      if (customSlotMissingRef.current && customLoadFailedRef.current === null) {
        customWriteNeededRef.current = true;
        customRecoveryAvailableRef.current = true;
        customMutationRef.current = { replacement: custom, patch: emptySettingsPatch() };
      }
      settingsRef.current = custom;
      activeModeRef.current = 'custom';
      setSettings(custom);
    } else {
      // Leaving custom cancels the debounced write, so flush the profile now
      // or an edit made within the last 250ms never reaches storage. A valid
      // active Custom record can also recover a broken remembered-custom slot,
      // but merely viewing fallback Custom defaults cannot erase bad bytes.
      const leavingCustom = activeModeRef.current === 'custom';
      if (leavingCustom && customLoadFailedRef.current !== null && customRecoveryAvailableRef.current) {
        customWriteAuthorizedRef.current = true;
        customWriteNeededRef.current = true;
        customMutationRef.current = {
          replacement: customProfileRef.current,
          patch: emptySettingsPatch(),
        };
      }
      if (leavingCustom && customProfileRef.current) {
        // Leaving Custom cancels its debounced effect. Ensure the remembered
        // slot owns a complete candidate, then use the same latest-record merge
        // as the normal timer before switching live state to the preset.
        if (!customWriteNeededRef.current && customLoadFailedRef.current === null) {
          customWriteNeededRef.current = true;
          customMutationRef.current = {
            replacement: customProfileRef.current,
            patch: emptySettingsPatch(),
          };
        }
        commitCustomNow(customProfileRef.current);
      }
      const preset = getPresetSettings(mode);
      activeMutationRef.current = { replacement: preset, patch: emptySettingsPatch() };
      settingsRef.current = preset;
      activeModeRef.current = mode;
      setSettings(preset);
    }
  }, [commitCustomNow]);

  return {
    settings,
    saveSettings,
    setTripMode,
    saveFailed: activeSaveFailed || customSaveFailed,
  };
}
