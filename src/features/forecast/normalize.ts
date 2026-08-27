import type { HourlyData, SeriesPoint } from './types';
export interface DmiFeature {
  type: 'Feature';
  geometry?: {
    type: 'Point';
    coordinates: [number, number];
  };
  properties: Record<string, number | string | null | undefined> & {
    step?: string;
  };
}

export interface DmiFeatureCollection {
  type: 'FeatureCollection';
  features: DmiFeature[];
}

// MET Norway Locationforecast 2.0 (the "complete" product). Only the fields
// FRANK reads are typed here.
interface MetPeriod {
  // Provider JSON is untrusted at runtime. The mappers below admit only a
  // non-empty string, so a malformed truthy value cannot reach symbol lookup.
  summary?: { symbol_code?: unknown };
  details?: { precipitation_amount?: number };
}

export interface MetTimeseriesEntry {
  time?: string;
  data?: {
    instant?: {
      details?: {
        air_temperature?: number;
        wind_speed?: number;
        wind_speed_percentile_90?: number;
        wind_speed_of_gust?: number;
        wind_from_direction?: number;
      };
    };
    next_1_hours?: MetPeriod;
    // Coarser period products used for the longer-range blocks past the hourly range.
    next_6_hours?: MetPeriod;
    next_12_hours?: MetPeriod;
  };
}

