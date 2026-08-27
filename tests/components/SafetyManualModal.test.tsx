import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import SafetyManualModal from '../../src/components/SafetyManualModal';
import { getPresetSettings } from '../../src/features/safety/presets';
import { LanguageProvider } from '../../src/i18n';

describe('SafetyManualModal profile evidence', () => {
  it('explains the thresholds, measurement clocks, local override, and primary sources', () => {
    localStorage.setItem('frank_lang', 'en');
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <LanguageProvider>
        <SafetyManualModal settings={getPresetSettings('default')} onClose={vi.fn()} />
      </LanguageProvider>,
    );

    expect(host.textContent).toContain('Profile basis');
    expect(host.textContent).toContain('Beginner · IPP 2: general wind Take care from 4.0 m/s and Rough from 5.0 m/s; significant waves Take care from 0.20 m and Rough from 0.50 m.');
    expect(host.textContent).toContain('Intermediate · IPP 3: general wind Take care from 6.0 m/s and Rough from 8.0 m/s; significant waves Take care from 0.30 m and Rough from 1.00 m.');
    expect(host.textContent).toContain('Advanced · IPP 4: general wind Take care from 8.0 m/s and Rough from 10.0 m/s; significant waves Take care from 0.50 m and Rough from 2.00 m.');
    expect(host.textContent).toContain('DKF did not publish them as safety limits');
    expect(host.textContent).toContain('mean height of the highest third of waves');
    expect(host.textContent).toContain('10-minute mean wind at 10 m');
    expect(host.textContent).toContain('multiplies the mean-wind Take care and danger thresholds by 1.6');
    expect(host.textContent).toContain("FRANK's forecast heuristic, not a threshold published by DKF, IPP, WMO, or a kayak club");
    expect(host.textContent).toContain('one-time sample of 230 MET forecast hours');
    expect(host.textContent).toContain('not observed wind or a safety study');
    expect(host.textContent).toContain('A gust is shown only as a number');
    expect(host.textContent).toContain('These caps are optional and off by default');
    expect(host.textContent).toContain('FRANK-curated broad estimates for the area');
    expect(host.textContent).toContain('They are not club-published rules or a survey of every shoreline');
    expect(host.textContent).toContain('You can adjust the speed caps. The bearings stay fixed.');
    expect(host.textContent).toContain("Intermediate's general wind band starts Take care at exactly 6.0 m/s");
    expect(host.textContent).toContain('The DKF/IPP material behind these profiles does not publish separate numeric gust bands');
    expect(host.textContent).toContain('also treats gusts as relevant in an official kayak forecast');
    expect(host.textContent).toContain("The weather description follows MET Norway's official Weathericons legend");
    expect(host.textContent).toContain('Danish wording follows DMI weather terminology');
    expect(host.textContent).toContain('Each forecast description keeps its specific meaning');
    expect(host.textContent).not.toContain('symbol_code');
    expect(host.textContent).not.toContain('native condition');
    expect(host.textContent).not.toContain('MET decides');
    expect(host.textContent).toContain('only the controlling wind explanation is shown');
    expect(host.textContent).toContain('Good to go → Take care → Rough');
    expect(host.textContent).toContain('If any rule reaches Rough');
    expect(host.textContent).toContain('such as the daylight rule');
    expect(host.textContent).toContain('marked Take care');
    expect(host.textContent).toContain("Beginner's 4 m/s and the lower wave Take care boundaries are FRANK's conservative choices");
    expect(host.textContent).not.toMatch(/\b(?:Chill|Normal|Pro)\b/);
    expect(host.textContent).toContain('3. Local wind sectors');
    expect(host.textContent).toContain('9. Launch windows');
    expect(host.textContent).not.toContain('Wind-against-Water-Level');
    expect(host.textContent).not.toContain('wind-against-water clash');
    expect(host.textContent).not.toContain('detect rising or falling water');
    expect(host.querySelector('a[href*="ipp-roeruddannelse/touring-tur"]')).not.toBeNull();
    expect(host.querySelector('a[href*="14lUb_7t5ZV1vp49sOBmCmlXuOnSWmQMX"]')).not.toBeNull();
    expect(host.querySelector('a[href*="1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2"]')).not.toBeNull();
    expect(host.querySelector('a[href*="1YoO6StJ_nfwx2kb9X7lyH5y4gFQqp1O5"]')).not.toBeNull();
    expect(host.querySelector('a[href*="beaufortskalaen"]')).not.toBeNull();
    expect(host.querySelector('a[href*="bolger-pa-havet"]')).not.toBeNull();
    expect(host.querySelector('a[href*="locationforecast/datamodel"]')).not.toBeNull();
    expect(host.querySelector('a[href*="weather.gov/mqt/Local_Marine"]')).not.toBeNull();
    expect(host.querySelector('a[href*="community.wmo.int"]')).not.toBeNull();
    localStorage.clear();
  });

  it('renders the weather explanation in natural Danish without implementation jargon', () => {
    localStorage.setItem('frank_lang', 'da');
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <LanguageProvider>
        <SafetyManualModal settings={getPresetSettings('default')} onClose={vi.fn()} />
      </LanguageProvider>,
    );

    expect(host.textContent).toContain('Vejrbeskrivelsen følger MET Norways officielle Weathericons-symbolforklaring');
    expect(host.textContent).toContain('Den danske ordlyd følger DMI-vejrterminologi');
    expect(host.textContent).toContain('Hver vejrbeskrivelse beholder sin præcise betydning');
    expect(host.textContent).not.toContain('symbol_code');
    expect(host.textContent).not.toContain('native condition');
    localStorage.clear();
  });
});
