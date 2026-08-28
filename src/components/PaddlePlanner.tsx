import { Fragment, memo, useState, useMemo, useRef } from 'react';
import { AlertTriangle, CalendarClock, Check, Share2, Sunset } from 'lucide-react';
import type { DisplayStatus } from '../features/safety/analyzeSafetyConditions';
import { sunsetCutoffFor } from '../features/planner/findLaunchWindows';
import type { LaunchWindow } from '../features/planner/findLaunchWindows';
import { blockHourRange } from '../features/forecast/blockHours';
import { formatReading } from '../utils/number';
import { describeWarningArea, LEVEL_WORD, warningsOverlapping } from '../features/forecast/parseWarnings';
import type { HourlyData, WeatherWarning } from '../features/forecast/types';
import { CURRENT_LOCATION } from '../config/locations';
import { useLang } from '../i18n';
import type { Translate } from '../i18n/interpolate';
import { formatDateMedium, formatDateShort, formatTime, formatWeekday, isSameLocationDay, locationDateKey, locationHour, locationHourFraction, locationHourLabel } from '../utils/date';

interface PaddlePlannerProps {
  data: HourlyData[];
  // DisplayStatus: with every check off there is no verdict, and those
  // hours render neutral rather than being painted amber.
  statuses: DisplayStatus[];
  // No personal limits are switched on, so the empty list below is a refusal to
  // recommend rather than a report about conditions.
  limitsOff: boolean;
  // This filter can starve the list while within-limit hours still exist. Name it in
  // the empty state so the message points at the knob that is actually binding
  // instead of "your criteria", which is every knob at once.
  minDuration: number;
  windows: LaunchWindow[];
  warnings?: WeatherWarning[];
  sunrises: string[];
  sunsets: string[];
  onSelectIndex: (index: number) => void;
  startIndex: number;
}

// One launch-window bar on a day row of the calendar Gantt (a window crossing
// midnight becomes one bar per day). Fractions are hours 0–24 on the day axis.
// Windows only ever contain within-limit hours (findLaunchWindows accepts
// rating === 'safe' exclusively), so a bar needs no per-hour status detail.
interface CalBar {
  id: string;
  firstIdx: number;
  // Axis geometry, in local hours on a 0-24 scale.
  startFrac: number;
  endFrac: number;
  // Absolute span, which is what the LABEL counts. Kept separate from the axis
  // fracs because a DST day is 23 or 25 hours long and cannot be drawn
  // truthfully on a 24-hour axis — the drawing may compress, the number must not.
  startMs: number;
  endMs: number;
  rangeLabel: string;
  compactLabel: string;
  hours: number;
  lowConfidence: boolean;
  missingGust: boolean;
  aria: string;
}

const formatDuration = (t: Translate, hours: number) => {
  const totalMinutes = Math.max(0, Math.floor(hours * 60 + 1e-6));
  const wholeHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (minutes === 0) return t(wholeHours === 1 ? '{0} hr' : '{0} hrs', wholeHours);
  if (wholeHours === 0) return t('{0} min', minutes);
  return t(wholeHours === 1 ? '{0} hr {1} min' : '{0} hrs {1} min', wholeHours, minutes);
};

// Outlook endIndex names the final block start, so its required closing row is
// one index beyond the ordinary inclusive slice. Use one shared definition for
// list and calendar disclosures so the two views cannot disagree about gusts.
function rowsRepresentedByWindow(data: HourlyData[], slot: LaunchWindow): HourlyData[] {
  return data.slice(slot.startIndex, slot.endIndex + (slot.lowConfidence ? 2 : 1));
}

function outlookWindowMissingGust(data: HourlyData[], slot: LaunchWindow): boolean {
  return Boolean(
    slot.lowConfidence
    && rowsRepresentedByWindow(data, slot)
      .some((hour) => !Number.isFinite(hour.windGust) || hour.windGust < 0),
  );
}

interface CalDay {
  key: string;
  weekday: string;
  dayNum: string;
  sunriseFrac: number;
  sunsetFrac: number;
  // Position of "now" on today's row; null on other days.
  nowFrac: number | null;
  bars: CalBar[];
  aria: string;
}

