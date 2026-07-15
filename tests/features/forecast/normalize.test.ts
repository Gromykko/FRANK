import { describe, it, expect } from 'vitest';
import { metSymbolToWmoCode, getWeatherDescription } from '../../../src/features/forecast/weatherCodes';
import {
  mapMetTimeseries,
  mapMetBlocks,
  aggregateBlockMarine,
  nearestPoint,
} from '../../../src/features/forecast/normalize';
import { blockHourRange } from '../../../src/features/forecast/blockHours';
import type { MetForecastResponse } from '../../../src/features/forecast/normalize';
import type { SeriesPoint } from '../../../src/features/forecast/types';

describe('metSymbolToWmoCode', () => {
  it('maps every thunder variant onto the WMO thunderstorm family', () => {
    expect(metSymbolToWmoCode('rainandthunder')).toBe(95);
    expect(metSymbolToWmoCode('sleetandthunder')).toBe(95);
    expect(metSymbolToWmoCode('snowandthunder')).toBe(95);
    expect(metSymbolToWmoCode('lightrainshowersandthunder_day')).toBe(95);
    expect(metSymbolToWmoCode('heavyrainandthunder')).toBe(99);
    expect(metSymbolToWmoCode('heavysnowshowersandthunder_night')).toBe(99);
  });

  it('maps the sleet family onto freezing-rain codes', () => {
    expect(metSymbolToWmoCode('lightsleet')).toBe(66);
    expect(metSymbolToWmoCode('sleet')).toBe(66);
    expect(metSymbolToWmoCode('sleetshowers')).toBe(66);
    expect(metSymbolToWmoCode('lightsleetshowers')).toBe(66);
    expect(metSymbolToWmoCode('heavysleet')).toBe(67);
    expect(metSymbolToWmoCode('heavysleetshowers')).toBe(67);
  });

  it('strips day/night/polartwilight suffixes before lookup', () => {
    expect(metSymbolToWmoCode('clearsky_day')).toBe(0);
    expect(metSymbolToWmoCode('clearsky_night')).toBe(0);
    expect(metSymbolToWmoCode('fair_polartwilight')).toBe(1);
    expect(metSymbolToWmoCode('partlycloudy_day')).toBe(2);
  });

  it('falls back to 3 (overcast) for unknown or missing symbols', () => {
    expect(metSymbolToWmoCode('someunknownsymbol')).toBe(3);
    expect(metSymbolToWmoCode(undefined)).toBe(3);
    expect(metSymbolToWmoCode('')).toBe(3);
  });

  it('maps the core precipitation family as documented', () => {
    expect(metSymbolToWmoCode('lightrain')).toBe(61);
    expect(metSymbolToWmoCode('rain')).toBe(63);
    expect(metSymbolToWmoCode('heavyrain')).toBe(65);
    expect(metSymbolToWmoCode('lightrainshowers')).toBe(80);
    expect(metSymbolToWmoCode('rainshowers')).toBe(81);
    expect(metSymbolToWmoCode('heavyrainshowers')).toBe(82);
    expect(metSymbolToWmoCode('lightsnow')).toBe(71);
    expect(metSymbolToWmoCode('snow')).toBe(73);
    expect(metSymbolToWmoCode('heavysnow')).toBe(75);
    expect(metSymbolToWmoCode('snowshowers')).toBe(85);
    expect(metSymbolToWmoCode('heavysnowshowers')).toBe(86);
    expect(metSymbolToWmoCode('fog')).toBe(45);
  });

  it('getWeatherDescription falls back for unknown codes', () => {
    expect(getWeatherDescription(42)).toBe('Unknown weather');
    expect(getWeatherDescription(95)).toBe('Thunderstorm risk');
  });
});

