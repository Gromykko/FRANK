import { useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n';
import { getPresetSettings } from '../features/safety/presets';
import { GUIDED_PROFILE_MODES, SAFETY_GUIDANCE_SOURCES } from '../features/safety/guidanceSources';
import type { SafetySettings } from '../hooks/useSettings';

const MODES: { value: SafetySettings['tripMode']; label: string }[] = [
  { value: 'beginner', label: 'Beginner' },
  { value: 'default', label: 'Intermediate' },
  { value: 'pro', label: 'Advanced' },
  { value: 'custom', label: 'Custom' },
];

interface TripProfilePanelProps {
  tripMode: SafetySettings['tripMode'];
  onTripModeChange: (mode: SafetySettings['tripMode']) => void;
}

// The one input that frames every reading below it: how cautious FRANK
// should judge conditions. One selector, four detents; the "?" opens a
// compact comparison of what each mode presets (numbers quoted from
// src/features/safety/presets.ts - keep in sync).
export default function TripProfilePanel({ tripMode, onTripModeChange }: TripProfilePanelProps) {
  const { t } = useLang();
  // 'weather' is deliberately NOT a fifth detent in the bank. The bank is a
  // scale of capability profiles; switching every check off is a different kind of choice,
  // and a detent next to Advanced could be slid onto by accident, silently
  // removing the verdict. It also keeps the bank's four-column grid intact.
  const weatherOnly = tripMode === 'weather';
  const activeIdx = Math.max(0, MODES.findIndex((m) => m.value === tripMode));
  const [showInfo, setShowInfo] = useState(false);
  const infoBtnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showInfo) return;
    // "Outside" means outside the POPOVER and its trigger — not the whole
    // header strip, or a tap beside the "?" on the same line wouldn't close it.
    // (The trigger is excluded so its own click handler toggles, instead of
    // pointerdown-close + click-reopen fighting each other.)
    const closeOutside = (e: PointerEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || infoBtnRef.current?.contains(t)) return;
      setShowInfo(false);
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setShowInfo(false);
        infoBtnRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [showInfo]);

  return (
    <div className="panel trip-profile-panel">
      <div className="trip-profile-head">
        {/* Same contract as the Your Limits panel's "?": the hover tip
            states an action, the click reveals the content. No numbers here -
            picking a mode shows the real values in the panel below, so this
            popover never drifts out of sync with the presets. */}
        <h2 className="trip-profile-title">
          {t('Trip Profile')}
          <button
            type="button"
            ref={infoBtnRef}
            className="settings-info-btn"
            aria-label={t('About the modes')}
            aria-expanded={showInfo}
            aria-controls="trip-profile-info-pop"
            data-tip={t('About the modes')}
            onClick={() => setShowInfo((v) => !v)}
          >
            ?
          </button>
        </h2>
        <span className="trip-profile-subtitle">{t('How cautious should FRANK be for you?')}</span>

      </div>

      <div
        className={`frank-mode-bank ${weatherOnly ? 'is-unset' : ''}`}
        role="radiogroup"
        aria-label={t('Trip mode')}
        style={{ '--mode-index': activeIdx } as React.CSSProperties}
        // The ARIA radiogroup contract: arrows move AND select
        onKeyDown={(e) => {
          const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1
            : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
          if (!dir) return;
          e.preventDefault();
          const next = (activeIdx + dir + MODES.length) % MODES.length;
          onTripModeChange(MODES[next].value);
          (e.currentTarget.querySelectorAll('button')[next])?.focus();
        }}
      >
        <span className="frank-mode-indicator" aria-hidden="true" />
        {MODES.map(({ value, label }) => {
          const isOn = !weatherOnly && tripMode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={isOn}
              tabIndex={isOn ? 0 : -1}
              className={`frank-mode ${isOn ? 'is-on' : ''}`}
              onClick={() => onTripModeChange(value)}
            >
              <span className="frank-mode-label">{t(label)}</span>
            </button>
          );
        })}
      </div>

      {/* Wanting raw weather with no judgement used to mean switching six rules
          off by hand and remembering which. One control, reversible in one
          click, and named for exactly what it does - "Simple" or "Basic" would
          hide that every safety check is gone. */}
      <button
        type="button"
        className={`frank-weather-toggle ${weatherOnly ? 'is-on' : ''}`}
        aria-pressed={weatherOnly}
        onClick={() => onTripModeChange(weatherOnly ? 'default' : 'weather')}
      >
        {t(weatherOnly ? 'Weather only — no limits applied' : 'Weather only — turn off all your limits')}
      </button>

      {/* BELOW the mode bank, and in normal flow rather than floating over it.
          As an absolutely-positioned popover hanging off the header it covered
          the four buttons it exists to describe (Beginner and Intermediate were hidden
          entirely) and spilled past the panel edge onto the conditions card
          underneath. An explainer must not hide its own subject; growing the
          panel while it is open is the smaller cost. */}
      {showInfo && (
        <div className="trip-profile-info" id="trip-profile-info-pop" role="note" ref={popRef}>
          <p>
            {t('The built-in profiles start with these maximum conditions:')}
          </p>
          <ul className="trip-profile-info-list">
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
          <p>
            {t('These are starting points, not DKF safety guarantees or proof of skill. Optional local wind sectors and every other enabled rule may make the result stricter.')}
          </p>
          <p className="trip-profile-info-note">
            {t('Basis: Intermediate and Advanced wind use the numeric conditions in')}{' '}
            <a href={SAFETY_GUIDANCE_SOURCES.dkfTouring} target="_blank" rel="noreferrer">DKF Touring</a>.
            {' '}{t('See the')}{' '}
            <a href={SAFETY_GUIDANCE_SOURCES.dkfIpp3Touring} target="_blank" rel="noreferrer">{t('IPP 3 Touring norm')}</a>
            {' '}{t('and')}{' '}
            <a href={SAFETY_GUIDANCE_SOURCES.dkfIpp4Touring} target="_blank" rel="noreferrer">{t('IPP 4 Touring norm')}</a>.
            {' '}{t("Touring IPP 2 has no numeric wind limit. The Beginner wind maximum and all three wave maxima use")}{' '}
            <a href={SAFETY_GUIDANCE_SOURCES.dkfSeaKayakNorm} target="_blank" rel="noreferrer">{t("DKF's 7 May 2026 sea-kayak norm")}</a>.
            {' '}{t('The source documents describe training and assessment conditions, not guaranteed safe conditions.')}
          </p>
          <p>
            <strong>{t('Custom')}</strong> {t('is your own set: change anything in Your Limits below and it lands there.')}
          </p>
          <p>
            <strong>{t('Weather only')}</strong> {t('switches every check off: FRANK shows the forecast and stops giving a verdict.')}
          </p>
          <p className="trip-profile-info-note">
            {t('Picking a mode updates the exact numbers in Your Limits. The manual explains every rule.')}
          </p>
        </div>
      )}
    </div>
  );
}
