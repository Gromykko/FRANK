import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTheme } from '../../src/hooks/useTheme';

type ThemeHook = ReturnType<typeof useTheme>;

let host: HTMLDivElement;
let root: Root;
let current: ThemeHook;

function Probe() {
  current = useTheme();
  return null;
}

function installSystemTheme(initialDark: boolean) {
  let dark = initialDark;
  const listeners = new Set<() => void>();
  const query = {
    media: '(prefers-color-scheme: dark)',
    get matches() { return dark; },
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: () => void) => listeners.add(listener)),
    removeEventListener: vi.fn((_type: string, listener: () => void) => listeners.delete(listener)),
    addListener: vi.fn((listener: () => void) => listeners.add(listener)),
    removeListener: vi.fn((listener: () => void) => listeners.delete(listener)),
    dispatchEvent: vi.fn(() => true),
  } as unknown as MediaQueryList;
  const matchMedia = vi.fn(() => query);
  vi.stubGlobal('matchMedia', matchMedia);

  return {
    query,
    setDark(next: boolean) {
      dark = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

async function renderHook() {
  await act(async () => root.render(<Probe />));
}

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  localStorage.clear();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-source');
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-source');
  document.querySelectorAll('meta[name="theme-color"]').forEach((meta) => meta.remove());
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('useTheme', () => {
  it('starts light regardless of the OS and persists only an explicit user choice', async () => {
    const system = installSystemTheme(true);
    const lightMeta = document.createElement('meta');
    lightMeta.name = 'theme-color';
    lightMeta.media = '(prefers-color-scheme: light)';
    document.head.append(lightMeta);
    await renderHook();

    expect(current.themeMode).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(localStorage.getItem('frank_theme_mode')).toBeNull();

    await act(async () => system.setDark(false));
    expect(current.themeMode).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(lightMeta.content).toBe('#f5f7fa');
    expect(lightMeta.hasAttribute('media')).toBe(false);
    expect(localStorage.getItem('frank_theme_mode')).toBeNull();
    expect(system.query.addEventListener).not.toHaveBeenCalled();

    await act(async () => current.cycleThemeMode());
    expect(current.themeMode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(lightMeta.content).toBe('#0c1117');
    expect(localStorage.getItem('frank_theme_mode')).toBe('dark');
    expect(document.documentElement.dataset.themeSource).toBe('saved');

    await act(async () => {
      system.setDark(true);
      system.setDark(false);
    });
    expect(current.themeMode).toBe('dark');
  });

  it('uses the pre-paint saved marker even if storage becomes blocked before React starts', async () => {
    installSystemTheme(false);
    localStorage.setItem('frank_theme_mode', 'dark');
    const prepaintScript = readFileSync(resolve(process.cwd(), 'public/theme-init.js'), 'utf8');
    window.eval(prepaintScript);
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeSource).toBe('saved');

    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('storage blocked after initial document script');
    });
    await renderHook();

    expect(current.themeMode).toBe('dark');
    expect(document.documentElement.dataset.theme).toBe('dark');
    expect(document.documentElement.dataset.themeSource).toBe('saved');
  });
});
