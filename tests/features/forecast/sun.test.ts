import { describe, it, expect } from 'vitest';
import { buildSunSchedule } from '../../../src/features/forecast/sun';
import { CURRENT_LOCATION } from '../../../src/config/locations';

// Horsens: 55.858 N, 9.905 E. Reference values (NOAA-style approximation):
// 2026-06-21 sunrise ~04:30 CEST (02:30 UTC), sunset ~22:00 CEST (20:00 UTC).
// 2026-12-21 sunrise ~08:45 CET (07:45 UTC), sunset ~15:40 CET (14:40 UTC).
// Assertions allow +/-20 minutes so they verify the formula's output without
// hardcoding it to the second.
const MINUTE = 60_000;

describe('buildSunSchedule', () => {
  it('computes Horsens summer-solstice sunrise/sunset near known values', () => {
    const schedule = buildSunSchedule(['2026-06-21T12:00:00Z'], CURRENT_LOCATION);
    expect(schedule.sunrise).toHaveLength(1);
    expect(schedule.sunset).toHaveLength(1);

    const sunriseMs = new Date(schedule.sunrise[0]).getTime();
    const sunsetMs = new Date(schedule.sunset[0]).getTime();

    const expectedSunrise = Date.UTC(2026, 5, 21, 2, 30);
    const expectedSunset = Date.UTC(2026, 5, 21, 20, 0);
    expect(Math.abs(sunriseMs - expectedSunrise)).toBeLessThanOrEqual(20 * MINUTE);
    expect(Math.abs(sunsetMs - expectedSunset)).toBeLessThanOrEqual(20 * MINUTE);

    // Day length ~17.5 h at this latitude on the solstice.
    const dayLengthHours = (sunsetMs - sunriseMs) / 3_600_000;
    expect(dayLengthHours).toBeGreaterThan(17.0);
    expect(dayLengthHours).toBeLessThan(18.0);
  });

  it('computes Horsens winter-solstice sunrise/sunset near known values', () => {
    const schedule = buildSunSchedule(['2026-12-21T12:00:00Z'], CURRENT_LOCATION);
    const sunriseMs = new Date(schedule.sunrise[0]).getTime();
    const sunsetMs = new Date(schedule.sunset[0]).getTime();

    const expectedSunrise = Date.UTC(2026, 11, 21, 7, 45);
    const expectedSunset = Date.UTC(2026, 11, 21, 14, 40);
    expect(Math.abs(sunriseMs - expectedSunrise)).toBeLessThanOrEqual(20 * MINUTE);
    expect(Math.abs(sunsetMs - expectedSunset)).toBeLessThanOrEqual(20 * MINUTE);

    const dayLengthHours = (sunsetMs - sunriseMs) / 3_600_000;
    expect(dayLengthHours).toBeGreaterThan(6.4);
    expect(dayLengthHours).toBeLessThan(7.4);
  });

  it('isDayByTime flips exactly at sunrise and sunset (inclusive at both ends)', () => {
    // Two-pass: derive sunrise/sunset for the day, then classify instants
    // one minute either side of them (and the instants themselves).
    const first = buildSunSchedule(['2026-06-21T12:00:00Z'], CURRENT_LOCATION);
    const sunrise = new Date(first.sunrise[0]);
    const sunset = new Date(first.sunset[0]);

    const beforeSunrise = new Date(sunrise.getTime() - MINUTE).toISOString();
    const atSunrise = sunrise.toISOString();
    const beforeSunset = new Date(sunset.getTime() - MINUTE).toISOString();
    const afterSunset = new Date(sunset.getTime() + MINUTE).toISOString();

    const schedule = buildSunSchedule(
      [beforeSunrise, atSunrise, beforeSunset, afterSunset],
      CURRENT_LOCATION
    );
    expect(schedule.isDayByTime.get(beforeSunrise)).toBe(false);
    expect(schedule.isDayByTime.get(atSunrise)).toBe(true);
    expect(schedule.isDayByTime.get(beforeSunset)).toBe(true);
    expect(schedule.isDayByTime.get(afterSunset)).toBe(false);
  });

  it('classifies midday as day and the small hours as night', () => {
    const midday = '2026-06-21T12:00:00Z';
    const smallHours = '2026-06-21T01:00:00Z'; // 03:00 local, before the ~04:30 sunrise
    const schedule = buildSunSchedule([midday, smallHours], CURRENT_LOCATION);
    expect(schedule.isDayByTime.get(midday)).toBe(true);
    expect(schedule.isDayByTime.get(smallHours)).toBe(false);
  });

  it('produces one sunrise/sunset pair per day, sorted ascending', () => {
    const times = [
      '2026-06-20T12:00:00Z',
      '2026-06-21T12:00:00Z',
      '2026-06-22T12:00:00Z',
    ];
    const schedule = buildSunSchedule(times, CURRENT_LOCATION);
    expect(schedule.sunrise).toHaveLength(3);
    expect(schedule.sunset).toHaveLength(3);
    for (let i = 1; i < schedule.sunrise.length; i++) {
      expect(new Date(schedule.sunrise[i]).getTime()).toBeGreaterThan(new Date(schedule.sunrise[i - 1]).getTime());
      expect(new Date(schedule.sunset[i]).getTime()).toBeGreaterThan(new Date(schedule.sunset[i - 1]).getTime());
    }
    // Each sunset follows its sunrise.
    for (let i = 0; i < schedule.sunrise.length; i++) {
      expect(new Date(schedule.sunset[i]).getTime()).toBeGreaterThan(new Date(schedule.sunrise[i]).getTime());
    }
  });
});
