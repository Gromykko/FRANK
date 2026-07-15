import locations from '../src/config/locations.json';
import { METEOALARM_DENMARK_FEED, enrichWarningCoverage, parseMeteoalarmFeed } from '../src/features/forecast/parseWarnings';
// Shared forecast-core: the Worker imports the SAME normalization/sun functions
// the client uses, so the two can never drift on the numbers the safety verdict
// runs on. (Previously each maintained its own copy.)
import {
  mapWaveFeatures,
  mapWaterFeatures,
  mapMetTimeseries,
  mapMetBlocks,
  aggregateBlockMarine,
  assembleBlockRow,
  assembleHourlyRow,
  nearestPoint,
} from '../src/features/forecast/normalize';
import { buildSunSchedule } from '../src/features/forecast/sun';
// Shared provider-request vocabulary (parameter lists + URL builders) — one
// copy for worker and dev client so the params can't drift from normalize.ts.
import {
  WAM_PARAMETERS,
  DKSS_PARAMETERS,
  buildDmiUrl as buildSharedDmiUrl,
  buildDmiInstancesUrl,
  buildMetUrl as buildSharedMetUrl,
} from '../src/features/forecast/providerUrls';
// Re-exported so tests/worker/math.test.ts keeps importing them from the worker.
export {
  asNumber,
  normalizeDegrees,
  currentSpeedFromComponents,
  currentDirectionFromComponents,
} from '../src/features/forecast/normalize';

const FETCH_TIMEOUT_MS = 25_000;
const MAX_FETCH_ATTEMPTS = 3;
const RETRY_BASE_DELAY_MS = 1_500;
const MANUAL_CHECK_MIN_INTERVAL_MS = 60 * 1000;
// When the cache is stale, a manual refresh is the user explicitly asking for
// a retry — allow it much sooner than the normal manual gate. 20s still keeps
// spam-taps from hammering the providers.
const STALE_MANUAL_RETRY_MS = 20 * 1000;
const USER_BACKGROUND_CHECK_MIN_INTERVAL_MS = 10 * 60 * 1000;
const CRON_CHECK_MIN_INTERVAL_MS = 4 * 60 * 1000;
// DMI marine runs are 6h apart (measured 2026-07-11: dkss_idw & wam_nsb run
// times 00/06/12/18Z, every gap exactly 6.00h; also DMI's documented synoptic
// cycle). A newer run therefore cannot exist until 6h after the one we hold,
// so probing the catalog before then is provably pointless. We gate at 5h =
// that 6h floor minus a 1h margin (guards clock skew / an early run), then
// probe every tick until a new run appears. Bump this only if DMI changes its
// run cadence.
const DMI_PROBE_QUIET_MS = 5 * 60 * 60 * 1000;
const DMI_BASE = 'https://opendataapi.dmi.dk/v1/forecastedr';
// The atmospheric weather picture comes from MET Norway Locationforecast. MET
// already computes the weather symbol, so FRANK never derives its own.
const MET_BASE = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
// MET requires an identifying User-Agent with a way to contact the operator, or
// it returns 403. See https://api.met.no/doc/TermsOfService.
const MET_USER_AGENT = 'FRANK-kayak-forecast/1.0 (https://github.com/Gromykko/FRANK)';
// Fallback validity when MET omits an Expires header (it normally sends one).
const MET_DEFAULT_TTL_MS = 30 * 60 * 1000;
// KV key prefix for the raw MET response, kept so refreshes can send
// If-Modified-Since (required by MET's TOS) and reuse the stored body on a
// 304 Not Modified instead of downloading the same forecast again.
const MET_RAW_KEY_PREFIX = 'met-raw';

// Version stamp written into every cached payload. Bump it whenever the
// payload shape or its data sources change: readCachedForecast refuses older
// payloads and forces a rebuild, so a redeployed worker can never keep
// serving forecasts built by previous logic. The app checks the same number
// and warns when the deployed worker lags behind it — keep this in sync with
// FORECAST_PAYLOAD_VERSION in src/features/forecast/types.ts.
const PAYLOAD_VERSION = 4;

const activeRefreshes = new Map();

// Marine data still comes straight from DMI.
function cacheKey(location) {
  return `forecast:${location.id}:weather-data:v1`;
}

// Strict lookup — the caller 404s unknown ids; a silent first-location
// fallback would mask a typo'd id as the wrong fjord's forecast.
function findLocation(id) {
  return locations.find((location) => location.id === id);
}

