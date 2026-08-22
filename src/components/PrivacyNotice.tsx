import { useState } from 'react';
import { useLang } from '../i18n';
import { clearFrankLocalDataAndReload } from '../utils/storage';

const TECHNICAL_SOURCES = {
  githubPages: 'https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection',
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
          {t('FRANK has no user accounts, sets no cookies, does not track your GPS, and includes no advertising or analytics trackers. Your chosen location, safety limits, and offline forecasts are stored strictly in this browser.')}
        </p>
        <p>
          {t('Forecast data is provided by MET Norway, DMI, and MeteoAlarm, served securely via Cloudflare and GitHub Pages.')}
        </p>
        <p className="privacy-sources">
          {t('Technical sources:')}{' '}
          <a href={TECHNICAL_SOURCES.githubPages} target="_blank" rel="noreferrer">GitHub Pages</a>
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
