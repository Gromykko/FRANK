import { useLayoutEffect, useState } from 'react';
import { readStorage } from '../utils/storage';

const THEME_STORAGE_KEY = 'frank_theme_mode';

// Keep the mobile browser chrome (theme-color) in sync with the manual
// light/dark toggle. The document starts light; an explicit saved choice wins.
const THEME_COLORS: Record<ThemeMode, string> = {
  light: '#f5f7fa',
  dark: '#0c1117',
};

export type ThemeMode = 'light' | 'dark';

interface ThemeState {
  mode: ThemeMode;
  saved: boolean;
}

function readSavedThemeMode(): ThemeMode | null {
  const saved = readStorage(THEME_STORAGE_KEY);
  return saved === 'dark' || saved === 'light' ? saved : null;
}

function readInitialThemeState(): ThemeState {
  const saved = readSavedThemeMode();
  if (saved) return { mode: saved, saved: true };

  // The tiny blocking head script may have read storage successfully before a
  // later browser policy blocked it. Its marker lets the hook retain that
  // explicit choice rather than immediately replacing it with the OS theme.
  try {
    const prepaint = document.documentElement.getAttribute('data-theme');
    if (
      document.documentElement.getAttribute('data-theme-source') === 'saved'
      && (prepaint === 'light' || prepaint === 'dark')
    ) {
      return { mode: prepaint, saved: true };
    }
  } catch {
    // The hook still has the light fallback below.
  }
  return { mode: 'light', saved: false };
}

export function useTheme() {
  const [theme, setTheme] = useState<ThemeState>(readInitialThemeState);

  // Layout timing keeps React's first committed frame aligned with the saved
  // head-script choice. The head script itself covers the earlier HTML/CSS
  // paint while the main bundle is still loading.
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', theme.mode);
    if (theme.saved) root.setAttribute('data-theme-source', 'saved');
    else root.removeAttribute('data-theme-source');

    document
      .querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')
      .forEach((meta) => {
        meta.removeAttribute('media');
        meta.setAttribute('content', THEME_COLORS[theme.mode]);
      });

    if (theme.saved) {
      try {
        localStorage.setItem(THEME_STORAGE_KEY, theme.mode);
      } catch {
        // Theme persistence is optional.
      }
    }
  }, [theme]);

  const cycleThemeMode = () => {
    setTheme((current) => ({
      mode: current.mode === 'light' ? 'dark' : 'light',
      saved: true,
    }));
  };

  return { themeMode: theme.mode, cycleThemeMode };
}