// Thin wrappers binding the shared builders to this worker's base URLs.
function buildDmiUrl(collection, parameters, location, instanceId) {
  return buildSharedDmiUrl(DMI_BASE, collection, parameters, location.coordinate, instanceId);
}

function buildInstancesUrl(collection) {
  return buildDmiInstancesUrl(DMI_BASE, collection);
}

function buildMetUrl(location) {
  return buildSharedMetUrl(MET_BASE, location.coordinate);
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
  };
}

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return new Response(`${JSON.stringify(body)}\n`, {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(),
      ...extraHeaders,
    },
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  return RETRY_BASE_DELAY_MS * 2 ** attempt + Math.floor(Math.random() * 500);
}

async function fetchWithTimeout(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJsonWithRetries(url, label) {
  let lastError;

  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(url, {
        headers: {
          Accept: 'application/geo+json, application/json',
        },
      });

      if (response.ok) return await response.json();

      const message = await response.text();
      lastError = new Error(`${label} failed: ${response.status} ${message.slice(0, 180)}`);
      lastError.status = response.status;
      // Any 4xx (incl. 429 "Server is busy") is terminal: retrying with
      // backoff is how a single refresh became an 18-request, 30-second
      // storm, and the 10-minute cron already IS the retry schedule. Use
      // break, not throw - a throw here is caught by this same try/catch
      // and would fall through to the delay-and-retry anyway.
      if (response.status < 500) break;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < MAX_FETCH_ATTEMPTS - 1) {
      await delay(retryDelay(attempt));
    }
  }

  throw lastError ?? new Error(`${label} failed`);
}

function parseDmiInstanceMs(id) {
  if (typeof id !== 'string') return Number.NaN;
  const compact = id.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (compact) {
    return new Date(`${compact[1]}T${compact[2]}:${compact[3]}:${compact[4]}Z`).getTime();
  }
  return new Date(id).getTime();
}

// Age of the OLDER of the two marine runs we hold (so if one source lags, we
// still probe). Infinity if either run id is missing/unparseable - an
// incomplete marine set must always trigger a probe.
export function marineRunAgeMs(marineInstances, now = Date.now()) {
  const water = parseDmiInstanceMs(marineInstances?.water?.id);
  const waves = parseDmiInstanceMs(marineInstances?.waves?.id);
  if (!Number.isFinite(water) || !Number.isFinite(waves)) return Infinity;
  return now - Math.min(water, waves);
}

function latestInstanceFromResponse(data) {
  const instances = Array.isArray(data?.instances) ? data.instances : [];
  let best;
  let bestMs = -Infinity;

  for (const instance of instances) {
    const id = instance?.id;
    const timeMs = parseDmiInstanceMs(id);
    if (id && Number.isFinite(timeMs) && timeMs > bestMs) {
      best = { id };
      bestMs = timeMs;
    }
  }

  return best;
}

async function fetchLatestInstanceForCollections(collections) {
  let lastError;

  for (const collection of collections) {
    try {
      const data = await fetchJsonWithRetries(buildInstancesUrl(collection), `DMI ${collection} instances`);
      const latest = latestInstanceFromResponse(data);
      if (latest) {
        return {
          collection,
          id: latest.id,
        };
      }
      lastError = new Error(`DMI ${collection} returned no usable instances`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      // Rate limiting is host-wide: the fallback collection lives on the
      // same busy server, so cascading to it just multiplies the load.
      // Fall through to fallbacks only for 404s/empty instance lists.
      if (lastError.status === 429) throw lastError;
    }
  }

  throw lastError ?? new Error(`No DMI instances found for ${collections.join(', ')}`);
}

async function fetchLatestMarineInstances(location) {
  const results = await Promise.allSettled([
    fetchLatestInstanceForCollections(location.dmiCollections.water),
    fetchLatestInstanceForCollections(location.dmiCollections.waves),
  ]);

  const water = results[0].status === 'fulfilled' ? results[0].value : undefined;
  const waves = results[1].status === 'fulfilled' ? results[1].value : undefined;

  if (!water || !waves) {
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason.message);
    throw new Error(`Failed to fetch DMI marine instances: ${errors.join(', ')}`);
  }

  return { water, waves };
}

function marineInstancesEqual(left, right) {
  return Boolean(
    left &&
      right &&
      left.water?.collection === right.water?.collection &&
      left.water?.id === right.water?.id &&
      left.waves?.collection === right.waves?.collection &&
      left.waves?.id === right.waves?.id
  );
}

