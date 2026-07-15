import { useEffect, useRef, useState } from 'react';
import { useLang } from '../i18n';
import type { SafetySettings } from '../hooks/useSettings';

const MODES: { value: SafetySettings['tripMode']; label: string }[] = [
  { value: 'beginner', label: 'Chill' },
  { value: 'default', label: 'Normal' },
  { value: 'pro', label: 'Pro' },
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
      if (e.key === 'Escape') setShowInfo(false);
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

        {showInfo && (
          <div className="trip-profile-info" id="trip-profile-info-pop" role="note" ref={popRef}>
            <p>
              <strong>Chill</strong>, <strong>Normal</strong> {t('and')} <strong>Pro</strong> {t('are presets — from the most cautious limits for beginners and easy trips to the loosest limits for experienced paddlers.')}
            </p>
            <p>
              <strong>Custom</strong> {t('is your own set: change anything in Your Limits below and it lands there.')}
            </p>
            <p className="trip-profile-info-note">
              {t('Picking a mode updates the exact numbers in Your Limits — the manual explains every rule.')}
            </p>
          </div>
        )}
      </div>

      <div
        className="frank-mode-bank"
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
          const isOn = tripMode === value;
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
              <span className="frank-mode-label">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
