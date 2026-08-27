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
  // The app no longer reads or migrates the retired ffkajak_* namespace, but
  // an explicit "delete local data" request must still remove those old,
  // FRANK-owned bytes rather than leave orphaned settings behind.
  return key.startsWith('frank_') || key.startsWith('ffkajak_');
}

function isFrankSettingsOrThemeKey(key: string): boolean {
  return key.startsWith('frank_settings_')
    || key.startsWith('frank_custom_saved_')
    || key === 'frank_last_trip_mode'
    || key === 'frank_theme_mode';
}

function removeMatchingKeys(
  storage: FrankStorage,
  matches: (key: string) => boolean,
): void {
  // Snapshot first: Storage indexes move whenever an entry is removed.
  const matchingKeys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key !== null && matches(key)) matchingKeys.push(key);
  }

  for (const key of matchingKeys) storage.removeItem(key);
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
  removeMatchingKeys(storage, isFrankLocalStorageKey);
  reload();
}

/**
 * Recover from a corrupt saved profile without erasing the location, language,
 * or offline forecast that the crash screen still needs to preserve.
 */
export function clearFrankSettingsAndTheme(
  storage: FrankStorage = window.localStorage,
): void {
  removeMatchingKeys(storage, isFrankSettingsOrThemeKey);
}