async function fetchDmiGeoJson(collection, parameters, location, instanceId) {
  return fetchJsonWithRetries(
    buildDmiUrl(collection, parameters, location, instanceId),
    `DMI ${collection}`
  );
}

function mapMetPayload(data, lastModified, expiresMs) {
  return {
    weatherSeries: mapMetTimeseries(data),
    blocks: mapMetBlocks(data),
    // Honour MET's own Expires header; fall back to a short TTL if absent.
    weatherExpires: Number.isFinite(expiresMs)
      ? new Date(expiresMs).toISOString()
      : new Date(Date.now() + MET_DEFAULT_TTL_MS).toISOString(),
    weatherLastModified: lastModified ?? undefined,
  };
}

async function fetchMetWeather(env, location) {
  const rawKey = `${MET_RAW_KEY_PREFIX}:${location.id}`;
  let stored = null;
  try {
    stored = await env.FRANK_FORECAST_CACHE.get(rawKey, 'json');
  } catch {
    stored = null;
  }

  const headers = {
    Accept: 'application/json',
    'User-Agent': MET_USER_AGENT,
  };
  // MET TOS: repeat requests must carry If-Modified-Since with exactly the
  // Last-Modified value previously received.
  if (stored?.lastModified && stored?.body) {
    headers['If-Modified-Since'] = stored.lastModified;
  }

  try {
    const response = await fetchWithTimeout(buildMetUrl(location), { headers });

    if (response.status === 304 && stored?.body) {
      // Unchanged on MET's side: reuse the stored body. A 304 can still extend
      // the validity window through its own Expires header.
      const expiresHeader = response.headers.get('Expires');
      const expiresMs = expiresHeader ? Date.parse(expiresHeader) : Number.NaN;
      return { ...mapMetPayload(stored.body, stored.lastModified, expiresMs), fallback: false };
    }

    if (!response.ok) {
      const message = await response.text();
      throw new Error(`MET Norway weather failed: ${response.status} ${message.slice(0, 180)}`);
    }

    const data = await response.json();
    const lastModified = response.headers.get('Last-Modified');
    const expiresHeader = response.headers.get('Expires');
    const expiresMs = expiresHeader ? Date.parse(expiresHeader) : Number.NaN;

    if (lastModified) {
      try {
        await env.FRANK_FORECAST_CACHE.put(rawKey, JSON.stringify({ lastModified, body: data }));
      } catch {
        // Storing the conditional-request state is best-effort.
      }
    }

    return { ...mapMetPayload(data, lastModified, expiresMs), fallback: false };
  } catch (error) {
    // MET unreachable but we hold its last response: build with that rather
    // than freezing the whole payload. The NaN expires maps to a short TTL,
    // so the next check retries MET soon.
    if (stored?.body) {
      // MET always returns data when reachable, so a MET fallback is always a
      // real transport failure - degraded, not merely "not published yet".
      return { ...mapMetPayload(stored.body, stored.lastModified, Number.NaN), fallback: true, degraded: true, busy: isBusyError(error?.message) };
    }
    throw error;
  }
}

// Last-good marine series per source, so one provider's brownout can't
// freeze the other's fresh data ("split retention, single serving": each
// ingredient falls back independently, the served payload stays one
// combined object where every hour has both weather and marine data).
const MARINE_INGREDIENT_KEY_PREFIX = 'frank-marine-ingredient';