describe('mapMetTimeseries', () => {
  it('keeps only entries with an hourly symbol, maps fields, and sorts by time', () => {
    const response: MetForecastResponse = {
      properties: {
        timeseries: [
          {
            time: '2026-07-08T13:00:00Z',
            data: {
              instant: { details: { air_temperature: 18, wind_speed: 4, wind_speed_of_gust: 6, wind_from_direction: 370 } },
              next_1_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: 1.2 } },
            },
          },
          {
            // No next_1_hours symbol -> dropped (coarser tail).
            time: '2026-07-10T12:00:00Z',
            data: { next_6_hours: { summary: { symbol_code: 'cloudy' } } },
          },
          {
            time: '2026-07-08T12:00:00Z',
            data: {
              instant: { details: { wind_speed: 3 } },
              next_1_hours: { summary: { symbol_code: 'clearsky_day' } },
            },
          },
        ],
      },
    };

    const points = mapMetTimeseries(response);
    expect(points).toHaveLength(2);
    // Sorted ascending despite input order.
    expect(points[0].time).toBe('2026-07-08T12:00:00.000Z');
    expect(points[1].time).toBe('2026-07-08T13:00:00.000Z');
    // Field mapping on the full entry.
    expect(points[1].symbolCode).toBe('rain');
    expect(points[1].weatherCode).toBe(63);
    expect(points[1].tempAir).toBe(18);
    expect(points[1].precipitation).toBe(1.2);
    expect(points[1].windSpeed).toBe(4);
    expect(points[1].windGust).toBe(6);
    expect(points[1].windDirection).toBe(10); // 370 normalized
    // Missing precipitation defaults to 0.
    expect(points[0].precipitation).toBe(0);
  });

  it('returns an empty array for a malformed response', () => {
    expect(mapMetTimeseries({})).toEqual([]);
    expect(mapMetTimeseries({ properties: {} })).toEqual([]);
  });
});

describe('mapMetBlocks', () => {
  it('prefers next_6_hours over next_12_hours when both carry a symbol', () => {
    const response: MetForecastResponse = {
      properties: {
        timeseries: [
          {
            time: '2026-07-12T06:00:00Z',
            data: {
              instant: { details: { wind_speed: 3, wind_from_direction: -90 } },
              next_6_hours: { summary: { symbol_code: 'rain' }, details: { precipitation_amount: 2 } },
              next_12_hours: { summary: { symbol_code: 'clearsky_day' }, details: { precipitation_amount: 0 } },
            },
          },
        ],
      },
    };
    const blocks = mapMetBlocks(response);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].spanHours).toBe(6);
    expect(blocks[0].symbolCode).toBe('rain');
    expect(blocks[0].weatherCode).toBe(63);
    expect(blocks[0].precipitation).toBe(2); // from the chosen 6h period
    expect(blocks[0].windDirection).toBe(270); // -90 normalized
  });

  it('falls back to next_12_hours when next_6_hours has no symbol', () => {
    const response: MetForecastResponse = {
      properties: {
        timeseries: [
          {
            time: '2026-07-13T06:00:00Z',
            data: {
              next_6_hours: { details: { precipitation_amount: 5 } }, // no symbol
              next_12_hours: { summary: { symbol_code: 'cloudy' }, details: { precipitation_amount: 1 } },
            },
          },
          {
            // Neither period -> dropped.
            time: '2026-07-14T06:00:00Z',
            data: { instant: { details: { wind_speed: 2 } } },
          },
        ],
      },
    };
    const blocks = mapMetBlocks(response);
    expect(blocks).toHaveLength(1);
    expect(blocks[0].spanHours).toBe(12);
    expect(blocks[0].symbolCode).toBe('cloudy');
    expect(blocks[0].precipitation).toBe(1);
  });
});

