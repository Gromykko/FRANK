import { CURRENT_LOCATION } from '../../config/locations';
import type { ForecastLocation } from '../../config/locations';
import { FORECAST_PAYLOAD_VERSION } from './types';
import type { HourlyData, SeriesPoint, WeatherData } from './types';
import {
  aggregateBlockMarine,
  assembleBlockRow,
  assembleHourlyRow,
  mapMetBlocks,
  mapMetTimeseries,
  mapWaterFeatures,
  mapWaveFeatures,
  nearestPoint,
} from './normalize';
import type { BlockMarine, DmiFeatureCollection, MetBlock, MetForecastResponse } from './normalize';
import { buildSunSchedule } from './sun';
import {
  WAM_PARAMETERS,
  DKSS_PARAMETERS,
  buildDmiUrl as buildSharedDmiUrl,
  buildMetUrl as buildSharedMetUrl,
} from './providerUrls';
import { saveCachedWeatherData } from './cache';
import { enrichWarningCoverage, parseMeteoalarmFeed } from './parseWarnings';
import type { WeatherWarning } from './types';
import { CURRENT_RELEASE } from './releaseContract';

// ── DEV-ONLY direct-fetch pipeline ─────────────────────────────────────────
// This whole module fetches MET + DMI directly and normalizes them client-side.
// In production it never runs — the deployed app reads the pre-built Worker
// cache (see cache.ts), and CAN_FETCH_FRESH_FORECAST below is only true in DEV
// or when VITE_DMI_FORECAST_BASE is set. It mirrors the Worker's pipeline for
// local development; the shared normalize.ts helpers keep the two in lockstep.
// ───────────────────────────────────────────────────────────────────────────
const FETCH_TIMEOUT_MS = 25_000;
const MAX_FETCH_ATTEMPTS = 2;

// The browser cannot set a User-Agent header, and MET Norway rejects requests
// without an identifying one, so the dev server proxies MET and injects it (see
// vite.config.ts). In production the client reads the Worker cache instead.
const MET_BASE = import.meta.env.DEV
  ? '/met-forecast/weatherapi/locationforecast/2.0/complete'
  : 'https://api.met.no/weatherapi/locationforecast/2.0/complete';

const CONFIGURED_DMI_BASE = import.meta.env.VITE_DMI_FORECAST_BASE?.replace(/\/$/, '');

export const CAN_FETCH_FRESH_FORECAST = Boolean(CONFIGURED_DMI_BASE) || import.meta.env.DEV;

const DMI_BASE =
  CONFIGURED_DMI_BASE ??
  (import.meta.env.DEV
    ? '/dmi-forecast'
    : 'https://opendataapi.dmi.dk/v1/forecastedr');

// Thin wrappers binding the shared builders (providerUrls.ts — same copy the
// Worker uses) to this dev pipeline's base URLs.
function buildDmiUrl(collection: string, parameters: string[], location: ForecastLocation): string {
  return buildSharedDmiUrl(DMI_BASE, collection, parameters, location.coordinate);
}