export async function fetchMarineSeriesWithFallback(env, location, kind, instance, parameters, mapFeatures, seedSeries) {
  const key = `${MARINE_INGREDIENT_KEY_PREFIX}:${kind}:${location.id}`;

  let stored = null;
  try {
    stored = await env.FRANK_FORECAST_CACHE.get(key, 'json');
  } catch {
    stored = null;
  }

  // Same run we already hold data for: reuse it, no network call. DMI runs
  // change only every ~6h, so an hourly weather rebuild must not re-pull
  // identical marine data (measured: gaps between runs are exactly 6.00h).
  if (stored && stored.collection === instance.collection && stored.id === instance.id
    && Array.isArray(stored.series) && stored.series.length > 0) {
    return { series: stored.series, instance, fallback: false };
  }

  // Fall back to the run we already hold (retained ingredient, else the seed
  // from the cached payload). `extra` distinguishes WHY we fell back.
  const fallbackToHeld = (extra) => {
    if (Array.isArray(stored?.series) && stored.series.length > 0) {
      return { series: stored.series, instance: { collection: stored.collection, id: stored.id }, fallback: true, ...extra };
    }
    if (Array.isArray(seedSeries) && seedSeries.length > 0) {
      return { series: seedSeries, instance, fallback: true, ...extra };
    }
    return null;
  };

  let data;
  try {
    data = await fetchDmiGeoJson(instance.collection, parameters, location, instance.id);
  } catch (error) {
    // Transport error (429/5xx/network): we genuinely could not refresh this
    // source. Show the held run and flag it degraded (amber).
    const held = fallbackToHeld({ degraded: true, busy: isBusyError(error?.message) });
    if (held) return held;
    throw error;
  }

  const series = mapFeatures(data.features);
  if (series.length > 0) {
    try {
      await env.FRANK_FORECAST_CACHE.put(key, JSON.stringify({ collection: instance.collection, id: instance.id, series }));
    } catch {
      // Retention is best-effort.
    }
    return { series, instance, fallback: false };
  }

  // 200 but no data for this instance: the run is listed in the catalog but
  // not published yet. The run we already hold is still the latest AVAILABLE
  // data, so this is NOT degradation - fall back silently and stay green.
  const held = fallbackToHeld({ notReady: true });
  if (held) return held;
  throw new Error(`DMI ${instance.collection} returned no ${kind} forecast points for ${location.areaName}.`);
}

// Reconstruct per-source marine series from a cached payload's hourly rows
// (block rows are aggregates, so only true hourly rows are usable).
export function deriveMarineSeedsFromPayload(cached) {
  const hourly = cached?.hourly;
  if (!Array.isArray(hourly)) return null;
  const rows = hourly.filter((row) => row && !row.blockSpanHours && row.time);
  if (rows.length === 0) return null;
  return {
    water: rows.map((row) => ({
      time: row.time,
      timeMs: Date.parse(row.time),
      tempWater: row.tempWater,
      tideLevel: row.tideLevel,
      currentSpeed: row.currentSpeed,
      currentDirection: row.currentDirection,
    })),
    waves: rows.map((row) => ({
      time: row.time,
      timeMs: Date.parse(row.time),
      waveHeight: row.waveHeight,
      waveDirection: row.waveDirection,
      wavePeriod: row.wavePeriod,
    })),
  };
}

