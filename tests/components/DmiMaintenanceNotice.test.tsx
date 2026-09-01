import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it } from 'vitest';
import DmiMaintenanceNotice from '../../src/components/DmiMaintenanceNotice';
import {
  DMI_MAINTENANCE_END_MS,
  DMI_MAINTENANCE_START_MS,
  shouldShowDmiMaintenanceNotice,
} from '../../src/components/dmiMaintenanceNoticePolicy';
import { LanguageProvider } from '../../src/i18n';

import type { WeatherData } from '../../src/features/forecast/types';

type CacheHealth = WeatherData['sources']['cacheHealth'];

const ACTIVE_MS = Date.parse('2026-09-01T10:00:00+02:00');
const STALE_MARINE_HEALTH: CacheHealth = {
  status: 'stale',
  lastAttemptAt: '2026-09-01T07:55:00.000Z',
  marineInstances: {
    water: { collection: 'dkss_idw', id: '2026-09-01T000000Z' },
    waves: { collection: 'wam_dw', id: '2026-08-31T180000Z' },
  },
};

const FRESH_MARINE_INSTANCES = {
  water: { collection: 'dkss_idw', id: '2026-09-01T000000Z' },
  waves: { collection: 'wam_dw', id: '2026-09-01T000000Z' },
};

function renderNotice(
  cacheHealth: CacheHealth,
  nowMs = ACTIVE_MS,
  danish = false,
  online = true,
  refreshFailureConfirmed = cacheHealth?.status === 'stale',
) {
  if (danish) localStorage.setItem('frank_lang', 'da');

  const markup = renderToStaticMarkup(
    danish ? (
      <LanguageProvider>
        <DmiMaintenanceNotice
          cacheHealth={cacheHealth}
          nowMs={nowMs}
          online={online}
          refreshFailureConfirmed={refreshFailureConfirmed}
        />
      </LanguageProvider>
    ) : (
      <DmiMaintenanceNotice
        cacheHealth={cacheHealth}
        nowMs={nowMs}
        online={online}
        refreshFailureConfirmed={refreshFailureConfirmed}
      />
    ),
  );
  const container = document.createElement('div');
  container.innerHTML = markup;
  return container;
}

beforeEach(() => localStorage.clear());

