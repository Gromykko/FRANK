import { useLang } from '../i18n';

interface ForecastAttributionProps {
  dmiModels: string;
  areaName: string;
  hasWarnings: boolean;
}

// Keep every forecast-provider credit in this one visible block. The privacy
// panel below links to provider policies, but deliberately does not repeat the
// attribution copy.
export default function ForecastAttribution({
  dmiModels,
  areaName,
  hasWarnings,
}: ForecastAttributionProps) {
  const { t } = useLang();

  return (
    <>
      <p className="footer-text">
        {t('Weather data by MET Norway')} (<a href="https://creativecommons.org/licenses/by/4.0/" target="_blank" rel="noreferrer">CC BY 4.0</a>)
        {t(', waves & water by DMI ({0}) for {1}.', dmiModels, areaName)}
        {hasWarnings ? (
          <> {t('Warnings by')} <a href="https://meteoalarm.org" target="_blank" rel="noreferrer">MeteoAlarm</a>/DMI (CC BY 4.0).</>
        ) : null}
      </p>
      {hasWarnings ? (
        <p className="footer-text meteoalarm-delay-disclaimer">
          {t('Time delays between this website and the http://www.meteoalarm.org website are possible. For the most up-to-date awareness information as published by the participating National Meteorological and Hydrological Services, please refer to http://www.meteoalarm.org.')}
        </p>
      ) : null}
    </>
  );
}
