// localStorage.getItem itself throws when storage is blocked (private mode,
// cookie blockers) — a throw inside a useState initializer or a module-load
// read would blank the app, so every read goes through this guard.
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

type FrankStorage = Pick<Storage, 'key' | 'length' | 'removeItem'>;

function isFrankLocalStorageKey(key: string): boolean {
  return key.startsWith('ffkajak_')
    || key.startsWith('frank_weather_data_v2')
    || key === 'frank_location'
    || key === 'frank_theme_mode';
}

/**
 * Remove only FRANK-owned values and reload before mounted state can write any
 * of them back. github.io storage is shared by projects on the same origin, so
 * clearing the whole Storage object would risk deleting another app's data.
 */
export function clearFrankLocalDataAndReload(
  storage: FrankStorage = window.localStorage,
  reload: () => void = () => window.location.reload(),
): void {
  // Snapshot first: Storage indexes move whenever an entry is removed.
  const ownedKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && isFrankLocalStorageKey(key)) ownedKeys.push(key);
  }

  for (const key of ownedKeys) storage.removeItem(key);
  reload();
}
