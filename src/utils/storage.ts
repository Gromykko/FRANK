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
