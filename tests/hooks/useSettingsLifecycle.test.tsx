import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  serializeStoredSettings,
  SETTINGS_STORAGE_METADATA_KEY,
  useSettings,
} from '../../src/hooks/useSettings';
import {
  CUSTOM_SETTINGS_STORAGE_KEY,
  DEFAULT_SETTINGS,
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
  it('does not read unsuffixed prelaunch settings keys', async () => {
    const oldActive = JSON.stringify(customSettings({ maxWindSpeedSafe: 4.0 }));
    const oldCustom = JSON.stringify(customSettings({ maxWindSpeedSafe: 4.1 }));
    localStorage.setItem('ffkajak_settings', oldActive);
    localStorage.setItem('ffkajak_custom_saved', oldCustom);

    await renderHook();
    await flushSettingsWrite();

    expect(current.settings).toEqual(DEFAULT_SETTINGS);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBeNull();
    expect(localStorage.getItem('ffkajak_settings')).toBe(oldActive);
    expect(localStorage.getItem('ffkajak_custom_saved')).toBe(oldCustom);
  });

  it('does not rewrite already-current records merely because a new app shell mounted', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(DEFAULT_SETTINGS));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(customSettings({
      maxWindSpeedSafe: 4.2,
    })));
    const setItem = vi.spyOn(Storage.prototype, 'setItem');

    await renderHook();
    await flushSettingsWrite();

    expect(setItem.mock.calls.some(([key]) => key === SETTINGS_STORAGE_KEY)).toBe(false);
    expect(setItem.mock.calls.some(([key]) => key === CUSTOM_SETTINGS_STORAGE_KEY)).toBe(false);
  });

  it('keeps an unreadable active record byte-for-byte until a deliberate user change', async () => {
    const unreadable = '{not-json';
    localStorage.setItem(SETTINGS_STORAGE_KEY, unreadable);

    await renderHook();
    await flushSettingsWrite();
    expect(current.settings).toEqual(DEFAULT_SETTINGS);
    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(unreadable);
    expect(localStorage.getItem(`${SETTINGS_STORAGE_KEY}_corrupt`)).toBeNull();

    await act(async () => current.setTripMode('pro'));
    await flushSettingsWrite();
    expect(localStorage.getItem(`${SETTINGS_STORAGE_KEY}_corrupt`)).toBe(unreadable);
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'pro',
      [SETTINGS_STORAGE_METADATA_KEY]: { schemaVersion: 1 },
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
      maxWindSpeedSafe: 4.3,
      tripMode: 'custom',
    }));
    await flushSettingsWrite();
    expect(localStorage.getItem(`${CUSTOM_SETTINGS_STORAGE_KEY}_corrupt`)).toBe(unreadableCustom);
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.3,
      [SETTINGS_STORAGE_METADATA_KEY]: { schemaVersion: 1 },
    });
  });

  it('uses a valid active Custom profile as recovery only when the user leaves that mode', async () => {
    const unreadableCustom = '{custom-not-json';
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(customSettings({
      maxWindSpeedSafe: 4.6,
      gustMargin: 1.6,
      daylightOnly: false,
    })));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, unreadableCustom);

    await renderHook();
    await flushSettingsWrite();
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.6,
      maxWindSpeedCaution: 6.2,
      daylightOnly: false,
    });
    // No mount-time destructive repair: a future app may understand these
    // bytes even though this one does not.
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBe(unreadableCustom);

    await act(async () => current.setTripMode('pro'));
    expect(localStorage.getItem(`${CUSTOM_SETTINGS_STORAGE_KEY}_corrupt`)).toBe(unreadableCustom);
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.6,
      maxWindSpeedCaution: 6.2,
      daylightOnly: false,
    });
  });

  it('keeps the save warning visible when only the remembered Custom slot fails', async () => {
    const initial = customSettings({ maxWindSpeedSafe: 5.5 });
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
      maxWindSpeedSafe: 4.1,
    }));
    await flushSettingsWrite();

    // The active record fit, but that success must not hide loss of the
    // remembered profile that selecting a preset will make authoritative.
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({ maxWindSpeedSafe: 4.1 });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({ maxWindSpeedSafe: 5.5 });
    expect(current.saveFailed).toBe(true);

    await act(async () => current.setTripMode('pro'));
    await flushSettingsWrite();
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({ tripMode: 'pro' });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({ maxWindSpeedSafe: 5.5 });
    expect(current.saveFailed).toBe(true);

    // Once that specific channel can persist again, its successful retry owns
    // clearing the warning; an unrelated active write never does.
    setItem.mockImplementation(function (this: Storage, key: string, value: string) {
      return nativeSetItem.call(this, key, value);
    });
    await act(async () => current.setTripMode('custom'));
    await flushSettingsWrite();
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({ maxWindSpeedSafe: 4.1 });
    expect(current.saveFailed).toBe(false);
  });

  it('remembers one location-scoped Custom profile across built-in mode changes', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(DEFAULT_SETTINGS));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(customSettings({
      maxWindSpeedSafe: 3.9,
      gustMargin: 1.4,
      daylightOnly: false,
    })));

    await renderHook();
    await act(async () => current.setTripMode('custom'));
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 3.9,
      maxWindSpeedCaution: 5.3,
      daylightOnly: false,
    });

    await act(async () => current.setTripMode('pro'));
    await act(async () => current.setTripMode('custom'));
    expect(current.settings).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 3.9,
      maxWindSpeedCaution: 5.3,
      daylightOnly: false,
    });
    await flushSettingsWrite();
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 3.9,
      maxWindSpeedCaution: 5.3,
      daylightOnly: false,
    });
  });

  it('merges an incoming storage event with a local field edit that is still pending', async () => {
    const initial = customSettings({
      maxWindSpeedSafe: 5.5,
      daylightOnly: true,
    });
    localStorage.setItem(SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, serializeStoredSettings(initial));

    await renderHook();
    await act(async () => {
      // This field has changed locally, but the 250ms persistence debounce has
      // not fired yet when the sibling tab publishes a different field.
      current.saveSettings({ ...current.settings, maxWindSpeedSafe: 4.0 });

      const remote = customSettings({
        maxWindSpeedSafe: 5.5,
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
      maxWindSpeedSafe: 4.0,
      daylightOnly: false,
    });

    await flushSettingsWrite();
    expect(storedRecord(SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.0,
      daylightOnly: false,
    });
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.0,
      daylightOnly: false,
    });
  });

  it('merges independent concurrent tab edits against the newest stored fields', async () => {
    const initial = customSettings({
      maxWindSpeedSafe: 5.5,
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
        pair[0].saveSettings({ ...pair[0].settings, maxWindSpeedSafe: 4.0 });
        pair[1].saveSettings({ ...pair[1].settings, daylightOnly: false });
      });
      await flushSettingsWrite();

      const persisted = storedRecord(SETTINGS_STORAGE_KEY);
      expect(persisted).toMatchObject({
        tripMode: 'custom',
        maxWindSpeedSafe: 4.0,
        daylightOnly: false,
      });
      expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
        tripMode: 'custom',
        maxWindSpeedSafe: 4.0,
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
      expect(pair[0].settings).toMatchObject({ maxWindSpeedSafe: 4.0, daylightOnly: false });
      expect(pair[1].settings).toMatchObject({ maxWindSpeedSafe: 4.0, daylightOnly: false });
    } finally {
      Reflect.deleteProperty(navigator, 'locks');
    }
  });
});
