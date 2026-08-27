import { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import {
  ChartLine,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { analyzeSafetyConditions, RATING_WORD } from './features/safety/analyzeSafetyConditions';
import { getWeatherDescription } from './features/forecast/weatherCodes';
import { getDisplayHourlyData, nextHourTideFor } from './features/forecast/displayData';
import { deriveCacheStatus } from './features/forecast/cacheStatusView';
import { getWorkerContactMs } from './features/forecast/cache';
import { formatTime, formatDateTime, locationDateKey } from './utils/date';
import { compassPoint } from './utils/compass';
import { NO_READING_TEXT } from './utils/number';
import { findLaunchWindows } from './features/planner/findLaunchWindows';
import { useForecast } from './features/forecast/useForecast';
import TimelineBar from './components/TimelineBar';
import PaddlePlanner from './components/PaddlePlanner';
import SafetyLimitsPanel from './components/SafetyLimitsPanel';
import StatusBar from './components/StatusBar';
import ConditionsSnapshot from './components/ConditionsSnapshot';
import TripProfilePanel from './components/TripProfilePanel';
import WarningStripe from './components/WarningStripe';
import ErrorBoundary from './components/ErrorBoundary';
import ForecastErrorScreen from './components/ForecastErrorScreen';
import ForecastInitializingScreen from './components/ForecastInitializingScreen';
import PrivacyNotice from './components/PrivacyNotice';
import ForecastAttribution from './components/ForecastAttribution';
import { getFrankPhrase } from './features/safety/frankPhrases';
import {
  getSafetyDisplay,
  hasActiveSafetyChecks,
} from './features/safety/safetyDisplay';
import { useSettings } from './hooks/useSettings';
import { useTheme } from './hooks/useTheme';
import { useOnline } from './hooks/useOnline';
import { useLang } from './i18n';
import { requestPreparedAppReleaseCheck } from './pwa/releaseUpdate';

import type { SafetySettings } from './hooks/useSettings';
import { CURRENT_LOCATION } from './config/locations';

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0';
const APP_BUILD_COMMIT = import.meta.env.VITE_APP_COMMIT ?? 'local';
const APP_BUILD_TIME = import.meta.env.VITE_APP_BUILD_TIME ?? '';
const WeatherCharts = lazy(() => import('./components/WeatherCharts'));

export default function App() {
  const [showDetailedCharts, setShowDetailedCharts] = useState(false);

  const { settings, saveSettings, setTripMode, saveFailed } = useSettings();
  const { themeMode, cycleThemeMode } = useTheme();
  const { t, lang } = useLang();
  const online = useOnline();
  const {
    weatherData,
    loading,
    refreshing,
    checkState,
    error,
    initialization,
    selectedHourIndex,
    setSelectedHourIndex,
    nowMs,
    nowIndex,
    refreshForecast,
  } = useForecast(settings.daylightOnly);

  const displayHourlyData = useMemo(() => {
    return weatherData ? getDisplayHourlyData(weatherData) : [];
  }, [weatherData]);

  useEffect(() => {
    if (displayHourlyData.length === 0) return;
    if (selectedHourIndex >= displayHourlyData.length) {
      setSelectedHourIndex(displayHourlyData.length - 1);
    }
  }, [displayHourlyData.length, selectedHourIndex, setSelectedHourIndex]);

  const handleUpdateSettings = (newSettings: SafetySettings) => {
    saveSettings(newSettings);
    if (!weatherData) return;

    // Same transform as the memoized displayHourlyData (it doesn't depend on
    // settings), so reuse it rather than recomputing the filtered array.
    const nextDisplayData = displayHourlyData;
    if (selectedHourIndex >= nextDisplayData.length) {
      setSelectedHourIndex(Math.max(0, nextDisplayData.length - 1));
      return;
    }

    if (
      newSettings.daylightOnly &&
      nextDisplayData[selectedHourIndex] &&
      !nextDisplayData[selectedHourIndex].blockSpanHours &&
      !nextDisplayData[selectedHourIndex].isDay
    ) {
      const firstDaylight = nextDisplayData.findIndex((h, idx) => idx >= selectedHourIndex && h.isDay);
      if (firstDaylight !== -1) {
        setSelectedHourIndex(firstDaylight);
      }
    }
  };

  const sunTimes = useMemo(
    () => weatherData
      ? { sunrise: weatherData.sunrise, sunset: weatherData.sunset }
      : undefined,
    [weatherData],
  );

  // One canonical analysis per displayed row. The timeline/matrix and selected
  // snapshot must consume these same objects; independently re-running safety
  // logic previously let a block show one verdict in the matrix and another in
  // its detail card when daylight context differed.
  const allAnalyses = useMemo(() => {
    if (displayHourlyData.length === 0) return [];
    return displayHourlyData.map((hour, idx) =>
      analyzeSafetyConditions(
        hour,
        settings,
        nextHourTideFor(displayHourlyData, idx),
        t,
        { blockDaylight: { mode: 'whole-period', sun: sunTimes } },
      ));
  }, [displayHourlyData, settings, sunTimes, t]);

  // Through the same transform the header uses. Reading `analysis.rating` raw
  // here let the timeline paint a green cell, and the planner recommend a
  // launch window, for an hour the header was calling "limits are off, raw
  // forecast only" - the disclosure existed but stopped at one row.
  const allStatuses = useMemo(() => {
    const active = hasActiveSafetyChecks(settings);
    return allAnalyses.map((analysis) => getSafetyDisplay(analysis, active, '').rating);
  }, [allAnalyses, settings]);

  const launchWindows = useMemo(
    () =>
      findLaunchWindows(
        displayHourlyData,
        settings,
        nowIndex,
        sunTimes,
        nowMs,
      ),
    [displayHourlyData, settings, nowIndex, sunTimes, nowMs]
  );

  const handleTripModeChange = (mode: SafetySettings['tripMode']) => {
    setTripMode(mode);
  };

  if (initialization && !weatherData) {
    return (
      <ForecastInitializingScreen
        initialization={initialization}
        refreshing={refreshing}
        online={online}
        attemptMessage={error}
        onRetry={() => refreshForecast(false, true)}
      />
    );
  }

  if (loading) {
    return (
      <div className="loader-container">
        <div className="spinner"></div>
        <div className="loader-text">{t('Analysing {0} marine forecast...', CURRENT_LOCATION.areaName)}</div>
      </div>
    );
  }

  if (error && !weatherData) {
    return (
      <ForecastErrorScreen
        message={error}
        onRetry={() => refreshForecast(true, true, true)}
      />
    );
  }

  if (!weatherData) {
    return (
      <div className="loader-container">
        <div className="spinner"></div>
        <div className="loader-text">{t('Preparing forecast dashboard...')}</div>
      </div>
    );
  }

  // A payload with no hours is not something the dashboard can render — every
  // panel below reads the selected hour. The old third fallback here
  // (weatherData.hourly[0]) could never help: displayHourlyData is a 1:1 map of
  // weatherData.hourly, so it is empty exactly when that is.
  if (displayHourlyData.length === 0) {
    return (
      <ForecastErrorScreen
        message="The forecast came back with no hours in it."
        onRetry={() => refreshForecast(true, true, true)}
      />
    );
  }

  const currentHourData = displayHourlyData[selectedHourIndex] ?? displayHourlyData[0];
  const safety = allAnalyses[selectedHourIndex] ?? allAnalyses[0]!;
  const activeSafetyChecks = hasActiveSafetyChecks(settings);
  const safetyDisplay = getSafetyDisplay(
    safety,
    activeSafetyChecks,
    t('Your personal limits are off. Use the raw forecast values and local judgement before launching.'),
  );
  const {
    rating: safetyDisplayRating,
  } = safetyDisplay;
  // Narrow on the rating rather than the flag: 'none' IS the no-verdict state,
  // so this is both the honest source of truth and what lets TypeScript prove
  // the other branches only ever see a real verdict.
  const noVerdict = safetyDisplayRating === 'none';
  // "Weather mode", not "Weather": on the glass this sits where a verdict
  // normally does, and one word there reads as a reading rather than as the
  // state the app has been put into.
  const safetyBadgeTitle = t(noVerdict ? 'Weather mode' : RATING_WORD[safetyDisplayRating]);
  const safetyBadgeSubtitle = t(noVerdict
    ? 'Limits are off — raw forecast only'
    : safetyDisplayRating === 'safe'
      ? 'Have fun out there'
      : safetyDisplayRating === 'caution'
        ? 'Keep an eye out'
        : 'Save it for another day');

  // Find daily sunrise and sunset for the selected hour's date
  const selectedDateStr = locationDateKey(currentHourData.time);
  const dayIndex = weatherData.sunrise.findIndex(s => locationDateKey(s) === selectedDateStr);
  const currentSunrise = dayIndex !== -1 ? weatherData.sunrise[dayIndex] : weatherData.sunrise[0];
  const currentSunset = dayIndex !== -1 ? weatherData.sunset[dayIndex] : weatherData.sunset[0];

  // FRANK's one-liner on the device display — stable for a given day + rating
  // so it doesn't reshuffle while scrubbing hours within the same verdict. The
  // {0} in some phrases is this location's water-body word, so Aarhus Bugt is
  // never called a fjord. English translates it ("bay"); Danish uses the
  // definite form ("Fjorden"/"Bugten").
  const isBugt = CURRENT_LOCATION.areaName.toLowerCase().includes('bugt');
  const waterWord = lang === 'da' ? (isBugt ? 'Bugten' : 'Fjorden') : (isBugt ? 'bay' : 'fjord');
  const frankPhrase = noVerdict
    ? t('Off duty. You are the captain now')
    : t(getFrankPhrase(safetyDisplayRating, selectedDateStr), waterWord);

  // Sunrise/sunset can legitimately be absent (polar edge cases) — guard the
  // empty string; the date utils themselves take ISO strings directly.
  const formatSunTime = (isoStr: string) => (isoStr ? formatTime(isoStr) : '');

  // A missing wind direction must not become `rotate(NaNdeg)` or "NaN°" — and
  // it must not become 0 either. Zero is a real bearing (wind from due north),
  // so the fallback drew a crisp, confident arrow beside a label that honestly
  // read "–". null means "draw no arrow".
  const windRotation = Number.isFinite(currentHourData.windDirection)
    ? Math.round(currentHourData.windDirection)
    : null;
  const weatherDesc = t(getWeatherDescription(currentHourData.weatherCode));

  const formatWindDirection = (degrees: number) =>
    Number.isFinite(degrees) ? `${Math.round(degrees) % 360}° ${t(compassPoint(degrees))}` : NO_READING_TEXT;

  // All cache-status derivation (header line, expanded detail, page warnings)
  // lives in the pure, unit-tested cacheStatusView helper. Date.now() is
  // re-read each render — useForecast's 60s heartbeat keeps age labels fresh.
  const presentationNowMs = Date.now();
  const {
    view: statusView,
    expandedDetail: cacheStatusExpandedDetail,
    showRefreshWarning: showCacheRefreshWarning,
    workerOutdated,
    forecastAgeLabel,
    refreshFailureConfirmed,
  } = deriveCacheStatus({
    sources: weatherData.sources,
    refreshing,
    online,
    nowMs: presentationNowMs,
    // Our own record of reaching the worker, not the worker's throttled stamp.
    workerContactedAtMs: getWorkerContactMs(),
    checkState,
  }, t);
  const safetyReasons = safetyDisplay.reasons;
  const cacheStatusClass = statusView.tone;
  const sourceLabel = statusView.label;
  const cacheStatusDetail = statusView.detail;
  // The labelled group exposes the exact visible state, including relative age
  // and a delayed source. Its live announcement uses the stable absolute-time
  // sentence instead, so the minute heartbeat does not repeatedly speak.
  const cacheAriaLabel = `${[sourceLabel, cacheStatusDetail]
    .filter(Boolean)
    .join('. ')
    .replace(/[.!?…]+$/u, '')}.`;
  const cacheAnnouncement = `${cacheStatusExpandedDetail.replace(/[.!?…]+$/u, '')}.`;
  // One attribution per provider: MET carries the license, DMI lists the
  // marine models in parentheses.
  const dmiModels = [weatherData.sources.waves, weatherData.sources.water]
    .filter((source): source is string => Boolean(source))
    .map((source) => source.replace(/^DMI\s+/, ''))
    .join(', ');
  const themeTitle = t(themeMode === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
  const appBuildLabel = `App v${APP_VERSION} · ${APP_BUILD_COMMIT}${APP_BUILD_TIME ? ` · ${t('built {0}', formatDateTime(APP_BUILD_TIME))}` : ''}`;

  return (
    <>
      <h1 className="sr-only">FRANK — Fjord Risk Assessment &amp; Navigation Kit</h1>

      {/* Sticky status bar — the 1-second answer, always visible */}
      <StatusBar
        rating={safetyDisplayRating}
        phrase={frankPhrase}
        srTitle={safetyBadgeTitle}
        srSubtitle={safetyBadgeSubtitle}
        location={CURRENT_LOCATION.subtitle}
        sourceLabel={sourceLabel}
        cacheDetail={cacheStatusDetail}
        cacheClass={cacheStatusClass}
        cacheAriaLabel={cacheAriaLabel}
        cacheAnnouncement={cacheAnnouncement}
        refreshing={refreshing}
        onRefresh={() => {
          void requestPreparedAppReleaseCheck();
          void refreshForecast(false, true, true);
        }}
        themeMode={themeMode}
        themeTitle={themeTitle}
        onToggleTheme={cycleThemeMode}
      />

      {/* Main Container */}
      <main className="container app-main">
        {/* Official DMI warning for the region — advisory, links out to DMI */}
        <WarningStripe warnings={weatherData.warnings} />
        {error && (
          <div className="forecast-warning" role="alert">
            <AlertTriangle size={15} />
            <span>{t(error)}</span>
          </div>
        )}
        {workerOutdated && (
          <div className="forecast-warning" role="alert">
            <AlertTriangle size={15} />
            <span>{t('The forecast is briefly out of date while FRANK updates behind the scenes. Please check back in a few minutes.')}</span>
          </div>
        )}
        {showCacheRefreshWarning && (
          <div className="forecast-warning" role="alert">
            <AlertTriangle size={15} />
            {!forecastAgeLabel ? (
              <span>{t('The saved forecast time could not be verified. Treat it with extra caution and check an official source before launching.')}</span>
            ) : !online ? (
              // Offline needs its own sentence. The banner keys on DATA AGE, which
              // is right — a paddler on the water with a six-hour-old forecast
              // must be told, connection or not — but the "refresh keeps failing"
              // wording then contradicted the header one line above, which
              // correctly said "Offline". Nothing is failing; there is simply no
              // connection to try over.
              <span>{t('You have been offline for a while, so this forecast is from {0} — {1} old. Treat it with extra caution; it will update by itself once you are back online.', formatDateTime(weatherData.sources.fetchedAt), forecastAgeLabel)}</span>
            ) : refreshFailureConfirmed ? (
              <span>{t('The forecast could not be refreshed. You are seeing data from {0} — {1} old, so treat it with extra caution. FRANK retries by itself roughly every 10 minutes.', formatDateTime(weatherData.sources.fetchedAt), forecastAgeLabel)}</span>
            ) : (
              <span>{t('This forecast has not updated as expected. You are seeing data from {0} — {1} old, so treat it with extra caution while FRANK checks again.', formatDateTime(weatherData.sources.fetchedAt), forecastAgeLabel)}</span>
            )}
          </div>
        )}
        <div className="app-sections">

          {/* Trip profile — the input that frames every reading below */}
          <TripProfilePanel
            tripMode={settings.tripMode}
            onTripModeChange={handleTripModeChange}
          />

          {/* ② Conditions snapshot — the at-a-glance card + safety reasons */}
          <ConditionsSnapshot
            data={currentHourData}
            weatherDesc={weatherDesc}
            windDirectionLabel={formatWindDirection(currentHourData.windDirection)}
            windRotation={windRotation}
            sunrise={formatSunTime(currentSunrise)}
            sunset={formatSunTime(currentSunset)}
            reasons={safetyReasons}
            rating={safetyDisplayRating}
          />

          {/* ③ Meteogram — the core data instrument (promoted) */}
          <div className="panel timeline-slider-panel" role="region" aria-label={t('Hourly forecast timeline')}>
            <TimelineBar
              data={displayHourlyData}
              statuses={allStatuses}
              selectedIndex={selectedHourIndex}
              onSelectIndex={setSelectedHourIndex}
              startIndex={nowIndex}
            />
          </div>

          {/* ④ Launch windows — "when can I go?" */}
          <PaddlePlanner
            data={displayHourlyData}
            statuses={allStatuses}
            windows={launchWindows}
            warnings={weatherData.warnings}
            sunrises={weatherData.sunrise}
            sunsets={weatherData.sunset}
            onSelectIndex={setSelectedHourIndex}
            startIndex={nowIndex}
            limitsOff={!activeSafetyChecks}
            minDuration={settings.minDuration}
            waterLevelFiltered={settings.tidePreference !== 'any'}
          />

          {/* ⑤ Safety limits — customize thresholds (collapsed) */}
          <SafetyLimitsPanel
            settings={settings}
            updateSettings={handleUpdateSettings}
            saveFailed={saveFailed}
          />

          {/* ⑥ Detailed charts — power-user graphs (collapsed) */}
          <div className="panel charts-disclosure-section">
              {/* One full-row native control inside its heading: valid
                  h2 > button markup, and the pointer/keyboard hit areas are
                  identical rather than splitting the row across two controls. */}
              <h2 className="charts-disclosure-heading">
                <button
                  type="button"
                  className={`panel-collapse-header module-head ${showDetailedCharts ? 'is-open' : ''}`}
                  onClick={() => setShowDetailedCharts((current) => !current)}
                  aria-expanded={showDetailedCharts}
                  aria-controls="charts-disclosure-body"
                >
                  <span className="charts-disclosure-copy">
                    <span className="charts-disclosure-title">
                      <ChartLine size={16} color="var(--primary)" /> {t('Detailed Graphs')}
                    </span>
                    <span className="charts-disclosure-subtitle">{t('Wind, waves, water level, and temperature')}</span>
                  </span>
                  <span className="settings-collapse-chevron" aria-hidden="true">
                    {showDetailedCharts ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                  </span>
                </button>
              </h2>

              {showDetailedCharts && (
                <div className="charts-disclosure-body" id="charts-disclosure-body">
                  {/* Scoped boundary: React.lazy REJECTS (not just suspends) when
                      a hashed chunk 404s after a redeploy, so without this an
                      optional power-user panel would take the safety verdict,
                      the timeline and the launch windows down with it. */}
                  <ErrorBoundary fallback={<div className="chart-panel chart-loading">{t('Charts are unavailable right now. The forecast above is unaffected.')}</div>}>
                    <Suspense fallback={<div className="chart-panel chart-loading">{t('Loading charts...')}</div>}>
                      <WeatherCharts
                        data={displayHourlyData}
                        settings={settings}
                        selectedIndex={selectedHourIndex}
                        onSelectIndex={setSelectedHourIndex}
                        startIndex={nowIndex}
                      />
                    </Suspense>
                  </ErrorBoundary>
                </div>
              )}
          </div>

          {/* Footer Panel */}
          <footer className="panel app-footer">
            <p className="footer-disclaimer">
              {t('Advisory only — FRANK does not replace official warnings, club rules, or your own look at the water. You are responsible for the decision to launch.')}
            </p>
            <ForecastAttribution
              dmiModels={dmiModels}
              areaName={weatherData.sources.location?.areaName ?? CURRENT_LOCATION.areaName}
              hasWarnings={Boolean(weatherData.warnings?.length)}
            />
            <PrivacyNotice
              buildLabel={appBuildLabel}
              builtAt={formatDateTime(weatherData.sources.fetchedAt)}
            />
          </footer>
        </div>
      </main>
    </>
  );
}