describe('DmiMaintenanceNotice', () => {
  it('shows one collapsed, sourced notice while marine data is older than its fallback limit', () => {
    const container = renderNotice(STALE_MARINE_HEALTH);
    const notice = container.querySelector('details.provider-maintenance-notice');

    expect(notice).not.toBeNull();
    expect(notice?.hasAttribute('open')).toBe(false);
    expect(notice?.querySelector('summary')?.textContent)
      .toBe('DMI maintenance may delay wave and water-level forecasts');
    expect(notice?.textContent).toContain('FRANK keeps the latest complete forecast');
    expect(notice?.querySelector('a')).toMatchObject({
      href: 'https://www.dmi.dk/friedata/dokumentation-paa-engelsk',
      target: '_blank',
      rel: 'noreferrer',
    });
  });

  it('shows for a delayed marine source but not for weather-only degradation', () => {
    const marine: CacheHealth = {
      status: 'current',
      lastAttemptAt: '2026-09-01T07:55:00.000Z',
      degradedSources: ['waves'],
    };
    const weather: CacheHealth = {
      ...marine,
      degradedSources: ['weather'],
      marineInstances: FRESH_MARINE_INSTANCES,
    };

    expect(renderNotice(marine).querySelector('details')).not.toBeNull();
    expect(renderNotice(weather).querySelector('details')).toBeNull();
  });

  it('does not blame DMI for a stale or offline forecast when marine evidence is fresh', () => {
    const weatherOnly: CacheHealth = {
      status: 'stale',
      lastAttemptAt: '2026-09-01T07:55:00.000Z',
      degradedSources: ['weather'],
      marineInstances: FRESH_MARINE_INSTANCES,
    };

    expect(shouldShowDmiMaintenanceNotice(weatherOnly, ACTIVE_MS, true, true)).toBe(false);
    expect(renderNotice(weatherOnly).querySelector('details')).toBeNull();
  });

  it('does not blame DMI for an offline or unverified old marine cache', () => {
    const apparentlyOldButHealthy: CacheHealth = {
      ...STALE_MARINE_HEALTH,
      status: 'current',
    };

    expect(shouldShowDmiMaintenanceNotice(
      apparentlyOldButHealthy,
      ACTIVE_MS,
      false,
      true,
    )).toBe(false);
    expect(shouldShowDmiMaintenanceNotice(
      apparentlyOldButHealthy,
      ACTIVE_MS,
      true,
      false,
    )).toBe(false);
  });

  it('does not override an explicit weather-only failure with old marine provenance', () => {
    const weatherOnly: CacheHealth = {
      ...STALE_MARINE_HEALTH,
      degradedSources: ['weather'],
    };

    expect(shouldShowDmiMaintenanceNotice(weatherOnly, ACTIVE_MS, true, true)).toBe(false);
  });

  it('honours a named busy provider before inferring a cause from old run ids', () => {
    const weatherBusy: CacheHealth = {
      ...STALE_MARINE_HEALTH,
      providerBusy: true,
      busyProvider: 'weather',
    };
    const marineBusy: CacheHealth = {
      status: 'current',
      lastAttemptAt: '2026-09-01T07:55:00.000Z',
      providerBusy: true,
      busyProvider: 'marine',
    };

    expect(shouldShowDmiMaintenanceNotice(weatherBusy, ACTIVE_MS, true, true)).toBe(false);
    expect(shouldShowDmiMaintenanceNotice(marineBusy, ACTIVE_MS, true, true)).toBe(true);
  });

  it('does not manufacture a delay from malformed DMI run provenance', () => {
    const malformed: CacheHealth = {
      status: 'stale',
      lastAttemptAt: '2026-09-01T07:55:00.000Z',
      marineInstances: {
        water: { collection: 'dkss_idw', id: '2026-02-30T000000Z' },
        waves: { collection: 'wam_dw', id: 'not-a-run' },
      },
    };

    expect(shouldShowDmiMaintenanceNotice(malformed, ACTIVE_MS, true, true)).toBe(false);
  });

  it('is bounded to DMI\'s published maintenance dates', () => {
    const explicitlyDelayed: CacheHealth = {
      status: 'current',
      lastAttemptAt: '2026-08-31T00:00:00.000Z',
      degradedSources: ['waves'],
    };

    expect(shouldShowDmiMaintenanceNotice(
      explicitlyDelayed,
      DMI_MAINTENANCE_START_MS - 1,
      true,
      true,
    ))
      .toBe(false);
    expect(shouldShowDmiMaintenanceNotice(
      explicitlyDelayed,
      DMI_MAINTENANCE_START_MS,
      true,
      true,
    ))
      .toBe(true);
    expect(shouldShowDmiMaintenanceNotice(
      explicitlyDelayed,
      DMI_MAINTENANCE_END_MS - 1,
      true,
      true,
    ))
      .toBe(true);
    expect(shouldShowDmiMaintenanceNotice(
      explicitlyDelayed,
      DMI_MAINTENANCE_END_MS,
      true,
      true,
    ))
      .toBe(false);
  });

  it('renders natural Danish copy', () => {
    const text = renderNotice(STALE_MARINE_HEALTH, ACTIVE_MS, true).textContent;

    expect(text).toContain("Vedligehold kan forsinke DMI's prognoser for bølger og vandstand");
    expect(text).toContain('FRANK viser den seneste komplette prognose og tjekker automatisk igen.');
    expect(text).toContain("Læs DMI's meddelelse om vedligeholdelse");
  });
});
