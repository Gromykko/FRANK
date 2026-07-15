// NOTE: this is a standalone local-debugging tool (`npm run forecast:cache`). It
// keeps its OWN copy of the forecast-normalization functions because it runs as
// plain Node and can't import the shared .ts core. The canonical, production
// versions live in src/features/forecast/{normalize,sun,weatherCodes}.ts (used
// by both the Worker and the client) — keep this copy in sync if you change the
// core, or run it through a TS loader to share directly.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const locations = JSON.parse(
  await readFile(new URL('../src/config/locations.json', import.meta.url), 'utf8')
);

const FORECAST_HOURS = 132;
const FETCH_TIMEOUT_MS = 45_000;
const MAX_FETCH_ATTEMPTS = 7;
const RETRY_BASE_DELAY_MS = 2_000;
const MAX_RETRY_DELAY_MS = 90_000;
const DMI_BASE = 'https://opendataapi.dmi.dk/v1/forecastedr';
const MET_BASE = 'https://api.met.no/weatherapi/locationforecast/2.0/complete';
const MET_USER_AGENT = 'F.R.A.N.K.-kayak-forecast/1.0 (https://github.com/Gromykko/F.R.A.N.K)';
const MANUAL_CACHE_OUTPUT_DIR = process.env.FORECAST_CACHE_OUTPUT_DIR ?? '.forecast-cache';

const WAM_PARAMETERS = [
  'significant-wave-height',
  'mean-wave-dir',
  'mean-wave-period',
  'dominant-wave-period',
];

const DKSS_PARAMETERS = [
  'sea-mean-deviation',
  'water-temperature',
  'current-u',
  'current-v',
];

const MET_SYMBOL_TO_WMO = {
  clearsky: 0,
  fair: 1,
  partlycloudy: 2,
  cloudy: 3,
  fog: 45,
  lightrain: 61,
  rain: 63,
  heavyrain: 65,
  lightrainshowers: 80,
  rainshowers: 81,
  heavyrainshowers: 82,
  lightsleet: 66,
  sleet: 66,
  heavysleet: 67,
  lightsleetshowers: 66,
  sleetshowers: 66,
  heavysleetshowers: 67,
  lightsnow: 71,
  snow: 73,
  heavysnow: 75,
  lightsnowshowers: 85,
  snowshowers: 85,
  heavysnowshowers: 86,
};

function metSymbolToWmoCode(symbol) {
  if (!symbol) return 3;
  const base = symbol.replace(/_(day|night|polartwilight)$/, '');
  if (base.includes('thunder')) return base.includes('heavy') ? 99 : 95;
  return MET_SYMBOL_TO_WMO[base] ?? 3;
}

function getDmiDateRange() {
  const start = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const end = new Date(Date.now() + FORECAST_HOURS * 60 * 60 * 1000);
  return `${start.toISOString()}/${end.toISOString()}`;
}

function buildDmiUrl(collection, parameters, location) {
  const query = new URLSearchParams({
    coords: `POINT(${location.coordinate.longitude} ${location.coordinate.latitude})`,
    crs: 'crs84',
    'parameter-name': parameters.join(','),
    datetime: getDmiDateRange(),
    f: 'GeoJSON',
  });

  return `${DMI_BASE}/collections/${collection}/position?${query.toString()}`;
}

