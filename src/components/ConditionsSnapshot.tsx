import { ArrowDown, Sunrise, Sunset } from 'lucide-react';
import WeatherWidgetIcon from './WeatherWidgetIcon';
import { blockHourRange } from '../features/forecast/blockHours';
import { useLang } from '../i18n';
import { formatWeekday, locationHourLabel } from '../utils/date';
import type { HourlyData } from '../features/forecast/types';
import type { SafetyRating, SafetyReason } from '../features/safety/analyzeSafetyConditions';

const signed = (v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;

interface ConditionsSnapshotProps {
  data: HourlyData;
  weatherDesc: string;
  windDirectionLabel: string;
  windRotation: number;
  sunrise: string;
  sunset: string;
  reasons: SafetyReason[];
  rating: SafetyRating;
}

// The 5-second scan: what does it look like right now? Compact two-column
// rows (not boxed tiles), then the safety reasons — the most actionable text
// in the app — with a color-coded pip carrying the current rating's meaning.
export default function ConditionsSnapshot({
  data,
  weatherDesc,
  windDirectionLabel,
  windRotation,
  sunrise,
  sunset,
  reasons,
  rating,
}: ConditionsSnapshotProps) {
  const { t } = useLang();
  const weekday = formatWeekday(data.time);
  const isBlock = Boolean(data.blockSpanHours);
  const range = isBlock ? blockHourRange(data.time, data.blockSpanHours as number) : null;
  const timeAnchor = range
    ? `${weekday} ${range.start}:00–${range.end}:00`
    : `${weekday} ${locationHourLabel(data.time)}`;

  // For longer-range blocks, the scalar fields carry the decision value and
  // the *Min/*Max fields carry the full DMI range that lives in this detail
  // panel. A flat block (min == max after rounding) collapses to the single
  // value — "0.12–0.12 m" reads as a glitch, not a range.
  const waveLo = (data.waveHeightMin ?? data.waveHeight).toFixed(2);
  const waveHi = (data.waveHeightMax ?? data.waveHeight).toFixed(2);
  const waveText = isBlock ? `${waveLo === waveHi ? waveHi : `${waveLo}–${waveHi}`} m` : `${data.waveHeight.toFixed(2)} m`;
  const waterLo = (data.tempWaterMin ?? data.tempWater).toFixed(1);
  const waterHi = (data.tempWaterMax ?? data.tempWater).toFixed(1);
  const waterText = isBlock ? `${waterLo === waterHi ? waterHi : `${waterLo}–${waterHi}`}°C` : `${data.tempWater.toFixed(1)}°C`;
  const tideLo = signed(data.tideLevelMin ?? data.tideLevel);
  const tideHi = signed(data.tideLevelMax ?? data.tideLevel);
  const tideText = isBlock
    ? (tideLo === tideHi ? `${tideHi} m` : t('{0} to {1} m', tideLo, tideHi))
    : `${data.tideLevel >= 0 ? '+' : ''}${data.tideLevel.toFixed(2)} m`;
  // MET supplies one instant wind value for an outlook block. Ignore legacy
  // percentile fields that may still exist in an older cached payload.
  const windText = `${data.windSpeed.toFixed(1)} m/s`;
  const gustText = isBlock
    ? ` ${t('gusts {0} max', (data.windGustMax ?? data.windGust).toFixed(1))}`
    : ` ${t('gusts {0}', data.windGust.toFixed(1))}`;

  return (
    <section className="panel snapshot" aria-label={t('Current conditions')}>
      <div className="snapshot-grid">
        <div className="snapshot-row">
          <span className="snapshot-cell">
            <span className="snapshot-label">{t('Weather')}</span>
            <WeatherWidgetIcon code={data.weatherCode} isNight={!data.isDay} size={18} />
            <span className="snapshot-value snapshot-desc">{weatherDesc}</span>
          </span>
          <span className="snapshot-cell snapshot-cell-end">
            <span className="snapshot-label">{t('Air')}</span>
            <span className="snapshot-value">{data.tempAir.toFixed(1)}°C</span>
          </span>
        </div>

        <div className="snapshot-row">
          <span className="snapshot-cell">
            <span className="snapshot-label">{t('Wind')}</span>
            <span className="snapshot-value">
              {windText}
              <span className="snapshot-sub">{gustText}</span>
            </span>
          </span>
          <span
            className="snapshot-cell snapshot-cell-end"
            title={t('Wind from {0}. The arrow points downwind (where the wind is heading).', windDirectionLabel)}
          >
            {/* Same icon + math as the meteogram's wind row: ArrowDown points
                south at 0°, so rotating by the FROM-direction makes the arrow
                point where the wind blows TO. */}
            <ArrowDown size={13} className="snapshot-wind-arrow" style={{ transform: `rotate(${windRotation}deg)` }} aria-hidden="true" />
            <span className="snapshot-value">{windDirectionLabel}</span>
          </span>
        </div>

        <div className="snapshot-row">
          <span className="snapshot-cell">
            <span className="snapshot-label">{t('Waves')}</span>
            <span className="snapshot-value">{waveText}</span>
          </span>
          <span className="snapshot-cell snapshot-cell-end">
            <span className="snapshot-label">{t('Water')}</span>
            <span className="snapshot-value">{waterText}</span>
          </span>
        </div>

        <div className="snapshot-row">
          <span className="snapshot-cell">
            <span className="snapshot-label">{t('Level')}</span>
            <span className="snapshot-value">{tideText}</span>
          </span>
          <span className="snapshot-cell snapshot-cell-end snapshot-sun">
            {sunrise && <span className="snapshot-value"><Sunrise size={13} /> {sunrise}</span>}
            {sunset && <span className="snapshot-value"><Sunset size={13} /> {sunset}</span>}
          </span>
        </div>

      </div>

      {isBlock && (
        <div className="snapshot-lowconf-note">
          {t('Long range outlook · lower confidence')}
        </div>
      )}

      <div className={`snapshot-reasons-container rating-${rating}`}>
        <span className="sr-only">{t('Overall rating: {0}.', t(rating))}</span>
        <div className="snapshot-time-anchor">{t('Conditions for {0}:', timeAnchor)}</div>
        <ul className="snapshot-reasons">
          {reasons.map((reason, i) => (
            <li key={i} className={`reason-${reason.severity}`}>{reason.text}</li>
          ))}
        </ul>
      </div>
    </section>
  );
}