// Official DMI warnings for the location's region, via the MeteoAlarm Denmark
// feed. One country-wide fetch (edge-cached 5 min) serves every location. Never
// throws into the build - warnings are advisory and must not block a forecast.
// On a feed failure it carries forward the last build's still-unexpired
// warnings (last-good retention, like the marine sources) so a brief feed
// hiccup during a rebuild can't blank an active warning; a reachable feed that
// simply has no warnings correctly returns [] and lets expired ones clear.
async function fetchWarnings(location, seedWarnings, now = Date.now()) {
  if (!location.emmaId) return [];
  try {
    const response = await fetchWithTimeout(METEOALARM_DENMARK_FEED, {
      headers: { Accept: '*/*' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!response.ok) throw new Error(`MeteoAlarm feed failed: ${response.status}`);
    const warnings = parseMeteoalarmFeed(await response.text(), location.emmaId);
    // Kommune-coverage soft filter (public CAP detail per warning): may only
    // QUIET a warning that demonstrably excludes this town — fail-open, so
    // any detail failure leaves the warning region-level and fully shown.
    return await enrichWarningCoverage(warnings, location.kommuneAliases, async (url) => {
      const detail = await fetchWithTimeout(url, {
        headers: { Accept: '*/*' },
        cf: { cacheTtl: 300, cacheEverything: true },
      });
      if (!detail.ok) throw new Error(`CAP detail failed: ${detail.status}`);
      return detail.text();
    });
  } catch {
    return (seedWarnings ?? []).filter((w) => Number.isFinite(Date.parse(w?.expires)) && Date.parse(w.expires) > now);
  }
}

async function buildForecastCache(env, location, marineInstances, marineSeeds, warningSeed) {
  const results = await Promise.allSettled([
    fetchMetWeather(env, location),
    fetchMarineSeriesWithFallback(env, location, 'water', marineInstances.water, DKSS_PARAMETERS, mapWaterFeatures, marineSeeds?.water),
    fetchMarineSeriesWithFallback(env, location, 'waves', marineInstances.waves, WAM_PARAMETERS, mapWaveFeatures, marineSeeds?.waves),
    fetchWarnings(location, warningSeed),
  ]);

  // Only weather + both marine sources are required to build; the warnings leg
  // (last) is advisory - a down feed yields an empty stripe, never a failure.
  if (results.slice(0, 3).some(r => r.status === 'rejected')) {
    const errors = results.slice(0, 3).filter(r => r.status === 'rejected').map(r => r.reason.message);
    throw new Error(`Failed to build forecast: ${errors.join(', ')}`);
  }

  const [met, water, wave] = results.slice(0, 3).map(r => r.value);
  const warnings = results[3].status === 'fulfilled' ? results[3].value : [];

  const weatherSeries = met.weatherSeries;
  const waterSeries = water.series;
  const waveSeries = wave.series;
  // Which model runs the payload is really built from (a fallback ingredient
  // keeps its own older run id), and which sources are riding on last-good
  // data because their provider was unavailable.
  const effectiveInstances = { water: water.instance, waves: wave.instance };
  // Only a fallback caused by a real error is "degraded" (amber). A fallback
  // because a newly-listed run isn't published yet is NOT degradation - the
  // held run is still the latest available, so it stays green.
  const degradedSources = [
    ...(met.fallback && met.degraded ? ['weather'] : []),
    ...(water.fallback && water.degraded ? ['water'] : []),
    ...(wave.fallback && wave.degraded ? ['waves'] : []),
  ];
  // Whether the degradation is because a provider was busy (429) vs some
  // other error - lets the client say "... · service busy".
  const degradedBusy = [met, water, wave].some((s) => s.fallback && s.degraded && s.busy);

  if (weatherSeries.length === 0) {
    throw new Error(`MET Norway returned no weather forecast points for ${location.areaName}.`);
  }

  // Longer-range blocks continue the matrix past MET's hourly range using
  // next_6_hours, with DMI marine aggregated per block. Stop where marine ends.
  const hourlyEndMs = weatherSeries[weatherSeries.length - 1].timeMs;
  const blockData = [];
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
    .map((weather) => {
      const water = nearestPoint(waterSeries, weather.timeMs);
      const wave = nearestPoint(waveSeries, weather.timeMs);
      if (!water || !wave) return null;
      return assembleHourlyRow(weather, water, wave, sun.isDayByTime.get(weather.time) ?? true);
    })
    .filter(Boolean)
    .concat(blockData.map(({ block, marine }) => assembleBlockRow(block, marine, sun.isDayByTime.get(block.time) ?? true)));

  if (hourly.length === 0) {
    throw new Error(`No overlapping weather + marine hours for ${location.areaName}.`);
  }

  return {
    degradedSources,
    degradedBusy,
    marineInstances: effectiveInstances,
    forecast: {
      hourly,
      sunrise: sun.sunrise,
      sunset: sun.sunset,
      warnings,
      sources: {
        payloadVersion: PAYLOAD_VERSION,
        weather: 'MET Norway Locationforecast',
        waves: `DMI ${effectiveInstances.waves.collection}`,
        water: `DMI ${effectiveInstances.water.collection}`,
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
    },
    weatherExpires: met.weatherExpires,
    weatherLastModified: met.weatherLastModified,
  };
}

function isUsableForecastCache(value) {
  return Boolean(
    value &&
      Array.isArray(value.hourly) &&
      value.hourly.length > 0 &&
      Array.isArray(value.sunrise) &&
      Array.isArray(value.sunset) &&
      value.sources?.fetchedAt &&
      // Payloads built by older worker logic are refused outright, forcing a
      // rebuild on the next request/cron instead of being re-blessed as
      // "current" forever.
      value.sources?.payloadVersion === PAYLOAD_VERSION
  );
}

function hasCurrentForecastWindow(data) {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return data.hourly.some((hour) => new Date(hour.time).getTime() >= oneHourAgo);
}

function buildCacheHealth(status, data, options = {}) {
  const now = new Date();
  const previousHealth = data?.sources?.cacheHealth;
  const marineInstances = options.marineInstances ?? previousHealth?.marineInstances;
  const weatherExpires = options.weatherExpires ?? previousHealth?.weatherExpires;
  const weatherLastModified = options.weatherLastModified ?? previousHealth?.weatherLastModified;
  const message = options.error
    ? options.error instanceof Error
      ? options.error.message.slice(0, 240)
      : String(options.error).slice(0, 240)
    : options.message;

  return {
    status,
    // A gated "recently checked" stamp must NOT advance lastAttemptAt: the
    // cron and background gates compare against it, and sustained page loads
    // inside the manual gate would otherwise starve real provider checks
    // forever.
    lastAttemptAt: options.preserveAttemptAt && previousHealth?.lastAttemptAt
      ? previousHealth.lastAttemptAt
      : now.toISOString(),
    lastSuccessfulBuildAt:
      status === 'current' && data?.sources?.fetchedAt
        ? data.sources.fetchedAt
        : previousHealth?.lastSuccessfulBuildAt ?? data?.sources?.fetchedAt,
    ...(marineInstances ? { marineInstances } : {}),
    ...(weatherExpires ? { weatherExpires } : {}),
    ...(weatherLastModified ? { weatherLastModified } : {}),
    ...(message ? { message } : {}),
    ...(options.needsRebuild ? { needsRebuild: true } : {}),
    ...(options.checkedBy ? { checkedBy: options.checkedBy } : {}),
    ...(options.providerBusy ? { providerBusy: true } : {}),
    ...(options.busyProvider ? { busyProvider: options.busyProvider } : {}),
    ...(options.degradedSources?.length ? { degradedSources: options.degradedSources } : {}),
  };
}

// A "busy" upstream (429/rate-limited) is a "try later", distinct from a real
// error - the UI words it calmly and the retry logic treats it as terminal.
export function isBusyError(message) {
  return /\b429\b|too many requests|server is busy|rate.?limit/i.test(String(message ?? ''));
}

// Classify a build failure so the client can word it calmly: whether the
// provider is merely busy vs a real error, and which provider it was.
export function classifyBuildFailure(message) {
  const text = String(message ?? '');
  const busy = isBusyError(text);
  const hasWeather = /\bMET\b|locationforecast/i.test(text);
  const hasMarine = /\bDMI\b|dkss|wam/i.test(text);
  const busyProvider = hasWeather && hasMarine ? 'services'
    : hasMarine ? 'marine'
    : hasWeather ? 'weather'
    : 'services';
  return { busy, busyProvider };
}

function withCacheHealth(data, status, options = {}) {
  return {
    ...data,
    sources: {
      ...data.sources,
      cacheHealth: buildCacheHealth(status, data, options),
    },
  };
}

async function readCachedForecast(env, location) {
  const raw = await env.FRANK_FORECAST_CACHE.get(cacheKey(location));
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    return isUsableForecastCache(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function writeCachedForecast(env, location, data) {
  await env.FRANK_FORECAST_CACHE.put(cacheKey(location), JSON.stringify(data));
}

function shouldCheckInBackground(data, minIntervalMs) {
  const lastAttemptAt = data?.sources?.cacheHealth?.lastAttemptAt;
  const lastAttemptMs = new Date(lastAttemptAt ?? 0).getTime();
  return !Number.isFinite(lastAttemptMs) || Date.now() - lastAttemptMs > minIntervalMs;
}

async function _refreshForecastCache(env, location, options = {}) {
  const cached = await readCachedForecast(env, location);
  const cachedNeedsRecovery = (() => {
    const health = cached?.sources?.cacheHealth;
    return health?.status === 'stale' || health?.status === 'fallback' || health?.needsRebuild;
  })();

  // A forced (user-initiated) refresh of a stale cache retries after 20s
  // instead of the normal gate — a gated no-op here is what used to make the
  // refresh button feel dead right after a failure.
  const baseIntervalMs = options.minIntervalMs ?? CRON_CHECK_MIN_INTERVAL_MS;
  const minIntervalMs = options.force && cachedNeedsRecovery
    ? Math.min(baseIntervalMs, STALE_MANUAL_RETRY_MS)
    : baseIntervalMs;

  if (cached && !shouldCheckInBackground(cached, minIntervalMs)) {
    if (options.force && !cachedNeedsRecovery) {
      // No provider was contacted here, so lastAttemptAt keeps its old value.
      return withCacheHealth(cached, 'current', {
        preserveAttemptAt: true,
        checkedBy: options.reason ?? 'recent-check',
        message: 'Recently checked; using the latest shared forecast cache.',
      });
    }
    return cached;
  }

  let latestMarine;

  try {
    const cachedHealth = cached?.sources?.cacheHealth;

    // Weather freshness comes from MET's own Expires header stored on the run we
    // built against; only marine ids need a probe here. If the probe itself is
    // down (DMI busy), continue with the runs we already know about - the
    // per-source ingredient fallbacks below still let fresh weather through.
    let marineProbeFailed = false;
    const knownMarine = cachedHealth?.marineInstances;
    // Schedule-aware gate: DMI publishes a new marine run only every 6h
    // (measured: run times 00/06/12/18Z, gaps exactly 6.00h), so a newer run
    // cannot exist until 6h after the one we hold. Skip the catalog probe
    // while our run is younger than that floor minus a 1h safety margin;
    // once past it, probe every tick until a new run appears. A forced or
    // rebuild-flagged refresh always probes.
    const canSkipProbe = Boolean(knownMarine?.water?.id && knownMarine?.waves?.id)
      && !options.forceRebuild
      && !cachedHealth?.needsRebuild
      && marineRunAgeMs(knownMarine) < DMI_PROBE_QUIET_MS;

    if (canSkipProbe) {
      latestMarine = knownMarine;
    } else {
      try {
        latestMarine = await fetchLatestMarineInstances(location);
      } catch (probeError) {
        if (!knownMarine?.water?.id || !knownMarine?.waves?.id) throw probeError;
        latestMarine = knownMarine;
        marineProbeFailed = true;
      }
    }

    const builtWeatherExpires = cachedHealth?.weatherExpires;
    const weatherExpiredMs = builtWeatherExpires ? Date.parse(builtWeatherExpires) : Number.NaN;
    const weatherStale = !Number.isFinite(weatherExpiredMs) || Date.now() >= weatherExpiredMs;

    const marineUnchanged = marineInstancesEqual(cachedHealth?.marineInstances, latestMarine);

    const cacheAlreadyCurrent =
      cached &&
      !options.forceRebuild &&
      !cachedHealth?.needsRebuild &&
      hasCurrentForecastWindow(cached) &&
      marineUnchanged &&
      !weatherStale;

    if (cacheAlreadyCurrent) {
      // MET data is still within its Expires window and marine ids are
      // unchanged: keep the forecast, just record that we checked.
      const checkedCache = withCacheHealth(cached, 'current', {
        marineInstances: latestMarine,
        checkedBy: options.reason ?? 'check',
      });
      await writeCachedForecast(env, location, checkedCache);
      return checkedCache;
    }

    const built = await buildForecastCache(env, location, latestMarine, deriveMarineSeedsFromPayload(cached), cached?.warnings);
    // The build can succeed on last-good ingredients while a provider is
    // down; the payload is then still the freshest combination obtainable,
    // so it ships as 'current' with the degradation named in the message.
    const fallbackNotes = [
      ...(built.degradedSources ?? []),
      ...(marineProbeFailed ? ['marine run schedule'] : []),
    ];
    const fresh = withCacheHealth(built.forecast, 'current', {
      marineInstances: built.marineInstances ?? latestMarine,
      weatherExpires: built.weatherExpires,
      weatherLastModified: built.weatherLastModified,
      checkedBy: options.reason ?? 'refresh',
      // Names the sources riding on last-good data (weather/water/waves) so
      // the client can show a calm "from an earlier update" note, and whether
      // it was because their provider was busy.
      ...(built.degradedSources?.length ? { degradedSources: built.degradedSources } : {}),
      ...((built.degradedBusy || marineProbeFailed) ? { providerBusy: true } : {}),
      ...(fallbackNotes.length
        ? { message: `Provider partly unavailable; using last good data for: ${fallbackNotes.join(', ')}.` }
        : {}),
    });
    await writeCachedForecast(env, location, fresh);
    return fresh;
  } catch (error) {
    if (cached) {
      const previousMarine = cached.sources?.cacheHealth?.marineInstances;
      const newMarineNeedsRebuild = Boolean(latestMarine && !marineInstancesEqual(previousMarine, latestMarine));
      const { busy, busyProvider } = classifyBuildFailure(error?.message);
      const failedCache = withCacheHealth(cached, 'stale', {
        marineInstances: latestMarine ?? previousMarine,
        needsRebuild: options.forceRebuild || newMarineNeedsRebuild,
        checkedBy: options.reason ?? 'failed-check',
        ...(busy ? { providerBusy: true, busyProvider } : {}),
        error,
      });
      await writeCachedForecast(env, location, failedCache);
      return failedCache;
    }

    throw error;
  }
}

async function refreshForecastCache(env, location, options = {}) {
  const key = cacheKey(location);
  
  if (activeRefreshes.has(key)) {
    return activeRefreshes.get(key);
  }

  const promise = _refreshForecastCache(env, location, options);
  activeRefreshes.set(key, promise);
  
  try {
    return await promise;
  } finally {
    activeRefreshes.delete(key);
  }
}

async function handleForecastRequest(request, env, ctx, locationId) {
  const location = findLocation(locationId);
  if (!location || location.id !== locationId) {
    return jsonResponse({ error: `Unknown forecast location: ${locationId}` }, 404);
  }

  const url = new URL(request.url);
  const force = url.searchParams.get('refresh') === '1' || url.searchParams.get('refresh') === 'true';
  const forceRebuildRequested = url.searchParams.get('rebuild') === '1' || url.searchParams.get('rebuild') === 'true';

  if (forceRebuildRequested) {
    return jsonResponse({ error: 'Manual rebuild is not available from the public forecast endpoint.' }, 403);
  }

  if (force) {
    // A user request cannot make upstream models publish sooner, so there is
    // nothing worth waiting for: answer instantly from cache and run the
    // forced rebuild in the background (measured worst case of the old
    // synchronous wait: 30s of DMI retry backoff ending in the same stale
    // payload). The lastAttemptAt stamp below is response-only - never
    // written to KV - and tells the client its explicit attempt was just
    // initiated, keeping the "unreachable service" detection truthful.
    const cached = await readCachedForecast(env, location);
    if (cached) {
      ctx.waitUntil(refreshForecastCache(env, location, {
        force: true,
        reason: 'manual',
        minIntervalMs: MANUAL_CHECK_MIN_INTERVAL_MS,
      }));
      return jsonResponse({
        ...cached,
        sources: {
          ...cached.sources,
          cacheHealth: {
            ...cached.sources?.cacheHealth,
            lastAttemptAt: new Date().toISOString(),
            checkedBy: 'manual',
          },
        },
      });
    }
    const data = await refreshForecastCache(env, location, {
      force: true,
      reason: 'manual',
      minIntervalMs: MANUAL_CHECK_MIN_INTERVAL_MS,
    });
    return jsonResponse(data);
  }

  const cached = await readCachedForecast(env, location);
  if (cached) {
    if (shouldCheckInBackground(cached, USER_BACKGROUND_CHECK_MIN_INTERVAL_MS)) {
      ctx.waitUntil(refreshForecastCache(env, location, {
        reason: 'user-background',
        minIntervalMs: USER_BACKGROUND_CHECK_MIN_INTERVAL_MS,
      }));
    }
    return jsonResponse(cached);
  }

  const data = await refreshForecastCache(env, location, {
    force: true,
    reason: 'cold-start',
    minIntervalMs: 0,
  });
  return jsonResponse(data);
}

async function handleHealthRequest(env) {
  const entries = await Promise.all(
    locations.map(async (location) => {
      const data = await readCachedForecast(env, location);
      return {
        id: location.id,
        areaName: location.areaName,
        hasCache: Boolean(data),
        fetchedAt: data?.sources?.fetchedAt,
        cacheHealth: data?.sources?.cacheHealth,
      };
    })
  );

  return jsonResponse({
    ok: true,
    service: 'frank-forecast',
    checkedAt: new Date().toISOString(),
    locations: entries,
  });
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(),
      });
    }

    try {
      const url = new URL(request.url);
      const normalizedPath = url.pathname.replace(/\/+$/, '') || '/';

      if (normalizedPath === '/') {
        return jsonResponse({
          ok: true,
          service: 'frank-forecast',
          endpoints: [...locations.map((l) => `/forecast/${l.id}`), '/health'],
        });
      }

      if (normalizedPath === '/health') {
        return handleHealthRequest(env);
      }

      const forecastMatch = normalizedPath.match(/^\/forecast\/([a-z0-9-]+)$/);
      if (forecastMatch) {
        return handleForecastRequest(request, env, ctx, forecastMatch[1]);
      }

      return jsonResponse({ error: 'Not found' }, 404);
    } catch (error) {
      console.error('Worker request failed:', error);
      return jsonResponse({
        error: 'Forecast service failed',
        message: 'An internal error occurred while fetching or processing forecast data.',
      }, 503);
    }
  },

  async scheduled(_event, env, _ctx) {
    // Isolate failures per location: a rebuild throw (no cached payload + a
    // provider outage) must not starve the remaining locations of their cron
    // refresh for the whole tick.
    for (const location of locations) {
      try {
        await refreshForecastCache(env, location, {
          reason: 'cron',
          minIntervalMs: CRON_CHECK_MIN_INTERVAL_MS,
        });
      } catch (error) {
        console.error(`Cron refresh failed for ${location.id}:`, error);
      }
    }
  },
};
