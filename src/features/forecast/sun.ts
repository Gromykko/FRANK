import type { ForecastLocation } from '../../config/locations';

function dayOfYear(year: number, monthIndex: number, day: number): number {
  const start = Date.UTC(year, 0, 0);
  const current = Date.UTC(year, monthIndex, day);
  return Math.floor((current - start) / 86_400_000);
}

function normalizeHours(hours: number): number {
  return ((hours % 24) + 24) % 24;
}

function normalizeDegrees(value: number): number {
  return ((value % 360) + 360) % 360;
}

// NOAA-style sunrise/sunset approximation for the location's coordinate. MET
// Norway's Locationforecast does not carry sunrise/sunset or an is_day flag, so
// FRANK derives day/night astronomically from the coordinate.
function calculateSunTime(year: number, monthIndex: number, day: number, isSunrise: boolean, location: ForecastLocation): string {
  const rad = Math.PI / 180;
  const degrees = 180 / Math.PI;
  const zenith = 90.833;
  const n = dayOfYear(year, monthIndex, day);
  const lngHour = location.coordinate.longitude / 15;
  const approxTime = n + ((isSunrise ? 6 : 18) - lngHour) / 24;
  const meanAnomaly = 0.9856 * approxTime - 3.289;
  let trueLongitude =
    meanAnomaly +
    1.916 * Math.sin(rad * meanAnomaly) +
    0.02 * Math.sin(rad * 2 * meanAnomaly) +
    282.634;
  trueLongitude = normalizeDegrees(trueLongitude);

  let rightAscension = degrees * Math.atan(0.91764 * Math.tan(rad * trueLongitude));
  rightAscension = normalizeDegrees(rightAscension);

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
  const utcHour = normalizeHours(localMeanTime - lngHour);
  const utcTime = Date.UTC(year, monthIndex, day) + utcHour * 60 * 60 * 1000;

  return new Date(utcTime).toISOString();
}

export interface SunSchedule {
  sunrise: string[];
  sunset: string[];
  isDayByTime: Map<string, boolean>;
}

export function buildSunSchedule(hourlyTimes: string[], location: ForecastLocation): SunSchedule {
  // Day buckets follow the LOCATION's calendar (en-CA renders YYYY-MM-DD), so
  // an hour near midnight lands on the fjord's date no matter what timezone
  // the viewer's browser — or the Worker runtime — happens to be in.
  const dateKeyFormat = new Intl.DateTimeFormat('en-CA', {
    timeZone: location.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const dateKeyOf = (date: Date) => dateKeyFormat.format(date);

  const days = new Map<string, { year: number; monthIndex: number; day: number }>();

  hourlyTimes.forEach((time) => {
    const key = dateKeyOf(new Date(time));
    if (!days.has(key)) {
      const [year, month, day] = key.split('-').map(Number);
      days.set(key, { year, monthIndex: month - 1, day });
    }
  });

  const schedule = [...days.entries()]
    .map(([dateKey, dateParts]) => ({
      sunrise: calculateSunTime(dateParts.year, dateParts.monthIndex, dateParts.day, true, location),
      sunset: calculateSunTime(dateParts.year, dateParts.monthIndex, dateParts.day, false, location),
      dateKey,
    }))
    .sort((a, b) => new Date(a.sunrise).getTime() - new Date(b.sunrise).getTime());

  const isDayByTime = new Map<string, boolean>();

  hourlyTimes.forEach((time) => {
    const date = new Date(time);
    const scheduleForDay = schedule.find((item) => item.dateKey === dateKeyOf(date));
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
