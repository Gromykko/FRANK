import { ArrowDown, Sun, Sunrise, Sunset } from 'lucide-react';
import WeatherWidgetIcon from './WeatherWidgetIcon';
import { blockHourRange } from '../features/forecast/blockHours';
import { getCompactWeatherDescription } from '../features/forecast/weatherCodes';
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
  // One label for both cases: the outlook note already says a block carries
  // its worst-case values, so a "max" suffix here only read as inconsistency.
  const blockGust = data.windGustMax ?? data.windGust;
  const gustValue = isBlock
    ? (Number.isFinite(blockGust) ? formatReading(blockGust, 1) : NO_READING_TEXT)
    : formatReading(data.windGust, 1);
  const gustText = t('gusts {0}', gustValue);
  const compactGustText = t('gust {0}', gustValue);
  const compactWeatherDesc = t(getCompactWeatherDescription(data.weatherCode));
  const daylightRange = [sunrise, sunset].filter(Boolean).join('–');

  return (
    <section className={`panel snapshot${isBlock ? ' is-outlook' : ''}`} aria-label={t('Current conditions')}>
      <div className="snapshot-grid">
        <div className="snapshot-row">
          <span className="snapshot-cell">
            <span className="snapshot-label">{t('Weather')}</span>
            {/* An outlook row describes a period, not its start instant. Its
                isDay flag only reflects that start mark, so turning the whole
                period into a moon icon would make a false night claim. */}
            <WeatherWidgetIcon code={data.weatherCode} isNight={!data.isDay && !isBlock} size={18} />
            <span className="snapshot-value snapshot-desc" title={weatherDesc}>
              <span className="snapshot-weather-full" aria-hidden="true">{weatherDesc}</span>
              <span className="snapshot-weather-compact" aria-hidden="true">{compactWeatherDesc}</span>
              <span className="sr-only">{weatherDesc}</span>
            </span>
          </span>
          <span className="snapshot-cell snapshot-cell-end">
            <span className="snapshot-label">{t('Air')}</span>
            <span className="snapshot-value">{formatReading(data.tempAir, 1)}°C</span>
          </span>
        </div>

        <div className="snapshot-row">
          <span className="snapshot-cell">
            <span className="snapshot-label">{t('Wind')}</span>
            {/* The full wording remains available to assistive technology;
                the visible phone label is intentionally shorter so a gust
                never creates an accidental second row in the ledger. */}
            <span className="snapshot-value snapshot-wind">
              <span className="snapshot-wind-visual" aria-hidden="true">
                <span>{windText}</span>
                <span className="snapshot-wind-separator">&middot;</span>
                <span className="snapshot-sub snapshot-gust-full">{gustText}</span>
                <span className="snapshot-sub snapshot-gust-compact">{compactGustText}</span>
              </span>
              <span className="sr-only">{windText}, {gustText}</span>
            </span>
          </span>
          <span
            className="snapshot-cell snapshot-cell-end"
            title={t('Wind from {0}. The arrow points downwind (where the wind is heading).', windDirectionLabel)}
          >
            <span className="snapshot-label snapshot-context-label">{t('Direction')}</span>
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
            <span className="snapshot-label snapshot-context-label">{t('Daylight')}</span>
            {/* Wider screens keep the separately illustrated times. A 320px
                phone uses one Sun + daylight range so this pair stays aligned
                with Water level; the complete meaning remains below for
                assistive technology. */}
            <span className="snapshot-sun-times" aria-hidden="true">
              {sunrise && <span className="snapshot-value"><Sunrise size={13} />{sunrise}</span>}
              {sunset && <span className="snapshot-value"><Sunset size={13} />{sunset}</span>}
            </span>
            {daylightRange && (
              <span className="snapshot-sun-range" aria-hidden="true">
                <Sun size={13} />
                <span>{daylightRange}</span>
              </span>
            )}
            <span className="sr-only">
              {sunrise && `${t('Sunrise')} ${sunrise}. `}
              {sunset && `${t('Sunset')} ${sunset}.`}
            </span>
          </span>
        </div>

      </div>

      {isBlock && (
        <div className="snapshot-lowconf-note">
          {t('Long range outlook · more uncertain forecast')}
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
