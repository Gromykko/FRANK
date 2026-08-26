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
      expect(host.textContent).not.toContain('Max Wind');
      expect(host.textContent).not.toContain('Max Wave');
      expect(host.textContent).not.toContain('Safe cap');

      const labels = [...host.querySelectorAll('[aria-label]')]
        .map((element) => element.getAttribute('aria-label'));
      expect(labels).toContain('Wind limit enabled');
      expect(labels).toContain('Check wind gusts');
      expect(labels).toContain('Wave-height limit enabled');
      expect(labels).toContain('Show Take care wave band');
      expect(labels.some((label) => label?.includes('wind Take care threshold'))).toBe(true);
      expect(labels.some((label) => label?.includes('wave Take care threshold'))).toBe(true);
      expect(labels.some((label) => label?.includes('Take care threshold'))).toBe(true);
      expect(
        labels.some((label) => label?.toLowerCase().includes('danger threshold')),
        labels.join('\n'),
      ).toBe(true);
    } finally {
      await act(async () => root.unmount());
      host.remove();
      localStorage.clear();
      globalThis.IS_REACT_ACT_ENVIRONMENT = false;
    }
  });
});
