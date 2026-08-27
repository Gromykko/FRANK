import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { CURRENT_LOCATION } from '../config/locations';
import { resolveSectors } from '../features/safety/analyzeSafetyConditions';
import { GUIDED_PROFILE_MODES, SAFETY_GUIDANCE_SOURCES } from '../features/safety/guidanceSources';
import { getPresetSettings } from '../features/safety/presets';
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
  const onshoreSectors = sectors.filter((s) => s.exposure === 'onshore');
  const offshoreSectors = sectors.filter((s) => s.exposure === 'offshore');
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
              {t('The built-in modes are FRANK starting points informed by DKF skill conditions. They are not DKF-issued safety limits, proof of competence, or a guarantee that a trip is safe.')}
            </p>
            <ul className="manual-list spaced">
              {GUIDED_PROFILE_MODES.map(({ mode, label, level }) => {
                const preset = getPresetSettings(mode);
                return (
                  <li key={mode}>
                    <strong>{t(label)} · {level}:</strong>{' '}
                    {t(
                      'general wind Take care from {0} m/s and Rough from {1} m/s; significant waves Take care from {2} m and Rough from {3} m.',
                      preset.maxWindSpeedSafe.toFixed(1),
                      preset.maxWindSpeedCaution.toFixed(1),
                      preset.maxWaveHeightSafe.toFixed(2),
                      preset.maxWaveHeightCaution.toFixed(2),
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
            <h3 className="manual-h">{t('1. Wave Height')}</h3>
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
            <h3 className="manual-h">{t('2. Wind Speed & Gusts')}</h3>
            <p className="manual-p">{t('MET supplies a 10-minute mean wind at 10 m and a peak gust based on a much shorter three-second average. When gust checking is on, FRANK checks both against the same general wind band; the Danger margin sets where each becomes Rough:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Good to go:')}</strong> {t('Both mean wind and gusts are below the Take care threshold.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('Mean wind or gusts are at or above the Take care threshold, but below the danger threshold.')}</li>
              <li><strong>{t('Rough:')}</strong> {t('Mean wind or gusts are at or above the danger threshold.')}</li>
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
              {t('The DKF/IPP material used for these profiles does not publish separate numeric gust bands. Using the selected general band for mean wind or gusts is a conservative FRANK rule, not a DKF limit. An official kayak-facing forecast uses the same sustained-wind-or-gust model:')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.nwsKayakWindHazards} target="_blank" rel="noreferrer">US National Weather Service</a>.
              {' '}{t('Its local Great Lakes numbers are not copied into FRANK.')}
            </p>
          </div>

          <div>
            <h3 className="manual-h">{t('3. Wind-against-Water-Level Clashing')}</h3>
            <p className="manual-p">{t('Active only when')} <strong>{t('Local wind sectors')}</strong> {t('is enabled. The app compares the current water level with the next forecast hour to detect rising or falling water. If sustained wind opposes that water movement, short steep chop is more likely:')}</p>
            <ul className="manual-list spaced">
              {offshoreSectors.map((s) => (
                <li key={s.id}><strong>{t('{0} wind', t(s.label))}</strong> ({s.min}&deg;-{s.max}&deg;) {t('can oppose rising water.')}</li>
              ))}
              {onshoreSectors.map((s) => (
                <li key={s.id}><strong>{t('{0} wind', t(s.label))}</strong> ({s.min}&deg;-{s.max}&deg;) {t('can oppose falling water.')}</li>
              ))}
              <li>{t('If a clash occurs and wind speed > 4.0 m/s, the hour is automatically marked')} <strong>{t('Take care')}</strong>.</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('4. Local Wind Sectors')}</h3>
            <p className="manual-p">{t('Active only when')} <strong>{t('Local wind sectors')}</strong> {t('is enabled. Applies separate direction-specific limits for the wind sectors configured for {0}; these can make a profile stricter:', CURRENT_LOCATION.areaName)}</p>
            <ul className="manual-list spaced">
              {sectors.map((s) => (
                <li key={s.id}><strong>{t(s.label)} ({s.min}&deg;-{s.max}&deg;):</strong> {t(s.description)}. {t('Take care from {0} m/s; danger from {1} m/s.', s.safeLimit, s.cautionLimit)}</li>
              ))}
              <li>{t('These limits use')} <strong>{t('average wind speed only')}</strong> {t('(not gusts), as the chop that matters here is driven by sustained wind blowing across a long open stretch of water (its "fetch").')}</li>
              <li>{t('Directions are fixed to the local geography; only the speed caps are yours to adjust.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('5. Water Level')}</h3>
            <p className="manual-p">
              {t('Water level comes from a storm-surge forecast model, not an astronomical tide table. The value shown is the forecast water level relative to mean sea level at the nearest model grid point, including wind setup and pressure effects.')}
            </p>
            <ul className="manual-list">
              <li><strong>{t('High Water Filter:')}</strong> {t('Water level ≥ +10 cm. Useful for shallow areas.')}</li>
              <li><strong>{t('Low Water Filter:')}</strong> {t('Water level ≤ -10 cm.')}</li>
              <li><strong>{t('Rising Only:')}</strong> {t('Water level rises through the whole launch window.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('6. Weather Condition (Rain, Snow, Sleet, Fog, Thunder)')}</h3>
            <p className="manual-p">
              {t("The weather condition comes straight from MET Norway's symbol_code. English follows MET's official")}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.metWeatherSymbolLegend} target="_blank" rel="noreferrer">{t('Weathericons legend')}</a>.
              {' '}{t('Danish uses translated')}{' '}
              <a href={SAFETY_GUIDANCE_SOURCES.dmiForecastVocabulary} target="_blank" rel="noreferrer">{t('DMI weather terminology')}</a>.
              {' '}{t('FRANK does not reconstruct rain or lightning from other readings; it assigns each native condition a paddling severity:')}
            </p>
            <ul className="manual-list spaced">
              <li><strong>{t('Good to go:')}</strong> {t('clear, fair, partly cloudy, cloudy, and light rain — no weather flag.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('rain, fog, light or ordinary snow and sleet, and non-heavy rain showers — worth keeping an eye on.')}</li>
              <li><strong>{t('Rough:')}</strong> {t('heavy precipitation, snow or sleet showers, and every condition with thunder — probably one to skip.')}</li>
            </ul>
            <p className="manual-note">{t('There is no configurable rain limit or lightning slider: MET decides the condition, and the reason keeps its native meaning (for example "Heavy rain" or "Heavy rain and thunder").')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('7. How Rules Combine')}</h3>
            <p className="manual-p">{t('Every enabled rule is evaluated for every hour, and the overall rating is the')} <strong>{t('worst result')}</strong> {t('among them. A rule can only raise the severity (Good to go → Take care → Rough) — no rule can lower a rating another rule has already set:')}</p>
            <ul className="manual-list spaced">
              <li>{t('If any rule reaches Rough (for example a thunderstorm or heavy-rain forecast), the whole hour is Rough, regardless of how calm everything else looks.')}</li>
              <li>{t('Take-care-only rules (wind-against-water clash > 4 m/s, nighttime) never raise an hour above Take care on their own.')}</li>
              <li>{t('Every distinct triggered hazard is listed. If general and local-sector limits flag the same sustained wind, only the controlling wind explanation is shown.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('8. Water Temperature')}</h3>
            <p className="manual-p">{t("Cold shock and hypothermia risk, checked against your configured limits. The defaults are conservative starting points — set them to your own club's rules, your gear, and the season:")}</p>
            <ul className="manual-list">
              <li><strong>&ge; {settings.minWaterTempSafe}&deg;C:</strong> {t('Good to go for general paddling clothing.')}</li>
              <li><strong>{settings.minWaterTempCaution}-{settings.minWaterTempSafe}&deg;C:</strong> {t('Take care. Thermal layers or wetsuit strongly recommended.')}</li>
              <li><strong>&lt; {settings.minWaterTempCaution}&deg;C:</strong> {t('Rough. Drysuit or heavy wetsuit required.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('9. Daylight Rule')}</h3>
            <p className="manual-p">{t('Many clubs prohibit paddling between sunset and sunrise without navigation lights and permission, so when this rule is on, hourly forecasts outside daylight are marked Take care (turn it off if night paddling is fine for you). A longer-range outlook block is marked Take care unless its whole period is daylight. Launch windows are handled separately: periods with no complete daylight hour are dropped, and partial periods show only their longest continuous daylight part.')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('10. Launch Windows')}</h3>
            <p className="manual-p">{t('A launch window is an unbroken run of Good-to-go hours — an hour rated Take care or Rough breaks the run:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Minimum duration:')}</strong> {t('runs shorter than your Min Duration setting are not shown.')}</li>
              <li><strong>{t('Day boundaries:')}</strong> {t('hourly windows split at local midnight, so each belongs to one calendar day; longer-range outlook windows can run past it (the end time then shows its day).')}</li>
              <li><strong>{t('Longer range:')}</strong> {t('beyond the hourly forecast, coarser outlook blocks (6 hours, occasionally 12) form windows marked "more uncertain forecast" — treat them as hints, not commitments.')}</li>
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
