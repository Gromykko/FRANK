import { readFileSync } from 'node:fs';
import type { Page, Route } from 'playwright/test';
import { FORECAST_PAYLOAD_VERSION } from '../../src/features/forecast/types';

const HOUR_MS = 60 * 60 * 1000;
export const FIXTURE_NOW_ISO = '2026-08-20T10:15:00.000Z';
const FIXTURE_NOW_MS = Date.parse(FIXTURE_NOW_ISO);

interface FixtureLocation {
  id: string;
  name: string;
  areaName: string;
  coordinate: { latitude: number; longitude: number };
}

const locations = JSON.parse(
  readFileSync(new URL('../../src/config/locations.json', import.meta.url), 'utf8'),
) as FixtureLocation[];

const locationById = new Map(locations.map((location) => [location.id, location]));

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
      weather: 'MET Norway Locationforecast',
      waves: 'DMI WAM',
      water: 'DMI DKSS',
      coordinate: location.coordinate,
      location: {
        id: location.id,
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
      },
      body: JSON.stringify(buildForecastFixture(locationId)),
    });
  };

  // Match the resource path rather than one hostname. A developer's local
  // VITE_FORECAST_WORKER_BASE must never make this deterministic suite escape
  // to a live Worker or provider.
  const routePattern = '**/forecast/**';
  await page.route(routePattern, handler);
  return {
    requests,
    stop: () => page.unroute(routePattern, handler),
  };
}
