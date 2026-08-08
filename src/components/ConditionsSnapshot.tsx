import { ArrowDown, Sunrise, Sunset } from 'lucide-react';
import WeatherWidgetIcon from './WeatherWidgetIcon';
import { blockHourRange } from '../features/forecast/blockHours';
import { useLang } from '../i18n';
import { formatWeekday, locationHourLabel } from '../utils/date';
import { formatReading, formatLevelCm, NO_READING_TEXT } from '../utils/number';
import type { HourlyData } from '../features/forecast/types';
import { RATING_WORD } from '../features/safety/analyzeSafetyConditions';
import type { SafetyRating, SafetyReason } from '../features/safety/analyzeSafetyConditions';

// Centimetres, matching DMI and the meteogram's Level row. See formatLevelCm.
const signed = (v: number) => formatLevelCm(v);

interface ConditionsSnapshotProps {
  data: HourlyData;
  weatherDesc: string;
  windDirectionLabel: string;
  // null when there is no wind-direction reading: draw no arrow at all rather
  // than a confident one pointing at an invented bearing.
  windRotation: number | null;
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
  const waveLo = formatReading(data.waveHeightMin ?? data.waveHeight, 2);
  const waveHi = formatReading(data.waveHeightMax ?? data.waveHeight, 2);
  const waveText = isBlock ? `${waveLo === waveHi ? waveHi : `${waveLo}–${waveHi}`} m` : `${formatReading(data.waveHeight, 2)} m`;
  const waterLo = formatReading(data.tempWaterMin ?? data.tempWater, 1);
  const waterHi = formatReading(data.tempWaterMax ?? data.tempWater, 1);
  const waterText = isBlock ? `${waterLo === waterHi ? waterHi : `${waterLo}–${waterHi}`}°C` : `${formatReading(data.tempWater, 1)}°C`;
  const tideLo = signed(data.tideLevelMin ?? data.tideLevel);
  const tideHi = signed(data.tideLevelMax ?? data.tideLevel);
  const tideText = isBlock
    ? (tideLo === tideHi ? `${tideHi} cm` : t('{0} to {1} cm', tideLo, tideHi))
    : `${formatLevelCm(data.tideLevel)} cm`;
  // MET supplies one instant wind value for an outlook block. Ignore legacy
  // percentile fields that may still exist in an older cached payload.
  const windText = `${formatReading(data.windSpeed, 1)} m/s`;
  // MET publishes no gust for the longer-range blocks. Show the no-reading
  // dash rather than repeating the sustained wind under a "gusts" label.
  const blockGust = data.windGustMax ?? data.windGust;
  const gustText = isBlock
    ? (Number.isFinite(blockGust) ? t('gusts {0} max', formatReading(blockGust, 1)) : t('gusts {0}', NO_READING_TEXT))
    : t('gusts {0}', formatReading(data.windGust, 1));

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
            <span className="snapshot-value">{formatReading(data.tempAir, 1)}°C</span>
          </span>
        </div>

        <div className="snapshot-row">
          <span className="snapshot-cell">
            <span className="snapshot-label">{t('Wind')}</span>
            {/* Two spans, so the gust can drop to its own line on a narrow
                phone while each part stays intact. Storm values make this the
                widest cell in the panel: "25.5 m/s vindstod 35.0" overflowed a
                180px cell by 23px, which is what used to force the entire grid
                into one column below 400px. */}
            <span className="snapshot-value snapshot-wind">
              <span>{windText}</span>
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
            {windRotation !== null && (
              <ArrowDown size={13} className="snapshot-wind-arrow" style={{ transform: `rotate(${windRotation}deg)` }} aria-hidden="true" />
            )}
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
            {/* Every other cell in this grid pairs its value with a visible
                .snapshot-label; these two carry only a lucide <svg>, which
                contributes no accessible name — so a screen reader announced
                two bare numbers. Daylight is one of the verdict's rules. */}
            {sunrise && <span className="snapshot-value"><Sunrise size={13} aria-hidden="true" /> <span className="sr-only">{t('Sunrise')} </span>{sunrise}</span>}
            {sunset && <span className="snapshot-value"><Sunset size={13} aria-hidden="true" /> <span className="sr-only">{t('Sunset')} </span>{sunset}</span>}
          </span>
        </div>

      </div>

      {isBlock && (
        <div className="snapshot-lowconf-note">
          {t('Long range outlook · lower confidence')}
        </div>
      )}

      <div className={`snapshot-reasons-container rating-${rating}`}>
        {/* RATING_WORD, not t(rating): the raw keys translate to a second
            vocabulary ("sikker/pas på/fare") that the status bar never uses. */}
        <span className="sr-only">{t('Overall rating: {0}.', t(RATING_WORD[rating]))}</span>
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
