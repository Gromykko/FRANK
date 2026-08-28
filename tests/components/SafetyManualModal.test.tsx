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
    expect(host.textContent).toContain('Beginner · IPP 2: maximum mean wind 5.0 m/s; maximum significant waves 0.50 m.');
    expect(host.textContent).toContain('Intermediate · IPP 3: maximum mean wind 8.0 m/s; maximum significant waves 1.00 m.');
    expect(host.textContent).toContain('Advanced · IPP 4: maximum mean wind 10.0 m/s; maximum significant waves 2.00 m.');
    expect(host.textContent).toContain('DKF did not publish them as safety limits');
    expect(host.textContent).toContain('mean height of the highest third of waves');
    expect(host.textContent).toContain('10-minute mean wind at 10 m');
    expect(host.textContent).toContain('derived gust maximum of 1.6 times the mean-wind maximum');
    expect(host.textContent).toContain('mean-wind maximum of 8.0 m/s gives a derived gust maximum of 12.8 m/s');
    expect(host.textContent).toContain("FRANK's rule of thumb, not a limit published by DKF, IPP, WMO, or a kayak club");
    expect(host.textContent).toContain('the limit does not move with the weather it is meant to judge');
    expect(host.textContent).toContain('A gust is shown only as a number');
    expect(host.textContent).toContain('If you turn gust checking off, the forecast still shows gusts, but they do not affect the verdict.');
    expect(host.textContent).toContain('MET does not publish gusts for the longer-range 6- or 12-hour outlook blocks.');
    expect(host.textContent).toContain('These limits are optional and off by default');
    expect(host.textContent).toContain('FRANK estimated these broad area bearings and starting limits');
    expect(host.textContent).toContain('They are not club-published rules or a survey of every shoreline');
    expect(host.textContent).toContain('You can adjust the wind limits. The bearings stay fixed.');
    expect(host.textContent).toContain('The DKF/IPP material behind these profiles does not publish separate numeric gust bands');
    expect(host.textContent).toContain('also treats gusts as relevant in an official kayak forecast');
    expect(host.textContent).toContain("The weather description follows MET Norway's official Weathericons legend");
    expect(host.textContent).toContain('Danish wording follows DMI weather terminology');
    expect(host.textContent).toContain('Each forecast description keeps its specific meaning');
    expect(host.textContent).not.toContain('symbol_code');
    expect(host.textContent).not.toContain('native condition');
    expect(host.textContent).not.toContain('MET decides');
    expect(host.textContent).toContain('only the controlling wind explanation is shown');
    expect(host.textContent).toContain('Within limits → Check before launch → Not recommended');
    expect(host.textContent).toContain('If any rule says Not recommended');
    expect(host.textContent).toContain('such as the daylight rule');
    expect(host.textContent).toContain('marks those hours Check before launch');
    expect(host.textContent).not.toContain('Take care threshold');
    expect(host.textContent).not.toContain('danger margin');
    expect(host.textContent).not.toMatch(/\b(?:Chill|Normal|Pro)\b/);
    expect(host.textContent).toContain('3. Local wind sectors');
    expect(host.textContent).toContain('4. Water level');
    expect(host.textContent).toContain('nearest model grid point');
    expect(host.textContent).toContain('planning context only');
    expect(host.textContent).toContain('does not change the safety verdict or filter launch windows');
    expect(host.textContent).not.toContain('High Water Filter');
    expect(host.textContent).not.toContain('Low Water Filter');
    expect(host.textContent).not.toContain('Rising Only');
    expect(host.textContent).toContain('9. Launch windows');
    expect(host.textContent).not.toContain('Wind-against-Water-Level');
    expect(host.textContent).not.toContain('wind-against-water clash');
    expect(host.textContent).not.toContain('detect rising or falling water');
    expect(host.textContent).toContain('default 15°C check');
    expect(host.textContent).toContain('default 10°C boundary');
    expect(host.querySelector('a[href*="ipp-roeruddannelse/touring-tur"]')).not.toBeNull();
    expect(host.querySelector('a[href*="14lUb_7t5ZV1vp49sOBmCmlXuOnSWmQMX"]')).not.toBeNull();
    expect(host.querySelector('a[href*="1iagdhW-B3ZXvHUmEBSfxVESyne5qevb2"]')).not.toBeNull();
    expect(host.querySelector('a[href*="1YoO6StJ_nfwx2kb9X7lyH5y4gFQqp1O5"]')).not.toBeNull();
    expect(host.querySelector('a[href*="beaufortskalaen"]')).not.toBeNull();
    expect(host.querySelector('a[href*="bolger-pa-havet"]')).not.toBeNull();
    expect(host.querySelector('a[href*="locationforecast/datamodel"]')).not.toBeNull();
    expect(host.querySelector('a[href*="weather.gov/mqt/Local_Marine"]')).not.toBeNull();
    expect(host.querySelector('a[href*="community.wmo.int"]')).not.toBeNull();
    expect(host.querySelector('a[href*="rnli.org/water-safety/know-the-risks/cold-water-shock"]')).not.toBeNull();
    expect(host.querySelector('a[href*="soesport.dk/redning-og-sikkerhed/kulde-og-beklaedning"]')).not.toBeNull();
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

  it('keeps a distinct cold-water check range in the explanation', () => {
    localStorage.setItem('frank_lang', 'en');
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
      <LanguageProvider>
        <SafetyManualModal settings={getPresetSettings('default')} onClose={vi.fn()} />
      </LanguageProvider>,
    );

    expect(host.textContent).toContain('≥ 15°C: Within the selected temperature limits.');
    expect(host.textContent).toContain('> 10°C and < 15°C: Check before launch.');
    expect(host.textContent).toContain('≤ 10°C: Not recommended');
    expect(host.textContent).not.toContain('no separate Check before launch range');
    localStorage.clear();
  });
});
