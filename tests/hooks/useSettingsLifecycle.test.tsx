import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  serializeStoredSettings,
  SETTINGS_STORAGE_METADATA_KEY,
  SETTINGS_STORAGE_SCHEMA_VERSION,
  useSettings,
} from '../../src/hooks/useSettings';
import {
  CUSTOM_SETTINGS_STORAGE_KEY,
  DEFAULT_SETTINGS,
  getPresetSettings,
  SETTINGS_STORAGE_KEY,
} from '../../src/features/safety/presets';
import type { SafetySettings } from '../../src/features/safety/presets';
import { CURRENT_LOCATION } from '../../src/config/locations';

type SettingsHook = ReturnType<typeof useSettings>;

let host: HTMLDivElement;
let root: Root;
let current: SettingsHook;
let pair: [SettingsHook, SettingsHook];

function Probe() {
  current = useSettings();
  return null;
}

function PairProbe() {
  pair = [useSettings(), useSettings()];
  return null;
}

async function renderHook() {
  await act(async () => {
    root.render(<Probe />);
  });
}

async function renderPair() {
  await act(async () => {
    root.render(<PairProbe />);
  });
}

async function flushSettingsWrite() {
  await act(async () => {
    vi.advanceTimersByTime(251);
  });
}

function customSettings(overrides: Partial<SafetySettings> = {}): SafetySettings {
  return {
    ...DEFAULT_SETTINGS,
    tripMode: 'custom',
    ...overrides,
  };
}

