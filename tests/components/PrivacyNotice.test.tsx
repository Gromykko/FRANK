import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import PrivacyNotice from '../../src/components/PrivacyNotice';
import { LanguageProvider } from '../../src/i18n';
import { clearFrankLocalDataAndReload } from '../../src/utils/storage';

let host: HTMLDivElement;
let root: Root;

beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = false;
});

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('ffkajak_lang', 'en');
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
});

describe('PrivacyNotice', () => {
  it('separates browser storage from hosting and provider privacy links', async () => {
    await act(async () => {
      root.render(<LanguageProvider><PrivacyNotice /></LanguageProvider>);
    });

    expect(host.querySelector('summary')?.textContent).toBe('About FRANK — data, privacy and version');
    expect(host.textContent).toContain('no user accounts, sets no cookies, does not track your GPS');
    expect(host.textContent).toContain('Served via Cloudflare and GitHub Pages.');
    expect(host.textContent).toContain('Privacy policies:');
    expect(host.textContent).not.toContain('Forecast data is provided by MET Norway, DMI, and MeteoAlarm');
  });

  it('links only to relevant platform technical and privacy sources', async () => {
    await act(async () => {
      root.render(<LanguageProvider><PrivacyNotice /></LanguageProvider>);
    });

    expect(host.querySelector('a[href*="docs.github.com/en/pages"]')).not.toBeNull();
    expect(host.querySelector('a[href*="developers.cloudflare.com/fundamentals/reference/http-headers"]')).toBeNull();
    expect(host.querySelector('a[href*="developers.cloudflare.com/workers/observability/logs"]')).not.toBeNull();
    expect(host.querySelector('a[href*="met.no/en/About-us/privacy"]')).not.toBeNull();
    expect(host.querySelector('a[href*="dmi.dk/friedata"]')).not.toBeNull();
    expect(host.querySelector('a[href*="api.meteoalarm.org/privacy"]')).not.toBeNull();
    expect(host.querySelector('a[href*="github.com/Gromykko/FRANK/issues"]')).toBeNull();
    expect(host.querySelector('a[href*="datatilsynet.dk"]')).toBeNull();
    expect(host.textContent).not.toContain('FRANK (Gromykko) is responsible');
  });

  it('requires confirmation before deleting browser data', async () => {
    localStorage.setItem('frank_location', 'vejle');

    await act(async () => {
      root.render(<LanguageProvider><PrivacyNotice /></LanguageProvider>);
    });

    const button = host.querySelector<HTMLButtonElement>('.privacy-delete')!;
    await act(async () => button.click());

    expect(localStorage.getItem('frank_location')).toBe('vejle');
    expect(button.textContent).toBe('Tap again to delete and reload');
    expect(host.querySelector('[role="status"]')?.textContent).toContain('reloads immediately');
  });

  it('removes only FRANK-owned values before reloading', () => {
    localStorage.setItem('frank_location', 'vejle');
    localStorage.setItem('frank_theme_mode', 'dark');
    localStorage.setItem('frank_weather_data_v2_horsens', '{"forecast":true}');
    localStorage.setItem('ffkajak_settings_horsens', '{"limits":true}');
    localStorage.setItem('another_project', 'keep-me');
    const reload = vi.fn(() => {
      expect(localStorage.getItem('frank_location')).toBeNull();
      expect(localStorage.getItem('ffkajak_lang')).toBeNull();
    });

    clearFrankLocalDataAndReload(localStorage, reload);

    expect(localStorage.getItem('frank_theme_mode')).toBeNull();
    expect(localStorage.getItem('frank_weather_data_v2_horsens')).toBeNull();
    expect(localStorage.getItem('ffkajak_settings_horsens')).toBeNull();
    expect(localStorage.getItem('another_project')).toBe('keep-me');
    expect(reload).toHaveBeenCalledOnce();
  });

  it('has a Danish label and interim disclosure', async () => {
    localStorage.removeItem('ffkajak_lang');

    await act(async () => {
      root.render(<LanguageProvider><PrivacyNotice /></LanguageProvider>);
    });

    expect(host.querySelector('summary')?.textContent).toBe('Om FRANK — data, privatliv og version');
    expect(host.textContent).toContain('ingen brugerkonti, sætter ingen cookies');
  });
});
