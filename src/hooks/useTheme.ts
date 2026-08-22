import { useEffect, useLayoutEffect, useState } from 'react';
import { readStorage } from '../utils/storage';

const THEME_STORAGE_KEY = 'frank_theme_mode';

// Keep the mobile browser chrome (theme-color) in sync with the manual
// light/dark toggle, which overrides the OS-preference meta tags in index.html.
const THEME_COLORS: Record<ThemeMode, string> = {
  light: '#f5f7fa',
  dark: '#0c1117',
};

export type ThemeMode = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  followsSystem: boolean;
}

function readSavedThemeMode(): ThemeMode | null {
  const saved = readStorage(THEME_STORAGE_KEY);
  return saved === 'dark' || saved === 'light' ? saved : null;
}

// First visit follows the OS preference; only an explicit toggle is persisted,
// so an OS-dark user isn't force-stamped into the light theme before they've
// touched anything.
function systemThemeMode(): ThemeMode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function readInitialThemeState(): ThemeState {
  const saved = readSavedThemeMode();
  if (saved) return { mode: saved, followsSystem: false };

  // The tiny blocking head script may have read storage successfully before a
  // later browser policy blocked it. Its marker lets the hook retain that
  // explicit choice rather than immediately replacing it with the OS theme.
  try {
    const prepaint = document.documentElement.getAttribute('data-theme');
    if (
      document.documentElement.getAttribute('data-theme-source') === 'saved'
      && (prepaint === 'light' || prepaint === 'dark')
    ) {
      return { mode: prepaint, followsSystem: false };
    }
  } catch {
    // The hook still has the system fallback below.
  }
  return { mode: systemThemeMode(), followsSystem: true };
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeState>(readInitialThemeState);

  // Layout timing keeps React's first committed frame aligned with the saved
  // head-script choice. The head script itself covers the earlier HTML/CSS
  // paint while the main bundle is still loading.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme.mode);
    if (theme.followsSystem) root.removeAttribute('data-theme-source');
    else root.setAttribute('data-theme-source', 'saved');

    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.removeAttribute('media');
        meta.setAttribute('content', THEME_COLORS[theme.mode]);
      });

    if (!theme.followsSystem) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme.mode);
      } catch {
        // Theme persistence is optional.
      }
    }
  }, [theme]);

  useEffect(() => {
    if (!theme.followsSystem) return;

    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }

    const syncSystemTheme = () => {
      const mode = query.matches ? 'dark' : 'light';
      setTheme((current) => (
        current.followsSystem && current.mode !== mode
          ? { ...current, mode }
          : current
      ));
    };
    syncSystemTheme();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', syncSystemTheme);
      return () => query.removeEventListener('change', syncSystemTheme);
    }
    query.addListener(syncSystemTheme);
    return () => query.removeListener(syncSystemTheme);
  }, [theme.followsSystem]);

  const cycleThemeMode = () => {
    setTheme((current) => ({
      mode: current.mode === 'light' ? 'dark' : 'light',
      followsSystem: false,
    }));
  };

  return { themeMode: theme.mode, cycleThemeMode };
}
