export interface SunTimes {
  sunrise: string[];
  sunset: string[];
}

export type BlockDaylightStatus = 'full' | 'partial' | 'none' | 'unknown';

export interface BlockDaylightAssessment {
  status: BlockDaylightStatus;
  /** Complete one-hour slots wholly contained inside sunrise..sunset. */
  fullHours: number;
  /** Complete hours in the single contiguous slice named below. */
  sliceHours: number;
  /** First complete daylight slot, or null when no safe slice can be named. */
  sliceStartMs: number | null;
  /** Exclusive end of the last complete daylight slot. */
  sliceEndMs: number | null;
}

const HOUR_MS = 3_600_000;

/**
 * Classify an outlook period against the same whole-hour grid used by launch
 * windows. A slot counts only when its entire [start, end) interval is inside
 * one paired sunrise..sunset interval; a slot that crosses sunset never counts.
 *
 * `unknown` means the period or sun schedule cannot be assessed. `none` means
 * a valid schedule was supplied and it contains no complete daylight hour.
 */
export function assessBlockDaylight(
  startMs: number,
  endMs: number,
  sun?: SunTimes,
): BlockDaylightAssessment {
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs || !sun) {
    return { status: 'unknown', fullHours: 0, sliceHours: 0, sliceStartMs: null, sliceEndMs: null };
  }

  const daylightIntervals = sun.sunrise.flatMap((rise, index) => {
    const riseMs = Date.parse(rise);
    const setMs = Date.parse(sun.sunset[index] ?? '');
    return Number.isFinite(riseMs) && Number.isFinite(setMs) && setMs > riseMs
      ? [{ riseMs, setMs }]
      : [];
  });
  if (daylightIntervals.length === 0) {
    return { status: 'unknown', fullHours: 0, sliceHours: 0, sliceStartMs: null, sliceEndMs: null };
  }

  const totalWholeHours = Math.floor((endMs - startMs) / HOUR_MS);
  let runStartMs: number | null = null;
  let runHours = 0;
  let sliceStartMs: number | null = null;
  let sliceHours = 0;
  let fullHours = 0;

  for (let markMs = startMs; markMs + HOUR_MS <= endMs; markMs += HOUR_MS) {
    const isFullDaylightHour = daylightIntervals.some(
      ({ riseMs, setMs }) => markMs >= riseMs && markMs + HOUR_MS <= setMs,
    );
    if (!isFullDaylightHour) {
      runStartMs = null;
      runHours = 0;
      continue;
    }
    if (runStartMs === null) runStartMs = markMs;
    runHours += 1;
    fullHours += 1;
    // A launch window must be continuous. If a longer period spans sunset,
    // night, and the next sunrise, never draw one apparent slice across the
    // darkness; retain the longest complete daylight run (earliest on a tie).
    if (runHours > sliceHours) {
      sliceStartMs = runStartMs;
      sliceHours = runHours;
    }
  }

  if (sliceStartMs === null || fullHours === 0) {
    return { status: 'none', fullHours: 0, sliceHours: 0, sliceStartMs: null, sliceEndMs: null };
  }

  return {
    status: fullHours === totalWholeHours ? 'full' : 'partial',
    fullHours,
    sliceHours,
    sliceStartMs,
    sliceEndMs: sliceStartMs + sliceHours * HOUR_MS,
  };
}
