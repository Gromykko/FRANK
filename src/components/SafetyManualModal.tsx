import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { CURRENT_LOCATION } from '../config/locations';
import { resolveSectors } from '../features/safety/analyzeSafetyConditions';
import { GUIDED_PROFILE_MODES, SAFETY_GUIDANCE_SOURCES } from '../features/safety/guidanceSources';
import { GUST_FACTOR, getPresetSettings } from '../features/safety/presets';
import { useLang } from '../i18n';
import type { SafetySettings } from '../hooks/useSettings';

interface SafetyManualModalProps {
  settings: SafetySettings;
  onClose: () => void;
}

export default function SafetyManualModal({ settings, onClose }: SafetyManualModalProps) {
  const { t } = useLang();
  // Live sectors with the user's caps applied, so the manual shows real numbers.
  const sectors = resolveSectors(CURRENT_LOCATION, settings);
  const contentRef = useRef<HTMLDivElement>(null);
  // A click's target is the element under mouseUP: releasing a text selection
  // over the backdrop must not close, so closing requires mousedown there too
  const mouseDownOnBackdrop = useRef(false);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // APG dialog: initial focus goes to the container, not the Close button
    // at the END of the manual (focusing that scrolled the modal to its
    // last page and starts screen readers past all the content)
    contentRef.current?.focus({ preventScroll: true });

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      // aria-modal promises the page behind is inert; keep Tab inside
      if (e.key === 'Tab' && contentRef.current) {
        const focusables = contentRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (!focusables.length) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        const active = document.activeElement;
        const inside = contentRef.current.contains(active);
        if (e.shiftKey && (active === first || !inside)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !inside)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  return (
    // oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- Escape and the close button provide keyboard dismissal.
    <div
      className="info-modal-backdrop"
      onMouseDown={(e) => { mouseDownOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
      {/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- This click only prevents backdrop dismissal; the dialog's keyboard behavior is unchanged. */}
      <div
        ref={contentRef}
        className="info-modal-content is-flush"
        role="dialog"
        aria-modal="true"
        aria-labelledby="safety-manual-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="info-modal-header manual-header">
          <h2 className="manual-title" id="safety-manual-title">{t('HOW FRANK DECIDES')}</h2>
          <button
            type="button"
            className="manual-header-close"
            onClick={onClose}
            aria-label={t('Close')}
          >
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="manual-body">
          <div>
            <h3 className="manual-h">{t('Profile basis')}</h3>
            <p className="manual-p">
              {t("FRANK's built-in profiles use DKF training and assessment conditions as starting points. DKF did not publish them as safety limits. Choosing a profile does not prove competence or make a trip safe.")}
            </p>
            <ul className="manual-list spaced">
              {GUIDED_PROFILE_MODES.map(({ mode, label, level }) => {
                const preset = getPresetSettings(mode);
                return (
                  <li key={mode}>
                    <strong>{t(label)} · {level}:</strong>{' '}
                    {t(
                      'maximum mean wind {0} m/s; maximum significant waves {1} m.',
                      preset.windLimit.toFixed(1),
                      preset.waveLimit.toFixed(2),
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="manual-note">
              {t('The Intermediate and Advanced wind limits draw on')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfTouring} target="_blank" rel="noreferrer">DKF Touring</a>
              {', '}{t('including the')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfIpp3Touring} target="_blank" rel="noreferrer">{t('IPP 3 Touring norm')}</a>,
              {' '}{t('and')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfIpp4Touring} target="_blank" rel="noreferrer">{t('IPP 4 Touring norm')}</a>.
              {' '}{t("Touring IPP 2 gives no numeric wind limit. The Beginner wind maximum and all three wave maxima use")}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfSeaKayakNorm} target="_blank" rel="noreferrer">{t("DKF's 7 May 2026 sea-kayak norm")}</a>.
              {' '}{t('These documents describe training and assessment conditions, not guaranteed safe conditions. Local wind sectors, gusts, temperature, weather, daylight, route, equipment, and club rules may all require a stricter decision.')}
            </p>
          </div>

          <div>
            <h3 className="manual-h">{t('1. Wave height')}</h3>
            <p className="manual-p">{t('FRANK compares significant wave height with the maximum in your profile:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Within limits:')}</strong> {t('Wave height is at or below your selected maximum.')}</li>
              <li><strong>{t('Not recommended:')}</strong> {t('Wave height is above your selected maximum.')}</li>
            </ul>
            <p className="manual-note">
              {t('Wave labels use')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.wmoSeaStateTerminology} target="_blank" rel="noreferrer">{t("WMO's sea-wave terms")}</a>
              {' '}{t('only as context; FRANK assesses the numeric height.')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dmiSignificantWaveHeight} target="_blank" rel="noreferrer">DMI</a>{' '}
              {t('defines significant wave height as the mean height of the highest third of waves and notes that individual waves can be higher. FRANK separately cautions that the number does not describe local surf or short steep chop by itself.')}
            </p>
          </div>

          <div>
            <h3 className="manual-h">{t('2. Wind speed and gusts')}</h3>
            <p className="manual-p">{t("MET forecasts a 10-minute mean wind at 10 m and a peak gust averaged over three seconds. FRANK compares mean wind with your selected maximum. If gust checking is on, it also checks a derived gust maximum of {0} times the mean-wind maximum.", GUST_FACTOR)}</p>
            <ul className="manual-list">
              <li><strong>{t('Within limits:')}</strong> {t('In the hourly forecast, mean wind is at or below your maximum, and any enabled gust check is also within its derived maximum.')}</li>
              <li><strong>{t('Not recommended:')}</strong> {t('Mean wind or an enabled gust check is above its maximum.')}</li>
            </ul>
            <p className="manual-note">
              {t("For example, a mean-wind maximum of {0} m/s gives a derived gust maximum of {1} m/s. The factor is FRANK's rule of thumb, not a limit published by DKF, IPP, WMO, or a kayak club.", settings.windLimit.toFixed(1), (settings.windLimit * GUST_FACTOR).toFixed(1))}
              {' '}{t('It stays fixed instead of learning from recent forecasts, so the limit does not move with the weather it is meant to judge.')}
            </p>
            <p className="manual-note">
              {t('Mean-wind names follow')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dmiBeaufort} target="_blank" rel="noreferrer">{t("DMI's Beaufort scale")}</a>.
              {' '}{t('A gust is shown only as a number because a short gust is not a Beaufort mean-wind category. Measurement definitions:')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.metForecastDataModel} target="_blank" rel="noreferrer">MET Norway</a>.
            </p>
            <p className="manual-note">
              {t('The DKF/IPP material behind these profiles does not publish separate numeric gust bands. The')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.nwsKayakWindHazards} target="_blank" rel="noreferrer">US National Weather Service</a>{' '}
              {t("also treats gusts as relevant in an official kayak forecast. FRANK does not copy that forecast's local Great Lakes thresholds. If you turn gust checking off, the forecast still shows gusts, but they do not affect the verdict.")}
            </p>
            <p className="manual-note">{t('MET does not publish gusts for the longer-range 6- or 12-hour outlook blocks. When that happens, FRANK says the gust is unavailable and judges the outlook only from the readings the block contains.')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('3. Local wind sectors')}</h3>
            <p className="manual-p">{t("These limits are optional and off by default. If you turn them on, FRANK applies separate wind limits to the fixed sectors below for {0}. A sector limit can make your profile stricter.", CURRENT_LOCATION.areaName)}</p>
            <ul className="manual-list spaced">
              {sectors.map((s) => (
                <li key={s.id}><strong>{t(s.label)} ({s.min}&deg;-{s.max}&deg;):</strong> {t(s.description)}. {t('Maximum {0} m/s for this direction.', s.maximumAt)}</li>
              ))}
              <li>{t('FRANK estimated these broad area bearings and starting limits. They are not club-published rules or a survey of every shoreline.')}</li>
              <li>{t('Sector limits use mean wind, not gusts.')}</li>
              <li>{t('You can adjust the wind limits. The bearings stay fixed.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('4. Water level')}</h3>
            <p className="manual-p">
              {t('Water level comes from a storm-surge forecast model, not an astronomical tide table. The value shown is the forecast water level relative to mean sea level at the nearest model grid point, including wind setup and pressure effects.')}
            </p>
            <p className="manual-note">{t('Water level is shown for planning context only. It does not change the safety verdict or filter launch windows.')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('5. Weather conditions (rain, snow, sleet, fog and thunder)')}</h3>
            <p className="manual-p">
              {t("The weather description follows MET Norway's official")}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.metWeatherSymbolLegend} target="_blank" rel="noreferrer">{t('Weathericons legend')}</a>.
              {' '}{t('Danish wording follows')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dmiForecastVocabulary} target="_blank" rel="noreferrer">{t('DMI weather terminology')}</a>.
              {' '}{t('FRANK does not infer rain or lightning from other readings. It gives each published weather condition a paddling rating:')}
            </p>
            <ul className="manual-list spaced">
              <li><strong>{t('Within limits:')}</strong> {t('clear, fair, partly cloudy, cloudy, and light rain. These conditions do not add a weather flag.')}</li>
              <li><strong>{t('Check before launch:')}</strong> {t('rain, fog, light or ordinary snow and sleet, and non-heavy rain showers. Check what they mean for your route and visibility.')}</li>
              <li><strong>{t('Not recommended:')}</strong> {t('heavy precipitation, snow or sleet showers, and every condition with thunder.')}</li>
            </ul>
            <p className="manual-note">{t('There is no rain limit or lightning setting. Each forecast description keeps its specific meaning, for example "Heavy rain" or "Heavy rain and thunder".')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('6. How rules combine')}</h3>
            <p className="manual-p">{t('FRANK checks every enabled rule for each hour. The')} <strong>{t('most restrictive result')}</strong> {t('becomes the overall rating. A rule can raise the result (Within limits → Check before launch → Not recommended), but it cannot lower a result set by another rule:')}</p>
            <ul className="manual-list spaced">
              <li>{t('If any rule says Not recommended, the whole hour is Not recommended, even if every other reading is within its limit.')}</li>
              <li>{t('A rule that only asks for a check, such as the daylight rule, cannot make an hour Not recommended by itself.')}</li>
              <li>{t('FRANK lists each separate problem it finds. If the general and local-sector limits flag the same mean wind, only the controlling wind explanation is shown.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('7. Water temperature')}</h3>
            <p className="manual-p">{t("Cold water can affect breathing and movement after an unexpected capsize. FRANK uses two temperature boundaries because clothing, rescue time, and paddling plans matter:")}</p>
            <ul className="manual-list">
              <li>
                <strong>&ge; {settings.waterTempTakeCareBelow}&deg;C:</strong>{' '}
                {t('Within the selected temperature limits. This is not a clothing recommendation.')}
              </li>
              <li><strong>&gt; {settings.waterTempDangerBelow}&deg;C {t('and')} &lt; {settings.waterTempTakeCareBelow}&deg;C:</strong> {t('Check before launch. Plan clothing and rescue for cold-water immersion.')}</li>
              <li><strong>&le; {settings.waterTempDangerBelow}&deg;C:</strong> {t('Not recommended under the selected temperature limits.')}</li>
            </ul>
            <p className="manual-note">
              {t('The default 15°C check follows')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.rnliColdWater} target="_blank" rel="noreferrer">RNLI</a>{' '}
              {t('cold-water-shock guidance. The default 10°C boundary follows advice from')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.danishColdWaterSafety} target="_blank" rel="noreferrer">Søsportens Sikkerhedsråd</a>{' '}
              {t('to wait until the water is above 10°C.')}
            </p>
          </div>

          <div>
            <h3 className="manual-h">{t('8. Daylight rule')}</h3>
            <p className="manual-p">{t('Many clubs require navigation lights and permission between sunset and sunrise. When the daylight rule is on, FRANK marks those hours Check before launch. You can turn it off if your own rules allow night paddling. A longer-range outlook block gets the same result unless its whole period is in daylight. Launch windows work differently: FRANK removes periods with no complete daylight hour and shows only the longest continuous daylight part of a partial period.')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('9. Launch windows')}</h3>
            <p className="manual-p">{t('An hourly launch window is an unbroken run of hours that stay within every selected check. Check before launch or Not recommended breaks the run:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Minimum duration:')}</strong> {t('runs shorter than your Min Duration setting are not shown.')}</li>
              <li><strong>{t('Day boundaries:')}</strong> {t('hourly windows split at local midnight, so each belongs to one calendar day; longer-range outlook windows can run past it (the end time then shows its day).')}</li>
              <li><strong>{t('Longer range:')}</strong> {t('beyond the hourly forecast, coarser outlook blocks (6 hours, occasionally 12) form windows from the readings available in each block. Gusts are not published there. These windows are marked "more uncertain forecast"; treat them as hints, not commitments.')}</li>
            </ul>
          </div>

          <button
            type="button"
            className="manual-close-btn"
            onClick={onClose}
          >
            {t('Close')}
          </button>
        </div>
      </div>
    </div>
  );
}
