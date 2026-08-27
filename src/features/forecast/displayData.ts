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
