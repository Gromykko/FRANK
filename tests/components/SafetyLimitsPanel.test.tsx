import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';
import SafetyLimitsPanel from '../../src/components/SafetyLimitsPanel';
import { getPresetSettings } from '../../src/features/safety/presets';
import { LanguageProvider } from '../../src/i18n';

describe('SafetyLimitsPanel terminology', () => {
  it('shows the live Take care boundaries and unambiguous wind/wave controls', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('ffkajak_lang', 'en');
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

      expect(host.textContent).toContain('Wind — Take care from');
      expect(host.textContent).toContain('Waves — Take care from');
      expect(host.textContent).toContain('Take care from');
      expect(host.textContent).toContain('Danger from');
      expect(host.textContent).toContain('Take care from 6.0 m/s; +2.0 m/s sets Danger from 8.0 m/s.');
      expect(host.textContent).toContain('Take care from 0.30 m; +0.70 m sets Danger from 1.00 m.');
      expect(host.textContent).not.toContain('Max Wind');
      expect(host.textContent).not.toContain('Max Wave');
      expect(host.textContent).not.toContain('Safe cap');

      const labels = [...host.querySelectorAll('[aria-label]')]
        .map((element) => element.getAttribute('aria-label'));
      expect(labels).toContain('Wind limit enabled');
      expect(labels).toContain('Check wind gusts');
      expect(labels).toContain('Wave-height limit enabled');
      expect(labels).toContain('Show Take care wave band');
      expect(labels).toContain('Increase wind Take care threshold; Danger stays 2.0 m/s above');
      expect(labels).toContain('Increase wind Take care-to-Danger gap');
      expect(labels).toContain('Increase wave Take care threshold; Danger stays 0.70 m above');
      expect(labels).toContain('Increase wave Take care-to-Danger gap');
      expect(labels.some((label) => label?.includes('Take care threshold'))).toBe(true);
      expect(
        labels.some((label) => label?.toLowerCase().includes('danger threshold')),
        labels.join('\n'),
      ).toBe(true);

      const sectors = [...host.querySelectorAll<HTMLElement>('.sector-block')];
      expect(sectors).toHaveLength(2);
      expect(host.querySelector('.sector-chip')).toBeNull();
      expect(sectors[0].textContent).toContain('Easterly');
      expect(sectors[0].textContent).toContain('from E');
      expect(sectors[0].textContent?.match(/onshore/gi)).toHaveLength(1);
      expect(sectors[1].textContent).toContain('Westerly');
      expect(sectors[1].textContent).toContain('from W');
      expect(sectors[1].textContent?.match(/offshore/gi)).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('keeps each configured gap attached when either linked threshold moves', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('ffkajak_lang', 'en');
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

      const click = async (label: string) => {
        await act(async () => {
          host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!.click();
        });
        return updateSettings.mock.calls.at(-1)?.[0];
      };

      expect(await click('Increase wind Take care threshold; Danger stays 2.0 m/s above'))
        .toMatchObject({ maxWindSpeedSafe: 6.5, maxWindSpeedCaution: 8.5, gustMargin: 2.0 });
      expect(await click('Increase wind Take care-to-Danger gap'))
        .toMatchObject({ maxWindSpeedSafe: 6.0, maxWindSpeedCaution: 8.5, gustMargin: 2.5 });
      expect(await click('Increase wave Take care threshold; Danger stays 0.70 m above'))
        .toMatchObject({ maxWaveHeightSafe: 0.35, maxWaveHeightCaution: 1.05, waveCautionMargin: 0.7 });
      expect(await click('Increase wave Take care-to-Danger gap'))
        .toMatchObject({ maxWaveHeightSafe: 0.3, maxWaveHeightCaution: 1.05, waveCautionMargin: 0.75 });
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });

  it('keeps each Danish exposure word in the description instead of repeating a chip', async () => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.setItem('ffkajak_lang', 'da');
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
