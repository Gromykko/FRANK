import { analyzeSafetyConditions } from '../safety/analyzeSafetyConditions';
import { isSameLocationDay } from '../../utils/date';
import type { SafetySettings } from '../safety/presets';
import type { HourlyData } from '../forecast/types';
import { nextHourTideFor } from '../forecast/displayData';
import { assessBlockDaylight } from '../safety/blockDaylight';
import { hasActiveSafetyChecks } from '../safety/safetyDisplay';
import type { SunTimes } from '../safety/blockDaylight';

// What this app calls high or low water: 10 cm either side of mean, in metres
// because that is the unit the model carries. Exported because the meteogram's
// outlook blocks mark the same threshold, and two definitions of "high water"
// in one app is one too many — the Launch Windows filter and the block arrows
// have to agree or the planner offers a window the matrix calls low.
export const HIGH_WATER_M = 0.1;

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
  // The paddleable slice of a daylightPartial block, snapped to whole local
  // hour marks. Computed here rather than in the card so `duration` and the
  // displayed times can never disagree.
  daylightStartMs?: number;
  daylightEndMs?: number;
}

export type { SunTimes } from '../safety/blockDaylight';

const MAX_WINDOWS = 12;
// Outlook windows are capped separately: they are appended after the hourly
// ones, so a single shared cap silently deleted the whole outlook section on
// any forecast that already had 12 hourly windows.
const MAX_BLOCK_WINDOWS = 4;

// A run is only continuous if consecutive samples really are an hour apart.
// The hourly series drops any hour with no marine sample within tolerance, so
// array adjacency does NOT imply time adjacency — without this check a window
// spanning a gap reports too short a duration AND silently covers an hour that
// was never assessed at all.
const HOUR_MS = 3_600_000;
function isContiguous(previous: HourlyData, current: HourlyData): boolean {
  const gap = new Date(current.time).getTime() - new Date(previous.time).getTime();
  if (!Number.isFinite(gap)) return false;
  const expectedSpan = (previous.blockSpanHours ?? 1) * HOUR_MS;
  return gap >= expectedSpan * 0.95 && gap <= expectedSpan * 1.05;
}

// A window is a run of consecutive safe forecast samples within one day.
// An N-hour window needs N+1 safe samples: both endpoints of every hour
// interval must be safe.
//
// Two ranges are searched: exact hourly windows within MET's hourly range, and
// block-level windows across the longer-range MET period blocks. A single safe
// block already qualifies (its span is 6h) and is flagged `lowConfidence`.
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
        return endpoints.every((hour) => hour.tideLevel >= HIGH_WATER_M);
      case 'low':
        return endpoints.every((hour) => hour.tideLevel <= -HIGH_WATER_M);
      case 'incoming':
        // A single-sample window (one safe outlook block) has no pair inside
        // it to compare, and the zero-iteration loop below would pass it as
        // "rising" unread. Judge it against the next sample instead, and
        // reject it when the forecast ends here.
        if (start === end) {
          return Boolean(data[end + 1]) && data[end + 1].tideLevel > data[end].tideLevel;
        }
        for (let i = start; i < end; i++) {
          // Negated `>` rather than `<=`: with no water-level reading both
          // sides are NaN, and `NaN <= NaN` is false — the window would have
          // passed, asserting rising water FRANK never read. The 'high' and
          // 'low' cases already reject NaN for the same reason.
          if (!data[i + 1] || !(data[i + 1].tideLevel > data[i].tideLevel)) {
            return false;
          }
        }
        return true;
      case 'any':
      default:
        return true;
    }
  };

  // With every personal limit switched off there is nothing left to check, so
  // there is nothing to recommend. Without this the planner offered a gale as a
  // launch window while the header said "limits are off, raw forecast only" -
  // a recommendation is a stronger claim than a rating, so it needs the
  // stricter gate, not a looser one.
  const activeSafetyChecks = hasActiveSafetyChecks(settings);

  const isSafe = (idx: number): boolean => {
    if (idx < startIndex || !activeSafetyChecks) return false;
    return analyzeSafetyConditions(
      data[idx],
      settings,
      nextHourTideFor(data, idx),
      undefined,
      { blockDaylight: { mode: 'defer-to-window' } },
    ).rating === 'safe';
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
    // A gap in the series breaks the run for the same reason a new day does:
    // the hours either side are not one continuous stretch on the water.
    const isNewDay = i > 0 && (!isSameLocationDay(data[i].time, data[i - 1].time) || !isContiguous(data[i - 1], data[i]));
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
  const blockSlots: LaunchWindow[] = [];
  let blockStart: number | null = null;
  const addBlockSlot = (start: number, end: number) => {
    if (!matchesWaterLevelPreference(start, end)) return;
    const spanHours = data
      .slice(start, end + 1)
      .reduce((sum, hour) => sum + (hour.blockSpanHours ?? 0), 0);
    // Same bar the hourly windows clear: a block run shorter than the user's
    // minimum duration is not a usable window.
    if (spanHours < settings.minDuration) return;

    // The whole-period matrix honestly marks a partial block Caution. The
    // planner deliberately defers only that daylight rule while assessing the
    // weather/marine values, then applies it here: a period with no complete
    // daylight slice is withheld; a partial one is clipped for the card.
    let daylight = null as ReturnType<typeof assessBlockDaylight> | null;
    if (settings.daylightOnly ?? true) {
      // With Daylight Only on and no sun schedule, a block's daylight is
      // unknowable — so it cannot be offered. Previously it was offered anyway,
      // which meant a night block could be recommended.
      if (!sun) return;
      const startMs = new Date(data[start].time).getTime();
      const endMs = new Date(data[end].time).getTime() + (data[end].blockSpanHours ?? 0) * HOUR_MS;
      daylight = assessBlockDaylight(startMs, endMs, sun);
      if (daylight.status === 'unknown' || daylight.status === 'none') return;
      // The user's minimum applies to the hours they can actually paddle, not
      // to the block's nominal span. "Minimum 6 hours" must never be answered
      // with a 20:00–21:00 sliver of a 20:00–02:00 block.
      if (daylight.sliceHours < settings.minDuration) return;
    }

    const partialDaylight = daylight?.status === 'partial' ? daylight : null;
    blockSlots.push({
      startIndex: start,
      endIndex: end,
      // The paddleable number, not the nominal span.
      duration: daylight ? daylight.sliceHours : spanHours,
      lowConfidence: true,
      ...(partialDaylight
        ? {
            daylightPartial: true,
            daylightStartMs: partialDaylight.sliceStartMs!,
            daylightEndMs: partialDaylight.sliceEndMs!,
          }
        : {}),
    });
  };

  for (let i = hourlyEnd; i < data.length; i++) {
    const isNewDay = i > hourlyEnd && (!isSameLocationDay(data[i].time, data[i - 1].time) || !isContiguous(data[i - 1], data[i]));
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

  return [...slots.slice(0, MAX_WINDOWS), ...blockSlots.slice(0, MAX_BLOCK_WINDOWS)];
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
