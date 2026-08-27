import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { CURRENT_LOCATION } from '../config/locations';
import { resolveSectors } from '../features/safety/analyzeSafetyConditions';
import { GUIDED_PROFILE_MODES, SAFETY_GUIDANCE_SOURCES } from '../features/safety/guidanceSources';
import { getPresetSettings, getWaveDangerAt, getWindDangerAt } from '../features/safety/presets';
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
              {t("FRANK's built-in modes use DKF skill conditions as starting points. DKF did not publish them as safety limits. Choosing a mode does not prove competence or make a trip safe.")}
            </p>
            <ul className="manual-list spaced">
              {GUIDED_PROFILE_MODES.map(({ mode, label, level }) => {
                const preset = getPresetSettings(mode);
                return (
                  <li key={mode}>
                    <strong>{t(label)} · {level}:</strong>{' '}
                    {t(
                      'general wind Take care from {0} m/s and Rough from {1} m/s; significant waves Take care from {2} m and Rough from {3} m.',
                      preset.windTakeCareAt.toFixed(1),
                      getWindDangerAt(preset).toFixed(1),
                      preset.waveTakeCareAt.toFixed(2),
                      getWaveDangerAt(preset).toFixed(2),
                    )}
                  </li>
                );
              })}
            </ul>
            <p className="manual-note">
              {t('Intermediate and Advanced wind anchors use')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfTouring} target="_blank" rel="noreferrer">DKF Touring</a>
              {', '}{t('including the')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfIpp3Touring} target="_blank" rel="noreferrer">{t('IPP 3 Touring norm')}</a>,
              {' '}{t('and')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfIpp4Touring} target="_blank" rel="noreferrer">{t('IPP 4 Touring norm')}</a>.
              {' '}{t("Touring IPP 2 gives no numeric wind limit. Beginner's 5 m/s Rough boundary and the numeric red wave ceilings use")}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dkfSeaKayakNorm} target="_blank" rel="noreferrer">{t("DKF's 7 May 2026 sea-kayak norm")}</a>.
              {' '}{t("Beginner's 4 m/s and the lower wave Take care boundaries are FRANK's conservative choices.")}
              {' '}{t('Local wind sectors, gusts, temperature, weather, daylight, route, equipment, and club rules can all demand a stricter decision.')}
            </p>
          </div>

          <div>
            <h3 className="manual-h">{t('1. Wave height')}</h3>
            <p className="manual-p">{t('Significant wave height is checked against your Take care threshold and danger margin:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Good to go:')}</strong> {t('Wave height is below your Take care threshold.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('Wave height is at or above the Take care threshold, but below the danger threshold.')}</li>
              <li><strong>{t('Rough:')}</strong> {t('Wave height is at or above the configured danger threshold.')}</li>
            </ul>
            <p className="manual-note">{t('If the Take care band toggle is off, the amber band disappears: waves remain Good to go until the danger threshold.')}</p>
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
            <p className="manual-p">{t("MET forecasts two different wind readings: a 10-minute mean wind at 10 m and a peak gust averaged over three seconds. When gust checks are on, FRANK multiplies the mean-wind Take care and danger thresholds by 1.6 and checks gusts against that separate band. The 1.6 factor is FRANK's forecast heuristic, not a threshold published by DKF, IPP, WMO, or a kayak club.")}</p>
            <p className="manual-note">{t('A one-time sample of 230 MET forecast hours across these four fjord locations had a median gust-to-mean ratio of 1.66. It was forecast data, not observed wind or a safety study, so it does not establish a universal coastal gust factor.')}</p>
            <ul className="manual-list">
              <li><strong>{t('Good to go:')}</strong> {t('Mean wind is below the Take care threshold, and gusts are below their own.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('Mean wind, or gusts against the gust band, reach Take care but not danger.')}</li>
              <li><strong>{t('Rough:')}</strong> {t('Mean wind, or gusts against the gust band, reach the danger threshold.')}</li>
            </ul>
            <p className="manual-note">
              {t("Intermediate's general wind band starts Take care at exactly 6.0 m/s and Rough at exactly 8.0 m/s. Enabled local sectors or other rules can make the result stricter. A threshold belongs to the stricter band.")}
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
              {t("also treats gusts as relevant in an official kayak forecast. FRANK does not copy that forecast's local Great Lakes thresholds.")}
            </p>
          </div>

          <div>
            <h3 className="manual-h">{t('3. Local wind sectors')}</h3>
            <p className="manual-p">{t("These caps are optional and off by default. If you turn them on, FRANK applies separate wind limits to the fixed sectors below for {0}. A sector cap can make your profile stricter.", CURRENT_LOCATION.areaName)}</p>
            <ul className="manual-list spaced">
              {sectors.map((s) => (
                <li key={s.id}><strong>{t(s.label)} ({s.min}&deg;-{s.max}&deg;):</strong> {t(s.description)}. {t('Take care from {0} m/s; danger from {1} m/s.', s.takeCareAt, s.dangerAt)}</li>
              ))}
              <li>{t("The bearings and starting caps are FRANK-curated broad estimates for the area. They are not club-published rules or a survey of every shoreline.")}</li>
              <li>{t('Sector caps use average wind, not gusts.')}</li>
              <li>{t('You can adjust the speed caps. The bearings stay fixed.')}</li>
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
              <li><strong>{t('Good to go:')}</strong> {t('clear, fair, partly cloudy, cloudy, and light rain. These conditions do not add a weather flag.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('rain, fog, light or ordinary snow and sleet, and non-heavy rain showers. Keep an eye on these conditions.')}</li>
              <li><strong>{t('Rough:')}</strong> {t('heavy precipitation, snow or sleet showers, and every condition with thunder. These are probably reasons to skip the trip.')}</li>
            </ul>
            <p className="manual-note">{t('There is no rain limit or lightning setting. Each forecast description keeps its specific meaning, for example "Heavy rain" or "Heavy rain and thunder".')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('6. How rules combine')}</h3>
            <p className="manual-p">{t('FRANK checks every enabled rule for each hour. The')} <strong>{t('worst result')}</strong> {t('becomes the overall rating. A rule can raise the severity (Good to go → Take care → Rough), but it cannot lower a rating set by another rule:')}</p>
            <ul className="manual-list spaced">
              <li>{t('If any rule reaches Rough (for example a thunderstorm or heavy-rain forecast), the whole hour is Rough, regardless of how calm everything else looks.')}</li>
              <li>{t('A rule that can only mark Take care, such as the daylight rule, cannot make an hour Rough by itself.')}</li>
              <li>{t('Every distinct triggered hazard is listed. If general and local-sector limits flag the same sustained wind, only the controlling wind explanation is shown.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('7. Water temperature')}</h3>
            <p className="manual-p">{t("FRANK checks cold-shock and hypothermia risk against your temperature limits. The defaults are conservative starting points. Set them for your club's rules, your gear, and the season:")}</p>
            <ul className="manual-list">
              <li><strong>&ge; {settings.waterTempTakeCareBelow}&deg;C:</strong> {t('Good to go for general paddling clothing.')}</li>
              <li><strong>{settings.waterTempDangerBelow}-{settings.waterTempTakeCareBelow}&deg;C:</strong> {t('Take care. Thermal layers or wetsuit strongly recommended.')}</li>
              <li><strong>&lt; {settings.waterTempDangerBelow}&deg;C:</strong> {t('Rough. Drysuit or heavy wetsuit required.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('8. Daylight rule')}</h3>
            <p className="manual-p">{t('Many clubs require navigation lights and permission between sunset and sunrise. When the daylight rule is on, FRANK marks those hours Take care. You can turn it off if your own rules allow night paddling. A longer-range outlook block is marked Take care unless its whole period is in daylight. Launch windows work differently: FRANK removes periods with no complete daylight hour and shows only the longest continuous daylight part of a partial period.')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('9. Launch windows')}</h3>
            <p className="manual-p">{t('A launch window is an unbroken run of Good-to-go hours. An hour rated Take care or Rough breaks the run:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Minimum duration:')}</strong> {t('runs shorter than your Min Duration setting are not shown.')}</li>
              <li><strong>{t('Day boundaries:')}</strong> {t('hourly windows split at local midnight, so each belongs to one calendar day; longer-range outlook windows can run past it (the end time then shows its day).')}</li>
              <li><strong>{t('Longer range:')}</strong> {t('beyond the hourly forecast, coarser outlook blocks (6 hours, occasionally 12) form windows marked "more uncertain forecast". Treat them as hints, not commitments.')}</li>
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
