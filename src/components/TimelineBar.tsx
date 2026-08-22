import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { Sun, Cloud, CloudRain, CloudLightning, CloudSnow, CloudSun, ArrowDown, ArrowUp, ArrowUpDown, Minus } from 'lucide-react';
import { formatDateMedium, isSameLocationDay, locationHourLabel } from '../utils/date';
import { formatReading, formatLevelCm, NO_READING_TEXT } from '../utils/number';
import { HIGH_WATER_M } from '../features/planner/findLaunchWindows';
import { blockHourRange } from '../features/forecast/blockHours';
import { useLang } from '../i18n';
import type { HourlyData } from '../features/forecast/types';
import { RATING_WORD } from '../features/safety/analyzeSafetyConditions';
import type { SafetyRating } from '../features/safety/analyzeSafetyConditions';

interface TimelineBarProps {
  data: HourlyData[];
  statuses: SafetyRating[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  startIndex: number;
}

interface DayGroup {
  label: string;
  // Keep the rating union rather than widening to string — it's what lets the
  // cell label reuse the app's shared RATING_WORD vocabulary.
  hours: { data: HourlyData; actualIndex: number; status: SafetyRating }[];
}

const HOUR_CELL_WIDTH = 44;
const WEATHER_ICON_SIZE = 15;
const WIND_ARROW_SIZE = 14;
// Bigger than the 10px text it replaced: legibility was half the reason the
// block water level stopped being a pair of numbers.
const LEVEL_TREND_SIZE = 15;

function getWeatherIcon(code: number, size: number) {
  if (code === 0 || code === 1) return <Sun size={size} className="tl-icon-sun" />;
  if (code === 2) return <CloudSun size={size} className="tl-icon-cloud" />;
  if (code === 3 || code === 45 || code === 48) return <Cloud size={size} className="tl-icon-cloud" />;
  if (code >= 51 && code <= 67) return <CloudRain size={size} className="tl-icon-rain" />;
  if (code >= 71 && code <= 77) return <CloudSnow size={size} className="tl-icon-snow" />;
  if (code >= 80 && code <= 82) return <CloudRain size={size} className="tl-icon-rain" />;
  if (code >= 85 && code <= 86) return <CloudSnow size={size} className="tl-icon-snow" />;
  if (code >= 95 && code <= 99) return <CloudLightning size={size} className="tl-icon-storm" />;
  return <Cloud size={size} className="tl-icon-cloud" />;
}

// The arrow stays neutral: the hour strip above already carries the safety
// verdict, so re-tinting arrows by speed would just repeat it in more colors.
function WindArrow({ direction, size }: { direction: number; size: number }) {
  // No bearing, no arrow. `rotate(NaNdeg)` is an invalid declaration that CSS
  // simply drops, leaving the arrow at 0deg — i.e. silently asserting "wind
  // from due north" for an hour with no wind direction at all.
  if (!Number.isFinite(direction)) return null;
  return (
    <div className="wind-arrow" style={{ transform: `rotate(${direction}deg)` }}>
      <ArrowDown size={size} />
    </div>
  );
}

// memo: App re-renders on a 60s heartbeat (relative-age labels); the ~130 hour
// cells here get identity-stable props, so skip the re-render entirely.
export default memo(function TimelineBar({ data, statuses, selectedIndex, onSelectIndex, startIndex }: TimelineBarProps) {
  // Context consumption inside the memo'd body — a language change re-renders
  // this component even though its props are identity-stable.
  const { t } = useLang();
  const hourCellWidth = HOUR_CELL_WIDTH;

  // Memoize displayData so it doesn't recreate on every render
  const displayData = useMemo(() => {
    const endIndex = data.length; // Show all available days (up to 7)
    return data.slice(startIndex, endIndex);
  }, [data, startIndex]);

  const [activeDayIndex, setActiveDayIndex] = useState<number>(0);
  const activeDayIndexRef = useRef(0);

  // Drag-to-scroll ref and state
  const scrollRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const startXRef = useRef(0);
  const offsetLeftRef = useRef(0);
  const scrollLeftRef = useRef(0);
  const hasDraggedRef = useRef(false);

  // Drag-to-scroll for tabs
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabsIsDraggingRef = useRef(false);
  const tabsStartXRef = useRef(0);
  const tabsOffsetLeftRef = useRef(0);
  const tabsScrollLeftRef = useRef(0);
  const tabsHasDraggedRef = useRef(false);
  // Target of an in-flight programmatic smooth scroll. While set, incoming
  // sync events and per-frame scroll handling are suppressed — an external
  // scrollLeft write mid-animation cancels the smooth scroll, which used to
  // strand long jumps (e.g. Today → last day) partway.
  const programmaticTargetRef = useRef<number | null>(null);
  // Where the last programmatic scroll landed. While parked there, the
  // leftmost-column day detection stays off: when the target was clamped (the
  // last day is shorter than the viewport), that rule would flip the active
  // tab back to the previous day right after the user clicked the last one.
  const arrivedAtRef = useRef<number | null>(null);
  // Distance to the target on the previous scroll event. A smooth scroll only
  // ever closes in; the moment distance grows, something interrupted the
  // animation (scrollbar drag, data refresh reflow) and the guard must let go
  // or every later scroll event would be swallowed.
  const lastDistanceRef = useRef<number | null>(null);

  // Clamp to the real scrollable maximum so a target past the end (last day
  // shorter than the viewport) still counts as "arrived" and clears the guard.
  const scrollMatrixTo = (left: number) => {
    const el = scrollRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollWidth - el.clientWidth);
    const target = Math.max(0, Math.min(Math.round(left), maxScroll));
    if (Math.abs(el.scrollLeft - target) < 1) return;
    programmaticTargetRef.current = target;
    lastDistanceRef.current = null;
    el.scrollTo({ left: target, behavior: 'smooth' });
  };

  useEffect(() => {
    activeDayIndexRef.current = activeDayIndex;
  }, [activeDayIndex]);

  // Only worth explaining when the forecast actually reaches that far.
  const hasOutlookColumns = displayData.some((h) => Boolean(h.blockSpanHours));

  const meteogramCellClass = (h: { data: HourlyData; isDayStart: boolean; isOutlookStart: boolean }) =>
    [
      'meteogram-cell',
      !h.data.isDay && !h.data.blockSpanHours ? 'is-night' : '',
      h.isDayStart ? 'is-day-start' : '',
      h.isOutlookStart ? 'is-outlook-start' : '',
      h.data.isLowConfidence ? 'is-low-confidence' : '',
    ].filter(Boolean).join(' ');

  const handleMouseDown = (e: React.MouseEvent) => {
    // Only the primary button owns drag-to-scroll. A right-click must remain a
    // normal context-menu gesture and must never leave selection disabled.
    if (e.button !== 0) return;
    const el = scrollRef.current;
    if (!el) return;
    // A press on the native scrollbar (below the client area) must stay
    // native — drag-to-scroll would fight the thumb and invert it.
    if (e.clientY - el.getBoundingClientRect().top >= el.clientHeight) return;
    // The user takes over: abandon any in-flight programmatic scroll.
    programmaticTargetRef.current = null;
    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    const offsetLeft = el.offsetLeft;
    offsetLeftRef.current = offsetLeft;
    startXRef.current = e.pageX - offsetLeft;
    scrollLeftRef.current = el.scrollLeft;
    el.style.cursor = 'grabbing';
    el.style.userSelect = 'none';
  };

  const snapToNearestColumn = () => {
    if (scrollRef.current) {
      const scrollLeft = scrollRef.current.scrollLeft;
      const nearest = Math.round(scrollLeft / hourCellWidth) * hourCellWidth;
      scrollRef.current.scrollTo({ left: nearest, behavior: 'smooth' });
    }
  };

  const handleMouseLeave = () => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      if (scrollRef.current) {
        scrollRef.current.style.cursor = 'grab';
        scrollRef.current.style.userSelect = '';
      }
      snapToNearestColumn();
    }
  };

  const handleMouseUp = () => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      if (scrollRef.current) {
        scrollRef.current.style.cursor = 'grab';
        scrollRef.current.style.userSelect = '';
      }
      snapToNearestColumn();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = e.pageX - offsetLeftRef.current;
    const walk = (x - startXRef.current) * 1.5; // Scroll speed multiplier
    
    if (Math.abs(walk) > 3) {
      hasDraggedRef.current = true;
    }
    
    el.scrollLeft = scrollLeftRef.current - walk;
  };

  const handleTabsMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const el = tabsRef.current;
    if (!el) return;
    tabsIsDraggingRef.current = true;
    tabsHasDraggedRef.current = false;
    const offsetLeft = el.offsetLeft;
    tabsOffsetLeftRef.current = offsetLeft;
    tabsStartXRef.current = e.pageX - offsetLeft;
    tabsScrollLeftRef.current = el.scrollLeft;
    el.style.cursor = 'grabbing';
    el.style.userSelect = 'none';
    el.style.scrollSnapType = 'none'; // Temporarily disable snapping to allow manual mouse dragging
  };

  const handleTabsMouseLeaveOrUp = () => {
    if (tabsIsDraggingRef.current) {
      tabsIsDraggingRef.current = false;
      if (tabsRef.current) {
        tabsRef.current.style.cursor = 'grab';
        tabsRef.current.style.userSelect = '';
        tabsRef.current.style.scrollSnapType = 'x mandatory'; // Restore snapping for swiping
      }
    }
  };

  const handleTabsMouseMove = (e: React.MouseEvent) => {
    if (!tabsIsDraggingRef.current) return;
    const el = tabsRef.current;
    if (!el) return;
    const x = e.pageX - tabsOffsetLeftRef.current;
    const walk = (x - tabsStartXRef.current) * 1.5;
    if (Math.abs(walk) > 3) {
      tabsHasDraggedRef.current = true;
    }
    el.scrollLeft = tabsScrollLeftRef.current - walk;
  };

  const handleBlockClick = (actualIndex: number) => {
    if (hasDraggedRef.current) {
      // Prevent selection trigger on dragging releases
      hasDraggedRef.current = false;
      return;
    }
    onSelectIndex(actualIndex);
  };

  // Group by day for headers
  const days = useMemo<DayGroup[]>(() => {
    const groupedDays: DayGroup[] = [];
    
    displayData.forEach((hourData, idx) => {
      const actualIndex = startIndex + idx;
      const status = statuses[actualIndex];
      const date = new Date(hourData.time);
      const dayLabel = formatDateMedium(date);
      
      if (groupedDays.length === 0 || groupedDays[groupedDays.length - 1].label !== dayLabel) {
        groupedDays.push({ label: dayLabel, hours: [{ data: hourData, actualIndex, status }] });
      } else {
        groupedDays[groupedDays.length - 1].hours.push({ data: hourData, actualIndex, status });
      }
    });
    return groupedDays;
    // t: dayLabel embeds a locale-formatted date via the module-level date
    // locale (invisible to the linter) — rebuild on language switch.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [displayData, statuses, startIndex, t]);

  const allHours = useMemo(() => {
    const flattened = days.flatMap((d, dIdx) =>
      d.hours.map((h, hIdx) => ({
        ...h,
        isDayStart: hIdx === 0 && dIdx > 0,
        dayLabel: d.label
      }))
    );

    return flattened.map((hour, index) => ({
      ...hour,
      isOutlookStart: Boolean(hour.data.isOutlook) && !flattened[index - 1]?.data.isOutlook,
    }));
  }, [days]);

  // Roving tab stop: the selected cell carries tabIndex=0; if the selection
  // isn't in the strip (edge case), the first cell takes it
  const selectionInHours = allHours.some((h) => h.actualIndex === selectedIndex);

  // Imperative "show me this hour" requests (launch-window/calendar clicks).
  // The selectedIndex effect below can't serve these when the clicked index is
  // already selected — after a manual swipe away, re-clicking the same window
  // must still scroll the matrix back to it AND re-activate its day tab (the
  // arrival guard suppresses the leftmost-day rule, so nothing else would).
  useEffect(() => {
    const handleReveal = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail || typeof detail.index !== 'number') return;
      const hourOffset = allHours.findIndex((h) => h.actualIndex === detail.index);
      if (hourOffset !== -1) {
        scrollMatrixTo(hourOffset * hourCellWidth);
      }
      const dayIdx = days.findIndex((d) => d.hours.some((h) => h.actualIndex === detail.index));
      if (dayIdx !== -1 && dayIdx !== activeDayIndexRef.current) {
        activeDayIndexRef.current = dayIdx;
        setActiveDayIndex(dayIdx);
        const tab = tabsRef.current?.children[dayIdx] as HTMLElement | undefined;
        if (tab && tabsRef.current) {
          tabsRef.current.scrollTo({ left: tab.offsetLeft, behavior: 'smooth' });
        }
      }
    };
    window.addEventListener('timeline-reveal-index', handleReveal);
    return () => window.removeEventListener('timeline-reveal-index', handleReveal);
  }, [allHours, days, hourCellWidth]);

  // Keep active tab and scroll position in sync with selectedIndex
  useEffect(() => {
    const dayIdx = days.findIndex((d: DayGroup) => d.hours.some((h) => h.actualIndex === selectedIndex));
    if (dayIdx !== -1 && dayIdx !== activeDayIndexRef.current) {
      activeDayIndexRef.current = dayIdx;
      setActiveDayIndex(dayIdx);
      if (tabsRef.current) {
        const tab = tabsRef.current.children[dayIdx] as HTMLElement;
        if (tab) {
          tabsRef.current.scrollTo({ left: tab.offsetLeft, behavior: 'smooth' });
        }
      }
    }

    if (scrollRef.current) {
      let hourOffset = -1;
      for (let i = 0; i < allHours.length; i++) {
        if (allHours[i].actualIndex === selectedIndex) {
          hourOffset = i;
          break;
        }
      }
      
      if (hourOffset !== -1) {
        const targetScroll = hourOffset * hourCellWidth;
        const currentScroll = scrollRef.current.scrollLeft;
        const viewWidth = scrollRef.current.clientWidth;
        // Only scroll if the selected block is fully out of view
        if (targetScroll < currentScroll || targetScroll + hourCellWidth > currentScroll + viewWidth) {
          scrollMatrixTo(targetScroll);
        }
      }
    }
  }, [selectedIndex, days, allHours, hourCellWidth]);

  if (days.length === 0) return null;

  const handleTabClick = (index: number) => {
    if (tabsHasDraggedRef.current) {
      tabsHasDraggedRef.current = false;
      return;
    }
    setActiveDayIndex(index);
    if (tabsRef.current) {
      const tab = tabsRef.current.children[index] as HTMLElement;
      if (tab) {
        tabsRef.current.scrollTo({ left: tab.offsetLeft, behavior: 'smooth' });
      }
    }
    if (days[index] && days[index].hours.length > 0) {
      const dayHours = days[index].hours;
      const firstDaylight = dayHours.find(h => h.data.isDay) || dayHours[0];
      // Scroll the meteogram to the target hour here, imperatively, so tapping
      // the same day again after a manual swipe still re-centres it — the
      // selectedIndex effect below only fires when the selection actually changes.
      const hourOffset = allHours.findIndex((h) => h.actualIndex === firstDaylight.actualIndex);
      if (hourOffset !== -1) {
        scrollMatrixTo(hourOffset * hourCellWidth);
      }
      onSelectIndex(firstDaylight.actualIndex);
    }
  };

  const handleScroll = () => {
    if (!scrollRef.current) return;
    const scrollLeft = scrollRef.current.scrollLeft;

    // While a programmatic smooth scroll is in flight, skip the per-frame
    // work: broadcasting intermediate positions makes the charts echo back
    // (cancelling the animation), and the day tabs would flick through every
    // day passed on the way. Everything below runs once, on arrival — or
    // immediately if the scroll stops converging on the target (the user or
    // a reflow took over and the animation is dead).
    if (programmaticTargetRef.current !== null) {
      const distance = Math.abs(scrollLeft - programmaticTargetRef.current);
      if (distance >= 2) {
        const converging = lastDistanceRef.current === null || distance <= lastDistanceRef.current + 1;
        if (converging) {
          lastDistanceRef.current = distance;
          return;
        }
        // Moving away from the target: abandon the guard and fall through.
        programmaticTargetRef.current = null;
        lastDistanceRef.current = null;
      } else {
        programmaticTargetRef.current = null;
        lastDistanceRef.current = null;
        arrivedAtRef.current = scrollLeft;
      }
    }

    // Parked where a programmatic scroll landed: the tab was already set by
    // the click/effect, so don't let the leftmost-column rule override it.
    if (arrivedAtRef.current !== null) {
      if (Math.abs(scrollLeft - arrivedAtRef.current) < 2) return;
      arrivedAtRef.current = null;
    }

    // The active day is whichever day owns the leftmost visible column. Using
    // the column index (not a fixed-hours threshold) keeps this correct even
    // when the first day only has a few hours left — e.g. late evening, where
    // "Today" would otherwise be skipped and the tab would jump to tomorrow.
    const leftColumn = Math.round(scrollLeft / hourCellWidth);
    let cumulativeHours = 0;
    for (let i = 0; i < days.length; i++) {
      cumulativeHours += days[i].hours.length;
      if (leftColumn < cumulativeHours) {
        if (activeDayIndex !== i) {
          setActiveDayIndex(i);
          if (tabsRef.current) {
            const tab = tabsRef.current.children[i] as HTMLElement;
            if (tab) {
              tabsRef.current.scrollTo({ left: tab.offsetLeft, behavior: 'smooth' });
            }
          }
        }
        break;
      }
    }
  };

  return (
    <div className="timeline-bar-container">
      {/* Day Tabs */}
      <div
        ref={tabsRef}
        className="timeline-day-tabs"
        role="group"
        aria-label={t('Forecast days')}
        onMouseDown={handleTabsMouseDown}
        onMouseLeave={handleTabsMouseLeaveOrUp}
        onMouseUp={handleTabsMouseLeaveOrUp}
        onMouseMove={handleTabsMouseMove}
      >
        {days.map((day, i) => {
          const firstHourTime = day.hours[0]?.data.time;
          const isDayToday = isSameLocationDay(firstHourTime, new Date());
          return (
            <button
              key={day.label}
              type="button"
              // The active day was conveyed by a CSS class alone, so assistive
              // tech heard seven identical-sounding buttons with no current one.
              aria-pressed={activeDayIndex === i}
              className={`day-tab-btn ${activeDayIndex === i ? 'active' : ''}`}
              onClick={() => handleTabClick(i)}
            >
              {isDayToday ? t('Today') : day.label}
            </button>
          );
        })}
      </div>
      
      {/* Aligning items flex-start guarantees matching top coordinates for both panels */}
      <div className="timeline-scroll-wrapper">
        {/* Sticky Legend Column */}
        <div className="timeline-legend-col">
          <div className="timeline-legend-label">{t('Weather')}</div>
          <div className="timeline-legend-label tall">{t('Wind')} (m/s)</div>
          <div className="timeline-legend-label">{t('Waves')} (m)</div>
          <div className="timeline-legend-label">{t('Level')} (cm)</div>
          <div className="timeline-legend-label">{t('Air')} (&deg;C)</div>
          <div className="timeline-legend-label">{t('Water')} (&deg;C)</div>
        </div>

        <div
          ref={scrollRef}
          className="scrollable-timeline"
          onMouseDown={handleMouseDown}
          onMouseLeave={handleMouseLeave}
          onMouseUp={handleMouseUp}
          onMouseMove={handleMouseMove}
          onScroll={handleScroll}
          onWheel={() => { programmaticTargetRef.current = null; }}
          onTouchStart={() => { programmaticTargetRef.current = null; }}
        >
          <div className="timeline-track-wrapper" style={{ width: `${allHours.length * hourCellWidth}px` }}>
            {/* The colored blocks */}
            <div className="timeline-track">
              {allHours.map((h) => {
                const { data: hourData, actualIndex, status, isDayStart, isOutlookStart } = h;
                const isSelected = selectedIndex === actualIndex;
                const isBlock = Boolean(hourData.blockSpanHours);
                const isNight = !hourData.isDay && !isBlock;
                const hourLabel = isBlock
                  ? blockHourRange(hourData.time, hourData.blockSpanHours as number).short
                  : locationHourLabel(hourData.time);

                return (
                  <div
                    key={actualIndex}
                    className={`timeline-block status-${status} ${isSelected ? 'selected' : ''} ${isNight ? 'is-night' : ''} ${isOutlookStart ? 'is-outlook-start' : ''} ${isDayStart ? 'is-day-start' : ''} ${hourData.isLowConfidence ? 'is-low-confidence' : ''}`}
                  >
                    <span className="timeline-hour-text">{hourLabel}</span>
                    {isNight && (
                      <svg className="moon-icon" viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path>
                      </svg>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Meteogram Rows */}
            <div className="meteogram-row" title={t('Weather')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  {getWeatherIcon(h.data.weatherCode, WEATHER_ICON_SIZE)}
                </div>
              ))}
            </div>

            <div className="meteogram-row tall" title={t('Wind direction, speed, and gusts (m/s)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={`${meteogramCellClass(h)} tall`}>
                  <div className="meteogram-wind-stack">
                    <WindArrow direction={h.data.windDirection} size={WIND_ARROW_SIZE} />
                    {/* Whole m/s, as yr.no and DMI print it. This row carried a
                        decimal for a while on the argument that limits move in
                        0.5 steps, so 5.5 (green) and 6.0 (amber) both print "6"
                        against a 6.0 cap. That is true, and it is the price of
                        this table: the matrix is for scanning, the CELL COLOUR
                        is the verdict, and the exact value is one tap away in
                        the snapshot. A decision the user made explicitly after
                        seeing both. Applies to the temperature rows below too. */}
                    <span className="meteogram-wind-value">{formatReading(h.data.windSpeed, 0)}/{formatReading(h.data.windGust, 0)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="meteogram-row" title={t('Wave Height (m)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  <span className="meteogram-value">
                    {/* The one row that keeps decimals, because metres is what
                        DMI publishes wave height in ("den signifikante
                        bølgehøjde ... 4 meter") and integer metres would print
                        "0" for every kayak-relevant sea state. 2dp, matching
                        the snapshot and chart readouts. */}
                    {formatReading(h.data.waveHeight, 2)}
                  </span>
                </div>
              ))}
            </div>

            <div className="meteogram-row" title={t('Water level (cm)')}>
              {allHours.map((h) => {
                // An outlook block shows its HIGHEST and LOWEST water level,
                // not one number. Every other row's block value is a defensible
                // single figure — the roughest wave, the coldest water, MET's
                // one wind reading for the period — but water level had no such
                // end to pick, so it showed the sample nearest the block's
                // centre. Six hours of water level summarised by whatever it
                // happened to be in the middle tells a paddler nothing: the
                // whole point of a level is the swing, and a block spanning +44
                // to -2 cm printed "+5". The pair reads as "it moves between
                // these", which is the honest answer at three days out.
                // A 6-hour block gets a direction, not a number.
                //
                // It first showed the sample nearest the block's centre, which
                // summarised six hours of moving water by whatever it happened
                // to be in the middle. Then both ends, which was accurate and
                // unreadable: two 10px numbers in a 44px cell, and a block whose
                // series held a single sample printed one number while its
                // neighbours printed two, which looks like a fault.
                //
                // Nobody plans around a water level four days out anyway. What
                // is worth knowing is whether the block reaches the marks this
                // app already uses for high and low water (HIGH_WATER_M, the
                // same +/-10 cm the Launch Windows tide filter tests), so that
                // is what the arrow says. The numbers are one tap away.
                if (h.data.blockSpanHours) {
                  // NaN comparisons are false either way, so a missing end
                  // simply never trips its arrow.
                  const top = h.data.tideLevelMax ?? Number.NaN;
                  const bottom = h.data.tideLevelMin ?? Number.NaN;
                  const high = top >= HIGH_WATER_M;
                  const low = bottom <= -HIGH_WATER_M;
                  const known = Number.isFinite(top) || Number.isFinite(bottom);
                  return (
                    <div key={h.actualIndex} className={meteogramCellClass(h)}>
                      {known ? (
                        <span className="meteogram-level-trend">
                          {high && low
                            ? <ArrowUpDown size={LEVEL_TREND_SIZE} aria-hidden="true" />
                            : high ? <ArrowUp size={LEVEL_TREND_SIZE} aria-hidden="true" />
                            : low ? <ArrowDown size={LEVEL_TREND_SIZE} aria-hidden="true" />
                            // Stays inside +/-10 cm for the whole block: near
                            // mean water, which is its own answer and not the
                            // same as "no reading" (that keeps the dash).
                            : <Minus size={LEVEL_TREND_SIZE} aria-hidden="true" />}
                        </span>
                      ) : (
                        <span className="meteogram-value">{NO_READING_TEXT}</span>
                      )}
                    </div>
                  );
                }
                const level = formatLevelCm(h.data.tideLevel);
                return (
                  <div key={h.actualIndex} className={meteogramCellClass(h)}>
                    {/* is-signed: a centred sign pushes the digits half a
                        character right of every unsigned row. */}
                    <span className={/^[+-]/.test(level) ? 'meteogram-value is-signed' : 'meteogram-value'}>
                      {level}
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="meteogram-row" title={t('Air temperature (°C)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  <span className="meteogram-value">
                    {/* Whole degrees, as every weather app prints air
                        temperature. Nothing in the safety engine reads it, so
                        unlike the rows above there is not even a threshold to
                        argue about. */}
                    {formatReading(h.data.tempAir, 0)}
                  </span>
                </div>
              ))}
            </div>

            <div className="meteogram-row" title={t('Water temperature (°C)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  <span className="meteogram-value">
                    {/* Whole degrees. The cold-shock lines sit at 10 and 15 °C,
                        so 9.5 (danger) and 10.4 (caution) both print "10" here —
                        told apart by the cell colour, and exactly in the
                        snapshot. Same trade as the wind row. */}
                    {formatReading(h.data.tempWater, 0)}
                  </span>
                </div>
              ))}
            </div>

            {/* Clickable overlay grid. Selecting an hour is one-of-many, so
                this is a listbox with aria-selected and a roving tab stop
                (a field of ~168 aria-pressed toggles read as independent
                switches and put every cell in the tab order). Arrows move
                and select; selection follows focus per the APG pattern. */}
            <div
              className="timeline-overlay-grid"
              role="listbox"
              aria-label={t('Forecast hours')}
              aria-orientation="horizontal"
              onKeyDown={(e) => {
                const pos = allHours.findIndex((h) => h.actualIndex === selectedIndex);
                let target: number | null = null;
                // No selection in the strip (pos === -1): both arrows land on
                // the first cell instead of silently skipping it.
                // Horizontal listbox: Up/Down are deliberately NOT bound. They
                // used to move the selection and preventDefault the event,
                // which trapped a keyboard user inside ~130 cells with no way
                // to scroll the page.
                if (e.key === 'ArrowRight') target = pos === -1 ? 0 : Math.min(allHours.length - 1, pos + 1);
                else if (e.key === 'ArrowLeft') target = Math.max(0, (pos === -1 ? 1 : pos) - 1);
                else if (e.key === 'Home') target = 0;
                else if (e.key === 'End') target = allHours.length - 1;
                if (target === null) return;
                e.preventDefault();
                // Not handleBlockClick: its drag-suppression flag is a mouse
                // concern, and a stale flag after a cross-cell drag swallowed
                // the first keypress while focus still moved — breaking the
                // "selection follows focus" contract promised above.
                onSelectIndex(allHours[target].actualIndex);
                (e.currentTarget.children[target] as HTMLElement | undefined)?.focus();
              }}
            >
              {allHours.map((h, i) => {
                const { data: hourData, actualIndex, status, isDayStart, isOutlookStart } = h;
                const isSelected = selectedIndex === actualIndex;
                const isBlock = Boolean(hourData.blockSpanHours);
                const isNight = !hourData.isDay && !isBlock;
                const timeLabel = isBlock
                  ? blockHourRange(hourData.time, hourData.blockSpanHours as number).short
                  : locationHourLabel(hourData.time);
                // The six data rows below the ribbon are bare divs of
                // context-free numbers, so the readings were unreachable by
                // screen reader — the cell label is the only place they can be
                // announced. Same verdict vocabulary as the status bar.
                // A block's water level is a range on screen, so it has to be a
                // range here too — announcing the centre sample would tell a
                // screen-reader user a number no sighted user can see.
                const levelReading = isBlock
                  && formatLevelCm(hourData.tideLevelMax) !== formatLevelCm(hourData.tideLevelMin)
                  ? t('{0} to {1} cm', formatLevelCm(hourData.tideLevelMin), formatLevelCm(hourData.tideLevelMax))
                  : `${formatLevelCm(isBlock ? hourData.tideLevelMax : hourData.tideLevel)} cm`;
                const cellReadings = [
                  `${t('Wind')} ${formatReading(hourData.windSpeed, 1)} m/s`,
                  `${t('Gusts')} ${formatReading(hourData.windGust, 1)} m/s`,
                  `${t('Waves')} ${formatReading(hourData.waveHeight, 2)} m`,
                  `${t('Level')} ${levelReading}`,
                  `${t('Air')} ${formatReading(hourData.tempAir, 1)}°C`,
                  `${t('Water')} ${formatReading(hourData.tempWater, 1)}°C`,
                ].join(', ');
                const cellDescription = `${formatDateMedium(hourData.time)} ${timeLabel} - ${t(RATING_WORD[status]).toUpperCase()}${isNight ? ` ${t('(Night)')}` : ''}${isBlock ? ` ${t('(Longer range, more uncertain forecast)')}` : ''}. ${cellReadings}`;
                return (
                  <button
                    key={`overlay-${actualIndex}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    tabIndex={isSelected || (!selectionInHours && i === 0) ? 0 : -1}
                    className={`timeline-overlay-cell ${isSelected ? 'is-selected' : ''} ${isOutlookStart ? 'is-outlook-start' : ''} ${isDayStart ? 'is-day-start' : ''} ${hourData.isLowConfidence ? 'is-low-confidence' : ''}`}
                    onClick={() => handleBlockClick(actualIndex)}
                    aria-label={cellDescription}
                    title={cellDescription}
                  />
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Nothing explained the columns that stop being hourly. Past MET's hourly
          range the matrix continues in 6-hour blocks: striped values,
          and a header reading a span like "02-08" instead of a single hour. All
          of it visual only, so a reader had no way to learn what it meant.
          A legend, not a paragraph: the first version said the same things in
          four sentences and nobody reads four sentences under a table. */}
      {hasOutlookColumns && (
        <div className="timeline-outlook-note">
          <p className="outlook-note-lead">
            {t('Columns like 02–08 show a 6-hour block.')}
          </p>
          <ul className="outlook-note-list">
            <li>{t('Waves and water temperature: the highest waves and coldest water.')}</li>
            <li>{t('Wind and air temperature: MET’s reading for the block.')}</li>
            <li aria-label={t('Water level: high water, low water, both, or near mean.')}>
              <span aria-hidden="true">
                {t('Water level: high water')} <ArrowUp size={12} />,{' '}
                {t('low water')} <ArrowDown size={12} />,{' '}
                {t('both')} <ArrowUpDown size={12} />{' '}
                {t('or near mean')} <Minus size={12} />.
              </span>
            </li>
          </ul>
          <p className="outlook-note-lead">{t('Tap a block for its numbers.')}</p>
        </div>
      )}
    </div>
  );
});
