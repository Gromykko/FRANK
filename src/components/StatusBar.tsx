import { useLayoutEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import GertyFace from './GertyFace';
import HeaderUtilityMenu from './HeaderUtilityMenu';
import LocationSwitcher from './LocationSwitcher';
import { useLang } from '../i18n';
import type { SafetyRating } from '../features/safety/analyzeSafetyConditions';
import type { ThemeMode } from '../hooks/useTheme';

const MARQUEE_SPEED = 42;

interface StatusBarProps {
  rating: SafetyRating;
  phrase: string;
  srTitle: string;
  srSubtitle: string;
  location: string;
  sourceLabel: string;
  cacheDetail: string;
  cacheClass: string;
  cacheAriaLabel: string;
  refreshing: boolean;
  onRefresh: () => void;
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

// The phone is the source layout: identity, place, freshness and utilities form
// one calm information band; FRANK's voice gets the full-width screen below.
// Wide screens use the same hierarchy in one row instead of stretching the
// phone composition into oversized empty columns.
export default function StatusBar({
  rating,
  phrase,
  srTitle,
  srSubtitle,
  location,
  sourceLabel,
  cacheDetail,
  cacheClass,
  cacheAriaLabel,
  refreshing,
  onRefresh,
  themeMode,
  onThemeChange,
}: StatusBarProps) {
  const displayRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [marqueeDuration, setMarqueeDuration] = useState(0);
  const { t } = useLang();

  useLayoutEffect(() => {
    const display = displayRef.current;
    const measureEl = measureRef.current;
    if (!display || !measureEl) return;

    const measure = () => {
      const textWidth = measureEl.offsetWidth;
      const displayWidth = display.clientWidth;
      setMarqueeDuration(textWidth > displayWidth
        ? (textWidth + displayWidth) / MARQUEE_SPEED
        : 0);
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(display);
    observer.observe(measureEl);
    return () => observer.disconnect();
  }, [phrase]);

  const isMarquee = marqueeDuration > 0;

  return (
    <header className="frank-device">
      <div className="container">
        <div className={`frank-device-shell rating-${rating} ${cacheDetail ? 'has-cache-detail' : ''}`}>
          <div className="frank-identity" aria-hidden="true">
            <span className="frank-crt">
              <GertyFace rating={rating} />
            </span>
            <span className="frank-nameplate">FRANK</span>
          </div>

          <div className="frank-context">
            <LocationSwitcher label={location} />

            <button
              type="button"
              className={`frank-cache ${cacheClass}`}
              aria-busy={refreshing}
              aria-disabled={refreshing}
              aria-label={`${t('Refresh forecast')}. ${cacheAriaLabel}`}
              onClick={() => { if (!refreshing) onRefresh(); }}
            >
              <span className="frank-cache-text">
                <span className="frank-cache-source">{sourceLabel}</span>
              </span>
              <RefreshCw className="frank-cache-refresh" size={17} aria-hidden="true" />
            </button>

            <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">
              {cacheAriaLabel}
            </span>
          </div>

          <HeaderUtilityMenu themeMode={themeMode} onThemeChange={onThemeChange} />

          {cacheDetail && (
            <div className="frank-cache-notice" aria-hidden="true">{cacheDetail}</div>
          )}

          <div className="frank-cell-display">
            <div
              ref={displayRef}
              className={`frank-display ${isMarquee ? 'is-marquee' : ''}`}
              role="status"
              aria-live="polite"
            >
              <span className="sr-only">{t('{0}. {1}. FRANK says: {2}.', srTitle, srSubtitle, phrase)}</span>
              <span
                className="frank-display-text"
                style={isMarquee ? { animationDuration: `${marqueeDuration}s` } : undefined}
                aria-hidden="true"
              >
                {phrase}
              </span>
              <span ref={measureRef} className="frank-display-measure" aria-hidden="true">
                {phrase}
              </span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
