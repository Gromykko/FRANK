import { AlertTriangle, RefreshCw } from 'lucide-react';
import { CURRENT_LOCATION } from '../config/locations';
import { useLang } from '../i18n';
import LocationSwitcher from './LocationSwitcher';

interface ForecastErrorScreenProps {
  message: string;
  onRetry: () => void;
}

// Keep recovery choices together for every forecast failure state. In
// particular, an offline user who chose a location without a saved forecast
// must still be able to return to one whose cache is available.
export default function ForecastErrorScreen({ message, onRetry }: ForecastErrorScreenProps) {
  const { t } = useLang();

  return (
    <div className="loader-container error-screen">
      <div role="alert">
        <AlertTriangle size={48} className="error-screen-icon" />
        <h2 className="error-screen-title">{t("Can't reach the forecast right now")}</h2>
        <p className="error-screen-text">{t(message)}</p>
      </div>
      <button
        type="button"
        className="btn-control error-screen-retry"
        onClick={onRetry}
      >
        <RefreshCw size={16} /> {t('Try Again')}
      </button>
      <div className="error-screen-location" role="group" aria-label={t('Choose location')}>
        <span className="error-screen-location-copy">{t('Or choose another location:')}</span>
        <LocationSwitcher label={CURRENT_LOCATION.areaName} />
      </div>
    </div>
  );
}
