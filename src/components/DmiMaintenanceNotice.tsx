import { AlertTriangle, ChevronDown } from 'lucide-react';
import { useLang } from '../i18n';
import { shouldShowDmiMaintenanceNotice } from './dmiMaintenanceNoticePolicy';

import type { WeatherData } from '../features/forecast/types';

type CacheHealth = WeatherData['sources']['cacheHealth'];

const DMI_MAINTENANCE_URL = 'https://www.dmi.dk/friedata/dokumentation-paa-engelsk';

interface DmiMaintenanceNoticeProps {
  cacheHealth: CacheHealth;
  nowMs: number;
  online: boolean;
  refreshFailureConfirmed: boolean;
}

export default function DmiMaintenanceNotice({
  cacheHealth,
  nowMs,
  online,
  refreshFailureConfirmed,
}: DmiMaintenanceNoticeProps) {
  const { t } = useLang();

  if (!shouldShowDmiMaintenanceNotice(
    cacheHealth,
    nowMs,
    online,
    refreshFailureConfirmed,
  )) return null;

  return (
    <details className="provider-maintenance-notice">
      <summary>
        <AlertTriangle size={15} aria-hidden="true" />
        <span>{t('DMI maintenance may delay wave and water-level forecasts')}</span>
        <ChevronDown className="provider-maintenance-chevron" size={16} aria-hidden="true" />
      </summary>
      <div className="provider-maintenance-notice-body">
        <p>
          {t('DMI says maintenance at its supercomputer provider may delay wave and water-level forecasts from 31 August through 10 September. FRANK keeps the latest complete forecast and checks again automatically. Check the forecast age before you launch.')}
        </p>
        <a href={DMI_MAINTENANCE_URL} target="_blank" rel="noreferrer">
          {t("Read DMI's maintenance notice")}
        </a>
      </div>
    </details>
  );
}
