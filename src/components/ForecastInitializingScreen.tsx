import { RefreshCw, Waves } from 'lucide-react';
import { CURRENT_LOCATION } from '../config/locations';
import type { ForecastInitializationState } from '../features/forecast/useForecast';
import { useLang } from '../i18n';
import LocationSwitcher from './LocationSwitcher';

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
  const { t } = useLang();
  const retryMinutes = Math.max(
    1,
    Math.ceil((initialization.nextRetryAtMs - Date.now()) / 60_000),
  );

  return (
    <main className="container app-main initialization-page" aria-labelledby="initialization-title">
      <section className="panel initialization-card" aria-busy={refreshing}>
        <div className="initialization-mark" aria-hidden="true">
          <Waves size={28} strokeWidth={1.8} />
          <span className="initialization-pulse" />
        </div>

        <div className="initialization-status" role="status" aria-live="polite" aria-atomic="true">
          <p className="initialization-eyebrow">{t('First forecast')}</p>
          <h1 className="initialization-title" id="initialization-title">
            {t('Preparing the forecast for {0}', initialization.location.areaName)}
          </h1>
          <p className="initialization-copy">
            {t('FRANK is building the first complete forecast for {0}. Until it is ready, no safety verdict or launch windows are shown.', initialization.location.areaName)}
          </p>
          <p className="initialization-copy initialization-auto-retry">
            {t('FRANK checks again automatically. The next check is in about {0} min.', retryMinutes)}
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
          className="btn-control initialization-retry"
          onClick={onRetry}
          disabled={refreshing}
        >
          <RefreshCw
            size={17}
            className={refreshing ? 'initialization-retry-icon is-spinning' : 'initialization-retry-icon'}
            aria-hidden="true"
          />
          {t(refreshing ? 'Checking…' : 'Check now')}
        </button>

        <div className="initialization-location" role="group" aria-label={t('Choose location')}>
          <span className="initialization-location-copy">{t('Choose another location:')}</span>
          <LocationSwitcher label={CURRENT_LOCATION.areaName} currentState="initializing" />
        </div>
      </section>
    </main>
  );
}
