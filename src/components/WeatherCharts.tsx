import { memo, useMemo, useRef, useEffect, useCallback, useState } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
  ComposedChart,
  Line,
} from 'recharts';
import { formatDateShort, formatWeekday, locationHourLabel } from '../utils/date';
import { useLang } from '../i18n';
import type { HourlyData } from '../features/forecast/types';
import type { SafetySettings } from '../features/safety/presets';
import { Wind, Waves, ArrowDownUp, Thermometer } from 'lucide-react';

interface WeatherChartsProps {
  data: HourlyData[];
  settings: SafetySettings;
  selectedIndex: number;
  onSelectIndex: (index: number) => void;
  startIndex: number;
}

const HOUR_CELL_WIDTH = 44;
// Shared by all charts; the click-to-hour math depends on left/right + Y-axis.
const CHART_MARGIN = { top: 18, right: 20, left: 0, bottom: 0 };
const Y_AXIS_WIDTH = 34;
const TICK_FONT_SIZE = 10;

// Series colors resolve through the theme's data-series tokens so the
// charts follow light/dark mode. SVG attributes accept var() references.
const SERIES = {
  wind: 'var(--data-wind)',
  gust: 'var(--data-gust)',
  wave: 'var(--data-wave)',
  tide: 'var(--data-tide)',
  airTemp: 'var(--data-air-temp)',
  waterTemp: 'var(--data-water-temp)',
} as const;

// Theme token: the navy that reads as "dimmed" on a white plot vanishes on
// the dark panel, so dark mode resolves this to a deeper near-black.
const NIGHT_FILL = 'var(--chart-night-fill)';
const GRID_STROKE = 'var(--panel-border)';
const SELECTED_LINE_STROKE = 'rgba(59, 130, 246, 0.55)';
const CAUTION_LINE = 'var(--color-caution)';
const DANGER_LINE = 'var(--color-danger)';
// Faint wash above/below a limit so "over the line" reads as a region, not
// just a crossing — kept ≤7% so it never competes with the data series.
const WASH_OPACITY = 0.07;

