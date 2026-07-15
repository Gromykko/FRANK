import { useEffect, useRef } from 'react';
import { CURRENT_LOCATION } from '../config/locations';
import { resolveSectors } from '../features/safety/analyzeSafetyConditions';
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
    <div
      className="info-modal-backdrop"
      onMouseDown={(e) => { mouseDownOnBackdrop.current = e.target === e.currentTarget; }}
      onClick={(e) => {
        if (mouseDownOnBackdrop.current && e.target === e.currentTarget) onClose();
      }}
    >
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
        </div>

        <div className="manual-body">
          <div>
            <h3 className="manual-h">{t('1. Wave Height')}</h3>
            <p className="manual-p">{t('Significant wave height is checked against your')} <strong>{t('Max Wave')}</strong> {t('safe limit and caution margin:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Good to go:')}</strong> {t('Wave height below your Max Wave safe limit.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('At or above the safe limit, but below (Max Wave + Wave Caution Margin).')}</li>
              <li><strong>{t('Rough:')}</strong> {t('At or above the danger threshold (Max Wave + Wave Caution Margin). Waves big enough to tip you — best avoided.')}</li>
            </ul>
            <p className="manual-note">{t('If the caution margin toggle is off, the caution band disappears: waves rate Safe all the way up to the danger threshold.')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('2. Wind Speed & Gusts')}</h3>
            <p className="manual-p">{t('Average wind speed and peak gusts are checked independently against one shared ceiling: the')} <strong>{t('Wind Gust Margin')}</strong> {t('sets how far above your Max Wind Safe limit either may go before rating Danger (there is no separate danger-wind control — the threshold is Max Wind Safe + Gust Margin):')}</p>
            <ul className="manual-list">
              <li><strong>{t('Good to go:')}</strong> {t('Both wind and gusts below Max Wind Safe.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('Wind or gusts between Max Wind Safe and Max Wind Safe + Gust Margin.')}</li>
              <li><strong>{t('Rough:')}</strong> {t('Wind or gusts at or above Max Wind Safe + Gust Margin.')}</li>
            </ul>
            <p className="manual-note">
              {t('Example: Max Wind Safe = 5 m/s, Gust Margin = 3 m/s means the gust ceiling is 8 m/s. A gust of 7.2 m/s exceeds the 5 m/s safe limit and rates Caution; 8.4 m/s rates Danger.')}
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
              <li>{t('If a clash occurs and wind speed > 4.0 m/s, the hour is automatically marked')} <strong>{t('Caution')}</strong>.</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('4. Local Wind Sectors')}</h3>
            <p className="manual-p">{t('Active only when')} <strong>{t('Local wind sectors')}</strong> {t('is enabled. Applies separate, stricter absolute limits for the wind sectors configured for {0}:', CURRENT_LOCATION.areaName)}</p>
            <ul className="manual-list spaced">
              {sectors.map((s) => (
                <li key={s.id}><strong>{t(s.label)} ({s.min}&deg;-{s.max}&deg;):</strong> {t(s.description)}. {t('Safe cap: {0} m/s, danger cap: {1} m/s.', s.safeLimit, s.cautionLimit)}</li>
              ))}
              <li>{t('These limits use')} <strong>{t('average wind speed only')}</strong> {t('(not gusts), as standing-wave hazards here are driven by sustained wind blowing across a long open stretch of water (its "fetch").')}</li>
              <li>{t('Directions are fixed to the local geography; only the speed caps are yours to adjust.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('5. Water Level')}</h3>
            <p className="manual-p">
              {t('Water level comes from a storm-surge forecast model, not an astronomical tide table. The value shown is the forecast water level relative to mean sea level at the nearest model grid point, including wind setup and pressure effects.')}
            </p>
            <ul className="manual-list">
              <li><strong>{t('High Water Filter:')}</strong> {t('Water level ≥ +0.1 m. Useful for shallow areas.')}</li>
              <li><strong>{t('Low Water Filter:')}</strong> {t('Water level ≤ -0.1 m.')}</li>
              <li><strong>{t('Rising Only:')}</strong> {t('Water level rises through the whole launch window.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('6. Weather Condition (Rain, Snow, Sleet, Fog, Thunder)')}</h3>
            <p className="manual-p">{t("The weather condition comes straight from the forecast's own symbol (MET Norway's symbol_code) — FRANK does not compute its own rain or lightning judgement. Each condition maps to a severity:")}</p>
            <ul className="manual-list spaced">
              <li><strong>{t('Good to go:')}</strong> {t('clear, cloudy, light drizzle, and light rain — no weather warning.')}</li>
              <li><strong>{t('Take care:')}</strong> {t('moderate rain, light snow, sleet, fog, and rain showers — worth keeping an eye on.')}</li>
              <li><strong>{t('Rough:')}</strong> {t('heavy rain, heavier snow or sleet, snow showers, and thunderstorms — probably one to skip.')}</li>
            </ul>
            <p className="manual-note">{t('There is no configurable rain limit or lightning slider: the forecast decides the condition, and the reason shows its plain description (for example "Heavy rain" or "Thunderstorm").')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('7. How Rules Combine')}</h3>
            <p className="manual-p">{t('Every enabled rule is evaluated for every hour, and the overall rating is the')} <strong>{t('worst result')}</strong> {t('among them. A rule can only raise the severity (Safe → Caution → Danger) — no rule can lower a rating another rule has already set:')}</p>
            <ul className="manual-list spaced">
              <li>{t('One Danger rule (for example a thunderstorm or heavy-rain forecast) makes the whole hour Danger, regardless of how calm everything else looks.')}</li>
              <li>{t('Caution-only rules (wind-against-water clash > 4 m/s, nighttime) never raise an hour above Caution on their own.')}</li>
              <li>{t('Every triggered rule is listed in the assessment, so you always see all reasons — not just the worst one.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('8. Water Temperature')}</h3>
            <p className="manual-p">{t("Cold shock and hypothermia risk, checked against your configured limits. The defaults are conservative starting points — set them to your own club's rules, your gear, and the season:")}</p>
            <ul className="manual-list">
              <li><strong>&ge; {settings.minWaterTempSafe}&deg;C:</strong> {t('Safe for general paddling clothing.')}</li>
              <li><strong>{settings.minWaterTempCaution}-{settings.minWaterTempSafe}&deg;C:</strong> {t('Caution. Thermal layers or wetsuit strongly recommended.')}</li>
              <li><strong>&lt; {settings.minWaterTempCaution}&deg;C:</strong> {t('Danger. Drysuit or heavy wetsuit required.')}</li>
            </ul>
          </div>

          <div>
            <h3 className="manual-h">{t('9. Daylight Rule')}</h3>
            <p className="manual-p">{t('Many clubs prohibit paddling between sunset and sunrise without navigation lights and permission, so when this rule is on, hourly forecasts outside daylight are marked Caution (turn it off if night paddling is fine for you). Longer-range outlook periods are handled per launch window instead: windows with no daylight at all are dropped, and windows that span night hours show only their daylight part in the list.')}</p>
          </div>

          <div>
            <h3 className="manual-h">{t('10. Launch Windows')}</h3>
            <p className="manual-p">{t('A launch window is an unbroken run of Good-to-go hours — an hour rated Take care or Rough breaks the run:')}</p>
            <ul className="manual-list">
              <li><strong>{t('Minimum duration:')}</strong> {t('runs shorter than your Min Duration setting are not shown.')}</li>
              <li><strong>{t('Day boundaries:')}</strong> {t('hourly windows split at local midnight, so each belongs to one calendar day; longer-range outlook windows can run past it (the end time then shows its day).')}</li>
              <li><strong>{t('Longer range:')}</strong> {t('beyond the hourly forecast, coarser outlook blocks (6 hours, occasionally 12) form windows marked "lower confidence" — treat them as hints, not commitments.')}</li>
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
