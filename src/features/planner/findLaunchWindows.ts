import {
  analyzeSafetyConditions,
  isNearLimitOnlyAnalysis,
} from '../safety/analyzeSafetyConditions';
import { isSameLocationDay } from '../../utils/date';
import type { SafetySettings } from '../safety/presets';
import type { HourlyData } from '../forecast/types';
import { assessBlockDaylight } from '../safety/blockDaylight';
import { hasActiveSafetyChecks } from '../safety/safetyDisplay';
import type { SunTimes } from '../safety/blockDaylight';

export interface LaunchWindow {
  startIndex: number;
  endIndex: number;
  duration: number;
  // When the first forecast row is already in progress, the usable window
  // starts at the clock rather than at that row's past hour mark.
  effectiveStartMs?: number;
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
  // Near-limit windows are never mixed into the primary green list. They are
  // shown separately as periods that need a closer check before launch.
  kind?: 'near-limit';
  // First amber sample inside a near-limit window. Selecting the alternative
  // opens the exact headroom reason instead of an adjacent green endpoint.
  reviewIndex?: number;
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
  // Both providers are normalized onto exact ISO grid starts. A tolerance here
  // fabricates unassessed coverage: e.g. a 06:00 block followed at 12:20 has no
  // assessed reading at its real 12:00 endpoint, even though the two rows are near.
  return gap === expectedSpan;
}

// A window is a run of consecutive qualifying forecast samples in absolute time.
// Midnight does not break water-time continuity; the UI alone segments the
// resulting bar by calendar day. An N-hour window needs N+1 qualifying
// samples: both endpoints of every hour interval must qualify.
//
// Two ranges are searched: exact hourly windows within MET's hourly range, and
// block-level hints across the longer-range MET period blocks. MET does not
// publish gusts there, so those blocks are judged from their available readings
// and say so in the verdict explanation. An outlook interval still needs a
// qualifying closing sample as well as a matching start, and is flagged
// `lowConfidence` because the period data is coarser and one selected input is absent.
type WindowSearch = 'safe' | 'near-limit';

