import { useEffect, useRef, useState } from 'react';
import { RefreshCw, Waves } from 'lucide-react';
import { AVAILABLE_LOCATIONS, CURRENT_LOCATION, setLocation } from '../config/locations';
import { useForecastAvailability } from '../features/forecast/useForecastAvailability';
import type { ForecastInitializationState } from '../features/forecast/useForecast';
import { useLang } from '../i18n';
import { FlagDK, FlagUK } from './FlagIcons';
import PrivacyNotice from './PrivacyNotice';

interface ForecastInitializingScreenProps {
  initialization: ForecastInitializationState;
  refreshing: boolean;
  online: boolean;
  attemptMessage?: string | null;
  onRetry: () => void;
}

export default function ForecastInitializingScreen({
  initialization,
  refreshing,
  online,
  attemptMessage,
  onRetry,
}: ForecastInitializingScreenProps) {
  const { lang, setLang, t } = useLang();
  const { availability, settled } = useForecastAvailability(initialization.nextRetryAtMs);
  const [locationSwitchFailed, setLocationSwitchFailed] = useState(false);
  const [cooldownSeconds, setCooldownSeconds] = useState(0);
  const attemptedCurrentOpenRef = useRef(false);
  const availableIds = new Set(availability?.availableLocationIds ?? []);
  const readyLocations = AVAILABLE_LOCATIONS.filter(({ id }) => availableIds.has(id));
  const currentIsAvailable = availableIds.has(CURRENT_LOCATION.id);
  const hasKnownZeroAvailability = Boolean(availability && readyLocations.length === 0);
  const hasPartialAvailability = Boolean(
    availability && readyLocations.length > 0 && !currentIsAvailable,
  );

  useEffect(() => {
    if (cooldownSeconds <= 0) return;
    const interval = window.setInterval(() => {
      setCooldownSeconds((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(interval);
  }, [cooldownSeconds]);

  const handleRetry = () => {
    if (refreshing || cooldownSeconds > 0) return;
    setCooldownSeconds(5);
    onRetry();
  };

  // /health may notice that the selected location recovered before its next
  // scheduled forecast read. Open it once immediately; the ordinary lifecycle
  // remains responsible for all later Retry-After checks if an edge races.
  useEffect(() => {
    if (!currentIsAvailable) {
      attemptedCurrentOpenRef.current = false;
      return;
    }
    if (refreshing || attemptedCurrentOpenRef.current) return;
    attemptedCurrentOpenRef.current = true;
    onRetry();
  }, [currentIsAvailable, onRetry, refreshing]);

  const title = hasKnownZeroAvailability || (!settled && !availability)
    ? t('Forecasts are being prepared')
    : hasPartialAvailability || (settled && !availability)
      ? t('The forecast for {0} is being prepared', initialization.location.areaName)
      : t('Opening the forecast for {0}', initialization.location.areaName);

  const retryButtonDisabled = refreshing || cooldownSeconds > 0;

  return (
    <main className="container app-main initialization-page" aria-labelledby="initialization-title">
      <section className="panel initialization-card" aria-busy={refreshing || !settled}>
        <div className="initialization-header-row">
          <div className="initialization-header-spacer" aria-hidden="true" />
          <div className="initialization-progress" aria-hidden="true">
            <Waves size={20} strokeWidth={1.8} />
            <span>{t('Preparation in progress')}</span>
          </div>
          <div className="initialization-header-actions">
            <button
              type="button"
              className="header-icon-btn"
              onClick={() => setLang(lang === 'da' ? 'en' : 'da')}
              aria-label={t(lang === 'da' ? 'Switch to English' : 'Switch to Danish')}
            >
              {lang === 'da' ? <FlagDK /> : <FlagUK />}
            </button>
          </div>
        </div>

        <div className="initialization-status" role="status" aria-live="polite" aria-atomic="true">
          <p className="initialization-eyebrow">{t('Forecast data')}</p>
          <h1 className="initialization-title" id="initialization-title">{title}</h1>

          {hasKnownZeroAvailability ? (
            <p className="initialization-copy">
              {t('There is no complete forecast to show yet. Safety verdicts and launch windows stay hidden until forecast data is ready.')}
            </p>
          ) : hasPartialAvailability ? (
            <p className="initialization-copy">
              {t('{0} of {1} areas already have a complete forecast. You can open one now while FRANK prepares the others.', readyLocations.length, AVAILABLE_LOCATIONS.length)}
            </p>
          ) : currentIsAvailable ? (
            <p className="initialization-copy">
              {t('A complete forecast is available. FRANK is opening it now.')}
            </p>
          ) : (
            <p className="initialization-copy">
              {t('The selected forecast is not ready yet. Safety verdicts and launch windows stay hidden until complete data is available.')}
            </p>
          )}

          <p className="initialization-copy initialization-auto-retry">
            {t('FRANK checks again automatically. This screen updates as forecasts become available.')}
          </p>
          {!online && (
            <p className="initialization-note">
              {t("You're offline. FRANK will continue as soon as this device is back online.")}
            </p>
          )}
          {attemptMessage && online && (
            <p className="initialization-note">{t(attemptMessage)}</p>
          )}
        </div>

        <button
          type="button"
          className="initialization-retry"
          onClick={handleRetry}
          disabled={retryButtonDisabled}
        >
          <RefreshCw size={15} className={refreshing ? 'spin' : ''} aria-hidden="true" />
          <span>
            {refreshing
              ? t('Checking…')
              : cooldownSeconds > 0
                ? t('Check manually ({0}s)', cooldownSeconds)
                : t('Check manually')}
          </span>
        </button>

        {hasPartialAvailability && (
          <div className="initialization-ready" role="group" aria-label={t('Forecasts ready now')}>
            <span className="initialization-ready-label">{t('Forecasts ready now')}</span>
            <div className="initialization-ready-list">
              {readyLocations.map((location) => (
                <button
                  type="button"
                  className="initialization-ready-option"
                  key={location.id}
                  onClick={() => {
                    setLocationSwitchFailed(false);
                    if (!setLocation(location.id)) setLocationSwitchFailed(true);
                  }}
                >
                  <span>{location.areaName}</span>
                  <span className="initialization-ready-state">{t('ready')}</span>
                </button>
              ))}
            </div>
            {locationSwitchFailed && (
              <p className="initialization-note" role="alert">
                {t('FRANK could not save that location in this browser. Try again or check the browser’s site-data settings.')}
              </p>
            )}
          </div>
        )}
      </section>
      <PrivacyNotice />
    </main>
  );
}
