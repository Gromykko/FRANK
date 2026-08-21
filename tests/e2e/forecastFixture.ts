import { readFileSync } from 'node:fs';
import type { Page, Route } from 'playwright/test';
import {
  CURRENT_RELEASE,
  FORECAST_RELEASE_HEADERS,
} from '../../src/features/forecast/releaseContract';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';

const HOUR_MS = 60 * 60 * 1000;
export const FIXTURE_NOW_ISO = '2026-08-20T10:15:00.000Z';
const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);

interface FixtureLocation {
  id: string;
  forecastConfigRevision: number;
  name: string;
  areaName: string;
  coordinate: { latitude: number; longitude: number };
}

const locations = JSON.parse(
  readFileSync(new URL('../../src/config/locations.json', import.meta.url), 'utf8'),
) as FixtureLocation[];

const locationById = new Map(locations.map((location) => [location.id, location]));

function releaseHeaders(ready: boolean): Record<string, string> {
  const exposedHeaders = Object.values(FORECAST_RELEASE_HEADERS).join(', ');
  return {
    [FORECAST_RELEASE_HEADERS.apiSchema]: String(CURRENT_RELEASE.apiSchemaVersion),
    [FORECAST_RELEASE_HEADERS.modelRevision]: String(CURRENT_RELEASE.modelRevision),
    [FORECAST_RELEASE_HEADERS.dataGeneration]: CURRENT_RELEASE.dataGenerationId,
    [FORECAST_RELEASE_HEADERS.assembledCacheSchema]: String(CURRENT_RELEASE.assembledCacheSchema),
    [FORECAST_RELEASE_HEADERS.marineCacheSchema]: String(CURRENT_RELEASE.marineCacheSchema),
    [FORECAST_RELEASE_HEADERS.payloadVersion]: String(CURRENT_RELEASE.payloadVersion),
    [FORECAST_RELEASE_HEADERS.generationReady]: String(ready),
    'Access-Control-Expose-Headers': `Retry-After, ${exposedHeaders}`,
  };
}

function buildHourly(startMs: number) {
  return Array.from({ length: 72 }, (_, index) => ({
    time: new Date(startMs + index * HOUR_MS).toISOString(),
    tempAir: 18,
    precipitation: 0,
    symbolCode: 'partlycloudy_day',
    weatherCode: 2,
    windSpeed: 2.8,
    windDirection: 250,
    windGust: 4.1,
    waveHeight: 0.12,
    waveDirection: 245,
    wavePeriod: 3.4,
    tempWater: 17,
    tideLevel: 0.08,
    currentSpeed: 0.05,
    currentDirection: 80,
    isDay: true,
    weatherSource: 'met-locationforecast',
    marineSource: 'dmi-dkss-wam',
  }));
}

export function buildForecastFixture(locationId: string, nowMs = FIXTURE_NOW_MS) {
  const location = locationById.get(locationId);
  if (!location) throw new Error(`Unknown fixture location: ${locationId}`);

  const startMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS - HOUR_MS;
  const fetchedAt = new Date(nowMs - 2 * 60 * 1000).toISOString();

  return {
    hourly: buildHourly(startMs),
    sunrise: [],
    sunset: [],
    warnings: [],
    sources: {
      payloadVersion: FORECAST_PAYLOAD_VERSION,
      release: { ...CURRENT_RELEASE },
      weather: 'MET Norway Locationforecast',
      waves: 'DMI WAM',
      water: 'DMI DKSS',
      coordinate: location.coordinate,
      location: {
        id: location.id,
        forecastConfigRevision: location.forecastConfigRevision,
        name: location.name,
        areaName: location.areaName,
      },
      fetchedAt,
      cacheHealth: {
        status: 'current',
        lastAttemptAt: fetchedAt,
        checkedBy: 'e2e-fixture',
        degradedSources: [],
      },
    },
  };
}

export interface ForecastMock {
  requests: URL[];
  stop: () => Promise<void>;
}

export async function mockInitializingForecastWorker(
  page: Page,
  { availableLocationIds = [] }: { availableLocationIds?: string[] } = {},
): Promise<ForecastMock> {
  const requests: URL[] = [];
  const availableIds = new Set(availableLocationIds);
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    const locationId = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    const location = locationById.get(locationId);
    if (!location) throw new Error(`Unknown fixture location: ${locationId}`);
    requests.push(url);
    if (availableIds.has(locationId)) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json; charset=utf-8',
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          ...releaseHeaders(true),
        },
        body: JSON.stringify(buildForecastFixture(locationId)),
      });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'Retry-After': '600',
        'X-Content-Type-Options': 'nosniff',
        ...releaseHeaders(false),
      },
      body: JSON.stringify({
        schemaVersion: 1,
        status: 'initializing',
        code: 'FORECAST_INITIALIZING',
        message: 'Forecast is being initialized.',
        retryAfterSeconds: 600,
        location: {
          id: location.id,
          name: location.name,
          areaName: location.areaName,
        },
      }),
    });
  };

  const healthHandler = async (route: Route) => {
    const available = locations
      .map(({ id }) => id)
      .filter((id) => availableIds.has(id));
    const missing = locations
      .map(({ id }) => id)
      .filter((id) => !availableIds.has(id));
    await route.fulfill({
      status: missing.length === 0 ? 200 : 503,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      body: JSON.stringify({
        service: 'frank-forecast',
        checkedAt: FIXTURE_NOW_ISO,
        release: {
          target: { ...CURRENT_RELEASE },
          allLocationsReady: missing.length === 0,
          ready: available,
          available,
          fallback: [],
          missing,
        },
      }),
    });
  };

  const routePattern = '**/forecast/**';
  const healthRoutePattern = '**/health';
  await page.route(routePattern, handler);
  await page.route(healthRoutePattern, healthHandler);
  return {
    requests,
    stop: async () => {
      await page.unroute(routePattern, handler);
      await page.unroute(healthRoutePattern, healthHandler);
    },
  };
}

export async function mockForecastWorker(page: Page): Promise<ForecastMock> {
  const requests: URL[] = [];
  const handler = async (route: Route) => {
    const url = new URL(route.request().url());
    const locationId = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    requests.push(url);
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...releaseHeaders(true),
      },
      body: JSON.stringify(buildForecastFixture(locationId)),
    });
  };

  const healthHandler = async (route: Route) => {
    const available = locations.map(({ id }) => id);
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
      body: JSON.stringify({
        service: 'frank-forecast',
        checkedAt: FIXTURE_NOW_ISO,
        release: {
          target: { ...CURRENT_RELEASE },
          allLocationsReady: true,
          ready: available,
          available,
          fallback: [],
          missing: [],
        },
      }),
    });
  };

  // Match the resource path rather than one hostname. A developer's local
  // VITE_FORECAST_WORKER_BASE must never make this deterministic suite escape
  // to a live Worker or provider.
  const routePattern = '**/forecast/**';
  const healthRoutePattern = '**/health';
  await page.route(routePattern, handler);
  await page.route(healthRoutePattern, healthHandler);
  return {
    requests,
    stop: async () => {
      await page.unroute(routePattern, handler);
      await page.unroute(healthRoutePattern, healthHandler);
    },
  };
}