describe('aggregateBlockMarine', () => {
  const HOUR = 3_600_000;
  const point = (timeMs: number, fields: Partial<SeriesPoint>): SeriesPoint => ({
    time: new Date(timeMs).toISOString(),
    timeMs,
    ...fields,
  });

  const waves = [
    // 0 = hour 0 (kept as a plain literal; `0 * HOUR` trips oxlint's erasing-op rule)
    point(0, { waveHeight: 0.2, waveDirection: 100, wavePeriod: 3 }),
    point(1 * HOUR, { waveHeight: 0.5, waveDirection: 200, wavePeriod: 4 }),
    point(2 * HOUR, { waveHeight: 0.3, waveDirection: 300, wavePeriod: 5 }),
  ];
  const waters = [
    // 0 = hour 0 (kept as a plain literal; `0 * HOUR` trips oxlint's erasing-op rule)
    point(0, { tideLevel: -0.2, tempWater: 14, currentSpeed: 0.1, currentDirection: 10 }),
    point(1 * HOUR, { tideLevel: 0.1, tempWater: 16, currentSpeed: 0.2, currentDirection: 20 }),
    point(2 * HOUR, { tideLevel: 0.3, tempWater: 18, currentSpeed: 0.3, currentDirection: 30 }),
  ];

  it('computes max wave, min/max ranges, centre-representative tide, and average temp', () => {
    const result = aggregateBlockMarine(waves, waters, 0, 3 * HOUR);
    expect(result).toBeDefined();
    // Wave decision value is the max; min/max carried alongside.
    expect(result!.waveHeight).toBe(0.5);
    expect(result!.waveHeightMin).toBe(0.2);
    expect(result!.waveHeightMax).toBe(0.5);
    // Direction/period from the sample closest to the window centre (1.5h -> 1h sample).
    expect(result!.waveDirection).toBe(200);
    expect(result!.wavePeriod).toBe(4);
    // Tide: centre-representative value plus full range.
    expect(result!.tideLevel).toBe(0.1);
    expect(result!.tideLevelMin).toBe(-0.2);
    expect(result!.tideLevelMax).toBe(0.3);
    // Temp: arithmetic mean plus range.
    expect(result!.tempWater).toBeCloseTo(16, 10);
    expect(result!.tempWaterMin).toBe(14);
    expect(result!.tempWaterMax).toBe(18);
    // Currents from the centre water sample.
    expect(result!.currentSpeed).toBe(0.2);
    expect(result!.currentDirection).toBe(20);
  });

  it('treats the window end as exclusive', () => {
    // Only sample sits exactly at endMs -> excluded -> no aggregation possible.
    const result = aggregateBlockMarine(
      [point(2 * HOUR, { waveHeight: 0.4 })],
      [point(2 * HOUR, { tideLevel: 0 })],
      0,
      2 * HOUR
    );
    expect(result).toBeUndefined();
  });

  it('returns undefined when either series has no samples in the window', () => {
    expect(aggregateBlockMarine([], waters, 0, 3 * HOUR)).toBeUndefined();
    expect(aggregateBlockMarine(waves, [], 0, 3 * HOUR)).toBeUndefined();
  });
});

describe('blockHourRange', () => {
  it('formats the location start/end hours of a block', () => {
    // blockHourRange renders hours in the LOCATION timezone, so the fixture
    // carries an explicit +02:00 (CEST) offset to be machine-independent.
    expect(blockHourRange('2026-07-08T06:00:00+02:00', 6)).toEqual({ start: '06', end: '12', short: '06–12' });
  });

  it('wraps past midnight', () => {
    expect(blockHourRange('2026-07-08T20:00:00+02:00', 6)).toEqual({ start: '20', end: '02', short: '20–02' });
  });
});

describe('nearestPoint', () => {
  const MINUTE = 60_000;
  const points: SeriesPoint[] = [
    { time: 'a', timeMs: 0 },
    { time: 'b', timeMs: 100 * MINUTE },
  ];

  it('returns the closest point within the default 90-minute tolerance', () => {
    expect(nearestPoint(points, 30 * MINUTE)?.time).toBe('a');
    expect(nearestPoint(points, 60 * MINUTE)?.time).toBe('b'); // 40min to b vs 60min to a
  });

  it('returns undefined beyond the tolerance', () => {
    expect(nearestPoint(points, 200 * MINUTE)).toBeUndefined(); // 100min from b
    // Custom tolerance widens the match.
    expect(nearestPoint(points, 200 * MINUTE, 120 * MINUTE)?.time).toBe('b');
  });
});