function findWindows(
  data: HourlyData[],
  settings: SafetySettings,
  startIndex: number,
  sun?: SunTimes,
  nowMs?: number,
  search: WindowSearch = 'safe',
): LaunchWindow[] {
  if (!data || data.length === 0) return [];

  // With every personal limit switched off there is nothing left to check, so
  // there is nothing to recommend. Without this the planner offered a gale as a
  // launch window while the header said "limits are off, raw forecast only" -
  // a recommendation is a stronger claim than a rating, so it needs the
  // stricter gate, not a looser one.
  const activeSafetyChecks = hasActiveSafetyChecks(settings);

  const assessments = data.map((hour, idx) => {
    if (idx < startIndex || !activeSafetyChecks) return 'other' as const;
    const analysis = analyzeSafetyConditions(
      hour,
      settings,
      undefined,
      { blockDaylight: { mode: 'defer-to-window' } },
    );
    if (analysis.rating === 'safe') return 'safe' as const;
    if (isNearLimitOnlyAnalysis(analysis)) return 'near-limit' as const;
    return 'other' as const;
  });

  const qualifies = (idx: number): boolean => assessments[idx] === 'safe'
    || (search === 'near-limit' && assessments[idx] === 'near-limit');
  const rangeHasNearLimit = (start: number, endInclusive: number): boolean =>
    assessments.slice(start, endInclusive + 1).includes('near-limit');
  const firstNearLimitIndex = (start: number, endInclusive: number): number | undefined => {
    const offset = assessments.slice(start, endInclusive + 1).indexOf('near-limit');
    return offset === -1 ? undefined : start + offset;
  };

  // First longer-range block index (blocks are appended after the hourly range).
  const firstBlockIndex = data.findIndex((hour) => hour.isLowConfidence);
  const hourlyEnd = firstBlockIndex === -1 ? data.length : firstBlockIndex;

  const slots: LaunchWindow[] = [];

  // --- Exact hourly windows (both endpoints must qualify) ----------------
  let currentStart: number | null = null;
  const addHourlySlot = (start: number, end: number) => {
    if (search === 'near-limit' && !rangeHasNearLimit(start, end)) return;
    const nominalStartMs = Date.parse(data[start]?.time ?? '');
    const endMs = Date.parse(data[end]?.time ?? '');
    if (!Number.isFinite(nominalStartMs) || !Number.isFinite(endMs)) return;
    const shouldClipStart = Number.isFinite(nowMs)
      && (nowMs as number) > nominalStartMs
      && (nowMs as number) < endMs;
    const effectiveStartMs = shouldClipStart ? nowMs as number : nominalStartMs;
    const duration = (endMs - effectiveStartMs) / HOUR_MS;
    if (duration >= settings.minDuration) {
      slots.push({
        startIndex: start,
        endIndex: end,
        duration,
        ...(search === 'near-limit' ? { kind: 'near-limit' as const } : {}),
        ...(search === 'near-limit' ? { reviewIndex: firstNearLimitIndex(start, end) } : {}),
        ...(shouldClipStart ? { effectiveStartMs } : {}),
      });
    }
  };

  for (let i = 0; i < hourlyEnd; i++) {
    // A gap in the series breaks the run for the same reason a new day does:
    // the hours either side are not one continuous stretch on the water.
    // Midnight is a presentation boundary, not a break in a qualifying run.
    // PaddlePlanner segments the one window into calendar-day bars; only a
    // real timestamp gap ends the recommendation.
    const breaksContinuity = i > 0 && !isContiguous(data[i - 1], data[i]);
    if (qualifies(i)) {
      if (currentStart === null) currentStart = i;
      else if (breaksContinuity) {
        addHourlySlot(currentStart, i - 1);
        currentStart = i;
      }
    } else if (currentStart !== null) {
      addHourlySlot(currentStart, i - 1);
      currentStart = null;
    }
  }
  if (currentStart !== null) addHourlySlot(currentStart, hourlyEnd - 1);

  // --- Longer-range block windows (each block interval must qualify) ------
  const blockSlots: LaunchWindow[] = [];
  let blockStart: number | null = null;
  const addBlockSlot = (start: number, end: number) => {
    // `end` is the final qualifying interval; its closing endpoint is end + 1.
    if (search === 'near-limit' && !rangeHasNearLimit(start, end + 1)) return;
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
      ...(search === 'near-limit' ? { kind: 'near-limit' as const } : {}),
      ...(search === 'near-limit' ? { reviewIndex: firstNearLimitIndex(start, end + 1) } : {}),
      ...(partialDaylight
        ? {
            daylightPartial: true,
            daylightStartMs: partialDaylight.sliceStartMs!,
            daylightEndMs: partialDaylight.sliceEndMs!,
          }
        : {}),
    });
  };

  // Unlike marine ranges, a MET outlook block's central wind and optional p90
  // are both instant estimates at the block start. Neither can clear the
  // following six hours by itself. A block is therefore a recommendable
  // interval only when its exact closing sample is present, contiguous, and
  // independently qualifying, using the same two-endpoint invariant the exact-hour
  // path uses.
  const isSafeBlockInterval = (index: number): boolean => {
    const next = data[index + 1];
    return Boolean(
      data[index]?.blockSpanHours
      && next
      && isContiguous(data[index], next)
      && qualifies(index)
      && qualifies(index + 1),
    );
  };

  for (let i = hourlyEnd; i < data.length; i++) {
    const breaksContinuity = i > hourlyEnd && !isContiguous(data[i - 1], data[i]);
    if (isSafeBlockInterval(i)) {
      if (blockStart === null) blockStart = i;
      else if (breaksContinuity) {
        addBlockSlot(blockStart, i - 1);
        blockStart = i;
      }
    } else if (blockStart !== null) {
      addBlockSlot(blockStart, i - 1);
      blockStart = null;
    }
  }
  if (blockStart !== null) addBlockSlot(blockStart, data.length - 2);

  return [...slots.slice(0, MAX_WINDOWS), ...blockSlots.slice(0, MAX_BLOCK_WINDOWS)];
}

export function findLaunchWindows(
  data: HourlyData[],
  settings: SafetySettings,
  startIndex: number,
  sun?: SunTimes,
  nowMs?: number,
): LaunchWindow[] {
  return findWindows(data, settings, startIndex, sun, nowMs, 'safe');
}

// These periods contain at least one pure proximity warning and no other
// caution or danger. Keeping them separate preserves the meaning of the green
// list while still showing useful alternatives instead of hiding them.
export function findNearLimitWindows(
  data: HourlyData[],
  settings: SafetySettings,
  startIndex: number,
  sun?: SunTimes,
  nowMs?: number,
): LaunchWindow[] {
  return findWindows(data, settings, startIndex, sun, nowMs, 'near-limit');
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
