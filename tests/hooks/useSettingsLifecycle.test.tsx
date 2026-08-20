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

type SettingsHook = ReturnType<typeof useSettings>;

let host: HTMLDivElement;
let root: Root;
let current: SettingsHook;

function Probe() {
  current = useSettings();
  return null;
}

async function renderHook() {
  await act(async () => {
    root.render(<Probe />);
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
  it('migrates active and remembered custom raw records in place without touching another location or forecast data', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
      ...DEFAULT_SETTINGS,
      tripMode: 'beginner',
    }));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, JSON.stringify(customSettings({
      maxWindSpeedSafe: 4.1,
      gustMargin: 1.7,
      tidePreference: 'incoming',
    })));
    const anotherLocationCustom = JSON.stringify(customSettings({ maxWindSpeedSafe: 6.2 }));
    localStorage.setItem('ffkajak_custom_saved_aarhus-bugt', anotherLocationCustom);
    localStorage.setItem('frank_weather_data_v2_horsens_api1_generation_example', '{"forecast":true}');

    await renderHook();
    expect(current.settings.tripMode).toBe('beginner');
    await flushSettingsWrite();

    expect(storedRecord(SETTINGS_STORAGE_KEY)).toHaveProperty(SETTINGS_STORAGE_METADATA_KEY);
    expect(storedRecord(CUSTOM_SETTINGS_STORAGE_KEY)).toMatchObject({
      tripMode: 'custom',
      maxWindSpeedSafe: 4.1,
      maxWindSpeedCaution: 5.8,
      gustMargin: 1.7,
      tidePreference: 'incoming',
    });
    expect(localStorage.getItem('ffkajak_custom_saved_aarhus-bugt')).toBe(anotherLocationCustom);
    expect(localStorage.getItem('frank_weather_data_v2_horsens_api1_generation_example')).toBe('{"forecast":true}');
  });

  it('cancels a delayed raw-format migration when another tab has already saved newer choices', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(customSettings({ maxWindSpeedSafe: 4.0 })));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, JSON.stringify(customSettings({ maxWindSpeedSafe: 4.0 })));

    await renderHook();

    const newerActive = JSON.stringify(customSettings({ maxWindSpeedSafe: 4.8 }));
    const newerCustom = JSON.stringify(customSettings({ maxWindSpeedSafe: 4.7 }));
    localStorage.setItem(SETTINGS_STORAGE_KEY, newerActive);
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, newerCustom);
    await flushSettingsWrite();

    expect(localStorage.getItem(SETTINGS_STORAGE_KEY)).toBe(newerActive);
    expect(localStorage.getItem(CUSTOM_SETTINGS_STORAGE_KEY)).toBe(newerCustom);
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
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
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
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(customSettings({
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

  it('remembers one location-scoped Custom profile across built-in mode changes', async () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(DEFAULT_SETTINGS));
    localStorage.setItem(CUSTOM_SETTINGS_STORAGE_KEY, JSON.stringify(customSettings({
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
});
