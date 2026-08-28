import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import SafetyLimitsPanel from '../../src/components/SafetyLimitsPanel';
import { getPresetSettings } from '../../src/features/safety/presets';
import { LanguageProvider } from '../../src/i18n';

describe('SafetyLimitsPanel terminology', () => {
  it('shows one explicit maximum for wind, waves, and each optional sector', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('frank_lang', 'en');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const updateSettings = vi.fn();

    try {
      await act(async () => {
        root.render(
          <LanguageProvider>
            <SafetyLimitsPanel
              settings={getPresetSettings('default')}
              updateSettings={updateSettings}
              saveFailed={false}
            />
          </LanguageProvider>,
        );
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.collapse-title-btn')!.click();
      });

      // Launch-window criteria are everyday controls, so they stay visible.
      // Only the optional, locally estimated wind sectors remain collapsed.
      expect(host.textContent).toContain('Planning rules');
      expect(host.textContent).toContain('Min Duration');
      expect(host.textContent).toContain('Daylight Only');
      expect(host.querySelector('.advanced-toggle')?.textContent).toContain('Optional local wind sectors');
      expect(host.querySelector('.sector-panel')).toBeNull();

      await act(async () => {
        host.querySelector<HTMLButtonElement>('.advanced-toggle')!.click();
      });

      expect(host.textContent).toContain('Maximum wind');
      expect(host.textContent).toContain('Pick Chill, Medium, or Pro');
      expect(host.textContent).toContain('Maximum waves');
      expect(host.textContent).toContain('Use forecast gusts in the verdict');
      expect(host.textContent).toContain('Check from 6.4 m/s · Not recommended above 8.0 m/s');
      expect(host.textContent).toContain('Check from 0.80 m · Not recommended above 1.00 m');
      expect(host.textContent).toContain('Check from 10.2 m/s · derived maximum 12.8 m/s (1.6× the wind maximum).');
      expect(host.textContent).toContain('FRANK calculates each Check before launch point at 80%');
      expect(host.textContent).toContain('not an official DKF or IPP threshold');
      const liveAnnouncements = [...host.querySelectorAll('[aria-live="polite"]')]
        .map((element) => element.textContent ?? '');
      expect(liveAnnouncements.some((text) => text.includes('Wind check from 6.4 m/s'))).toBe(true);
      expect(liveAnnouncements.some((text) => text.includes('gusts are checked from 10.2 m/s'))).toBe(true);
      expect(liveAnnouncements.some((text) => text.includes('Wave check from 0.80 m'))).toBe(true);
      expect(host.textContent).toContain('Check below 15°C · Not recommended at or below 10°C');
      expect(host.textContent).not.toContain('Cold-water margin');
      expect(host.textContent).not.toContain('Gap to Danger');
      expect(host.textContent).not.toContain('Wind — Take care from');
      expect(host.textContent).not.toContain('Waves — Take care from');
      expect(host.querySelector('.advanced-toggle')?.textContent).not.toContain('water level');
      expect(host.textContent).not.toContain('Preferred water level for launching');
      expect(host.textContent).not.toContain('Any Level');
      expect(host.textContent).not.toContain('High Water');
      expect(host.textContent).not.toContain('Low Water');
      expect(host.textContent).not.toContain('Rising');
      expect(host.querySelectorAll('.zone-bar.has-maximum')).toHaveLength(2);

      const labels = [...host.querySelectorAll('[aria-label]')]
        .map((element) => element.getAttribute('aria-label'));
      expect(labels).not.toContain('Water level');
      expect(labels).toContain('Wind limit enabled');
      expect(labels).toContain('Use forecast gusts in the verdict');
      expect(labels).toContain('Apply optional wind-sector limits');
      expect(labels).toContain('Wave-height limit enabled');
      expect(labels).toContain('Increase Maximum wind');
      expect(labels).toContain('Increase Maximum waves');
      expect(labels).toContain('Increase water temperature check boundary');
      expect(labels).toContain('Increase water temperature Not recommended boundary');
      expect(labels).toContain('Increase Easterly maximum wind');
      expect(labels).toContain('Increase Westerly maximum wind');
      expect(labels).not.toContain('Use Take care wave band in verdict');
      expect(labels.some((label) => /near-limit|80%|caution point/i.test(label ?? ''))).toBe(false);

      const sectors = [...host.querySelectorAll<HTMLElement>('.sector-block')];
      expect(sectors).toHaveLength(2);
      expect(host.querySelector('.sector-chip')).toBeNull();
      expect(sectors[0].textContent).toContain('Easterly');
      expect(sectors[0].textContent).toContain('from E');
      expect(sectors[0].textContent?.match(/onshore/gi)).toHaveLength(1);
      expect(sectors[1].textContent).toContain('Westerly');
      expect(sectors[1].textContent).toContain('from W');
      expect(sectors[1].textContent?.match(/offshore/gi)).toHaveLength(1);
      expect(host.textContent).toContain('broad FRANK estimates');
      expect(host.textContent).toContain('not current kayak-club rules');

      // All judged profiles start with the optional sector rule off. Its fixed
      // bearings and speeds remain visible for inspection, but cannot be edited
      // until the user explicitly opts in.
      expect(host.querySelector('.sector-panel')?.getAttribute('aria-disabled')).toBe('true');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Increase Easterly maximum wind"]')?.disabled).toBe(true);
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Increase Westerly maximum wind"]')?.disabled).toBe(true);

      await act(async () => {
        host.querySelector<HTMLButtonElement>('[aria-label="Apply optional wind-sector limits"]')!.click();
      });
      expect(updateSettings).toHaveBeenLastCalledWith(expect.objectContaining({
        tripMode: 'custom',
        enableCustomWindDirs: true,
      }));
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('edits the wind and wave maximums directly with no derived gap fields', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('frank_lang', 'en');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const updateSettings = vi.fn();

    try {
      await act(async () => {
        root.render(
          <LanguageProvider>
            <SafetyLimitsPanel
              settings={{
                ...getPresetSettings('default'),
                waterTempTakeCareBelow: 10,
                waterTempDangerBelow: 8,
              }}
              updateSettings={updateSettings}
              saveFailed={false}
            />
          </LanguageProvider>,
        );
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.collapse-title-btn')!.click();
      });

      const click = async (label: string) => {
        await act(async () => {
          host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
        });
        return updateSettings.mock.calls.at(-1)?.[0];
      };

      const windUpdate = await click('Increase Maximum wind');
      expect(windUpdate).toMatchObject({ windLimit: 8.5 });
      expect(windUpdate).not.toHaveProperty('windTakeCareAt');
      expect(windUpdate).not.toHaveProperty('windDangerGap');

      const waveUpdate = await click('Increase Maximum waves');
      expect(waveUpdate).toMatchObject({ waveLimit: 1.05 });
      expect(waveUpdate).not.toHaveProperty('waveTakeCareAt');
      expect(waveUpdate).not.toHaveProperty('waveDangerGap');

      const checkTemperatureUpdate = await click('Decrease water temperature check boundary');
      expect(checkTemperatureUpdate).toMatchObject({
        waterTempTakeCareBelow: 9,
        waterTempDangerBelow: 8,
      });

      const notRecommendedTemperatureUpdate = await click('Increase water temperature Not recommended boundary');
      expect(notRecommendedTemperatureUpdate).toMatchObject({
        waterTempTakeCareBelow: 10,
        waterTempDangerBelow: 9,
      });
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('enables the visible sector speed editors only after the optional rule is on', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('frank_lang', 'en');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <LanguageProvider>
            <SafetyLimitsPanel
              settings={{ ...getPresetSettings('default'), enableCustomWindDirs: true }}
              updateSettings={vi.fn()}
              saveFailed={false}
            />
          </LanguageProvider>,
        );
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.collapse-title-btn')!.click();
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.advanced-toggle')!.click();
      });

      expect(host.querySelector('.sector-panel')?.getAttribute('aria-disabled')).toBe('false');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Increase Easterly maximum wind"]')?.disabled).toBe(false);
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Increase Westerly maximum wind"]')?.disabled).toBe(false);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('keeps the optional sector controls subordinate to the main wind switch', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('frank_lang', 'en');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <LanguageProvider>
            <SafetyLimitsPanel
              settings={{
                ...getPresetSettings('default'),
                enableWindSpeed: false,
                enableCustomWindDirs: true,
              }}
              updateSettings={vi.fn()}
              saveFailed={false}
            />
          </LanguageProvider>,
        );
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.collapse-title-btn')!.click();
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.advanced-toggle')!.click();
      });

      const sectorToggle = host.querySelector<HTMLButtonElement>('[aria-label="Apply optional wind-sector limits"]');
      expect(sectorToggle?.disabled).toBe(true);
      expect(sectorToggle?.getAttribute('aria-checked')).toBe('false');
      expect(host.querySelector('.sector-panel')?.getAttribute('aria-disabled')).toBe('true');
      expect(host.querySelector<HTMLButtonElement>('[aria-label="Increase Easterly maximum wind"]')?.disabled).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('keeps each Danish exposure word in the description instead of repeating a chip', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('frank_lang', 'da');
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(
          <LanguageProvider>
            <SafetyLimitsPanel
              settings={getPresetSettings('default')}
              updateSettings={vi.fn()}
              saveFailed={false}
            />
          </LanguageProvider>,
        );
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.collapse-title-btn')!.click();
      });
      await act(async () => {
        host.querySelector<HTMLButtonElement>('.advanced-toggle')!.click();
      });

      const sectors = [...host.querySelectorAll<HTMLElement>('.sector-block')];
      expect(sectors).toHaveLength(2);
      expect(host.querySelector('.sector-chip')).toBeNull();
      expect(sectors[0].textContent).toContain('Østlig');
      expect(sectors[0].textContent).toContain('fra Ø');
      expect(sectors[0].textContent?.match(/pålandsvind/gi)).toHaveLength(1);
      expect(sectors[1].textContent).toContain('Vestlig');
      expect(sectors[1].textContent).toContain('fra V');
      expect(sectors[1].textContent?.match(/fralandsvind/gi)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