function buildMetUrl(location) {
  const lat = location.coordinate.latitude.toFixed(4);
  const lon = location.coordinate.longitude.toFixed(4);
  return `${MET_BASE}?lat=${lat}&lon=${lon}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  const exponential = Math.min(MAX_RETRY_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** attempt);
  return exponential + Math.floor(Math.random() * 1_500);
}

async function fetchWithTimeout(url, headers = { Accept: 'application/geo+json, application/json' }) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    return await fetch(url, {
      headers,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchJsonWithRetries(url, label, headers) {
  let lastError;

  for (let attempt = 0; attempt < MAX_FETCH_ATTEMPTS; attempt++) {
    try {
      const response = await fetchWithTimeout(url, headers);
      if (response.ok) return await response.json();

      const message = await response.text();
      lastError = new Error(`${label} failed: ${response.status} ${message.slice(0, 160)}`);
      if (response.status !== 429 && response.status < 500) throw lastError;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < MAX_FETCH_ATTEMPTS - 1) {
      await delay(retryDelay(attempt));
    }
  }

  throw lastError ?? new Error(`${label} failed`);
}

async function fetchFirstAvailableCollection(collections, parameters, location) {
  let lastError;

  for (const collection of collections) {
    try {
      const data = await fetchJsonWithRetries(buildDmiUrl(collection, parameters, location), `DMI ${collection}`);
      return { collection, data };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      await delay(400);
    }
  }

  throw lastError ?? new Error(`DMI request failed for ${collections.join(', ')}`);
}

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeDegrees(value) {
  if (value === undefined) return undefined;
  return ((value % 360) + 360) % 360;
}

function currentSpeedFromComponents(u, v) {
  if (u === undefined || v === undefined) return undefined;
  return Math.sqrt(u * u + v * v);
}

function currentDirectionFromComponents(u, v) {
  if (u === undefined || v === undefined) return undefined;
  return normalizeDegrees((Math.atan2(u, v) * 180) / Math.PI);
}

function mapWaveFeatures(features) {
  return (features ?? [])
    .map((feature) => {
      const time = feature.properties?.step;
      if (!time) return null;
      const properties = feature.properties;
      return {
        time,
        timeMs: new Date(time).getTime(),
        waveHeight: asNumber(properties['significant-wave-height']),
        waveDirection: normalizeDegrees(asNumber(properties['mean-wave-dir'])),
        wavePeriod: asNumber(properties['mean-wave-period']) ?? asNumber(properties['dominant-wave-period']),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timeMs - b.timeMs);
}

function mapWaterFeatures(features) {
  return (features ?? [])
    .map((feature) => {
      const time = feature.properties?.step;
      if (!time) return null;
      const properties = feature.properties;
      const currentU = asNumber(properties['current-u']);
      const currentV = asNumber(properties['current-v']);
      return {
        time,
        timeMs: new Date(time).getTime(),
        tideLevel: asNumber(properties['sea-mean-deviation']),
        tempWater: asNumber(properties['water-temperature']),
        currentSpeed: currentSpeedFromComponents(currentU, currentV),
        currentDirection: currentDirectionFromComponents(currentU, currentV),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timeMs - b.timeMs);
}

function mapMetTimeseries(data) {
  const series = data?.properties?.timeseries;
  if (!Array.isArray(series)) return [];

  return series
    .map((entry) => {
      const time = entry?.time;
      const symbolCode = entry?.data?.next_1_hours?.summary?.symbol_code;
      if (!time || !symbolCode) return null;
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return null;
      const instant = entry?.data?.instant?.details ?? {};
      return {
        time: date.toISOString(),
        timeMs: date.getTime(),
        symbolCode,
        weatherCode: metSymbolToWmoCode(symbolCode),
        tempAir: asNumber(instant.air_temperature),
        precipitation: asNumber(entry?.data?.next_1_hours?.details?.precipitation_amount) ?? 0,
        windSpeed: asNumber(instant.wind_speed),
        windDirection: normalizeDegrees(asNumber(instant.wind_from_direction)),
        windGust: asNumber(instant.wind_speed_of_gust),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timeMs - b.timeMs);
}

// MET longer-range period blocks (next_6_hours, or next_12_hours fallback).
function mapMetBlocks(data) {
  const series = data?.properties?.timeseries;
  if (!Array.isArray(series)) return [];

  return series
    .map((entry) => {
      const time = entry?.time;
      const six = entry?.data?.next_6_hours;
      const twelve = entry?.data?.next_12_hours;
      const period = six?.summary?.symbol_code ? six : twelve?.summary?.symbol_code ? twelve : undefined;
      const symbolCode = period?.summary?.symbol_code;
      if (!time || !period || !symbolCode) return null;
      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return null;
      const instant = entry?.data?.instant?.details ?? {};
      return {
        time: date.toISOString(),
        timeMs: date.getTime(),
        spanHours: period === six ? 6 : 12,
        symbolCode,
        weatherCode: metSymbolToWmoCode(symbolCode),
        tempAir: asNumber(instant.air_temperature),
        windSpeed: asNumber(instant.wind_speed),
        windGust: asNumber(instant.wind_speed_of_gust),
        windDirection: normalizeDegrees(asNumber(instant.wind_from_direction)),
        windSpeedMin: asNumber(instant.wind_speed_percentile_10),
        windSpeedMax: asNumber(instant.wind_speed_percentile_90),
        precipitation: asNumber(period.details?.precipitation_amount) ?? 0,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timeMs - b.timeMs);
}

function aggregateBlockMarine(waveSeries, waterSeries, startMs, endMs) {
  const waves = waveSeries.filter((p) => p.timeMs >= startMs && p.timeMs < endMs);
  const waters = waterSeries.filter((p) => p.timeMs >= startMs && p.timeMs < endMs);
  if (waves.length === 0 || waters.length === 0) return undefined;

  // Mirrors normalize.ts: aggregate only samples that carry a value (coercing a
  // missing sample to 0 drags averages toward 0 and collapses mins to 0).
  const definedNums = (arr) => {
    const out = arr.filter((v) => v != null);
    return out.length ? out : [0];
  };
  const waveHeights = definedNums(waves.map((w) => w.waveHeight));
  const tideLevels = definedNums(waters.map((w) => w.tideLevel));
  const temps = definedNums(waters.map((w) => w.tempWater));

  const centreMs = startMs + (endMs - startMs) / 2;
  const closestTo = (series) => series.reduce((best, p) =>
    Math.abs(p.timeMs - centreMs) < Math.abs(best.timeMs - centreMs) ? p : best, series[0]);
  const centre = closestTo(waters);
  const centreWave = closestTo(waves);

  return {
    waveHeight: Math.max(...waveHeights),
    waveHeightMin: Math.min(...waveHeights),
    waveHeightMax: Math.max(...waveHeights),
    waveDirection: centreWave.waveDirection ?? 0,
    wavePeriod: centreWave.wavePeriod ?? 0,
    tideLevel: centre.tideLevel ?? 0,
    tideLevelMin: Math.min(...tideLevels),
    tideLevelMax: Math.max(...tideLevels),
    tempWater: temps.reduce((a, b) => a + b, 0) / temps.length,
    tempWaterMin: Math.min(...temps),
    tempWaterMax: Math.max(...temps),
    currentSpeed: centre.currentSpeed ?? 0,
    currentDirection: centre.currentDirection ?? 0,
  };
}

function assembleBlockRow(block, marine, isDay) {
  const windSpeed = block.windSpeed ?? 0;
  const windGust = block.windGust ?? block.windSpeed ?? 0;
  return {
    time: block.time,
    tempAir: block.tempAir ?? 0,
    precipitation: block.precipitation ?? 0,
    symbolCode: block.symbolCode,
    weatherCode: block.weatherCode,
    windSpeed,
    windDirection: block.windDirection ?? 0,
    windGust,
    waveHeight: marine.waveHeight,
    waveDirection: marine.waveDirection,
    wavePeriod: marine.wavePeriod,
    tempWater: marine.tempWater,
    tideLevel: marine.tideLevel,
    currentSpeed: marine.currentSpeed,
    currentDirection: marine.currentDirection,
    isDay,
    isOutlook: true,
    isLowConfidence: true,
    blockSpanHours: block.spanHours,
    // Mirrors normalize.ts assembleBlockRow: MET percentiles clamped around
    // the decision value; gust ceiling never below the wind range's top.
    windSpeedMin: Math.min(block.windSpeedMin ?? windSpeed, windSpeed),
    windSpeedMax: Math.max(block.windSpeedMax ?? windSpeed, windSpeed),
    windGustMax: Math.max(windGust, block.windSpeedMax ?? windSpeed),
    waveHeightMin: marine.waveHeightMin,
    waveHeightMax: marine.waveHeightMax,
    tideLevelMin: marine.tideLevelMin,
    tideLevelMax: marine.tideLevelMax,
    tempWaterMin: marine.tempWaterMin,
    tempWaterMax: marine.tempWaterMax,
    weatherSource: 'met-locationforecast',
    marineSource: 'dmi-dkss-wam',
  };
}

// Astronomical sunrise/sunset — MET carries no sun/is_day data.
function sunDayOfYear(year, monthIndex, day) {
  const start = Date.UTC(year, 0, 0);
  const current = Date.UTC(year, monthIndex, day);
  return Math.floor((current - start) / 86_400_000);
}

function calculateSunTime(year, monthIndex, day, isSunrise, location) {
  const rad = Math.PI / 180;
  const degrees = 180 / Math.PI;
  const zenith = 90.833;
  const n = sunDayOfYear(year, monthIndex, day);
  const lngHour = location.coordinate.longitude / 15;
  const approxTime = n + ((isSunrise ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * approxTime - 3.289;
  let trueLongitude =
    meanAnomaly + 1.916 * Math.sin(rad * meanAnomaly) + 0.02 * Math.sin(rad * 2 * meanAnomaly) + 282.634;
  trueLongitude = ((trueLongitude % 360) + 360) % 360;

  let rightAscension = degrees * Math.atan(0.91764 * Math.tan(rad * trueLongitude));
  rightAscension = ((rightAscension % 360) + 360) % 360;

  const longitudeQuadrant = Math.floor(trueLongitude / 90) * 90;
  const ascensionQuadrant = Math.floor(rightAscension / 90) * 90;
  rightAscension = (rightAscension + longitudeQuadrant - ascensionQuadrant) / 15;

  const sinDec = 0.39782 * Math.sin(rad * trueLongitude);
  const cosDec = Math.cos(Math.asin(sinDec));
  const latRad = location.coordinate.latitude * rad;
  const cosHourAngle = (Math.cos(rad * zenith) - sinDec * Math.sin(latRad)) / (cosDec * Math.cos(latRad));
  const clampedCosHourAngle = Math.min(1, Math.max(-1, cosHourAngle));

  let hourAngle = isSunrise
    ? 360 - degrees * Math.acos(clampedCosHourAngle)
    : degrees * Math.acos(clampedCosHourAngle);
  hourAngle /= 15;

  const localMeanTime = hourAngle + rightAscension - 0.06571 * approxTime - 6.622;
  const utcHour = (((localMeanTime - lngHour) % 24) + 24) % 24;
  const utcTime = Date.UTC(year, monthIndex, day) + utcHour * 60 * 60 * 1000;
  return new Date(utcTime).toISOString();
}

function localDateKey(date) {
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, '0');
  const day = `${date.getUTCDate()}`.padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function buildSunSchedule(hourlyTimes, location) {
  const days = new Map();
  hourlyTimes.forEach((time) => {
    const date = new Date(time);
    days.set(localDateKey(date), {
      year: date.getUTCFullYear(),
      monthIndex: date.getUTCMonth(),
      day: date.getUTCDate(),
    });
  });

  const schedule = [...days.values()]
    .map((dateParts) => ({
      sunrise: calculateSunTime(dateParts.year, dateParts.monthIndex, dateParts.day, true, location),
      sunset: calculateSunTime(dateParts.year, dateParts.monthIndex, dateParts.day, false, location),
      dateKey: `${dateParts.year}-${`${dateParts.monthIndex + 1}`.padStart(2, '0')}-${`${dateParts.day}`.padStart(2, '0')}`,
    }))
    .sort((a, b) => new Date(a.sunrise).getTime() - new Date(b.sunrise).getTime());

  const isDayByTime = new Map();
  hourlyTimes.forEach((time) => {
    const date = new Date(time);
    const scheduleForDay = schedule.find((item) => item.dateKey === localDateKey(date));
    const timeMs = date.getTime();
    const sunriseMs = scheduleForDay ? new Date(scheduleForDay.sunrise).getTime() : 0;
    const sunsetMs = scheduleForDay ? new Date(scheduleForDay.sunset).getTime() : 0;
    isDayByTime.set(time, timeMs >= sunriseMs && timeMs <= sunsetMs);
  });

  return {
    sunrise: schedule.map((item) => item.sunrise),
    sunset: schedule.map((item) => item.sunset),
    isDayByTime,
  };
}

function nearestPoint(series, timeMs, maxDifferenceMs = 90 * 60 * 1000) {
  let best;
  let bestDiff = Infinity;
  for (const point of series) {
    const diff = Math.abs(point.timeMs - timeMs);
    if (diff < bestDiff) {
      best = point;
      bestDiff = diff;
    }
  }
  return bestDiff <= maxDifferenceMs ? best : undefined;
}

async function buildForecastCache(location) {
  const metData = await fetchJsonWithRetries(buildMetUrl(location), `MET Norway ${location.areaName}`, {
    Accept: 'application/json',
    'User-Agent': MET_USER_AGENT,
  });
  await delay(500);
  const waterResult = await fetchFirstAvailableCollection(location.dmiCollections.water, DKSS_PARAMETERS, location);
  await delay(750);
  const waveResult = await fetchFirstAvailableCollection(location.dmiCollections.waves, WAM_PARAMETERS, location);

  const weatherSeries = mapMetTimeseries(metData);
  const metBlocks = mapMetBlocks(metData);
  const waterSeries = mapWaterFeatures(waterResult.data.features);
  const waveSeries = mapWaveFeatures(waveResult.data.features);

  if (weatherSeries.length === 0) throw new Error(`MET Norway returned no weather points for ${location.areaName}.`);
  if (waterSeries.length === 0) throw new Error(`DMI returned no DKSS points for ${location.areaName}.`);
  if (waveSeries.length === 0) throw new Error(`DMI returned no WAM points for ${location.areaName}.`);

  const hourlyEndMs = weatherSeries[weatherSeries.length - 1].timeMs;
  const blockData = [];
  for (const block of metBlocks) {
    if (block.timeMs <= hourlyEndMs) continue;
    const marine = aggregateBlockMarine(waveSeries, waterSeries, block.timeMs, block.timeMs + block.spanHours * 3_600_000);
    if (!marine) break;
    blockData.push({ block, marine });
  }

  const allTimes = [...weatherSeries.map((w) => w.time), ...blockData.map((b) => b.block.time)];
  const sun = buildSunSchedule(allTimes, location);

  const hourly = weatherSeries
    .map((weather) => {
      const water = nearestPoint(waterSeries, weather.timeMs);
      const wave = nearestPoint(waveSeries, weather.timeMs);
      if (!water || !wave) return null;
      return {
        time: weather.time,
        tempAir: weather.tempAir ?? 0,
        precipitation: weather.precipitation ?? 0,
        symbolCode: weather.symbolCode ?? '',
        weatherCode: weather.weatherCode ?? 0,
        windSpeed: weather.windSpeed ?? 0,
        windDirection: weather.windDirection ?? 0,
        windGust: weather.windGust ?? weather.windSpeed ?? 0,
        waveHeight: wave.waveHeight ?? 0,
        waveDirection: wave.waveDirection ?? 0,
        wavePeriod: wave.wavePeriod ?? 0,
        tempWater: water.tempWater ?? 0,
        tideLevel: water.tideLevel ?? 0,
        currentSpeed: water.currentSpeed ?? 0,
        currentDirection: water.currentDirection ?? 0,
        isDay: sun.isDayByTime.get(weather.time) ?? true,
        weatherSource: 'met-locationforecast',
        marineSource: 'dmi-dkss-wam',
      };
    })
    .filter(Boolean)
    .concat(blockData.map(({ block, marine }) => assembleBlockRow(block, marine, sun.isDayByTime.get(block.time) ?? true)));

  return {
    hourly,
    sunrise: sun.sunrise,
    sunset: sun.sunset,
    sources: {
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
}

for (const location of locations) {
  const outputPath = resolve(MANUAL_CACHE_OUTPUT_DIR, `${location.id}.forecast-cache.json`);
  const data = await buildForecastCache(location);

  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(data)}\n`, 'utf8');

  console.log(`Wrote ${outputPath} for ${location.areaName} with ${data.hourly.length} forecast hours.`);
}
