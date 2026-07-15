import { Fragment, memo, useState, useMemo, useRef } from 'react';
import { AlertTriangle, CalendarClock, Check, Share2, Sunset } from 'lucide-react';
import type { SafetyRating } from '../features/safety/analyzeSafetyConditions';
import { sunsetCutoffFor } from '../features/planner/findLaunchWindows';
import type { LaunchWindow } from '../features/planner/findLaunchWindows';
import { blockHourRange } from '../features/forecast/blockHours';
import { describeWarningArea, LEVEL_WORD, warningsOverlapping } from '../features/forecast/parseWarnings';
import type { HourlyData, WeatherWarning } from '../features/forecast/types';
import { CURRENT_LOCATION } from '../config/locations';
import { useLang } from '../i18n';
import type { Translate } from '../i18n/interpolate';
import { formatDateMedium, formatDateShort, formatTime, formatWeekday, isSameLocationDay, locationDateKey, locationHour, locationHourFraction, locationHourLabel } from '../utils/date';

interface PaddlePlannerProps {
  data: HourlyData[];
  statuses: SafetyRating[];
  windows: LaunchWindow[];
  warnings?: WeatherWarning[];
  sunrises: string[];
  sunsets: string[];
  onSelectIndex: (index: number) => void;
  startIndex: number;
}

// One launch-window bar on a day row of the calendar Gantt (a window crossing
// midnight becomes one bar per day). Fractions are hours 0–24 on the day axis.
// Windows only ever contain Good-to-go hours (findLaunchWindows accepts
// rating === 'safe' exclusively), so a bar needs no per-hour status detail.
interface CalBar {
  firstIdx: number;
  startFrac: number;
  endFrac: number;
  label: string;
  lowConfidence: boolean;
  aria: string;
}

const formatDuration = (t: Translate, hours: number) => t(hours === 1 ? '{0} hr' : '{0} hrs', hours);

