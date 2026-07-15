import { lazy, Suspense, useState, useEffect, useMemo } from 'react';
import {
  ChartLine,
  RefreshCw,
  AlertTriangle,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { analyzeSafetyConditions } from './features/safety/analyzeSafetyConditions';
import { getWeatherDescription } from './features/forecast/weatherCodes';
import { getDisplayHourlyData } from './features/forecast/displayData';
import { deriveCacheStatus } from './features/forecast/cacheStatusView';
import { formatTime, formatDateTime, locationDateKey } from './utils/date';
import { compassPoint } from './utils/compass';
import { findLaunchWindows } from './features/planner/findLaunchWindows';
import { useForecast } from './features/forecast/useForecast';
import TimelineBar from './components/TimelineBar';
import PaddlePlanner from './components/PaddlePlanner';
import SafetyLimitsPanel from './components/SafetyLimitsPanel';
import StatusBar from './components/StatusBar';
import ConditionsSnapshot from './components/ConditionsSnapshot';
import TripProfilePanel from './components/TripProfilePanel';
import WarningStripe from './components/WarningStripe';
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
    return displayHourlyData.map((hour, idx) => {
      const nextHour = displayHourlyData[idx + 1];
      return analyzeSafetyConditions(hour, settings, nextHour ? nextHour.tideLevel : undefined, t).rating;
    });
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

  const currentHourData = displayHourlyData[selectedHourIndex] ?? displayHourlyData[0] ?? weatherData.hourly[0];
  const nextHourData = displayHourlyData[selectedHourIndex + 1];
  const safety = analyzeSafetyConditions(currentHourData, settings, nextHourData ? nextHourData.tideLevel : undefined, t);
  const activeSafetyChecks = [
    settings.enableWindSpeed,
    settings.enableWindSpeed && settings.enableWindGust,
    settings.enableWaveHeight,
    settings.enableWaveHeight && settings.enableWaveCaution,
    settings.enableWaterTemp,
    settings.enableCustomWindDirs,
    settings.daylightOnly,
  ].some(Boolean);
  const safetyBadgeTitle = t(!activeSafetyChecks
    ? 'Weather'
    : safety.rating === 'safe'
      ? 'Good to go'
      : safety.rating === 'caution'
        ? 'Take care'
        : 'Rough');
  const safetyBadgeSubtitle = t(!activeSafetyChecks
    ? 'Limits are off — raw forecast only'
    : safety.rating === 'safe'
      ? 'Have fun out there'
      : safety.rating === 'caution'
        ? 'Keep an eye out'
        : 'Maybe skip today');
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
  // never called a fjord (definite form in Danish: "Fjorden"/"Bugten").
  const isBugt = CURRENT_LOCATION.areaName.toLowerCase().includes('bugt');
  const waterWord = lang === 'da' ? (isBugt ? 'Bugten' : 'Fjorden') : (isBugt ? 'bugt' : 'fjord');
  const frankPhrase = activeSafetyChecks
    ? t(getFrankPhrase(safetyDisplayRating, selectedDateStr), waterWord)
    : t('Limits are off. You are the captain now');

  // Sunrise/sunset can legitimately be absent (polar edge cases) — guard the
  // empty string; the date utils themselves take ISO strings directly.
  const formatSunTime = (isoStr: string) => (isoStr ? formatTime(isoStr) : '');

  const windRotation = Math.round(currentHourData.windDirection);
  const weatherDesc = t(getWeatherDescription(currentHourData.weatherCode));

  const formatWindDirection = (degrees: number) =>
    `${Math.round(degrees)}° ${t(compassPoint(degrees))}`;

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
          <div className="forecast-warning">
            <AlertTriangle size={15} />
            <span>{t(error)}</span>
          </div>
        )}
        {workerOutdated && (
          <div className="forecast-warning">
            <AlertTriangle size={15} />
            <span>{t('The forecast is briefly out of date while FRANK updates behind the scenes. Please check back in a few minutes.')}</span>
          </div>
        )}
        {showCacheRefreshWarning && (
          <div className="forecast-warning">
            <AlertTriangle size={15} />
            {providerBusy ? (
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
              <div
                className={`panel-collapse-header module-head ${showDetailedCharts ? 'is-open' : ''}`}
                onClick={() => setShowDetailedCharts((current) => !current)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setShowDetailedCharts(!showDetailedCharts);
                  }
                }}
                role="button"
                tabIndex={0}
                aria-expanded={showDetailedCharts}
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
              </div>

              {showDetailedCharts && (
                <div className="charts-disclosure-body">
                  <Suspense fallback={<div className="chart-panel chart-loading">{t('Loading charts...')}</div>}>
                    <WeatherCharts
                      data={displayHourlyData}
                      settings={settings}
                      selectedIndex={selectedHourIndex}
                      onSelectIndex={setSelectedHourIndex}
                      startIndex={nowIndex}
                    />
                  </Suspense>
                </div>
              )}
          </div>

        </div>
      </main>

      {/* Footer */}
      <footer className="app-footer">
        <div className="container">
          <p className="footer-text">
            {t('Weather data by MET Norway')} (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>){t(', waves & water by DMI ({0}) for {1}.', dmiModels, weatherData.sources.location?.areaName ?? CURRENT_LOCATION.areaName)}{weatherData.warnings ? <> {t('Warnings by')} <a href="https://meteoalarm.org" target="_blank" rel="noreferrer">MeteoAlarm</a>/DMI (CC BY 4.0).</> : ''} {t('Forecast built {0}. Worker checked {1}.', formatDateTime(weatherData.sources.fetchedAt), formatDateTime(cacheCheckedAt))}
            <span className="footer-build">{appBuildLabel}</span>
          </p>
        </div>
      </footer>
    </>
  );
}