// Every chart answers "where does my line cross MY limit?": the user's own
// caps render as labeled dashed rules with a faint wash beyond them, and all
// four charts share ONE scroll body (one time axis, one drag, no sync machinery).
export default memo(function WeatherCharts({ data, settings, selectedIndex, onSelectIndex, startIndex }: WeatherChartsProps) {
  // Context consumption inside the memo'd body — a language change re-renders
  // this component even though its props are identity-stable.
  const { t } = useLang();
  const activeItem = data[selectedIndex];
  // The dashed limit rules + washes are opt-in via the legend toggle: they
  // add four to five lines of red/amber per chart, which is a lot of ink for
  // information the verdict colours already carry. Off by default.
  const [showLimits, setShowLimits] = useState(false);

  // Detailed graphs stop at the hourly/outlook boundary. Aggregate outlook
  // blocks remain available in the meteogram and launch-window views.
  const displayData = useMemo(() => {
    const remaining = data.slice(startIndex);
    const boundary = remaining.findIndex((item) => Boolean(item.blockSpanHours));
    return boundary === -1 ? remaining : remaining.slice(0, boundary);
  }, [data, startIndex]);

  const chartData = useMemo(() => {
    return displayData.map((item) => {
      const date = new Date(item.time);
      const wind = parseFloat(item.windSpeed.toFixed(1));
      const gust = parseFloat(item.windGust.toFixed(1));
      return {
        ...item,
        timeLabel: locationHourLabel(date),
        dayLabel: formatWeekday(date),
        // The graphs are strictly HOURLY detail: every series stops at the
        // outlook boundary (a 6h aggregate carries no hourly shape — plotting
        // anything there read as data that doesn't exist). The x-range still
        // spans the blocks so the ribbon/day rail/meteogram stay aligned; the
        // empty zone carries a big "Outlook" plate instead. Block ranges live
        // in the snapshot and the launch-window list.
        windDisplay: wind,
        // The gust RIBBON is the visible object: the band between sustained
        // wind and gusts, so gust spread reads directly instead of as a
        // second line to mentally subtract.
        gustBand: [wind, gust] as [number, number],
        waveDisplay: parseFloat(item.waveHeight.toFixed(2)),
        tideDisplay: parseFloat(item.tideLevel.toFixed(2)),
        tempWaterDisplay: parseFloat(item.tempWater.toFixed(1)),
        tempDisplay: parseFloat(item.tempAir.toFixed(1)),
      };
    });
    // t: timeLabel/dayLabel embed locale-formatted dates via the module-level
    // date locale (invisible to the linter) — a language switch must rebuild
    // them; daySegments derives from chartData and follows.
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [displayData, t]);

  const nightRanges = useMemo(() => {
    const ranges: { x1: string; x2: string }[] = [];
    let currentStart: string | null = null;
    chartData.forEach((item, idx) => {
      const isNight = !item.isDay && !item.blockSpanHours;
      if (isNight) {
        if (currentStart === null) currentStart = item.time;
      } else if (currentStart !== null) {
        ranges.push({ x1: currentStart, x2: chartData[idx - 1].time });
        currentStart = null;
      }
    });
    if (currentStart !== null) {
      ranges.push({ x1: currentStart, x2: chartData[chartData.length - 1].time });
    }
    return ranges;
  }, [chartData]);

  // One segment per calendar day; the rail renders a sticky label per
  // segment, so the current day holds the left edge and the next day's
  // label rides its 00:00 boundary in and pushes the old one out.
  const daySegments = useMemo(() => {
    const segs: { label: string; startIdx: number; span: number }[] = [];
    chartData.forEach((item, i) => {
      const label = formatDateShort(item.time);
      const last = segs[segs.length - 1];
      if (last && last.label === label) last.span += 1;
      else segs.push({ label, startIdx: i, span: 1 });
    });
    return segs;
  }, [chartData]);

  // ── One scroll body ──────────────────────────────────────────────────────
  const scrollRef = useRef<HTMLDivElement>(null);
  const isDraggingRef = useRef(false);
  const hasDraggedRef = useRef(false);
  const startXRef = useRef(0);
  const scrollLeftRef = useRef(0);
  const chartSelectedIndexRef = useRef<number | null>(null);

  const handleMouseDown = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!el) return;
    // A press on the native scrollbar (below the client area) must stay
    // native — drag-to-scroll would fight the thumb and invert it.
    if (e.clientY - el.getBoundingClientRect().top >= el.clientHeight) return;
    isDraggingRef.current = true;
    hasDraggedRef.current = false;
    startXRef.current = e.pageX - el.offsetLeft;
    scrollLeftRef.current = el.scrollLeft;
    el.style.cursor = 'grabbing';
    el.style.userSelect = 'none';
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    const el = scrollRef.current;
    if (!isDraggingRef.current || !el) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    if (Math.abs(x - startXRef.current) > 3) hasDraggedRef.current = true;
    el.scrollLeft = scrollLeftRef.current - (x - startXRef.current) * 1.5;
  };

  const handleMouseLeaveOrUp = () => {
    const el = scrollRef.current;
    if (isDraggingRef.current && el) {
      isDraggingRef.current = false;
      el.style.cursor = 'grab';
      el.style.userSelect = '';
    }
  };

  // Bring the selected hour into view when it's selected elsewhere.
  useEffect(() => {
    const el = scrollRef.current;
    const hourOffset = selectedIndex - startIndex;
    if (!el || hourOffset < 0 || hourOffset >= displayData.length) return;
    // The point the user just clicked is already visible. Do not run the
    // cross-component reveal logic, which would otherwise pull a point near
    // the right edge all the way to the left of the viewport.
    if (chartSelectedIndexRef.current === selectedIndex) {
      chartSelectedIndexRef.current = null;
      return;
    }
    chartSelectedIndexRef.current = null;
    const targetScroll = hourOffset * HOUR_CELL_WIDTH;
    // Only scroll if the selected block is FULLY out of view. A thumb tap
    // often lands on a half-clipped cell at the screen edge - treating that
    // as "out of view" yanked the chart a screenful left.
    if (targetScroll + HOUR_CELL_WIDTH <= el.scrollLeft || targetScroll >= el.scrollLeft + el.clientWidth) {
      el.scrollTo({ left: targetScroll, behavior: 'smooth' });
    }
  }, [selectedIndex, startIndex, displayData.length]);

  const handleChartClick = useCallback((_state: unknown, event?: unknown) => {
    // A drag-to-scroll release still fires a click on whatever hour is under
    // the cursor - selecting there was never the intent
    if (hasDraggedRef.current) return;
    // Never use Recharts' activeTooltipIndex here: it maps the pointer
    // through a container offset cached at mount, so once the chart is
    // scrolled it names an hour far from the one clicked. The x-axis is a
    // point scale over a fixed grid, so the live SVG rect (which moves with
    // the scroll) gives the exact hour for every input.
    const e = event as { clientX?: number; target?: EventTarget } | null;
    const svg = e?.target instanceof Element ? e.target.closest('.recharts-surface') : null;
    if (!svg || typeof e?.clientX !== 'number' || displayData.length < 2) return;
    const rect = svg.getBoundingClientRect();
    const plotLeft = rect.left + CHART_MARGIN.left + Y_AXIS_WIDTH;
    const plotWidth = rect.width - CHART_MARGIN.left - Y_AXIS_WIDTH - CHART_MARGIN.right;
    const idx = Math.max(0, Math.min(
      Math.round(((e.clientX - plotLeft) / plotWidth) * (displayData.length - 1)),
      displayData.length - 1,
    ));
    const clickedItem = displayData[idx];
    if (clickedItem) {
      const globalIndex = data.findIndex((item) => item.time === clickedItem.time);
      if (globalIndex !== -1) {
        chartSelectedIndexRef.current = globalIndex;
        onSelectIndex(globalIndex);
      }
    }
  }, [displayData, data, onSelectIndex]);

  const formatTickTime = (timeStr: string) => locationHourLabel(timeStr);

  if (!activeItem || chartData.length === 0) return null;

  // ── The user's own limits, straight from settings ───────────────────────
  const windSafe = settings.maxWindSpeedSafe;
  const windDanger = settings.maxWindSpeedCaution;
  const gustCeil = settings.maxWindSpeedSafe + (settings.gustMargin ?? 2.5);
  const waveSafe = settings.maxWaveHeightSafe;
  const waveDanger = settings.maxWaveHeightCaution;
  const tempSafe = settings.minWaterTempSafe;
  const tempDanger = settings.minWaterTempCaution;
  const windEnabled = settings.enableWindSpeed ?? true;
  const gustEnabled = windEnabled && (settings.enableWindGust ?? true);
  const waveEnabled = settings.enableWaveHeight ?? true;
  const waveCautionEnabled = waveEnabled && (settings.enableWaveCaution ?? true);
  const waterTempEnabled = settings.enableWaterTemp ?? true;
  // What actually renders: the enable flags decide WHICH limits exist (and
  // keep sizing the axis domains so toggling never rescales the plots); the
  // legend toggle decides whether any of them are drawn.
  const windLimitsOn = showLimits && windEnabled;
  const gustLimitsOn = showLimits && gustEnabled;
  const waveLimitsOn = showLimits && waveEnabled;
  const waveCautionOn = showLimits && waveCautionEnabled;
  const tempLimitsOn = showLimits && waterTempEnabled;

  const chartWidth = chartData.length * HOUR_CELL_WIDTH;
  // Axis ranges always include the limit lines AND the data, or a loosened
  // cap / a windy day would silently extend the domain — Recharts widens a
  // too-narrow declared domain without telling anyone, and the sticky rail's
  // y math (which trusts the declared domain) would drift off the real lines.
  const windAxisMax = Math.max(
    10,
    Math.ceil(Math.max(
      windEnabled ? windDanger + 1 : 0,
      gustEnabled ? gustCeil + 1 : 0,
      ...chartData.map((d) => d.gustBand?.[1] ?? 0),
    ) / 5) * 5,
  );
  const waveAxisMax = Math.max(
    0.5,
    waveEnabled ? waveDanger + 0.1 : 0,
    Math.ceil(Math.max(...chartData.map((d) => d.waveDisplay ?? 0)) * 10) / 10,
  );
  const tideAbsMax = Math.max(0.5, Math.ceil(Math.max(...chartData.map((d) => Math.abs(d.tideDisplay ?? 0))) * 2) / 2);
  const tideAxisMin = -tideAbsMax;
  const tideAxisMax = tideAbsMax;
  const tempMinValue = Math.min(
    waterTempEnabled ? tempDanger - 2 : 99,
    ...chartData.map((d) => Math.min(d.tempDisplay ?? 99, d.tempWaterDisplay ?? 99)),
  );
  const tempMaxValue = Math.max(
    ...chartData.map((d) => Math.max(d.tempDisplay ?? -99, d.tempWaterDisplay ?? -99)),
  );
  const tempAxisMin = Math.floor(tempMinValue / 5) * 5;
  const tempAxisMax = Math.max(tempAxisMin + 5, Math.ceil(tempMaxValue / 5) * 5);

  // Tick text is rendered by the sticky HTML rail below instead of the SVG
  // axis (which scrolls away with the content); the axis still reserves its
  // gutter width and its ticks still drive the horizontal grid lines.
  const axisProps = {
    width: Y_AXIS_WIDTH,
    stroke: 'var(--text-muted)',
    fontSize: TICK_FONT_SIZE,
    tickLine: false,
    axisLine: false,
    tick: false,
  } as const;

  // ── Sticky rails: axis values + limit labels that follow the scroll ─────
  // HTML chips inside a position:sticky anchor, so "wind limit 5" and the
  // tick values stay pinned at the scrollport's left edge however far the
  // charts are scrolled (same trick as the day labels above).
  const stickyRail = (
    domainMin: number,
    domainMax: number,
    plotHeight: number,
    ticks: number[],
    limits: { value: number; label: string; tone: 'caution' | 'danger' | 'muted' }[],
    topOffset = CHART_MARGIN.top,
  ) => {
    const y = (v: number) => topOffset + (1 - (v - domainMin) / (domainMax - domainMin)) * plotHeight;
    return (
      <div className="chart-sticky-rail" aria-hidden="true">
        <span className="chart-sticky-anchor">
          {ticks.map((t) => (
            <span key={`t${t}`} className="chart-axis-chip" style={{ top: `${y(t)}px` }}>{t}</span>
          ))}
          {limits.map((l) => (
            <span key={l.label} className={`chart-limit-chip chart-limit-chip--${l.tone}`} style={{ top: `${y(l.value)}px` }}>
              {l.label}
            </span>
          ))}
        </span>
      </div>
    );
  };

  // Night shading and the selected-hour marker are shared by every graph.
  const backdrops = () => (
    <>
      {nightRanges.map((r, i) => (
        <ReferenceArea key={`n${i}`} x1={r.x1} x2={r.x2} fill={NIGHT_FILL} strokeOpacity={0} />
      ))}
      {!activeItem.blockSpanHours && <ReferenceLine x={activeItem.time} stroke={SELECTED_LINE_STROKE} strokeDasharray="4 6" strokeWidth={1.5} />}
    </>
  );

  const inlineHeader = (icon: React.ReactNode, title: string, metric: React.ReactNode) => (
    <div className="chart-inline-header" aria-hidden="true">
      <span className="chart-inline-header-content">
        <span className="chart-header-title">{icon} {title}</span>
        <span className="chart-header-metric">{metric}</span>
      </span>
    </div>
  );
  const activeMetric = (metric: React.ReactNode) => activeItem.blockSpanHours
    ? <span>{t('Detailed graphs restricted to hourly available data')}</span>
    : metric;

  return (
    <div className="charts-grid">
      <div className="calendar-legend">
        <div className="calendar-legend-item">
          <div className="legend-swatch night"></div> {t('Night')}
        </div>
        <button
          type="button"
          className={`calendar-legend-item legend-toggle ${showLimits ? 'is-on' : ''}`}
          aria-pressed={showLimits}
          onClick={() => setShowLimits((v) => !v)}
        >
          <div className="legend-swatch limit-line"></div> {t(showLimits ? 'Your limits: on' : 'Your limits: off')}
        </button>
        <span className="calendar-legend-note">{t('Tap or click a graph to select that hour')}</span>
      </div>

      <div
        ref={scrollRef}
        className="chart-scroll-container chart-scroll-single"
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseLeaveOrUp}
        onMouseLeave={handleMouseLeaveOrUp}
      >
        {/* aria-hidden: the charts are a pointer-only visual layer; the same
            data is text in the timeline and snapshot */}
        <div className="chart-canvas" aria-hidden="true" style={{ width: `${chartWidth}px` }}>
          {/* 1 — WIND: gust spread as a ribbon, your caps as labeled rules */}
          {inlineHeader(<Wind size={16} />, t('Wind & gusts'), activeMetric(
            <>
              <span className="tone-wind">{activeItem.windSpeed.toFixed(1)} m/s</span>
              {' · '}
              <span className="tone-gust">{t('gusts {0}', activeItem.windGust.toFixed(1))}</span>
            </>
          ))}
          {/* Day labels sit directly on the wind chart's top hour axis, so
              "Tue 14" reads as part of the time scale, not a floating row. */}
          <div className="chart-day-rail" aria-hidden="true">
            {daySegments.map((seg) => (
              <div
                key={seg.startIdx}
                className="chart-day-cell"
                style={{ left: `${seg.startIdx * HOUR_CELL_WIDTH}px`, width: `${seg.span * HOUR_CELL_WIDTH}px` }}
              >
                <span className="chart-day-label">{seg.label}</span>
              </div>
            ))}
          </div>
          <div className="chart-plot-wrap" style={{ width: `${chartWidth}px` }}>
            <AreaChart width={chartWidth} height={170} data={chartData} accessibilityLayer={false} onClick={handleChartClick} margin={CHART_MARGIN}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis
                dataKey="time"
                orientation="top"
                height={30}
                tickFormatter={formatTickTime}
                stroke="var(--text-muted)"
                fontSize={TICK_FONT_SIZE}
                tickLine={false}
              />
              <YAxis {...axisProps} domain={[0, windAxisMax]} ticks={[0, Math.round(windAxisMax / 2), windAxisMax]} />
              {backdrops()}
              {windLimitsOn && <ReferenceArea y1={windSafe} y2={windDanger} fill={CAUTION_LINE} fillOpacity={WASH_OPACITY} strokeOpacity={0} />}
              {windLimitsOn && <ReferenceArea y1={windDanger} y2={windAxisMax} fill={DANGER_LINE} fillOpacity={WASH_OPACITY} strokeOpacity={0} />}
              {windLimitsOn && <ReferenceLine y={windSafe} stroke={CAUTION_LINE} strokeDasharray="5 4" />}
              {windLimitsOn && <ReferenceLine y={windDanger} stroke={DANGER_LINE} strokeDasharray="5 4" />}
              {gustLimitsOn && gustCeil !== windDanger && <ReferenceLine y={gustCeil} stroke={DANGER_LINE} strokeDasharray="2 4" />}
              <Area type="monotone" dataKey="gustBand" name="Gust spread" stroke="none" fill={SERIES.gust} fillOpacity={0.28} />
              <Line type="monotone" dataKey="windDisplay" name="Wind" stroke={SERIES.wind} dot={false} strokeWidth={2.5} />
            </AreaChart>
            {stickyRail(0, windAxisMax, 170 - CHART_MARGIN.top - 30, [0, Math.round(windAxisMax / 2), windAxisMax], [
              ...(windLimitsOn ? [{ value: windSafe, label: t('wind safe {0}', windSafe), tone: 'caution' as const }] : []),
              ...(windLimitsOn ? [{ value: windDanger, label: t(gustEnabled && gustCeil === windDanger ? 'wind/gust danger {0}' : 'wind danger {0}', windDanger), tone: 'danger' as const }] : []),
              ...(gustLimitsOn && gustCeil !== windDanger ? [{ value: gustCeil, label: t('gust danger {0}', gustCeil), tone: 'danger' as const }] : []),
            ], CHART_MARGIN.top + 30)}
          </div>

          {/* 2 — WAVES */}
          {inlineHeader(<Waves size={16} />, t('Waves'), activeMetric(
            <span className="tone-wave">{t('{0} m · period {1} s', activeItem.waveHeight.toFixed(2), activeItem.wavePeriod.toFixed(1))}</span>
          ))}
          <div className="chart-plot-wrap" style={{ width: `${chartWidth}px` }}>
            <AreaChart width={chartWidth} height={150} data={chartData} accessibilityLayer={false} onClick={handleChartClick} margin={CHART_MARGIN}>
              <defs>
                <linearGradient id="colorWave" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={SERIES.wave} stopOpacity={0.4} />
                  <stop offset="95%" stopColor={SERIES.wave} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="time" hide />
              <YAxis {...axisProps} domain={[0, waveAxisMax]} ticks={[0, waveAxisMax]} />
              {backdrops()}
              {waveLimitsOn && <ReferenceArea y1={waveDanger} y2={waveAxisMax} fill={DANGER_LINE} fillOpacity={WASH_OPACITY} strokeOpacity={0} />}
              {waveCautionOn && <ReferenceLine y={waveSafe} stroke={CAUTION_LINE} strokeDasharray="5 4" />}
              {waveLimitsOn && <ReferenceLine y={waveDanger} stroke={DANGER_LINE} strokeDasharray="5 4" />}
              <Area type="monotone" dataKey="waveDisplay" name="Wave height" stroke={SERIES.wave} fillOpacity={1} fill="url(#colorWave)" strokeWidth={2.5} />
            </AreaChart>
            {stickyRail(0, waveAxisMax, 150 - CHART_MARGIN.top, [0, waveAxisMax], [
              ...(waveCautionOn ? [{ value: waveSafe, label: t('wave safe {0}', waveSafe), tone: 'caution' as const }] : []),
              ...(waveLimitsOn ? [{ value: waveDanger, label: t('danger {0}', waveDanger), tone: 'danger' as const }] : []),
            ])}
          </div>

          {/* 3 — WATER LEVEL */}
          {inlineHeader(<ArrowDownUp size={16} />, t('Water level'), activeMetric(
            <span className="tone-tide">{activeItem.tideLevel > 0 ? '+' : ''}{activeItem.tideLevel.toFixed(2)} m</span>
          ))}
          <div className="chart-plot-wrap" style={{ width: `${chartWidth}px` }}>
            <AreaChart width={chartWidth} height={130} data={chartData} accessibilityLayer={false} onClick={handleChartClick} margin={CHART_MARGIN}>
              <defs>
                <linearGradient id="colorTide" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={SERIES.tide} stopOpacity={0.3} />
                  <stop offset="95%" stopColor={SERIES.tide} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="time" hide />
              <YAxis {...axisProps} domain={[tideAxisMin, tideAxisMax]} ticks={[tideAxisMin, 0, tideAxisMax]} />
              {backdrops()}
              <ReferenceLine y={0} stroke="var(--text-muted)" strokeDasharray="5 4" />
              <Area type="monotone" dataKey="tideDisplay" name="Water level" stroke={SERIES.tide} fillOpacity={1} fill="url(#colorTide)" strokeWidth={2.5} />
            </AreaChart>
            {stickyRail(tideAxisMin, tideAxisMax, 130 - CHART_MARGIN.top, [tideAxisMin, 0, tideAxisMax], [])}
          </div>

          {/* 4 — TEMPERATURE (carries the shared hour axis) */}
          {inlineHeader(<Thermometer size={16} />, t('Air & water temp'), activeMetric(
            <>
              <span className="chart-metric-air">{t('air {0}°', activeItem.tempAir.toFixed(1))}</span>
              {' · '}
              <span className="chart-metric-water">{t('water {0}°', activeItem.tempWater.toFixed(1))}</span>
            </>
          ))}
          <div className="chart-plot-wrap" style={{ width: `${chartWidth}px` }}>
            <ComposedChart width={chartWidth} height={150} data={chartData} accessibilityLayer={false} onClick={handleChartClick} margin={{ ...CHART_MARGIN, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={GRID_STROKE} />
              <XAxis dataKey="time" tickFormatter={formatTickTime} stroke="var(--text-muted)" fontSize={TICK_FONT_SIZE} tickLine={false} />
              <YAxis {...axisProps} domain={[tempAxisMin, tempAxisMax]} ticks={[tempAxisMin, Math.round((tempAxisMin + tempAxisMax) / 2), tempAxisMax]} />
              {backdrops()}
              {tempLimitsOn && <ReferenceArea y1={tempAxisMin} y2={tempDanger} fill={DANGER_LINE} fillOpacity={WASH_OPACITY} strokeOpacity={0} />}
              {tempLimitsOn && <ReferenceArea y1={tempDanger} y2={tempSafe} fill={CAUTION_LINE} fillOpacity={WASH_OPACITY} strokeOpacity={0} />}
              {tempLimitsOn && <ReferenceLine y={tempSafe} stroke={CAUTION_LINE} strokeDasharray="5 4" />}
              {tempLimitsOn && <ReferenceLine y={tempDanger} stroke={DANGER_LINE} strokeDasharray="5 4" />}
              <Line type="monotone" dataKey="tempDisplay" name="Air temp" stroke={SERIES.airTemp} dot={false} strokeWidth={2.5} />
              <Line type="monotone" dataKey="tempWaterDisplay" name="Water temp" stroke={SERIES.waterTemp} dot={false} strokeWidth={2.5} />
            </ComposedChart>
            {/* plot height excludes the visible bottom hour axis (30px) + 4px margin */}
            {stickyRail(tempAxisMin, tempAxisMax, 150 - CHART_MARGIN.top - 34, [tempAxisMin, Math.round((tempAxisMin + tempAxisMax) / 2), tempAxisMax], [
              ...(tempLimitsOn ? [{ value: tempSafe, label: t('water min {0}°', tempSafe), tone: 'caution' as const }] : []),
              ...(tempLimitsOn ? [{ value: tempDanger, label: t('danger below {0}°', tempDanger), tone: 'danger' as const }] : []),
            ])}
          </div>
        </div>
      </div>
    </div>
  );
});