// memo: App re-renders on a 60s heartbeat; the planner grid/list gets
// identity-stable props, so skip the re-render entirely.
export default memo(function PaddlePlanner({ data, statuses, windows, warnings, sunrises, sunsets, onSelectIndex, startIndex, limitsOff, minDuration }: PaddlePlannerProps) {
  // Context consumption inside the memo'd body — a language change re-renders
  // this component even though its props are identity-stable.
  const { lang, t } = useLang();
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  const [selectedCalendarBarId, setSelectedCalendarBarId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listDragRef = useRef({ active: false, moved: false, startX: 0, scrollLeft: 0 });

  const handleListMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !listRef.current) return;
    const list = listRef.current;
    if (event.clientY - list.getBoundingClientRect().top >= list.clientHeight) return;
    listDragRef.current = {
      active: true,
      moved: false,
      startX: event.clientX,
      scrollLeft: list.scrollLeft,
    };
    list.classList.add('is-dragging');
  };

  const handleListMouseMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const drag = listDragRef.current;
    const list = listRef.current;
    if (!drag.active || !list) return;
    const distance = event.clientX - drag.startX;
    if (Math.abs(distance) > 3) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    list.scrollLeft = drag.scrollLeft - distance;
  };

  const endListDrag = () => {
    listDragRef.current.active = false;
    listRef.current?.classList.remove('is-dragging');
    // The click produced by this same mouseup still sees `moved`; clear it
    // immediately afterwards so a release outside the rail cannot suppress
    // the user's next intentional click.
    window.setTimeout(() => { listDragRef.current.moved = false; }, 0);
  };

  const suppressDraggedClick = (event: React.MouseEvent<HTMLDivElement>) => {
    if (!listDragRef.current.moved) return;
    event.preventDefault();
    event.stopPropagation();
    listDragRef.current.moved = false;
  };

  // Day-row Gantt: one row per forecast day on a shared 00–24 axis, launch
  // windows drawn as bars. The shared axis makes the week's pattern readable in
  // one glance ("mornings are good all week" = bars stacked in one column) and
  // needs no scrolling in either direction on a phone.
  const calendarDays = useMemo(() => {
    if (!data || data.length === 0) return [] as CalDay[];

    const days: CalDay[] = [];
    const dayByKey = new Map<string, CalDay>();
    const ensureDay = (ms: number): CalDay => {
      const key = locationDateKey(ms);
      let day = dayByKey.get(key);
      if (!day) {
        day = {
          key,
          weekday: formatWeekday(ms),
          dayNum: String(Number(key.slice(8, 10))),
          // Danish-summer fallbacks, patched from the real sun tables below.
          sunriseFrac: 4.5,
          sunsetFrac: 22,
          nowFrac: null,
          bars: [],
          aria: '',
        };
        dayByKey.set(key, day);
        days.push(day);
      }
      return day;
    };

    // Materialise a row for every day the forecast covers (hourly + blocks),
    // splitting block spans at midnight.
    for (let idx = startIndex; idx < data.length; idx++) {
      const span = data[idx].blockSpanHours ?? 1;
      const startMs = new Date(data[idx].time).getTime();
      let h = 0;
      while (h < span) {
        const ms = startMs + h * 3_600_000;
        ensureDay(ms);
        h += Math.min(span - h, 24 - locationHour(ms));
      }
    }

    // Real sun times per day; days past the sun tables borrow the last known
    // (sunrise drifts ~2 min/day, invisible at this scale). The overlay edges
    // snap to the hour grid the hourly day/night rating uses (first daylight
    // hour = ceil(sunrise), first night hour = floor(sunset)+1) — bars sit on
    // whole hours, so un-snapped edges leave 1px slivers of "dawn" between
    // night and a 05:00 bar.
    let lastSunrise = 4.5;
    let lastSunset = 22;
    for (const day of days) {
      const sunrise = sunrises.find((s) => locationDateKey(s) === day.key);
      const sunset = sunsets.find((s) => locationDateKey(s) === day.key);
      if (sunrise) lastSunrise = locationHourFraction(sunrise);
      if (sunset) lastSunset = locationHourFraction(sunset);
      day.sunriseFrac = Math.ceil(lastSunrise);
      day.sunsetFrac = Math.min(24, Math.floor(lastSunset) + 1);
    }

    const todayKey = locationDateKey(Date.now());
    const today = dayByKey.get(todayKey);
    if (today) today.nowFrac = locationHourFraction(Date.now());

    // One bar per window per day (a window crossing midnight splits).
    for (const slot of windows) {
      type Run = CalBar & { day: CalDay };
      const runs: Run[] = [];
      let run: Run | null = null;

      const startRow = data[slot.startIndex];
      const endRow = data[slot.endIndex];
      if (!startRow || !endRow) continue;
      const missingGust = outlookWindowMissingGust(data, slot);

      // The interval this bar must draw, in ABSOLUTE time — the same interval
      // the list card describes for the same window. Walking row indices
      // instead painted every hourly window an hour too long: endIndex is the
      // window's CLOSING endpoint, so an 8-hour window covers 9 rows, and the
      // Gantt announced "9 h" beside a card reading "8 hrs".
      const fromMs = slot.daylightStartMs
        ?? slot.effectiveStartMs
        ?? new Date(startRow.time).getTime();
      const toMs = slot.daylightEndMs
        ?? (slot.lowConfidence
          ? new Date(endRow.time).getTime() + (endRow.blockSpanHours ?? 1) * 3_600_000
          : new Date(endRow.time).getTime());
      if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) continue;

      for (let ms = fromMs; ms < toMs;) {
        const nextHourBoundaryMs = (Math.floor(ms / 3_600_000) + 1) * 3_600_000;
        const segmentEndMs = Math.min(toMs, nextHourBoundaryMs);
        const segmentHours = (segmentEndMs - ms) / 3_600_000;
        const day = ensureDay(ms);
        const startHour = locationHourFraction(ms);
        // Continuity by absolute time, not by local hour. A DST fall-back
        // repeats local 02:00, which made `run.endFrac === startHour` fail and
        // split one window into two overlapping bars; spring-forward skips
        // 02:00 and left a phantom gap.
        if (run && run.day === day && run.endMs === ms) {
          run.endFrac = Math.max(run.endFrac, startHour + segmentHours);
          run.endMs = segmentEndMs;
        } else {
          run = {
            id: `${day.key}-${slot.startIndex}`,
            day,
            firstIdx: slot.startIndex,
            startFrac: startHour,
            endFrac: startHour + segmentHours,
            startMs: ms,
            endMs: segmentEndMs,
            rangeLabel: '',
            compactLabel: '',
            hours: 0,
            lowConfidence: Boolean(slot.lowConfidence),
            missingGust,
            aria: '',
          };
          runs.push(run);
        }
        ms = segmentEndMs;
      }

      for (const r of runs) {
        const hours = (r.endMs - r.startMs) / 3_600_000;
        const hasPartialHour = r.startMs % 3_600_000 !== 0 || r.endMs % 3_600_000 !== 0;
        const from = hasPartialHour
          ? formatTime(r.startMs)
          : `${String(Math.floor(r.startFrac)).padStart(2, '0')}`;
        const to = hasPartialHour
          ? formatTime(r.endMs)
          : `${String(Math.floor(r.endFrac) % 24 || 24).padStart(2, '0')}`;
        // Both variants are always present. CSS container queries choose the
        // exact range when the rendered bar is wide enough and the compact
        // duration when it is not, so a two-hour bar is useful on desktop and
        // phone without tying content to a fixed duration threshold.
        r.rangeLabel = `${from}–${to}`;
        r.compactLabel = formatDuration(t, hours);
        r.hours = hours;
        r.aria = r.lowConfidence
          ? t(
            r.missingGust
              ? 'Outlook window, approximately {0}:00 to {1}:00 — no gust forecast and more uncertain'
              : 'Outlook window, approximately {0}:00 to {1}:00 — more uncertain forecast',
            from,
            to,
          )
          : t(
            hasPartialHour ? 'Launch window {0} to {1}, {2}' : 'Launch window {0}:00 to {1}:00, {2}',
            from,
            to,
            formatDuration(t, hours),
          ) + (slot.daylightPartial ? t(', partly outside daylight') : '');
        r.day.bars.push(r);
      }
    }

    for (const day of days) {
      day.aria = `${day.weekday} ${day.dayNum}: ${day.bars.length ? day.bars.map((b) => b.aria).join('; ') : t('no launch windows')}`;
    }

    return days;
  }, [data, windows, sunrises, sunsets, startIndex, t]);

  const selectedCalendarBar = useMemo(
    () => calendarDays.flatMap((day) => day.bars).find((bar) => bar.id === selectedCalendarBarId) ?? null,
    [calendarDays, selectedCalendarBarId],
  );

  // Selecting from the planner also asks the meteogram to reveal that hour.
  // A plain onSelectIndex can't do this when the index is already selected —
  // after a manual swipe away, re-clicking the same window must still scroll.
  const selectAndReveal = (idx: number) => {
    onSelectIndex(idx);
    window.dispatchEvent(new CustomEvent('timeline-reveal-index', { detail: { index: idx } }));
  };

  const formatDateLabel = (timeStr: string) => {
    return formatDateShort(timeStr);
  };

  const formatTimeLabel = (timeStr: string) => locationHourLabel(timeStr);

  const formatSunsetTime = (isoStr: string) => formatTime(isoStr);

  // In Danish the warning region shows DMI's own Danish areaDesc verbatim;
  // English goes through the shared region mapping.
  const warningRegion = (w: WeatherWarning) =>
    lang === 'da' ? (w.areaDesc ?? t('your region')) : describeWarningArea(w.areaDesc);

  // Keyed by the window's startIndex, not its list position - a forecast
  // refresh can reorder the list while the checkmark is showing
  const [copiedKey, setCopiedKey] = useState<number | null>(null);

  const shareWindow = async (text: string, key: number) => {
    try {
      if (navigator.share) {
        await navigator.share({ text });
        return;
      }
    } catch (err) {
      // Cancelling the share sheet is a deliberate no-op
      if ((err as DOMException)?.name === 'AbortError') return;
    }
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(key);
      window.setTimeout(() => setCopiedKey(null), 2000);
    } catch {
      // No share API and clipboard denied - never leave the button silently
      // dead; the native prompt still lets the user copy the text
      window.prompt(t('Copy the launch window details:'), text);
    }
  };

  // A window whose indices no longer resolve (a refresh shortened the payload
  // between the launchWindows memo and this render) used to render as null
  // while still being counted, so the header could read "(4)" above three
  // cards. Filter once and drive both the count and the list from it.
  const renderableWindows = windows.filter((slot) => data[slot.startIndex] && data[slot.endIndex]);

  const windowsPanel = (
    <div className="panel launch-panel">
      <div className="launch-results-head">
        <div className="launch-panel-header module-head">
          <h2 className="launch-panel-title">
            <CalendarClock size={16} color="var(--primary)" /> {t('Available Launch Windows')} ({renderableWindows.length})
          </h2>

          <div className="view-toggle" role="group" aria-label={t('Launch window view')}>
            <button
              type="button"
              onClick={() => setViewMode('list')}
              className={viewMode === 'list' ? 'active' : ''}
              aria-pressed={viewMode === 'list'}
            >{t('List')}</button>
            <button
              type="button"
              onClick={() => setViewMode('calendar')}
              className={viewMode === 'calendar' ? 'active' : ''}
              aria-pressed={viewMode === 'calendar'}
            >{t('Calendar')}</button>
          </div>
        </div>

            {renderableWindows.length === 0 ? (
              <div className="launch-empty">
                {limitsOff
                  // Both other messages explain the silence in terms of your
                  // limits. With every limit switched off that reads as a
                  // contradiction of the header directly above it, and it
                  // credits a comparison that never happened.
                  ? t('Your personal limits are switched off, so there is nothing to measure the forecast against and no window can be recommended. Turn a limit back on to see suggested windows.')
                  : statuses.some((s, i) => i >= startIndex && s === 'safe')
                    ? t('Some hours are within your limits, but never {0} in a row. Lower the minimum duration in Advanced settings, or try another trip mode.', formatDuration(t, minDuration))
                    : t('No launch windows fit all your selected checks yet. Open an hour to see what needs attention, or check again after the forecast updates.')}
              </div>
            ) : viewMode === 'list' ? (
              /* Tide-table list: day-grouped — the Gantt sibling shows the
                 week's shape; this view carries the numbers, caveats, and the
                 share action. */
              <div
                ref={listRef}
                className="tide-list is-horizontal"
                onMouseDown={handleListMouseDown}
                onMouseMove={handleListMouseMove}
                onMouseUp={endListDrag}
                onMouseLeave={endListDrag}
                onClickCapture={suppressDraggedClick}
              >
                {renderableWindows.map((slot) => {
                  const startHour = data[slot.startIndex];
                  const endHour = data[slot.endIndex];
                  if (!startHour || !endHour) return null;

                  // Hourly windows show the exclusive hour end; block windows show
                  // the end of the last block's clock span.
                  const startLabel = slot.lowConfidence
                    ? `${blockHourRange(startHour.time, startHour.blockSpanHours ?? 6).start}:00`
                    : formatTimeLabel(startHour.time);
                  const endHourLabel = slot.lowConfidence
                    ? `${blockHourRange(endHour.time, endHour.blockSpanHours ?? 6).end}:00`
                    : locationHourLabel(endHour.time);
                  // Block runs can roll past midnight; when the real end lands
                  // on another day, the end label carries that day so
                  // "02:00–02:00" can't read as a zero-length window.
                  const windowEndMs = slot.lowConfidence
                    ? new Date(endHour.time).getTime() + (endHour.blockSpanHours ?? 6) * 3_600_000
                    : new Date(endHour.time).getTime();
                  const crossesMidnight = !isSameLocationDay(windowEndMs, startHour.time);
                  const endLabel = crossesMidnight
                    ? `${formatDateLabel(new Date(windowEndMs).toISOString())} ${endHourLabel}`
                    : endHourLabel;
                  const sunsetCutoff = slot.lowConfidence ? null : sunsetCutoffFor(slot, data, sunsets);
                  // An official DMI warning overlapping this window (most severe
                  // first) — a heads-up badge; it never removes the window. Warnings
                  // whose kommune list demonstrably excludes this town don't badge
                  // windows at all — they still show region-level in the warning stripe.
                  const overlapEndMs = windowEndMs;
                  const slotWarning = warningsOverlapping(
                    warnings,
                    slot.effectiveStartMs ?? new Date(startHour.time).getTime(),
                    overlapEndMs
                  ).filter((w) => w.coverage !== 'excluded')[0];

                  // Share text: place, day, time span, and the range across the
                  // window's actual MET samples. Each outlook block contributes
                  // its one wind value; its independently assessed closing
                  // endpoint also bounds the interval and must be represented.
                  // Exact-hour windows already store that endpoint in endIndex;
                  // outlook windows store the last block start and close at +1.
                  const slotHours = rowsRepresentedByWindow(data, slot);
                  // Outlook blocks usually have no gust forecast, but do not
                  // claim that when the represented rows actually contain one.
                  // Keep the window either way: it remains a deliberately
                  // lower-confidence launch hint based on the readings present.
                  const outlookMissingGust = outlookWindowMissingGust(data, slot);
                  // Only real readings: Math.min/max coerce a missing value to
                  // 0, which turned an unknown hour into a "0 m/s, 0.00 m"
                  // flat-calm claim on the card AND in the shared text.
                  const readings = (values: number[]) => values.filter(Number.isFinite);
                  const winds = readings(slotHours.map((h) => h.windSpeed));
                  const waveLos = readings(slotHours.map((h) => h.waveHeightMin ?? h.waveHeight));
                  const waveHis = readings(slotHours.map((h) => h.waveHeightMax ?? h.waveHeight));
                  const windLo = winds.length ? Math.round(Math.min(...winds)) : NaN;
                  const windHi = winds.length ? Math.round(Math.max(...winds)) : NaN;
                  const waveLo = waveLos.length ? Math.min(...waveLos) : NaN;
                  const waveHi = waveHis.length ? Math.max(...waveHis) : NaN;
                  // Compare the FORMATTED values, as waveShare below does: comparing
                  // the raw numbers meant NaN !== NaN with no wind readings, so the
                  // card rendered "––– m/s" where waves correctly showed a single "–".
                  const windShare = formatReading(windLo, 0) === formatReading(windHi, 0)
                    ? formatReading(windHi, 0)
                    : `${formatReading(windLo, 0)}–${formatReading(windHi, 0)}`;
                  const waveShare = formatReading(waveLo, 2) === formatReading(waveHi, 2)
                    ? formatReading(waveHi, 2)
                    : `${formatReading(waveLo, 2)}–${formatReading(waveHi, 2)}`;

                  // An outlook window flagged daylightPartial shows only its
                  // DAYLIGHT slice, which findLaunchWindows computed and stored
                  // on the window. This used to be re-derived here, and the two
                  // could disagree: the local loop needed TWO whole daylight
                  // hour marks before it narrowed anything, so a 6-hour block
                  // holding 40 minutes of daylight printed its full span.
                  // Tapping still selects the underlying block.
                  let displayStart = startLabel;
                  let displayEnd = endLabel;
                  const displayDuration = slot.duration;
                  if (slot.daylightStartMs !== undefined && slot.daylightEndMs !== undefined) {
                    displayStart = locationHourLabel(slot.daylightStartMs);
                    displayEnd = isSameLocationDay(slot.daylightEndMs, slot.daylightStartMs)
                      ? locationHourLabel(slot.daylightEndMs)
                      : `${formatDateLabel(new Date(slot.daylightEndMs).toISOString())} ${locationHourLabel(slot.daylightEndMs)}`;
                  } else if (slot.effectiveStartMs !== undefined) {
                    displayStart = formatTime(slot.effectiveStartMs);
                  }

                  const shareText = t('{0}: {1} {2}–{3}. Wind {4} m/s, waves {5} m.', CURRENT_LOCATION.areaName, formatDateLabel(startHour.time), displayStart, displayEnd, windShare, waveShare);

                  // daylightPartial needs no caveat line: the displayed times
                  // are already the daylight slice, and the "outlook" tag
                  // carries the lower-confidence nature.
                  const hasCaveats = sunsetCutoff || slotWarning;

                  return (
                    <Fragment key={slot.startIndex}>
                      <div className="tide-row-wrap">
                        <button
                          type="button"
                          className={`tide-row ${slot.lowConfidence ? 'is-outlook' : ''}`}
                          onClick={() => selectAndReveal(slot.startIndex)}
                        >
                          <span className="tide-day-inline">
                            {formatDateMedium(startHour.time)}
                            {/* Tag rides the day line so the card stays short. */}
                            {slot.lowConfidence && (
                              <span className="tide-tag">
                                {t(outlookMissingGust ? 'outlook · no gust forecast' : 'outlook · more uncertain forecast')}
                              </span>
                            )}
                          </span>
                          <span className="tide-row-main">
                            <span className="tide-time">{displayStart}–{displayEnd}</span>
                            <span className="tide-duration"> · {formatDuration(t, displayDuration)}</span>
                          </span>
                          <span className="tide-conditions">
                            {/* The min–max range across the whole window — a
                                single "at start" number misrepresents any
                                window longer than an hour or two. Matches the
                                share text. */}
                            {t('{0} m/s wind · {1} m waves', windShare, waveShare)}
                          </span>
                          {hasCaveats && (
                            <span className="tide-caveats">
                              {sunsetCutoff && (
                                <span className="tide-caveat">
                                  <Sunset size={11} /> {t('Ends near sunset ({0})', formatSunsetTime(sunsetCutoff))}
                                </span>
                              )}
                              {slotWarning && (
                                <span
                                  className="tide-caveat"
                                  title={t("A DMI {0} warning for {1} overlaps this window — it doesn't change this window's verdict; see the warning banner and DMI for details", t(LEVEL_WORD[slotWarning.colour]), warningRegion(slotWarning))}
                                >
                                  <AlertTriangle size={11} className={`warning-ico warning--${slotWarning.colour}`} /> {t('{0} warning · {1}', t(LEVEL_WORD[slotWarning.colour]), warningRegion(slotWarning))}
                                </span>
                              )}
                            </span>
                          )}
                          {slot.lowConfidence && (
                            <span className="sr-only"> {t(
                              outlookMissingGust
                                ? 'Longer-range outlook — no gust forecast and more uncertain.'
                                : 'Longer-range outlook — more uncertain forecast.',
                            )}</span>
                          )}
                          <span className="sr-only"> {t('Tap to show this window in the graph.')}</span>
                        </button>
                        <button
                          type="button"
                          className="tide-share"
                          aria-label={t('Share this launch window')}
                          title={t('Share this launch window')}
                          onClick={() => shareWindow(shareText, slot.startIndex)}
                        >
                          {copiedKey === slot.startIndex ? <Check size={15} /> : <Share2 size={15} />}
                        </button>
                      </div>
                    </Fragment>
                  );
                })}
              </div>
            ) : (
              <div className="calendar-view">
                {/* Legend lists only marks that are actually on screen. On
                    phones it breaks into two balanced rows (window + outlook,
                    then night + now) instead of wrapping raggedly. */}
                <div className="calendar-legend">
                  <div className="calendar-legend-item">
                    <div className="legend-swatch window"></div> {t('Launch window')}
                  </div>
                  {calendarDays.some((d) => d.bars.some((b) => b.lowConfidence)) && (
                    <div className="calendar-legend-item">
                      <div className="legend-swatch outlook"></div> {t('Outlook · more uncertain forecast')}
                    </div>
                  )}
                  <span className="calendar-legend-break" aria-hidden="true" />
                  <div className="calendar-legend-item">
                    <div className="legend-swatch night"></div> {t('Night')}
                  </div>
                  {calendarDays.some((d) => d.nowFrac !== null) && (
                    <div className="calendar-legend-item">
                      <div className="legend-swatch now"></div> {t('Now')}
                    </div>
                  )}
                </div>

                {/* Day-row Gantt on a shared 00–24 axis: bars ARE the windows
                    (and the touch targets); night is an overlay drawn above
                    the bars so a partly-after-sunset window dims honestly. */}
                <div className="gantt" role="list" aria-label={t('Launch windows by day, {0} days', calendarDays.length)}>
                  <div className="gantt-axis" aria-hidden="true">
                    <span className="gantt-day" />
                    <div className="gantt-axis-track">
                      {/* `hour`, not `t` — that shadowed the translate function
                          from useLang() for the whole block. */}
                      {[0, 6, 12, 18, 24].map((hour) => (
                        <span key={hour} className="gantt-tick" style={{ left: `${(hour / 24) * 100}%` }}>
                          {String(hour).padStart(2, '0')}
                        </span>
                      ))}
                    </div>
                  </div>

                  {calendarDays.map((day) => (
                    <div key={day.key} className={`gantt-row ${day.nowFrac !== null ? 'is-today' : ''}`} role="listitem" aria-label={day.aria}>
                      <span className="gantt-day" aria-hidden="true">
                        <span className="gantt-weekday">{day.weekday}</span>
                        <span className="gantt-daynum">{day.dayNum}</span>
                      </span>
                      <div className="gantt-track">
                        {day.bars.map((bar, i) => {
                          const barSpan = bar.endFrac - bar.startFrac;
                          return (
                            <button
                              key={i}
                              type="button"
                              className={`gantt-bar ${bar.lowConfidence ? 'is-outlook' : ''}`}
                              style={{ left: `${(bar.startFrac / 24) * 100}%`, width: `${(barSpan / 24) * 100}%` }}
                              onClick={() => {
                                setSelectedCalendarBarId(bar.id);
                                selectAndReveal(bar.firstIdx);
                              }}
                              aria-label={bar.aria}
                              title={bar.aria}
                            >
                              <span className="gantt-bar-label gantt-bar-label-range" aria-hidden="true">{bar.rangeLabel}</span>
                              <span className="gantt-bar-label gantt-bar-label-compact" aria-hidden="true">{bar.compactLabel}</span>
                              <span className="gantt-bar-label-dot" aria-hidden="true" />
                            </button>
                          );
                        })}
                        <span className="gantt-night is-morning" style={{ left: 0, width: `${(day.sunriseFrac / 24) * 100}%` }} aria-hidden="true" />
                        <span className="gantt-night is-evening" style={{ left: `${(day.sunsetFrac / 24) * 100}%`, width: `${((24 - day.sunsetFrac) / 24) * 100}%` }} aria-hidden="true" />
                        {day.nowFrac !== null && (
                          <span className="gantt-now" style={{ left: `${(day.nowFrac / 24) * 100}%` }} aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                {selectedCalendarBar && (
                  <div className="gantt-selection" role="status" aria-live="polite">
                    <span className="gantt-selection-label">{t('Selected window')}</span>
                    <strong className="gantt-selection-time">{selectedCalendarBar.rangeLabel}</strong>
                    <span>· {formatDuration(t, selectedCalendarBar.hours)}</span>
                    {selectedCalendarBar.lowConfidence && (
                      <span className="gantt-selection-confidence">{t(
                        selectedCalendarBar.missingGust
                          ? 'No gust forecast · more uncertain forecast'
                          : 'More uncertain forecast',
                      )}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

  );

  return windowsPanel;
});