function buildMetUrl(location: ForecastLocation): string {
  return buildSharedMetUrl(MET_BASE, location.coordinate);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function fetchWithTimeout(url: string): Promise<Response> {
  // Keep the signal alive for the response BODY too. The old manual timer was
  // cleared as soon as fetch() returned headers, so response.json()/text()
  // could hang forever on a stalled body and hold the whole dev refresh open.
  return fetch(url, {
    headers: {
      Accept: 'application/geo+json, application/json',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
}

const METEOALARM_FEED_URL = import.meta.env.DEV
  ? '/meteoalarm/feeds/meteoalarm-legacy-atom-denmark'
  : 'https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-denmark';

// Best-effort in this client path: a missing/blocked feed just means no stripe.
// (Production reads the worker payload, which parses warnings server-side.) Uses
// its own fetch — the shared helper forces a geo+json Accept the XML feed 406s.
async function fetchWarnings(location: ForecastLocation): Promise<WeatherWarning[]> {
  if (!location.emmaId) return [];
  try {
    // MeteoAlarm's server 406s on a specific XML Accept — it only serves */*.
    const response = await fetch(METEOALARM_FEED_URL, {
      headers: { Accept: '*/*' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return [];
    const warnings = parseMeteoalarmFeed(await response.text(), location.emmaId);
    // Same coverage soft filter as the worker; a browser CORS failure on the
    // detail endpoint just leaves warnings region-level (fail-open).
    return await enrichWarningCoverage(warnings, location.kommuneAliases, async (url) => {
      const detail = await fetch(url, {
        headers: { Accept: '*/*' },
        // Each CAP document gets its own budget. Previously detail requests had
        // no signal and could keep a best-effort warning fetch pending forever.
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!detail.ok) throw new Error(`CAP detail failed: ${detail.status}`);
      return detail.text();
    });
  } catch {
    return [];
  }
}

// Exported for tests (like the Worker's helpers) — the retry/terminal-status
// branching is the part worth pinning down.
export async function fetchDmiGeoJson(collection: string, parameters: string[], location: ForecastLocation): Promise<DmiFeatureCollection> {
  const url = buildDmiUrl(collection, parameters, location);
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(url);

      if (response.ok) {
        return await response.json();
      }

      const message = await response.text();
      lastError = new Error(`DMI ${collection} request failed: ${response.status} ${message.slice(0, 160)}`);

      // Terminal 4xx (429 excepted — DMI uses it for transient "server is
      // busy"). Use break, not throw: a throw here is caught by this same
      // try/catch and would fall through to the delay-and-retry anyway, so a
      // hard 400/404 cost a second pointless request. Same fix the Worker
      // already carries in fetchJsonWithRetries.
      if (response.status !== 429 && response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    // No backoff after the final attempt — it only delays the throw.
    if (attempt < MAX_FETCH_ATTEMPTS - 1) await delay(700 * (attempt + 1));
  }

  throw lastError ?? new Error(`DMI ${collection} request failed`);
}

async function fetchFirstAvailableCollection(
  collections: string[],
  parameters: string[],
  location: ForecastLocation
): Promise<{ collection: string; data: DmiFeatureCollection }> {
  let lastError: Error | null = null;

  for (const collection of collections) {
    try {
      const data = await fetchDmiGeoJson(collection, parameters, location);

      // An empty FeatureCollection can never succeed downstream (the mappers
      // yield an empty series and fetchWeatherData throws), so treat it like
      // the all-null case and let the next collection in the list try.
      const hasValidData = data.features.length > 0 && data.features.some((f) =>
        parameters.some((p) => f.properties[p] !== null && f.properties[p] !== undefined)
      );

      if (!hasValidData) {
        throw new Error(`DMI ${collection} returned no usable values for requested parameters.`);
      }

      return { collection, data };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(400);
    }
  }

  throw lastError ?? new Error(`DMI request failed for ${collections.join(', ')}`);
}

interface MetWeather {
  hourly: SeriesPoint[];
  blocks: MetBlock[];
}

async function fetchMetWeather(location: ForecastLocation): Promise<MetWeather> {
  const response = await fetchWithTimeout(buildMetUrl(location));

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`MET Norway weather request failed: ${response.status} ${message.slice(0, 160)}`);
  }

  const data = (await response.json()) as MetForecastResponse;
  return { hourly: mapMetTimeseries(data), blocks: mapMetBlocks(data) };
}

export async function fetchWeatherData(location = CURRENT_LOCATION): Promise<WeatherData> {
  try {
    const [met, waterResult, waveResult, warnings] = await Promise.all([
      fetchMetWeather(location),
      fetchFirstAvailableCollection(location.dmiCollections.water, DKSS_PARAMETERS, location),
      fetchFirstAvailableCollection(location.dmiCollections.waves, WAM_PARAMETERS, location),
      fetchWarnings(location),
    ]);

    const weatherSeries = met.hourly;
    const waterSeries = mapWaterFeatures(waterResult.data.features);
    const waveSeries = mapWaveFeatures(waveResult.data.features);

    if (weatherSeries.length === 0) {
      throw new Error(`MET Norway returned no weather forecast points for ${location.areaName}.`);
    }
    if (waterSeries.length === 0) {
      throw new Error(`DMI returned no DKSS water-level forecast points for ${location.areaName}.`);
    }
    if (waveSeries.length === 0) {
      throw new Error(`DMI returned no WAM wave forecast points for ${location.areaName}.`);
    }

    // Longer-range blocks continue the matrix past MET's hourly range using
    // next_6_hours, with DMI marine aggregated per block. Stop where marine runs out.
    const hourlyEndMs = weatherSeries[weatherSeries.length - 1].timeMs;
    const blockData: { block: MetBlock; marine: BlockMarine }[] = [];
    for (const block of met.blocks) {
      if (block.timeMs <= hourlyEndMs) continue;
      const marine = aggregateBlockMarine(waveSeries, waterSeries, block.timeMs, block.timeMs + block.spanHours * 3_600_000);
      if (!marine) break;
      blockData.push({ block, marine });
    }

    // MET has no sunrise/sunset or is_day, so day/night is derived
    // astronomically from the coordinate over every hour and block we keep.
    const allTimes = [...weatherSeries.map((w) => w.time), ...blockData.map((b) => b.block.time)];
    const sun = buildSunSchedule(allTimes, location);

    // One continuous forecast: keep every weather hour for which we also have
    // marine data, then append the longer-range blocks.
    const hourly = weatherSeries
      .map((weather): HourlyData | null => {
        const water = nearestPoint(waterSeries, weather.timeMs);
        const wave = nearestPoint(waveSeries, weather.timeMs);
        if (!water || !wave) return null;
        return assembleHourlyRow(weather, water, wave, sun.isDayByTime.get(weather.time) ?? true);
      })
      .filter((hour): hour is HourlyData => Boolean(hour))
      .concat(blockData.map(({ block, marine }) => assembleBlockRow(block, marine, sun.isDayByTime.get(block.time) ?? true)));

    const data: WeatherData = {
      hourly,
      sunrise: sun.sunrise,
      sunset: sun.sunset,
      warnings,
      sources: {
        payloadVersion: FORECAST_PAYLOAD_VERSION,
        release: { ...CURRENT_RELEASE },
        weather: 'MET Norway Locationforecast',
        waves: `DMI ${waveResult.collection}`,
        water: `DMI ${waterResult.collection}`,
        coordinate: {
          latitude: location.coordinate.latitude,
          longitude: location.coordinate.longitude,
        },
        location: {
          id: location.id,
          name: location.name,
          areaName: location.areaName,
        },
        fetchedAt: new Date().toISOString(),
      },
    };

    saveCachedWeatherData(data, location);
    return data;
  } catch (error) {
    console.error('Error fetching forecast data:', error);
    throw error;
  }
}
