import type { HourlyData, SeriesPoint } from './types';
import { metSymbolToWmoCode } from './weatherCodes';

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
  summary?: { symbol_code?: string };
  details?: { precipitation_amount?: number };
}

export interface MetTimeseriesEntry {
  time?: string;
  data?: {
    instant?: {
      details?: {
        air_temperature?: number;
        wind_speed?: number;
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

// Shared forecast-core helpers. Exported so the Worker imports the one canonical
// copy instead of maintaining its own (they must never drift — they compute the
// numbers the safety verdict runs on).
export function asNumber(value: number | string | null | undefined): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
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
      if (!time || !symbolCode) return null;

      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return null;

      const instant = entry.data?.instant?.details ?? {};

      return {
        time: date.toISOString(),
        timeMs: date.getTime(),
        symbolCode,
        weatherCode: metSymbolToWmoCode(symbolCode),
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
  weatherCode: number;
  tempAir?: number;
  windSpeed?: number;
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
      const period = six?.summary?.symbol_code ? six : twelve?.summary?.symbol_code ? twelve : undefined;
      const symbolCode = period?.summary?.symbol_code;
      if (!time || !period || !symbolCode) return null;

      const date = new Date(time);
      if (Number.isNaN(date.getTime())) return null;

      const instant = entry.data?.instant?.details ?? {};

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
  // field is absent across the whole window, fall back to [0] (the old
  // behaviour) so max/min/avg stay finite.
  const definedNums = (arr: (number | undefined)[]): number[] => {
    const out = arr.filter((v): v is number => v != null);
    return out.length ? out : [0];
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

// A longer-range block row: MET symbol + wind for the period, DMI marine
// aggregated inside it. Scalar fields carry the decision value (max wind/gust/
// wave, representative tide, average water temp); *Min/*Max carry the range.
// Shared so the Worker and client build identical block rows.
export function assembleBlockRow(block: MetBlock, marine: BlockMarine, isDay: boolean): HourlyData {
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
    // MET's single instant wind value at the start of this outlook block.
    // Do not present ensemble percentiles as a within-block min–max range.
    windSpeedMin: windSpeed,
    windSpeedMax: windSpeed,
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
