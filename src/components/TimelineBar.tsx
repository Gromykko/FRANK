import { memo, useState, useEffect, useMemo, useRef } from 'react';
import { Sun, Cloud, CloudRain, CloudLightning, CloudSnow, CloudSun, ArrowDown } from 'lucide-react';
import { formatDateMedium, isSameLocationDay, locationHourLabel } from '../utils/date';
import { blockHourRange } from '../features/forecast/blockHours';
import { useLang } from '../i18n';
import type { HourlyData } from '../features/forecast/types';

interface TimelineBarProps {
  data: HourlyData[];
  statuses: ('safe' | 'caution' | 'danger')[];
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  startIndex: number;
}

interface DayGroup {
  label: string;
  hours: { data: HourlyData; actualIndex: number; status: string }[];
}

const HOUR_CELL_WIDTH = 44;
const WEATHER_ICON_SIZE = 15;
const WIND_ARROW_SIZE = 14;

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
  const scrollLeftRef = useRef(0);
  const hasDraggedRef = useRef(false);

  // Drag-to-scroll for tabs
  const tabsRef = useRef<HTMLDivElement>(null);
  const tabsIsDraggingRef = useRef(false);
  const tabsStartXRef = useRef(0);
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

  const meteogramCellClass = (h: { data: HourlyData; isDayStart: boolean; isOutlookStart: boolean }) =>
    [
      'meteogram-cell',
      !h.data.isDay && !h.data.blockSpanHours ? 'is-night' : '',
      h.isDayStart ? 'is-day-start' : '',
      h.isOutlookStart ? 'is-outlook-start' : '',
      h.data.isLowConfidence ? 'is-low-confidence' : '',
    ].filter(Boolean).join(' ');

  const handleMouseDown = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    // A press on the native scrollbar (below the client area) must stay
    // native — drag-to-scroll would fight the thumb and invert it.
    if (e.clientY - el.getBoundingClientRect().top >= el.clientHeight) return;
    // The user takes over: abandon any in-flight programmatic scroll.
    programmaticTargetRef.current = null;
    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    startXRef.current = e.pageX - el.offsetLeft;
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
      if (scrollRef.current) scrollRef.current.style.cursor = 'grab';
      snapToNearestColumn();
    }
  };

  const handleMouseUp = () => {
    if (isDraggingRef.current) {
      isDraggingRef.current = false;
      if (scrollRef.current) scrollRef.current.style.cursor = 'grab';
      snapToNearestColumn();
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (!isDraggingRef.current) return;
    const el = scrollRef.current;
    if (!el) return;
    const x = e.pageX - el.offsetLeft;
    const walk = (x - startXRef.current) * 1.5; // Scroll speed multiplier
    
    if (Math.abs(walk) > 3) {
      hasDraggedRef.current = true;
    }
    
    el.scrollLeft = scrollLeftRef.current - walk;
  };

  const handleTabsMouseDown = (e: React.MouseEvent) => {
    const el = tabsRef.current;
    if (!el) return;
    tabsIsDraggingRef.current = true;
    tabsHasDraggedRef.current = false;
    tabsStartXRef.current = e.pageX - el.offsetLeft;
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
        tabsRef.current.style.scrollSnapType = 'x mandatory'; // Restore snapping for swiping
      }
    }
  };

  const handleTabsMouseMove = (e: React.MouseEvent) => {
    if (!tabsIsDraggingRef.current) return;
    const el = tabsRef.current;
    if (!el) return;
    const x = e.pageX - el.offsetLeft;
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
              key={i}
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
          <div className="timeline-legend-label">{t('Level')} (m)</div>
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
                const hourLabel = isBlock
                  ? blockHourRange(hourData.time, hourData.blockSpanHours as number).short
                  : locationHourLabel(hourData.time);
                const isNight = !hourData.isDay && !isBlock;

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
                    <span className="meteogram-wind-value">{Math.round(h.data.windSpeed)}/{Math.round(h.data.windGust)}</span>
                  </div>
                </div>
              ))}
            </div>

            <div className="meteogram-row" title={t('Wave Height (m)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  <span className="meteogram-value">
                    {h.data.waveHeight.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>

            <div className="meteogram-row" title={t('Water level (m)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  <span className="meteogram-value">
                    {h.data.tideLevel > 0 ? '+' : ''}{h.data.tideLevel.toFixed(2)}
                  </span>
                </div>
              ))}
            </div>

            <div className="meteogram-row" title={t('Air temperature (°C)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  <span className="meteogram-value">
                    {Math.round(h.data.tempAir)}
                  </span>
                </div>
              ))}
            </div>

            <div className="meteogram-row" title={t('Water temperature (°C)')}>
              {allHours.map((h) => (
                <div key={h.actualIndex} className={meteogramCellClass(h)}>
                  <span className="meteogram-value">
                    {Math.round(h.data.tempWater)}
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
                if (e.key === 'ArrowRight' || e.key === 'ArrowDown') target = pos === -1 ? 0 : Math.min(allHours.length - 1, pos + 1);
                else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') target = Math.max(0, (pos === -1 ? 1 : pos) - 1);
                else if (e.key === 'Home') target = 0;
                else if (e.key === 'End') target = allHours.length - 1;
                if (target === null) return;
                e.preventDefault();
                handleBlockClick(allHours[target].actualIndex);
                (e.currentTarget.children[target] as HTMLElement | undefined)?.focus();
              }}
            >
              {allHours.map((h, i) => {
                const { data: hourData, actualIndex, status, isDayStart, isOutlookStart } = h;
                const isSelected = selectedIndex === actualIndex;
                const isBlock = Boolean(hourData.blockSpanHours);
                const timeLabel = isBlock
                  ? blockHourRange(hourData.time, hourData.blockSpanHours as number).short
                  : locationHourLabel(hourData.time);
                const cellDescription = `${formatDateMedium(hourData.time)} ${timeLabel} - ${t(status).toUpperCase()}${hourData.isDay ? '' : ` ${t('(Night)')}`}${isBlock ? ` ${t('(Longer range, lower confidence)')}` : ''}`;
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
    </div>
  );
});