// TRIAL (2026-07-14): the owner is comparing list layouts live. 'horizontal'
// = card rail (compact height, windows past the fold need a swipe);
// 'vertical' = tide table (everything visible, page grows). Flip the word to
// switch; delete the losing branch once decided.
const LIST_LAYOUT = 'horizontal' as 'horizontal' | 'vertical';

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
export default memo(function PaddlePlanner({ data, statuses, windows, warnings, sunrises, sunsets, onSelectIndex, startIndex }: PaddlePlannerProps) {
  // Context consumption inside the memo'd body — a language change re-renders
  // this component even though its props are identity-stable.
  const { lang, t } = useLang();
  const [viewMode, setViewMode] = useState<'list' | 'calendar'>('list');
  const listRef = useRef<HTMLDivElement>(null);
  const listDragRef = useRef({ active: false, moved: false, startX: 0, scrollLeft: 0 });

  const handleListMouseDown = (event: React.MouseEvent<HTMLDivElement>) => {
    if (LIST_LAYOUT !== 'horizontal' || event.button !== 0 || !listRef.current) return;
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

      for (let idx = slot.startIndex; idx <= slot.endIndex && idx < data.length; idx++) {
        const span = data[idx].blockSpanHours ?? 1;
        const entryMs = new Date(data[idx].time).getTime();
        let h = 0;
        while (h < span) {
          const ms = entryMs + h * 3_600_000;
          const day = ensureDay(ms);
          const startHour = locationHour(ms);
          const segSpan = Math.min(span - h, 24 - startHour);
          if (run && run.day === day && run.endFrac === startHour) {
            run.endFrac = startHour + segSpan;
          } else {
            run = {
              day,
              firstIdx: idx,
              startFrac: startHour,
              endFrac: startHour + segSpan,
              label: '',
              lowConfidence: Boolean(slot.lowConfidence),
              aria: '',
            };
            runs.push(run);
          }
          h += segSpan;
        }
      }

      for (const r of runs) {
        const hours = r.endFrac - r.startFrac;
        const from = `${String(Math.floor(r.startFrac)).padStart(2, '0')}`;
        const to = `${String(Math.floor(r.endFrac) % 24 || 24).padStart(2, '0')}`;
        // Label by how much bar there is to write on (~12px/hour on a phone).
        // Outlook bars never print start–end times: a 6h block is not a
        // promise that 02:00 is paddleable.
        r.label = r.lowConfidence
          ? (hours >= 4 ? t('outlook') : '')
          : hours >= 7 ? `${from}–${to} · ${hours} h`
            : hours >= 3 ? `${hours} h`
              : '';
        r.aria = r.lowConfidence
          ? t('Outlook window, roughly {0}:00 to {1}:00 — longer range, lower confidence', from, to)
          : t('Launch window {0}:00 to {1}:00, {2}', from, to, formatDuration(t, hours)) + (slot.daylightPartial ? t(', partly outside daylight') : '');
        r.day.bars.push(r);
      }
    }

    for (const day of days) {
      day.aria = `${day.weekday} ${day.dayNum}: ${day.bars.length ? day.bars.map((b) => b.aria).join('; ') : t('no launch windows')}`;
    }

    return days;
  }, [data, windows, sunrises, sunsets, startIndex, t]);

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

  const windowsPanel = (
    <div className="panel launch-panel">
      <div className="launch-results-head">
        <div className="launch-panel-header module-head">
          <h2 className="launch-panel-title">
            <CalendarClock size={16} color="var(--primary)" /> {t('Available Launch Windows')} ({windows.length})
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

            {windows.length === 0 ? (
              <div className="launch-empty">
                {t(statuses.some((s, i) => i >= startIndex && s === 'safe')
                  ? 'No windows match your criteria — there are safe hours, but not a long enough run for your minimum duration and water-level preference. Try another trip mode or loosen the Advanced settings.'
                  : 'No good windows in the forecast yet — conditions stay above your limits for now. Check back as it updates.')}
              </div>
            ) : viewMode === 'list' ? (
              /* Tide-table list: day-grouped — the Gantt sibling shows the
                 week's shape; this view carries the numbers, caveats, and the
                 share action. Layout (vertical column vs horizontal rail) is
                 under live comparison via LIST_LAYOUT above. */
              <div
                ref={listRef}
                className={`tide-list ${LIST_LAYOUT === 'horizontal' ? 'is-horizontal' : ''}`}
                onMouseDown={handleListMouseDown}
                onMouseMove={handleListMouseMove}
                onMouseUp={endListDrag}
                onMouseLeave={endListDrag}
                onClickCapture={suppressDraggedClick}
              >
                {windows.map((slot, index) => {
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
                  // first) — a heads-up badge; it never removes the window. For
                  // hourly windows, endHour.time is the START of the last hour, so
                  // extend the overlap window by that hour; block windows already
                  // include their full span in windowEndMs. Warnings whose kommune
                  // list demonstrably excludes this town don't badge windows at
                  // all — they still show region-level in the warning stripe.
                  const overlapEndMs = slot.lowConfidence ? windowEndMs : windowEndMs + 3_600_000;
                  const slotWarning = warningsOverlapping(
                    warnings,
                    new Date(startHour.time).getTime(),
                    overlapEndMs
                  ).filter((w) => w.coverage !== 'excluded')[0];

                  // Share text: place, day, time span, and the range across the
                  // window's actual MET samples. Each outlook block contributes
                  // its one wind value; legacy percentile fields are ignored.
                  const slotHours = data.slice(slot.startIndex, slot.endIndex + 1);
                  const windLo = Math.round(Math.min(...slotHours.map((h) => h.windSpeed)));
                  const windHi = Math.round(Math.max(...slotHours.map((h) => h.windSpeed)));
                  const waveLo = Math.min(...slotHours.map((h) => h.waveHeightMin ?? h.waveHeight));
                  const waveHi = Math.max(...slotHours.map((h) => h.waveHeightMax ?? h.waveHeight));
                  const windShare = windLo === windHi ? `${windHi}` : `${windLo}–${windHi}`;
                  const waveShare = waveLo.toFixed(2) === waveHi.toFixed(2)
                    ? waveHi.toFixed(2)
                    : `${waveLo.toFixed(2)}–${waveHi.toFixed(2)}`;

                  // Outlook windows flagged daylightPartial show only their
                  // DAYLIGHT slice — the times an hourly window would have
                  // shown had the columns existed (sunrise 04:54 → start
                  // 05:00). Tapping still selects the underlying block. The
                  // slice walks the window's hour marks and keeps those the
                  // hourly day/night rating would call daylight.
                  let displayStart = startLabel;
                  let displayEnd = endLabel;
                  let displayDuration = slot.duration;
                  if (slot.lowConfidence && slot.daylightPartial) {
                    const windowStartMs = new Date(startHour.time).getTime();
                    let firstDayMs: number | null = null;
                    let lastDayMs: number | null = null;
                    for (let ms = windowStartMs; ms < windowEndMs; ms += 3_600_000) {
                      const key = locationDateKey(ms);
                      const sunrise = sunrises.find((s) => locationDateKey(s) === key);
                      const sunset = sunsets.find((s) => locationDateKey(s) === key);
                      if (!sunrise || !sunset) continue;
                      const h = locationHour(ms);
                      if (h >= Math.ceil(locationHourFraction(sunrise)) && h <= Math.floor(locationHourFraction(sunset))) {
                        if (firstDayMs === null) firstDayMs = ms;
                        lastDayMs = ms;
                      }
                    }
                    if (firstDayMs !== null && lastDayMs !== null && lastDayMs > firstDayMs) {
                      displayStart = locationHourLabel(firstDayMs);
                      displayEnd = isSameLocationDay(lastDayMs, firstDayMs)
                        ? locationHourLabel(lastDayMs)
                        : `${formatDateLabel(new Date(lastDayMs).toISOString())} ${locationHourLabel(lastDayMs)}`;
                      displayDuration = Math.round((lastDayMs - firstDayMs) / 3_600_000);
                    }
                  }

                  const shareText = t('{0}: {1} {2}–{3}. Wind {4} m/s, waves {5} m.', CURRENT_LOCATION.areaName, formatDateLabel(startHour.time), displayStart, displayEnd, windShare, waveShare);

                  // Day headers render whenever the (chronological) list moves
                  // to a new location-day.
                  const prevSlot = windows[index - 1];
                  const prevStart = prevSlot ? data[prevSlot.startIndex] : undefined;
                  const showDayHead = !prevStart || !isSameLocationDay(prevStart.time, startHour.time);

                  // daylightPartial needs no caveat line: the displayed times
                  // are already the daylight slice, and the "outlook" tag
                  // carries the lower-confidence nature.
                  const hasCaveats = sunsetCutoff || slotWarning;

                  return (
                    <Fragment key={index}>
                      {LIST_LAYOUT === 'vertical' && showDayHead && (
                        <h3 className="tide-day-head">{formatDateMedium(startHour.time)}</h3>
                      )}
                      <div className="tide-row-wrap">
                        <button
                          type="button"
                          className={`tide-row ${slot.lowConfidence ? 'is-outlook' : ''}`}
                          onClick={() => selectAndReveal(slot.startIndex)}
                        >
                          {LIST_LAYOUT === 'horizontal' && (
                            <span className="tide-day-inline">
                              {formatDateMedium(startHour.time)}
                              {/* Tag rides the day line so the card stays short. */}
                              {slot.lowConfidence && <span className="tide-tag">{t('outlook')}</span>}
                            </span>
                          )}
                          <span className="tide-row-main">
                            <span className="tide-time">{displayStart}–{displayEnd}</span>
                            <span className="tide-duration"> · {formatDuration(t, displayDuration)}</span>
                            {LIST_LAYOUT === 'vertical' && slot.lowConfidence && <span className="tide-tag">{t('outlook')}</span>}
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
                            <span className="sr-only"> {t('Longer-range outlook — lower confidence.')}</span>
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
                      <div className="legend-swatch outlook"></div> {t('Outlook (lower confidence)')}
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

                {windows.length === 0 && (
                  <p className="calendar-empty">
                    {t('No launch windows in this forecast — the timeline above shows the marginal hours.')}
                  </p>
                )}

                {/* Day-row Gantt on a shared 00–24 axis: bars ARE the windows
                    (and the touch targets); night is an overlay drawn above
                    the bars so a partly-after-sunset window dims honestly. */}
                <div className="gantt" role="list" aria-label={t('Launch windows by day, {0} days', calendarDays.length)}>
                  <div className="gantt-axis" aria-hidden="true">
                    <span className="gantt-day" />
                    <div className="gantt-axis-track">
                      {[0, 6, 12, 18, 24].map((t) => (
                        <span key={t} className="gantt-tick" style={{ left: `${(t / 24) * 100}%` }}>
                          {String(t).padStart(2, '0')}
                        </span>
                      ))}
                    </div>
                  </div>

                  {calendarDays.map((day) => (
                    <div key={day.key} className="gantt-row" role="listitem" aria-label={day.aria}>
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
                              onClick={() => selectAndReveal(bar.firstIdx)}
                              aria-label={bar.aria}
                            >
                              {bar.label && <span className="gantt-bar-label">{bar.label}</span>}
                            </button>
                          );
                        })}
                        <span className="gantt-night" style={{ left: 0, width: `${(day.sunriseFrac / 24) * 100}%` }} aria-hidden="true" />
                        <span className="gantt-night" style={{ left: `${(day.sunsetFrac / 24) * 100}%`, width: `${((24 - day.sunsetFrac) / 24) * 100}%` }} aria-hidden="true" />
                        {day.nowFrac !== null && (
                          <span className="gantt-now" style={{ left: `${(day.nowFrac / 24) * 100}%` }} aria-hidden="true" />
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

  );

  return windowsPanel;
});
