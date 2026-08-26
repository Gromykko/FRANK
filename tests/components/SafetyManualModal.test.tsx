import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SafetyManualModal from '../../src/components/SafetyManualModal';
import { getPresetSettings } from '../../src/features/safety/presets';
import { LanguageProvider } from '../../src/i18n';

describe('SafetyManualModal profile evidence', () => {
  it('explains the thresholds, measurement clocks, local override, and primary sources', () => {
    localStorage.setItem('ffkajak_lang', 'en');
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <LanguageProvider>
        <SafetyManualModal settings={getPresetSettings('default')} onClose={vi.fn()} />
      </LanguageProvider>,
    );

    expect(host.textContent).toContain('Profile basis');
    expect(host.textContent).toContain('Chill · IPP 2: general wind Take care from 4.0 m/s and Rough from 5.0 m/s; significant waves Take care from 0.20 m and Rough from 0.50 m.');
    expect(host.textContent).toContain('Normal · IPP 3: general wind Take care from 6.0 m/s and Rough from 8.0 m/s; significant waves Take care from 0.30 m and Rough from 1.00 m.');
    expect(host.textContent).toContain('Pro · IPP 4: general wind Take care from 8.0 m/s and Rough from 10.0 m/s; significant waves Take care from 0.50 m and Rough from 2.00 m.');
    expect(host.textContent).toContain('not DKF-issued safety limits');
    expect(host.textContent).toContain('mean height of the highest third of waves');
    expect(host.textContent).toContain('10-minute mean wind at 10 m');
    expect(host.textContent).toContain('A gust is shown only as a number');
    expect(host.textContent).toContain('these can make a profile stricter');
    expect(host.textContent).toContain("Normal's general wind band starts Take care at exactly 6.0 m/s");
    expect(host.textContent).toContain('Good to go → Take care → Rough');
    expect(host.textContent).toContain('If any rule reaches Rough');
    expect(host.textContent).toContain('Take-care-only rules');
    expect(host.textContent).toContain('marked Take care');
    expect(host.textContent).toContain("Chill's 4 m/s and the lower wave Take care boundaries are FRANK's conservative choices");
    expect(host.querySelector('a[href*="ipp-roeruddannelse/touring-tur"]')).not.toBeNull();
    expect(host.querySelector('a[href*="14lUb_7t5ZV1vp49sOBmCmlXuOnSWmQMX"]')).not.toBeNull();
    expect(host.querySelector('a[href*="1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2"]')).not.toBeNull();
    expect(host.querySelector('a[href*="1YoO6StJ_nfwx2kb9X7lyH5y4gFQqp1O5"]')).not.toBeNull();
    expect(host.querySelector('a[href*="beaufortskalaen"]')).not.toBeNull();
    expect(host.querySelector('a[href*="bolger-pa-havet"]')).not.toBeNull();
    expect(host.querySelector('a[href*="locationforecast/datamodel"]')).not.toBeNull();
    expect(host.querySelector('a[href*="community.wmo.int"]')).not.toBeNull();
    localStorage.clear();
  });
});
