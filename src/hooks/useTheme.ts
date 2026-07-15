import { useEffect, useRef, useState } from 'react';
import { readStorage } from '../utils/storage';

const THEME_STORAGE_KEY = 'frank_theme_mode';

// Keep the mobile browser chrome (theme-color) in sync with the manual
// light/dark toggle, which overrides the OS-preference meta tags in index.html.
const THEME_COLORS: Record<ThemeMode, string> = {
  light: '#f5f7fa',
  dark: '#0c1117',
};

export type ThemeMode = 'light' | 'dark';

function readSavedThemeMode(): ThemeMode | null {
  const saved = readStorage(THEME_STORAGE_KEY);
  return saved === 'dark' || saved === 'light' ? saved : null;
}

// First visit follows the OS preference; only an explicit toggle is persisted,
// so an OS-dark user isn't force-stamped into the light theme before they've
// touched anything.
function readInitialThemeMode(): ThemeMode {
  const saved = readSavedThemeMode();
  if (saved) return saved;
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(readInitialThemeMode);
  // Persist only once the user has chosen (had a saved value, or toggled).
  const hasExplicitChoice = useRef<boolean>(readSavedThemeMode() !== null);

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', themeMode);

    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.removeAttribute('media');
        meta.setAttribute('content', THEME_COLORS[themeMode]);
      });

    if (hasExplicitChoice.current) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, themeMode);
      } catch {
        // Theme persistence is optional.
      }
    }
  }, [themeMode]);

  const cycleThemeMode = () => {
    hasExplicitChoice.current = true;
    setThemeMode((current) => (current === 'light' ? 'dark' : 'light'));
  };

  return { themeMode, cycleThemeMode };
}
