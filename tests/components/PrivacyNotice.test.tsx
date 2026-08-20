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
  it('plainly separates browser, GitHub, Cloudflare, and weather-provider processing', async () => {
    await act(async () => {
      root.render(<LanguageProvider><PrivacyNotice /></LanguageProvider>);
    });

    expect(host.querySelector('summary')?.textContent).toBe('Technical data note');
    expect(host.textContent).toContain('not a complete legal privacy notice');
    expect(host.textContent).toContain('GitHub Pages serves the app files');
    expect(host.textContent).toContain('Cloudflare serves the forecast API');
    expect(host.textContent).toContain('MET Norway, DMI, and MeteoAlarm');
    expect(host.textContent).toContain('automatic request-and-response invocation logs are disabled');
    expect(host.textContent).toContain('3 days on Free plans and 7 days on paid plans');
  });

  it('links only to relevant platform technical and privacy sources', async () => {
    await act(async () => {
      root.render(<LanguageProvider><PrivacyNotice /></LanguageProvider>);
    });

    expect(host.querySelector('a[href*="docs.github.com/en/pages"]')).not.toBeNull();
    expect(host.querySelector('a[href*="developers.cloudflare.com/fundamentals/reference/http-headers"]')).not.toBeNull();
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

    expect(host.querySelector('summary')?.textContent).toBe('Teknisk datanote');
    expect(host.textContent).toContain('ikke en fuldstændig juridisk privatlivsmeddelelse');
  });
});
