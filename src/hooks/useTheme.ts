import { useEffect, useLayoutEffect, useState } from 'react';
import { readStorage } from '../utils/storage';

const THEME_STORAGE_KEY = 'frank_theme_mode';

// Keep the mobile browser chrome (theme-color) in sync with the resolved
// theme, whether that came from the OS or from the manual toggle.
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

// Until someone touches the toggle, the OS decides. Stamping every first
// visit light ignores a phone that is set to dark, and on an installed PWA
// it leaves a light document sitting under a dark system status bar.
function systemThemeMode(): ThemeMode {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
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
    // The hook still has the OS fallback below.
  }
  return { mode: systemThemeMode(), saved: false };
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

  // A phone that flips to dark at sunset should take the app with it, but only
  // for someone who has never pressed the toggle. One explicit press ends this
  // for good - that is what `saved` means.
  useEffect(() => {
    if (theme.saved) return;

    let query: MediaQueryList;
    try {
      query = window.matchMedia('(prefers-color-scheme: dark)');
    } catch {
      return;
    }

    const syncSystemTheme = () => {
      const mode = query.matches ? 'dark' : 'light';
      setTheme((current) => (
        current.saved || current.mode === mode ? current : { ...current, mode }
      ));
    };
    syncSystemTheme();
    query.addEventListener('change', syncSystemTheme);
    return () => query.removeEventListener('change', syncSystemTheme);
  }, [theme.saved]);

  const cycleThemeMode = () => {
    setTheme((current) => ({
      mode: current.mode === 'light' ? 'dark' : 'light',
      saved: true,
    }));
  };

  return { themeMode: theme.mode, cycleThemeMode };
}
