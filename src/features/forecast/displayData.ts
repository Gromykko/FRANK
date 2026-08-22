import type { HourlyData, WeatherData } from './types';

// The matrix the UI renders: one continuous forecast — MET Norway hourly hours
// (~2 days) followed by the longer-range MET period blocks (to ~5 days, where
// DMI marine ends). The longer-range blocks carry `isLowConfidence`, and the
// first of them starts the subtle "Outlook" marker.
export function getDisplayHourlyData(data: WeatherData): HourlyData[] {
  if (data.hourly.length === 0) return [];

  return data.hourly.map((hour) => ({
    ...hour,
    isOutlook: Boolean(hour.isLowConfidence),
  }));
}

// The water level to hand analyzeSafetyConditions as "next hour", for the
// wind-against-water-level chop rule.
//
// Only a true HOURLY neighbour counts. Past the hourly range the next row is a
// 6-hour block whose tideLevel is its centre sample, hours away — reading that
// as "next hour" can invert rising/falling and so invent, or hide, a chop
// caution. The planner already refused to do it; the header and the timeline
// did not, so the same hour could rate differently depending on which surface
// you looked at. One rule, one place, so a fourth caller can't drift again.
export function nextHourTideFor(rows: HourlyData[], index: number): number | undefined {
  const current = rows[index];
  const next = rows[index + 1];
  if (!current || !next || current.blockSpanHours || next.blockSpanHours) return undefined;

  const currentMs = Date.parse(current.time);
  const nextMs = Date.parse(next.time);
  return Number.isFinite(currentMs)
    && Number.isFinite(nextMs)
    && nextMs - currentMs === 60 * 60 * 1000
    ? next.tideLevel
    : undefined;
}
