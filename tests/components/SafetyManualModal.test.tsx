import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import locationData from '../../src/config/locations.json';
import type { ForecastLocation } from '../../src/config/locationTypes';
import SafetyManualModal from '../../src/components/SafetyManualModal';
import { getPresetSettings } from '../../src/features/safety/presets';
import { LanguageProvider } from '../../src/i18n';

const LOCATIONS = locationData as ForecastLocation[];

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
    expect(host.textContent).toContain('Chill · IPP 2: maximum mean wind 5.0 m/s; maximum significant waves 0.50 m.');
    expect(host.textContent).toContain('Medium · IPP 3: maximum mean wind 8.0 m/s; maximum significant waves 1.00 m.');
    expect(host.textContent).toContain('Pro · IPP 4: maximum mean wind 10.0 m/s; maximum significant waves 2.00 m.');
    expect(host.textContent).toContain('DKF did not publish them as safety limits');
    expect(host.textContent).toContain("The automatic 80% check point is FRANK's own headroom rule, not a threshold published by DKF or IPP.");
    expect(host.textContent?.match(/not a threshold published by DKF or IPP/g)).toHaveLength(1);
    expect(host.textContent).toContain('mean height of the highest third of waves');
    expect(host.textContent).toContain('Wave height is below 0.80 m.');
    expect(host.textContent).toContain('Wave height is from 0.80 through 1.00 m.');
    expect(host.textContent).toContain('Wave height is above 1.00 m.');
    expect(host.textContent).toContain('FRANK calculates the point at 80% and rounds it to the same precision as the forecast.');
    expect(host.textContent).toContain('remaining room is not a guaranteed safety margin');
    expect(host.textContent).toContain('10-minute mean wind at 10 m');
    expect(host.textContent).toContain('Mean wind is below 6.4 m/s, and any enabled gust check is below its own check point.');
    expect(host.textContent).toContain('Mean wind is from 6.4 through 8.0 m/s, or an enabled gust check is from its own check point through its maximum.');
    expect(host.textContent).toContain('Mean wind is above 8.0 m/s, or an enabled gust check is above its maximum.');
    expect(host.textContent).toContain('When mean wind and gusts both reach their check point, FRANK shows only the mean-wind explanation');
    expect(host.textContent).toContain('A gust explanation on its own means the gusts are high relative to the mean wind');
    expect(host.textContent).toContain('derived gust maximum of 1.6 times the mean-wind maximum');
    expect(host.textContent).toContain('mean-wind maximum of 8.0 m/s gives a derived gust maximum of 12.8 m/s');
    expect(host.textContent).toContain("The factor is FRANK's rule of thumb.");
    expect(host.textContent).not.toContain('not a limit published by DKF, IPP, WMO, or a kayak club');
    expect(host.textContent).toContain('the limit does not move with the weather it is meant to judge');
    expect(host.textContent).toContain('A gust is shown only as a number');
    expect(host.textContent).toContain('If you turn gust checking off, the forecast still shows gusts, but they do not affect the verdict.');
    expect(host.textContent).toContain('MET does not publish gusts for the longer-range 6- or 12-hour outlook blocks.');
    expect(host.textContent).toContain('These limits are optional and off by default');
    expect(host.textContent).toContain('FRANK estimated these broad area bearings and starting limits');
    expect(host.textContent).toContain('They are not club-published rules or a survey of every shoreline');
    expect(host.textContent).toContain('You can adjust the wind limits. The bearings stay fixed.');
    expect(host.textContent).toContain('An active sector uses the same automatic check-point rule as the general wind limit.');
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
    expect([...host.querySelectorAll<HTMLHeadingElement>('.manual-h')]
      .map((heading) => heading.textContent)
      .filter((heading) => /^\d+\./.test(heading ?? '')))
      .toEqual([
        '1. How rules combine',
        '2. Wind speed and gusts',
        '3. Wave height',
        '4. Water temperature',
        '5. Local wind sectors',
        '6. Weather conditions (rain, snow, sleet, fog and thunder)',
        '7. Daylight rule',
        '8. Launch windows',
      ]);
    expect(host.textContent).not.toContain('Take care threshold');
    expect(host.textContent).not.toContain('danger margin');
    expect(host.textContent).not.toMatch(/\bNormal\b/);
    expect(host.textContent).toContain('Forecast points and model grids');
    expect(host.querySelectorAll('.manual-coordinate-table tbody tr')).toHaveLength(LOCATIONS.length);
    for (const location of LOCATIONS) {
      expect(host.textContent).toContain(
        `${location.areaName}${location.coordinate.latitude.toFixed(6)}° N, ${location.coordinate.longitude.toFixed(6)}° E`,
      );
    }
    expect(host.textContent).toContain('interpolates its weather model to the requested point');
    expect(host.textContent).toContain('returns the closest model grid point for water and waves');
    expect(host.textContent).toContain('checks that a complete marine series is usable before it replaces the previous data');
    expect(host.textContent).toContain('The technical status page records the requested and returned points so the change can be investigated. It does not add a warning to the public forecast or change the verdict.');
    expect(host.querySelector('a[href*="forecast-data-edr-api"]')).not.toBeNull();
    expect(host.querySelector('a[href*="locationforecast/FAQ.html"]')).not.toBeNull();
    expect(host.textContent).toContain('See all weather ratings (41 conditions)');
    expect(host.querySelectorAll('.manual-weather-table tbody tr')).toHaveLength(10);
    expect(host.textContent).toContain('Light rainWithin limitsLight continuous rain alone does not raise the result.');
    expect(host.textContent).toContain('RainCheck before launchContinuous rain triggers Check before launch.');
    expect(host.textContent).toContain('Heavy rain showers or heavy rainNot recommendedHeavy precipitation is Not recommended.');
    expect(host.textContent).toContain('An unknown or missing code becomes Check before launch');
    expect(host.textContent).toContain('5. Local wind sectors');
    expect(host.textContent).not.toContain('4. Water level');
    expect(host.textContent).toContain('nearest model grid point');
    expect(host.textContent).toContain('planning context only');
    expect(host.textContent).toContain('does not change the safety verdict or filter launch windows');
    const gridDetails = host.querySelector('details.manual-details:not(.is-nested)');
    expect(gridDetails?.textContent).toContain('Water level comes from a storm-surge forecast model');
    expect(gridDetails?.textContent).toContain('Water level is shown for planning context only');
    expect(host.textContent).not.toContain('High Water Filter');
    expect(host.textContent).not.toContain('Low Water Filter');
    expect(host.textContent).not.toContain('Rising Only');
    expect(host.textContent).toContain('8. Launch windows');
    expect(host.textContent).toContain('A launch window is an unbroken green run that stays below every automatic check point');
    expect(host.textContent).toContain('Periods rated Check before launch remain visible in the forecast, but are not listed as launch windows');
    expect(host.textContent).toContain('they are not promoted into the green launch-window list');
    expect(host.textContent).toContain('When no window qualifies, FRANK says how many continuous stretches came close so you can find them on the timeline. It does not list them as windows.');
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
    expect(host.textContent).toContain('Bølgehøjden ligger fra 0.80 til og med 1.00 m.');
    expect(host.textContent).toContain('FRANK beregner punktet ved 80% og afrunder det til samme præcision som prognosen.');
    expect(host.textContent).toContain('Et rovindue er et ubrudt grønt forløb');
    expect(host.textContent).toContain('Perioder med Tjek før du tager på vandet kan stadig ses i prognosen, men vises ikke som rovinduer');
    expect(host.textContent).toContain('Prognosepunkter og modelgitre');
    expect(host.textContent).toContain('Se alle vejrvurderinger (41 forhold)');
    expect(host.textContent).toContain('Kraftige regnbyger eller kraftig regn');
    expect(host.textContent).toContain('Kraftig nedbør frarådes.');
    expect([...host.querySelectorAll<HTMLHeadingElement>('.manual-h')]
      .map((heading) => heading.textContent)
      .filter((heading) => /^\d+\./.test(heading ?? '')))
      .toEqual([
        '1. Sådan kombineres reglerne',
        '2. Vindstyrke og vindstød',
        '3. Bølgehøjde',
        '4. Vandtemperatur',
        '5. Lokale vindsektorer',
        '6. Vejrforhold (regn, sne, slud, tåge og torden)',
        '7. Dagslysregel',
        '8. Rovinduer',
      ]);
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