function storedRecord(key: string): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(key)!) as Record<string, unknown>;
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('useSettings persistence lifecycle', () => {
  it('starts a first-time visitor on the most cautious profile, without inventing a saved choice', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await renderHook();
    await flushSettingsWrite();

    // Guessing is unavoidable on a first visit; guess where being wrong sends
    // somebody home rather than onto the water.
    expect(current.settings).toEqual(getPresetSettings('beginner'));
    expect(current.settings.tripMode).toBe('beginner');
    expect(setItem.mock.calls.some(([key]) => key === SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('seeds a city it has never opened from the profile chosen in another one', async () => {
    // A profile describes the paddler, not the water, so it is the one record
    // that is not location-suffixed. This city has no settings of its own.
    localStorage.setItem('frank_last_trip_mode', 'pro');

    await renderHook();
    await flushSettingsWrite();

    expect(current.settings.tripMode).toBe('pro');
    // Carried judgement, not carried numbers: the caps still come from this
    // location's own configured sector geometry.
    expect(current.settings).toEqual(getPresetSettings('pro'));
  });

  it('does not carry Custom into a city that has no Custom record', async () => {
    // Custom's numbers live in a per-city slot this city does not have, so
    // there is nothing to carry and the cautious first-visit guess applies.
    localStorage.setItem('frank_last_trip_mode', 'custom');

    await renderHook();
    await flushSettingsWrite();

    expect(current.settings.tripMode).toBe('beginner');
  });

  it('remembers a deliberate profile choice for the next city', async () => {
    await renderHook();
    await act(async () => current.setTripMode('pro'));
    await flushSettingsWrite();

    expect(localStorage.getItem('frank_last_trip_mode')).toBe('pro');
  });

  it('does not read unsuffixed prelaunch settings keys', async () => {
    const oldActive = JSON.stringify(customSettings({ windLimit: 4.0 }));
    const oldCustom = JSON.stringify(customSettings({ windLimit: 4.1 }));
    localStorage.setItem('frank_settings', oldActive);
    localStorage.setItem('frank_custom_saved', oldCustom);

    await renderHook();
    await flushSettingsWrite();

    expect(current.settings).toEqual(getPresetSettings('beginner'));
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('frank_settings')).toBe(oldActive);
    expect(localStorage.getItem('frank_custom_saved')).toBe(oldCustom);
  });

  it('does not rewrite already-current records merely because a new app shell mounted', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(DEFAULT_SETTINGS));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(customSettings({
      windLimit: 4.2,
    })));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await renderHook();
    await flushSettingsWrite();

    expect(setItem.mock.calls.some(([key]) => key === SETTINGS_STORAGE_KEY)).toBe(false);
    expect(setItem.mock.calls.some(([key]) => key === CUSTOM_SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('loads current built-in values from the stored mode without changing remembered Custom limits', async () => {
    const staleNormal = {
      ...DEFAULT_SETTINGS,
      tripMode: 'default' as const,
      windLimit: 5.5,
      waveLimit: 0.3,
    };
    const rememberedCustom = customSettings({
      windLimit: 4.3,
      waveLimit: 0.25,
    });
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(staleNormal));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(rememberedCustom));

    await renderHook();

    expect(current.settings).toEqual(getPresetSettings('default'));
    expect(current.settings).toMatchObject({
      tripMode: 'default',
      windLimit: 8.0,
      waveLimit: 1.0,
    });
    // Merely loading a built-in mode is not a destructive migration of either
    // stored record. Built-ins resolve from code; Custom remains user-owned.
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'default',
      windLimit: 5.5,
      waveLimit: 0.3,
    });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.3,
      waveLimit: 0.25,
    });

    await act(async () => current.setTripMode('custom'));
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.3,
      waveLimit: 0.25,
    });
  });

  it('keeps an unreadable active record byte-for-byte until a deliberate user change', async () => {
    const unreadable = '{not-json';
    localStorage.setItem(SETTINGS_STORAGE_KEY, unreadable);

    await renderHook();
    await flushSettingsWrite();
    // An unreadable profile is no authority for a verdict, but silence is not
    // the safe failure either: fall back to the most cautious profile.
    expect(current.settings).toEqual(getPresetSettings('beginner'));
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(unreadable);
    expect(localStorage.getItem(`${SETTINGS_STORAGE_KEY}_corrupt`)).toBeNull();

    await act(async () => current.setTripMode('pro'));
    await flushSettingsWrite();
    expect(localStorage.getItem(`${SETTINGS_STORAGE_KEY}_corrupt`)).toBe(unreadable);
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'pro',
      [SETTINGS_STORAGE_METADATA_KEY]: { schemaVersion: SETTINGS_STORAGE_SCHEMA_VERSION },
    });
  });

  it('treats a previous-schema record as a fresh reset and preserves it until a deliberate choice', async () => {
    const legacy = JSON.parse(serializeStoredSettings(customSettings({
      windLimit: 4.4,
    }))) as Record<string, unknown>;
    legacy[SETTINGS_STORAGE_METADATA_KEY] = {
      ...(legacy[SETTINGS_STORAGE_METADATA_KEY] as Record<string, unknown>),
      schemaVersion: SETTINGS_STORAGE_SCHEMA_VERSION - 1,
    };
    const legacyBytes = JSON.stringify(legacy);
    localStorage.setItem(SETTINGS_STORAGE_KEY, legacyBytes);

    await renderHook();
    await flushSettingsWrite();

    expect(current.settings).toEqual(getPresetSettings('beginner'));
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(legacyBytes);

    await act(async () => current.setTripMode('pro'));
    await flushSettingsWrite();

    expect(localStorage.getItem(`${SETTINGS_STORAGE_KEY}_corrupt`)).toBe(legacyBytes);
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'pro',
      [SETTINGS_STORAGE_METADATA_KEY]: { schemaVersion: SETTINGS_STORAGE_SCHEMA_VERSION },
    });
  });

  it('does not erase a corrupt remembered Custom profile when switching between built-in modes', async () => {
    const unreadableCustom = '{custom-not-json';
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(DEFAULT_SETTINGS));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, unreadableCustom);

    await renderHook();
    await flushSettingsWrite();
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBe(unreadableCustom);

    await act(async () => current.setTripMode('pro'));
    await flushSettingsWrite();
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBe(unreadableCustom);
    expect(localStorage.getItem(`${CUSTOM_SETTINGS_STORAGE_KEY}_corrupt`)).toBeNull();

    // Merely selecting fallback Custom is not permission to destroy a record
    // this app cannot understand. Only an actual limits edit replaces it.
    await act(async () => current.setTripMode('custom'));
    await flushSettingsWrite();
    expect(current.settings.tripMode).toBe('custom');
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBe(unreadableCustom);
    expect(localStorage.getItem(`${CUSTOM_SETTINGS_STORAGE_KEY}_corrupt`)).toBeNull();

    await act(async () => current.saveSettings({
      ...current.settings,
      windLimit: 4.3,
      tripMode: 'custom',
    }));
    await flushSettingsWrite();
    expect(localStorage.getItem(`${CUSTOM_SETTINGS_STORAGE_KEY}_corrupt`)).toBe(unreadableCustom);
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.3,
      [SETTINGS_STORAGE_METADATA_KEY]: { schemaVersion: SETTINGS_STORAGE_SCHEMA_VERSION },
    });
  });

  it('uses a valid active Custom profile as recovery only when the user leaves that mode', async () => {
    const unreadableCustom = '{custom-not-json';
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(customSettings({
      windLimit: 4.6,
      daylightOnly: false,
    })));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, unreadableCustom);

    await renderHook();
    await flushSettingsWrite();
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.6,
      daylightOnly: false,
    });
    // No mount-time destructive repair: a future app may understand these
    // bytes even though this one does not.
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBe(unreadableCustom);

    await act(async () => current.setTripMode('pro'));
    expect(localStorage.getItem(`${CUSTOM_SETTINGS_STORAGE_KEY}_corrupt`)).toBe(unreadableCustom);
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.6,
      daylightOnly: false,
    });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).not.toHaveProperty('windDangerGap');
  });

  it('keeps the save warning visible when only the remembered Custom slot fails', async () => {
    const initial = customSettings({ windLimit: 5.5 });
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));
    await renderHook();

    const nativeSetItem = Storage.prototype.setItem;
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (key === CUSTOM_SETTINGS_STORAGE_KEY) throw new Error('remembered Custom slot is full');
      return nativeSetItem.call(this, key, value);
    });

    await act(async () => current.saveSettings({
      ...current.settings,
      windLimit: 4.1,
    }));
    await flushSettingsWrite();

    // The active record fit, but that success must not hide loss of the
    // remembered profile that selecting a preset will make authoritative.
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({ windLimit: 4.1 });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({ windLimit: 5.5 });
    expect(current.saveFailed).toBe(true);

    await act(async () => current.setTripMode('pro'));
    await flushSettingsWrite();
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({ tripMode: 'pro' });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({ windLimit: 5.5 });
    expect(current.saveFailed).toBe(true);

    // Once that specific channel can persist again, its successful retry owns
    // clearing the warning; an unrelated active write never does.
    setItem.mockImplementation(function (this: Storage, key: string, value: string) {
      return nativeSetItem.call(this, key, value);
    });
    await act(async () => current.setTripMode('custom'));
    await flushSettingsWrite();
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({ windLimit: 4.1 });
    expect(current.saveFailed).toBe(false);
  });

  it('remembers one location-scoped Custom profile across built-in mode changes', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(DEFAULT_SETTINGS));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(customSettings({
      windLimit: 3.9,
      daylightOnly: false,
    })));

    await renderHook();
    await act(async () => current.setTripMode('custom'));
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      windLimit: 3.9,
      daylightOnly: false,
    });

    await act(async () => current.setTripMode('pro'));
    await act(async () => current.setTripMode('custom'));
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      windLimit: 3.9,
      daylightOnly: false,
    });
    await flushSettingsWrite();
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      windLimit: 3.9,
      daylightOnly: false,
    });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).not.toHaveProperty('windDangerGap');
  });

  it('merges an incoming storage event with a local field edit that is still pending', async () => {
    const initial = customSettings({
      windLimit: 5.5,
      daylightOnly: true,
    });
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));

    await renderHook();
    await act(async () => {
      // This field has changed locally, but the 250ms persistence debounce has
      // not fired yet when the sibling tab publishes a different field.
      current.saveSettings({ ...current.settings, windLimit: 4.0 });

      const remote = customSettings({
        windLimit: 5.5,
        daylightOnly: false,
      });
      const remoteValue = serializeStoredSettings(remote);
      localStorage.setItem(SETTINGS_STORAGE_KEY, remoteValue);
      localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, remoteValue);
      window.dispatchEvent(new StorageEvent('storage', {
        key: SETTINGS_STORAGE_KEY,
        newValue: remoteValue,
        storageArea: localStorage,
      }));
      window.dispatchEvent(new StorageEvent('storage', {
        key: CUSTOM_SETTINGS_STORAGE_KEY,
        newValue: remoteValue,
        storageArea: localStorage,
      }));
    });

    // The live verdict must immediately reflect the remote field without
    // dropping the not-yet-persisted local field.
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.0,
      daylightOnly: false,
    });

    await flushSettingsWrite();
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.0,
      daylightOnly: false,
    });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      windLimit: 4.0,
      daylightOnly: false,
    });
  });

  it('merges independent concurrent tab edits against the newest stored fields', async () => {
    const initial = customSettings({
      windLimit: 5.5,
      daylightOnly: true,
    });
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));

    const lockRequest = vi.fn(async <T,>(name: string, callback: () => T | PromiseLike<T>) => {
      expect(name).toBe(`frank-settings:${CURRENT_LOCATION.id}`);
      return callback();
    });
    Object.defineProperty(navigator, 'locks', {
      configurable: true,
      value: { request: lockRequest },
    });

    try {
      await renderPair();
      await act(async () => {
        pair[0].saveSettings({ ...pair[0].settings, windLimit: 4.0 });
        pair[1].saveSettings({ ...pair[1].settings, daylightOnly: false });
      });
      await flushSettingsWrite();

      const persisted = storedRecord(SETTINGS_STORAGE_KEY);
      expect(persisted).toMatchObject({
        tripMode: 'custom',
        windLimit: 4.0,
        daylightOnly: false,
      });
      expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
        tripMode: 'custom',
        windLimit: 4.0,
        daylightOnly: false,
      });
      expect(lockRequest).toHaveBeenCalledTimes(2);

      // localStorage does not emit `storage` in the document that performed a
      // write. Simulate the notification each real sibling tab receives and
      // verify both live verdicts converge on the merged record too.
      const newValue = localStorage.getItem(SETTINGS_STORAGE_KEY)!;
      await act(async () => {
        window.dispatchEvent(new StorageEvent('storage', {
          key: SETTINGS_STORAGE_KEY,
          newValue,
          storageArea: localStorage,
        }));
      });
      expect(pair[0].settings).toMatchObject({ windLimit: 4.0, daylightOnly: false });
      expect(pair[1].settings).toMatchObject({ windLimit: 4.0, daylightOnly: false });
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });
});