export interface MetForecastResponse {
  properties?: {
    timeseries?: MetTimeseriesEntry[];
  };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

// Shared forecast-core helpers. Exported so the Worker imports the one canonical
// copy instead of maintaining its own (they must never drift — they compute the
// numbers the safety verdict runs on).
// A reading the providers did not give us. NaN rather than 0, because 0 is a
// perfectly plausible measurement — 0 m of wave and 0°C water both read as real
// values to every threshold, and "flat calm" is the most dangerous thing a
// missing wave height could pretend to be. Every `>=`/`<` against NaN is false,
// and analyzeSafetyConditions treats a non-finite reading as "cannot clear this
// hour" rather than as a pass.
export const NO_READING = NaN;

// The numeric HourlyData fields, i.e. everything NO_READING can land in.
const READING_FIELDS = [
  'tempAir', 'precipitation', 'windSpeed', 'windDirection', 'windGust',
  'waveHeight', 'waveDirection', 'wavePeriod', 'tempWater', 'tideLevel',
  'currentSpeed', 'currentDirection',
  'windSpeedMin', 'windSpeedMax', 'windSpeedP90', 'windGustMax', 'waveHeightMin', 'waveHeightMax',
  'tideLevelMin', 'tideLevelMax', 'tempWaterMin', 'tempWaterMax',
] as const;

// JSON has no NaN: `JSON.stringify(NaN)` is `null`, so every NO_READING becomes
// null the moment a payload crosses the Worker boundary or hits localStorage.
// That matters because null and NaN behave OPPOSITELY in a comparison —
// `null <= 0.1` is true and `Math.min(null, 4)` is 0, so a missing reading would
// quietly come back as a flat calm, while `NaN` fails every comparison as
// intended. Revive them on the way in, so all the code downstream sees the
// values it was written against. (Dev fetches directly and never serializes,
// which is exactly why this only ever showed up in production.)
export function reviveReadings<T extends { hourly?: unknown[] }>(payload: T): T {
  if (!payload || !Array.isArray(payload.hourly)) return payload;
  for (const hour of payload.hourly as Record<string, unknown>[]) {
    if (!hour) continue;
    for (const field of READING_FIELDS) {
      if (hour[field] === null) hour[field] = NO_READING;
    }
  }
  return payload;
}

export function asNumber(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    // Number('') and Number('  ') are both 0 — an empty field is missing data,
    // not a zero measurement.
    if (value.trim() === '') return undefined;
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

export function normalizeDegrees(value: number | undefined): number | undefined {
  if (value === undefined) return undefined;
  return ((value % 360) + 360) % 360;
}

export function currentDirectionFromComponents(u: number | undefined, v: number | undefined): number | undefined {
  if (u === undefined || v === undefined) return undefined;
  return normalizeDegrees((Math.atan2(u, v) * 180) / Math.PI);
}

export function currentSpeedFromComponents(u: number | undefined, v: number | undefined): number | undefined {
  if (u === undefined || v === undefined) return undefined;
  return Math.sqrt(u * u + v * v);
}

function featureStep(feature: DmiFeature): string | undefined {
  const step = feature.properties.step;
  return typeof step === 'string' ? step : undefined;
}

// DMI WAM wave model → significant wave height, direction, and period.
export function mapWaveFeatures(features: DmiFeature[]): SeriesPoint[] {
  return features
    .map((feature): SeriesPoint | null => {
      const time = featureStep(feature);
      if (!time) return null;

      const properties = feature.properties;

      return {
        time,
        timeMs: new Date(time).getTime(),
        waveHeight: asNumber(properties['significant-wave-height']),
        waveDirection: normalizeDegrees(asNumber(properties['mean-wave-dir'])),
        wavePeriod: asNumber(properties['mean-wave-period']) ?? asNumber(properties['dominant-wave-period']),
      } satisfies SeriesPoint;
    })
    .filter((point): point is SeriesPoint => Boolean(point))
    .sort((a, b) => a.timeMs - b.timeMs);
}

// DMI DKSS ocean model → water level, water temperature, and currents.
export function mapWaterFeatures(features: DmiFeature[]): SeriesPoint[] {
  return features
    .map((feature): SeriesPoint | null => {
      const time = featureStep(feature);
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
      } satisfies SeriesPoint;
    })
    .filter((point): point is SeriesPoint => Boolean(point))
    .sort((a, b) => a.timeMs - b.timeMs);
}

// MET Norway Locationforecast → the whole weather picture: MET's own condition
// symbol (which decides severity and drives the icon/label), air temperature,
// wind, gusts, and precipitation. Only entries with an hourly `next_1_hours`
// summary are kept, so the weather series covers MET's hourly range (~2 days);
// the coarser 6-hourly tail is intentionally dropped.
export function mapMetTimeseries(data: MetForecastResponse): SeriesPoint[] {
  const series = data.properties?.timeseries;
  if (!Array.isArray(series)) return [];

  return series
    .map((entry): SeriesPoint | null => {
      const time = entry.time;
      const symbolCode = entry.data?.next_1_hours?.summary?.symbol_code;
      if (!time || !isNonBlankString(symbolCode)) return null;

      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return null;

      const instant = entry.data?.instant?.details ?? {};

      return {
        time: date.toISOString(),
        timeMs: date.getTime(),
        symbolCode,
        tempAir: asNumber(instant.air_temperature),
        precipitation: asNumber(entry.data?.next_1_hours?.details?.precipitation_amount) ?? 0,
        windSpeed: asNumber(instant.wind_speed),
        windDirection: normalizeDegrees(asNumber(instant.wind_from_direction)),
        windGust: asNumber(instant.wind_speed_of_gust),
      } satisfies SeriesPoint;
    })
    .filter((point): point is SeriesPoint => Boolean(point))
    .sort((a, b) => a.timeMs - b.timeMs);
}

// A MET longer-range period block (from next_6_hours, or next_12_hours as a
// fallback). MET only carries one `instant` sample per block after the hourly
// range, so wind/temp here are that single period value.
export interface MetBlock {
  time: string;
  timeMs: number;
  spanHours: number;
  symbolCode: string;
  tempAir?: number;
  windSpeed?: number;
  // MET complete-product uncertainty estimate at this instant. It is not a
  // maximum observed or forecast across spanHours.
  windSpeedP90?: number;
  windGust?: number;
  windDirection?: number;
  precipitation: number;
}

export function mapMetBlocks(data: MetForecastResponse): MetBlock[] {
  const series = data.properties?.timeseries;
  if (!Array.isArray(series)) return [];

  return series
    .map((entry): MetBlock | null => {
      const time = entry.time;
      const six = entry.data?.next_6_hours;
      const twelve = entry.data?.next_12_hours;
      const sixSymbol = six?.summary?.symbol_code;
      const twelveSymbol = twelve?.summary?.symbol_code;
      const period = isNonBlankString(sixSymbol)
        ? six
        : isNonBlankString(twelveSymbol)
          ? twelve
          : undefined;
      const symbolCode = period?.summary?.symbol_code;
      if (!time || !period || !isNonBlankString(symbolCode)) return null;

      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return null;

      const instant = entry.data?.instant?.details ?? {};

      return {
        time: date.toISOString(),
        timeMs: date.getTime(),
        spanHours: period === six ? 6 : 12,
        symbolCode,
        tempAir: asNumber(instant.air_temperature),
        windSpeed: asNumber(instant.wind_speed),
        windSpeedP90: asNumber(instant.wind_speed_percentile_90),
        windGust: asNumber(instant.wind_speed_of_gust),
        windDirection: normalizeDegrees(asNumber(instant.wind_from_direction)),
        precipitation: asNumber(period.details?.precipitation_amount) ?? 0,
      } satisfies MetBlock;
    })
    .filter((block): block is MetBlock => Boolean(block))
    .sort((a, b) => a.timeMs - b.timeMs);
}

export interface BlockMarine {
  waveHeight: number;
  waveHeightMin: number;
  waveHeightMax: number;
  waveDirection: number;
  wavePeriod: number;
  tideLevel: number;
  tideLevelMin: number;
  tideLevelMax: number;
  tempWater: number;
  tempWaterMin: number;
  tempWaterMax: number;
  currentSpeed: number;
  currentDirection: number;
}

// Aggregate the hourly DMI marine series inside one block window: max wave,
// min/max + centre-representative tide, average + min/max water temp. Returns
// undefined when no marine samples fall in the window (i.e. past the marine
// horizon), which the callers use to stop extending blocks.
export function aggregateBlockMarine(
  waveSeries: SeriesPoint[],
  waterSeries: SeriesPoint[],
  startMs: number,
  endMs: number
): BlockMarine | undefined {
  const waves = waveSeries.filter((p) => p.timeMs >= startMs && p.timeMs < endMs);
  const waters = waterSeries.filter((p) => p.timeMs >= startMs && p.timeMs < endMs);
  if (waves.length === 0 || waters.length === 0) return undefined;

  // Aggregate only the samples that actually carry a value — coercing a missing
  // sample to 0 would drag the average toward 0 and collapse the min to 0. If a
  // field is absent across the WHOLE window there is nothing to aggregate, so
  // the result is NO_READING, not a fabricated 0.
  const definedNums = (arr: (number | undefined)[]): number[] => {
    const out = arr.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    return out.length ? out : [NO_READING];
  };
  const waveHeights = definedNums(waves.map((w) => w.waveHeight));
  const tideLevels = definedNums(waters.map((w) => w.tideLevel));
  const temps = definedNums(waters.map((w) => w.tempWater));

  const centreMs = startMs + (endMs - startMs) / 2;
  const closestTo = (series: SeriesPoint[]) =>
    series.reduce((best, p) => (Math.abs(p.timeMs - centreMs) < Math.abs(best.timeMs - centreMs) ? p : best), series[0]);
  const centre = closestTo(waters);
  const centreWave = closestTo(waves);

  return {
    waveHeight: Math.max(...waveHeights),
    waveHeightMin: Math.min(...waveHeights),
    waveHeightMax: Math.max(...waveHeights),
    waveDirection: centreWave.waveDirection ?? NO_READING,
    wavePeriod: centreWave.wavePeriod ?? NO_READING,
    tideLevel: centre.tideLevel ?? NO_READING,
    tideLevelMin: Math.min(...tideLevels),
    tideLevelMax: Math.max(...tideLevels),
    // Coldest sample, not the mean — matching waveHeight's Math.max. For both
    // readings the hazard sits at one end of the range, and the block's
    // decision value has to be the end that can hurt you: a 6-hour block of
    // 9.8/9.9/10.1/10.2/10.3/10.4 averages 10.12 and rates caution, while its
    // coldest hour is below the 10 °C cold-shock danger line.
    tempWater: Math.min(...temps),
    tempWaterMin: Math.min(...temps),
    tempWaterMax: Math.max(...temps),
    currentSpeed: centre.currentSpeed ?? NO_READING,
    currentDirection: centre.currentDirection ?? NO_READING,
  };
}

// A longer-range block row: MET symbol + start-instant wind for the period,
// with DMI marine aggregated inside it. Central wind stays the honest display
// value; its p90 uncertainty estimate travels separately as informational
// context. Marine scalar fields carry their hazard/representative
// decision values, and *Min/*Max carry genuine within-block ranges. Shared so
// the Worker and client build identical block rows.
export function assembleBlockRow(block: MetBlock, marine: BlockMarine, isDay: boolean): HourlyData {
  const windSpeed = block.windSpeed ?? NO_READING;
  // MET publishes no gust for its 6/12-hourly blocks. Substituting the
  // sustained wind here made the UI print "gusts N max" for a gust nobody
  // forecast — and understated it, since real gusts run well above sustained.
  const windGust = block.windGust ?? NO_READING;
  return {
    time: block.time,
    tempAir: block.tempAir ?? NO_READING,
    precipitation: block.precipitation ?? 0,
    symbolCode: block.symbolCode,
    windSpeed,
    windDirection: block.windDirection ?? NO_READING,
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
    // MET's single instant wind value at the start of this outlook block.
    // Do not present ensemble percentiles as a within-block min–max range.
    windSpeedMin: windSpeed,
    windSpeedMax: windSpeed,
    windSpeedP90: block.windSpeedP90,
    windGustMax: windGust,
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

// A single hourly row: the MET weather hour joined to the nearest DMI marine
// samples (water + wave). Shared so the Worker and client build byte-identical
// hourly rows — this is the path the safety verdict runs on most, so any drift
// between them would diverge the dev/preview verdict from production.
export function assembleHourlyRow(
  weather: SeriesPoint,
  water: SeriesPoint,
  wave: SeriesPoint,
  isDay: boolean
): HourlyData {
  return {
    time: weather.time,
    tempAir: weather.tempAir ?? NO_READING,
    precipitation: weather.precipitation ?? 0,
    symbolCode: weather.symbolCode ?? '',
    windSpeed: weather.windSpeed ?? NO_READING,
    windDirection: weather.windDirection ?? NO_READING,
    windGust: weather.windGust ?? NO_READING,
    waveHeight: wave.waveHeight ?? NO_READING,
    waveDirection: wave.waveDirection ?? NO_READING,
    wavePeriod: wave.wavePeriod ?? NO_READING,
    tempWater: water.tempWater ?? NO_READING,
    tideLevel: water.tideLevel ?? NO_READING,
    currentSpeed: water.currentSpeed ?? NO_READING,
    currentDirection: water.currentDirection ?? NO_READING,
    isDay,
    weatherSource: 'met-locationforecast',
    marineSource: 'dmi-dkss-wam',
  };
}

export function nearestPoint(series: SeriesPoint[], timeMs: number, maxDifferenceMs = 90 * 60 * 1000): SeriesPoint | undefined {
  let best: SeriesPoint | undefined;
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
