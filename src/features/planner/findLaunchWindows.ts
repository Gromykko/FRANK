import { analyzeSafetyConditions } from '../safety/analyzeSafetyConditions';
import { isSameLocationDay } from '../../utils/date';
import type { SafetySettings } from '../safety/presets';
import type { HourlyData } from '../forecast/types';

export interface LaunchWindow {
  startIndex: number;
  endIndex: number;
  duration: number;
  // Set for windows built from longer-range MET blocks (past the hourly range):
  // a soft "this period looks generally suitable" hint, not an exact hourly window.
  lowConfidence?: boolean;
  // Set on block windows that include night hours while Daylight Only is on:
  // only the daylight portion of the period is actually paddleable.
  daylightPartial?: boolean;
}

export interface SunTimes {
  sunrise: string[];
  sunset: string[];
}

const MAX_WINDOWS = 12;

// A window is a run of consecutive safe forecast samples within one day.
// An N-hour window needs N+1 safe samples: both endpoints of every hour
// interval must be safe.
//
// Two ranges are searched: exact hourly windows within MET's hourly range, and
// block-level windows across the longer-range MET period blocks. A single safe
// block already qualifies (its span is 6h) and is flagged `lowConfidence`.
// Total daylight within [startMs, endMs), summed across the schedule's days.
function daylightOverlapMs(startMs: number, endMs: number, sun: SunTimes): number {
  let overlap = 0;
  for (let i = 0; i < sun.sunrise.length; i++) {
    const rise = new Date(sun.sunrise[i]).getTime();
    const set = new Date(sun.sunset[i] ?? '').getTime();
    if (!Number.isFinite(rise) || !Number.isFinite(set)) continue;
    overlap += Math.max(0, Math.min(endMs, set) - Math.max(startMs, rise));
  }
  return overlap;
}

export function findLaunchWindows(
  data: HourlyData[],
  settings: SafetySettings,
  startIndex: number,
  sun?: SunTimes
): LaunchWindow[] {
  if (!data || data.length === 0) return [];

  const matchesWaterLevelPreference = (start: number, end: number) => {
    const endpoints = data.slice(start, end + 1);

    switch (settings.tidePreference) {
      case 'high':
        return endpoints.every((hour) => hour.tideLevel >= 0.1);
      case 'low':
        return endpoints.every((hour) => hour.tideLevel <= -0.1);
      case 'incoming':
        for (let i = start; i < end; i++) {
          if (!data[i + 1] || data[i + 1].tideLevel <= data[i].tideLevel) {
            return false;
          }
        }
        return true;
      case 'any':
      default:
        return true;
    }
  };

  const isSafe = (idx: number): boolean => {
    if (idx < startIndex) return false;
    const nextHour = data[idx + 1];
    return analyzeSafetyConditions(data[idx], settings, nextHour ? nextHour.tideLevel : undefined).rating === 'safe';
  };

  // First longer-range block index (blocks are appended after the hourly range).
  const firstBlockIndex = data.findIndex((hour) => hour.isLowConfidence);
  const hourlyEnd = firstBlockIndex === -1 ? data.length : firstBlockIndex;

  const slots: LaunchWindow[] = [];

  // --- Exact hourly windows (endpoints must be safe) ---------------------
  let currentStart: number | null = null;
  const addHourlySlot = (start: number, end: number) => {
    const duration = end - start;
    if (duration >= settings.minDuration && matchesWaterLevelPreference(start, end)) {
      slots.push({ startIndex: start, endIndex: end, duration });
    }
  };

  for (let i = 0; i < hourlyEnd; i++) {
    const isNewDay = i > 0 && !isSameLocationDay(data[i].time, data[i - 1].time);
    if (isSafe(i)) {
      if (currentStart === null) currentStart = i;
      else if (isNewDay) {
        addHourlySlot(currentStart, i - 1);
        currentStart = i;
      }
    } else if (currentStart !== null) {
      addHourlySlot(currentStart, i - 1);
      currentStart = null;
    }
  }
  if (currentStart !== null) addHourlySlot(currentStart, hourlyEnd - 1);

  // --- Longer-range block windows (each safe block qualifies) ------------
  let blockStart: number | null = null;
  const addBlockSlot = (start: number, end: number) => {
    if (!matchesWaterLevelPreference(start, end)) return;
    const spanHours = data
      .slice(start, end + 1)
      .reduce((sum, hour) => sum + (hour.blockSpanHours ?? 0), 0);
    // Same bar the hourly windows clear: a block run shorter than the user's
    // minimum duration is not a usable window.
    if (spanHours < settings.minDuration) return;

    // Blocks span the day/night boundary and are never rated as nighttime, so
    // with Daylight Only on, apply the rule at the window level instead: a
    // period with no daylight at all is not a window, and one that includes
    // night hours is flagged so the card can say only its daylight part counts.
    let daylightPartial = false;
    if ((settings.daylightOnly ?? true) && sun) {
      const startMs = new Date(data[start].time).getTime();
      const endMs = new Date(data[end].time).getTime() + (data[end].blockSpanHours ?? 0) * 3_600_000;
      const overlap = daylightOverlapMs(startMs, endMs, sun);
      if (overlap <= 0) return;
      daylightPartial = overlap < endMs - startMs - 60_000;
    }

    slots.push({
      startIndex: start,
      endIndex: end,
      duration: spanHours,
      lowConfidence: true,
      ...(daylightPartial ? { daylightPartial: true } : {}),
    });
  };

  for (let i = hourlyEnd; i < data.length; i++) {
    const isNewDay = i > hourlyEnd && !isSameLocationDay(data[i].time, data[i - 1].time);
    if (isSafe(i)) {
      if (blockStart === null) blockStart = i;
      else if (isNewDay) {
        addBlockSlot(blockStart, i - 1);
        blockStart = i;
      }
    } else if (blockStart !== null) {
      addBlockSlot(blockStart, i - 1);
      blockStart = null;
    }
  }
  if (blockStart !== null) addBlockSlot(blockStart, data.length - 1);

  return slots.slice(0, MAX_WINDOWS);
}

const SUNSET_MARGIN_MS = 45 * 60 * 1000;

// If the window's end lands within 45 minutes before sunset (or at it),
// returns that sunset ISO string so the UI can warn about fading light.
export function sunsetCutoffFor(
  window: LaunchWindow,
  data: HourlyData[],
  sunsets: string[]
): string | null {
  const endSample = data[window.endIndex];
  if (!endSample) return null;

  const endDate = new Date(endSample.time);
  const sunset = sunsets.find((s) => isSameLocationDay(s, endDate));
  if (!sunset) return null;

  const sunsetMs = new Date(sunset).getTime();
  const gap = sunsetMs - endDate.getTime();
  return gap >= 0 && gap <= SUNSET_MARGIN_MS ? sunset : null;
}
