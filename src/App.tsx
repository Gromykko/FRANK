import { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import {
  ChartLine,
  RefreshCw,
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
import { getFrankPhrase } from './features/safety/frankPhrases';
import { useSettings } from './hooks/useSettings';
import { useTheme } from './hooks/useTheme';
import { useOnline } from './hooks/useOnline';
import { useLang } from './i18n';

import type { SafetySettings } from './hooks/useSettings';
import { CURRENT_LOCATION } from './config/locations';

const APP_VERSION = import.meta.env.VITE_APP_VERSION ?? '0.0.0';
const APP_BUILD_COMMIT = import.meta.env.VITE_APP_COMMIT ?? 'local';
const APP_BUILD_TIME = import.meta.env.VITE_APP_BUILD_TIME ?? '';
const WeatherCharts = lazy(() => import('./components/WeatherCharts'));

export default function App() {
  const [showDetailedCharts, setShowDetailedCharts] = useState(false);

  const { settings, saveSettings, setTripMode } = useSettings();
  const { themeMode, cycleThemeMode } = useTheme();
  const { t, lang } = useLang();
  const online = useOnline();
  const {
    weatherData,
    loading,
    refreshing,
    error,
    selectedHourIndex,
    setSelectedHourIndex,
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

    if (newSettings.daylightOnly && nextDisplayData[selectedHourIndex] && !nextDisplayData[selectedHourIndex].isDay) {
      const firstDaylight = nextDisplayData.findIndex((h, idx) => idx >= selectedHourIndex && h.isDay);
      if (firstDaylight !== -1) {
        setSelectedHourIndex(firstDaylight);
      }
    }
  };

  const allStatuses = useMemo(() => {
    if (displayHourlyData.length === 0) return [];
    return displayHourlyData.map((hour, idx) =>
      analyzeSafetyConditions(hour, settings, nextHourTideFor(displayHourlyData, idx), t).rating);
  }, [displayHourlyData, settings, t]);

  const launchWindows = useMemo(
    () =>
      findLaunchWindows(
        displayHourlyData,
        settings,
        nowIndex,
        weatherData ? { sunrise: weatherData.sunrise, sunset: weatherData.sunset } : undefined
      ),
    [displayHourlyData, settings, nowIndex, weatherData]
  );

  const handleTripModeChange = (mode: SafetySettings['tripMode']) => {
    setTripMode(mode);
  };

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
      <div className="loader-container error-screen">
        <AlertTriangle size={48} className="error-screen-icon" />
        <h2 className="error-screen-title">{t("Can't reach the forecast right now")}</h2>
        <p className="error-screen-text">{t(error)}</p>
        <button
          type="button"
          className="btn-control error-screen-retry"
          onClick={() => refreshForecast(true, true, true)}
        >
          <RefreshCw size={16} /> {t('Try Again')}
        </button>
      </div>
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
      <div className="loader-container error-screen">
        <AlertTriangle size={48} className="error-screen-icon" />
        <h2 className="error-screen-title">{t("Can't reach the forecast right now")}</h2>
        <p className="error-screen-text">{t('The forecast came back with no hours in it.')}</p>
        <button
          type="button"
          className="btn-control error-screen-retry"
          onClick={() => refreshForecast(true, true, true)}
        >
          <RefreshCw size={16} /> {t('Try Again')}
        </button>
      </div>
    );
  }

  const currentHourData = displayHourlyData[selectedHourIndex] ?? displayHourlyData[0];
  const safety = analyzeSafetyConditions(currentHourData, settings, nextHourTideFor(displayHourlyData, selectedHourIndex), t);
  const activeSafetyChecks = [
    settings.enableWindSpeed,
    settings.enableWindSpeed && settings.enableWindGust,
    settings.enableWaveHeight,
    settings.enableWaveHeight && settings.enableWaveCaution,
    settings.enableWaterTemp,
    settings.enableCustomWindDirs,
    settings.daylightOnly,
  ].some(Boolean);
  const safetyBadgeTitle = t(!activeSafetyChecks ? 'Weather' : RATING_WORD[safety.rating]);
  const safetyBadgeSubtitle = t(!activeSafetyChecks
    ? 'Limits are off — raw forecast only'
    : safety.rating === 'safe'
      ? 'Have fun out there'
      : safety.rating === 'caution'
        ? 'Keep an eye out'
        : 'Save it for another day');
  const safetyDisplayRating = activeSafetyChecks ? safety.rating : 'caution';
  const safetyReasons = activeSafetyChecks
    ? safety.reasons
    : [{ text: t('Your personal limits are off. Use the raw forecast values and local judgement before launching.'), severity: 'caution' as const }];

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
  const frankPhrase = activeSafetyChecks
    ? t(getFrankPhrase(safetyDisplayRating, selectedDateStr), waterWord)
    : t('Limits are off. You are the captain now');

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
  const {
    view: statusView,
    expandedDetail: cacheStatusExpandedDetail,
    failureDetail: cacheFailureDetail,
    showRefreshWarning: showCacheRefreshWarning,
    workerOutdated,
    forecastAgeLabel,
    checkedAt: cacheCheckedAt,
  } = deriveCacheStatus({
    sources: weatherData.sources,
    refreshing,
    online,
    nowMs: Date.now(),
    // Our own record of reaching the worker, not the worker's throttled stamp.
    workerContactedAtMs: getWorkerContactMs(),
  }, t);
  const { providerBusy, busyServiceName } = statusView;
  const cacheStatusClass = statusView.tone;
  const sourceLabel = statusView.label;
  const cacheStatusDetail = statusView.detail;
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
        cacheAriaLabel={`${sourceLabel}. ${cacheStatusExpandedDetail}.`}
        refreshing={refreshing}
        onRefresh={() => refreshForecast(false, true, true)}
        themeMode={themeMode}
        themeTitle={themeTitle}
        onToggleTheme={cycleThemeMode}
      />

      {/* Main Container */}
      <main className="container app-main">
        {/* Official DMI warning for the region — advisory, links out to DMI */}
        <WarningStripe warnings={weatherData.warnings} />
        {CURRENT_LOCATION.provisional && (
          <div className="forecast-warning provisional-note">
            <AlertTriangle size={15} />
            <span>{t('{0} is a provisional location — its wind sectors and caps are placeholders, not locally calibrated. Verify with a local paddler before trusting the verdict.', CURRENT_LOCATION.name)}</span>
          </div>
        )}
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
            {!online ? (
              // Offline needs its own sentence. The banner keys on DATA AGE, which
              // is right — a paddler on the water with a six-hour-old forecast
              // must be told, connection or not — but the "refresh keeps failing"
              // wording then contradicted the header one line above, which
              // correctly said "Offline". Nothing is failing; there is simply no
              // connection to try over.
              <span>{t('You have been offline for a while, so this forecast is from {0} — {1} old. Treat it with extra caution; it will update by itself once you are back online.', formatDateTime(weatherData.sources.fetchedAt), forecastAgeLabel)}</span>
            ) : providerBusy ? (
              <span>{t("{0} has been busy for a while, so the forecast hasn't updated since {1}. FRANK keeps retrying automatically — you are seeing the last good forecast.", busyServiceName, formatDateTime(weatherData.sources.fetchedAt))}</span>
            ) : (
              <span>{t('Forecast refresh keeps failing (last try {0}). You are seeing data from {1} — {2} old, so treat it with extra caution.{3} FRANK retries by itself roughly every 10 minutes.', formatDateTime(cacheCheckedAt), formatDateTime(weatherData.sources.fetchedAt), forecastAgeLabel, cacheFailureDetail)}</span>
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
          />

          {/* ⑤ Safety limits — customize thresholds (collapsed) */}
          <SafetyLimitsPanel
            settings={settings}
            updateSettings={handleUpdateSettings}
          />

          {/* ⑥ Detailed charts — power-user graphs (collapsed) */}
          <div className="panel charts-disclosure-section">
              {/* A real <button>, not a div with role/tabIndex and a
                  hand-rolled Enter/Space handler — the browser gives all of
                  that for free, and the hand-rolled version read `showDetailedCharts`
                  from a stale closure while the click path used the updater
                  form. Matches the sibling disclosure in SafetyLimitsPanel. */}
              <button
                type="button"
                className={`panel-collapse-header module-head ${showDetailedCharts ? 'is-open' : ''}`}
                onClick={() => setShowDetailedCharts((current) => !current)}
                aria-expanded={showDetailedCharts}
                aria-controls="charts-disclosure-body"
              >
                <span className="charts-disclosure-copy">
                  <h2 className="charts-disclosure-title">
                    <ChartLine size={16} color="var(--primary)" /> {t('Detailed Graphs')}
                  </h2>
                  <span className="charts-disclosure-subtitle">{t('Wind, waves, water level, and temperature')}</span>
                </span>
                <div className="settings-collapse-chevron">
                  {showDetailedCharts ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
                </div>
              </button>

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

        </div>
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <div className="container">
          <p className="footer-disclaimer">
            {t('Advisory only — FRANK does not replace official warnings, club rules, or your own look at the water. You are responsible for the decision to launch.')}
          </p>
          <p className="footer-text">
            {t('Weather data by MET Norway')} (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>){t(', waves & water by DMI ({0}) for {1}.', dmiModels, weatherData.sources.location?.areaName ?? CURRENT_LOCATION.areaName)}{weatherData.warnings?.length ? <> {t('Warnings by')} <a href="https://meteoalarm.org" target="_blank" rel="noreferrer">MeteoAlarm</a>/DMI (CC BY 4.0).</> : ''} {t('Forecast built {0}. Worker checked {1}.', formatDateTime(weatherData.sources.fetchedAt), formatDateTime(cacheCheckedAt))}
            <span className="footer-build">{appBuildLabel}</span>
          </p>
        </div>
      </footer>
    </>
  );
}
