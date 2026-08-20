import { useState } from 'react';
import { useLang } from '../i18n';
import { clearFrankLocalDataAndReload } from '../utils/storage';

const TECHNICAL_SOURCES = {
  githubPages: 'https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection',
  cloudflareHeaders: 'https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests',
  cloudflareLogs: 'https://developers.cloudflare.com/workers/observability/logs/workers-logs/#pricing',
  met: 'https://www.met.no/en/About-us/privacy',
  dmi: 'https://www.dmi.dk/friedata/guides-til-frie-data/vilkar-for-brug-af-data',
  meteoAlarm: 'https://api.meteoalarm.org/privacy',
} as const;

export default function PrivacyNotice() {
  const { t } = useLang();
  const [deleteState, setDeleteState] = useState<'idle' | 'confirm' | 'error'>('idle');

  const deleteLocalData = () => {
    if (deleteState === 'idle') {
      setDeleteState('confirm');
      return;
    }

    try {
      clearFrankLocalDataAndReload();
    } catch {
      // A privacy mode or browser policy can block storage access. Keep a
      // retry available and point to the browser's own site-data controls.
      setDeleteState('error');
    }
  };

  return (
    <details className="footer-details privacy-details">
      <summary>{t('Technical data note')}</summary>
      <div className="privacy-copy">
        <p>
          {t('This is a factual note about the app’s current technical behaviour. It is not a complete legal privacy notice: the operator still needs to publish verified identity and contact details before presenting it as one.')}
        </p>
        <p>
          {t('FRANK has no account system and does not request your device’s GPS position. The app code sets no cookies and adds no advertising tracker or separate product-analytics service. Your chosen area, language, theme, safety limits, and latest forecast are stored in this browser for preferences and offline use. Language, theme, safety limits, and the cached forecast stay in the browser; the selected forecast area is sent with forecast requests.')}
        </p>
        <p>
          {t('GitHub Pages serves the app files and logs visitor IP addresses for security. Cloudflare serves the forecast API and receives the requested forecast area and ordinary connection data such as IP address, HTTP/browser information, and time. Cloudflare also provides operational service metrics. FRANK’s custom Worker logs may record the forecast area and failures when service events occur; automatic request-and-response invocation logs are disabled. Cloudflare retains Workers Logs for 3 days on Free plans and 7 days on paid plans.')}
        </p>
        <p>
          {t('When a visitor request must build new forecast data, the Cloudflare Worker contacts MET Norway, DMI, and MeteoAlarm with FRANK’s fixed forecast coordinates. For destinations that are not Cloudflare customer zones, Cloudflare documents that these subrequests also carry visitor-IP headers, so a provider can receive the visitor IP address. This does not use your device GPS or send FRANK’s saved language, theme, or safety limits. Scheduled refreshes are not tied to a visitor.')}
        </p>
        <p>
          {t('The local values remain until you delete them below or clear browser site data. GitHub and the weather providers apply the retention periods in their own published terms.')}
        </p>
        <p className="privacy-sources">
          {t('Technical sources:')}{' '}
          <a href={TECHNICAL_SOURCES.githubPages} target="_blank" rel="noreferrer">GitHub Pages</a>
          {' · '}
          <a href={TECHNICAL_SOURCES.cloudflareHeaders} target="_blank" rel="noreferrer">Cloudflare {t('headers')}</a>
          {' · '}
          <a href={TECHNICAL_SOURCES.cloudflareLogs} target="_blank" rel="noreferrer">Cloudflare {t('logs')}</a>
          {' · '}
          <a href={TECHNICAL_SOURCES.met} target="_blank" rel="noreferrer">MET Norway</a>
          {' · '}
          <a href={TECHNICAL_SOURCES.dmi} target="_blank" rel="noreferrer">DMI</a>
          {' · '}
          <a href={TECHNICAL_SOURCES.meteoAlarm} target="_blank" rel="noreferrer">MeteoAlarm</a>
        </p>
        <button
          type="button"
          className="privacy-delete"
          onClick={deleteLocalData}
        >
          {t(deleteState === 'idle'
            ? 'Delete saved choices and forecasts'
            : deleteState === 'confirm'
              ? 'Tap again to delete and reload'
              : 'Try deleting local data again')}
        </button>
        <p className="privacy-delete-note" role="status" aria-live="polite">
          {deleteState === 'confirm'
            ? t('This removes FRANK’s saved settings and offline forecast from this browser, then reloads immediately with the defaults.')
            : deleteState === 'error'
              ? t('FRANK could not access browser storage. Try again, or use your browser’s site-data controls.')
              : ''}
        </p>
      </div>
    </details>
  );
}
