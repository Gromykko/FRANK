import { AlertTriangle, RefreshCw } from 'lucide-react';
import { CURRENT_LOCATION } from '../config/locations';
import { useLang } from '../i18n';
import { FlagDK, FlagUK } from './FlagIcons';
import LocationSwitcher from './LocationSwitcher';
import PrivacyNotice from './PrivacyNotice';

interface ForecastErrorScreenProps {
  message: string;
  onRetry: () => void;
}

// Keep recovery choices together for every forecast failure state. In
// particular, an offline user who chose a location without a saved forecast
// must still be able to return to one whose cache is available.
export default function ForecastErrorScreen({ message, onRetry }: ForecastErrorScreenProps) {
  const { lang, setLang, t } = useLang();

  return (
    <div className="loader-container error-screen">
      <div className="error-screen-top-bar">
        <button
          type="button"
          className="header-icon-btn"
          onClick={() => setLang(lang === 'da' ? 'en' : 'da')}
          aria-label={t(lang === 'da' ? 'Switch to English' : 'Switch to Danish')}
        >
          {lang === 'da' ? <FlagDK /> : <FlagUK />}
        </button>
      </div>
      <div role="alert">
        <AlertTriangle size={48} className="error-screen-icon" />
        <h1 className="error-screen-title">{t("Can't reach the forecast right now")}</h1>
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
      <PrivacyNotice />
    </div>
  );
}
