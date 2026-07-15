import { useLayoutEffect, useRef, useState } from 'react';
import { Moon, RefreshCw, Sun } from 'lucide-react';
import GertyFace from './GertyFace';
import LocationSwitcher from './LocationSwitcher';
import { useLang } from '../i18n';
import type { SafetyRating } from '../features/safety/analyzeSafetyConditions';

// How fast the marquee walks when a phrase overflows the display (px/second).
const MARQUEE_SPEED = 42;

// Inline SVG flags (emoji flags render as plain letters on Windows), clipped
// to a rounded rect so they sit nicely inside the round push-button.
// Dannebrog: white cross arms 2/7 of the height, vertical arm centered at
// 3/7 of the width (toward the hoist).
function FlagDK() {
  return (
    <svg className="flag-icon" viewBox="0 0 20 14" aria-hidden="true">
      <clipPath id="flag-dk-clip">
        <rect width="20" height="14" rx="2.5" />
      </clipPath>
      <g clipPath="url(#flag-dk-clip)">
        <rect width="20" height="14" fill="#C8102E" />
        <rect x="6.57" width="4" height="14" fill="#FFFFFF" />
        <rect y="5" width="20" height="4" fill="#FFFFFF" />
      </g>
    </svg>
  );
}

// Simplified Union Jack: blue field, white diagonals with thinner red
// diagonals, red central cross with a white fringe.
function FlagUK() {
  return (
    <svg className="flag-icon" viewBox="0 0 20 14" aria-hidden="true">
      <clipPath id="flag-uk-clip">
        <rect width="20" height="14" rx="2.5" />
      </clipPath>
      <g clipPath="url(#flag-uk-clip)">
        <rect width="20" height="14" fill="#012169" />
        <path d="M0 0 L20 14 M20 0 L0 14" stroke="#FFFFFF" strokeWidth="3" />
        <path d="M0 0 L20 14 M20 0 L0 14" stroke="#C8102E" strokeWidth="1.2" />
        <rect x="7.5" width="5" height="14" fill="#FFFFFF" />
        <rect y="4.5" width="20" height="5" fill="#FFFFFF" />
        <rect x="8.5" width="3" height="14" fill="#C8102E" />
        <rect y="5.5" width="20" height="3" fill="#C8102E" />
      </g>
    </svg>
  );
}

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
  themeMode: 'light' | 'dark';
  themeTitle: string;
  onToggleTheme: () => void;
}

// FRANK as a physical instrument: the check status centered along the top,
// then three seam-divided columns — round CRT with the GERTY face and the
// nameplate on the left, the dot-matrix phrase display in the middle, and
// the refresh/theme buttons stacked over the location on the right. Both
// screens glow in the rating's phosphor color.
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
  themeTitle,
  onToggleTheme,
}: StatusBarProps) {
  const displayRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLSpanElement>(null);
  const [marqueeDuration, setMarqueeDuration] = useState(0);
  const { lang, setLang, t } = useLang();

  // A phrase that fits stays solid; one that overflows becomes a slow walking
  // line. Measured off a hidden twin span so the marquee padding on the live
  // text never skews the measurement.
  useLayoutEffect(() => {
    const display = displayRef.current;
    const measureEl = measureRef.current;
    if (!display || !measureEl) return;

    const measure = () => {
      const textWidth = measureEl.offsetWidth;
      const displayWidth = display.clientWidth;
      if (textWidth > displayWidth) {
        // The marquee travels its own width plus the display width per loop.
        setMarqueeDuration((textWidth + displayWidth) / MARQUEE_SPEED);
      } else {
        setMarqueeDuration(0);
      }
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(display);
    return () => observer.disconnect();
  }, [phrase]);

  const isMarquee = marqueeDuration > 0;

  return (
    <header className="frank-device">
      <div className="container">
        <div className={`frank-device-shell rating-${rating}`}>
          <div
            className={`frank-cache ${cacheClass}`}
            aria-busy={refreshing}
            aria-label={cacheAriaLabel}
          >
            <span className="frank-cache-text">
              <span className="frank-cache-source">{sourceLabel}</span>
              {cacheDetail && <span className="frank-cache-detail">{cacheDetail}</span>}
            </span>
          </div>

          {/* One shared grid so the columns line up across rows: the CRT,
              display, and button stack all span the same top band, and the
              nameplate and location share the bottom line. */}
          <div className="frank-device-columns">
            <span className="frank-crt">
              <GertyFace rating={rating} />
            </span>

            <div className="frank-cell-display">
              <div
                ref={displayRef}
                className={`frank-display ${isMarquee ? 'is-marquee' : ''}`}
                role="status"
                aria-live="polite"
              >
                {/* Live regions announce CONTENT changes, not aria-label
                    changes - the announcement must be a real text node */}
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

            <div className="frank-actions">
              {/* Triangle: flag + refresh side by side, theme centered below
                  (flex-wrap in a two-buttons-wide cluster). */}
              <div className="header-btn-cluster">
                <button
                  type="button"
                  className="header-icon-btn"
                  onClick={() => setLang(lang === 'da' ? 'en' : 'da')}
                  aria-label={t('Switch to Danish')}
                >
                  {lang === 'da' ? <FlagDK /> : <FlagUK />}
                </button>
                <button
                  type="button"
                  className="header-icon-btn header-refresh-btn"
                  onClick={onRefresh}
                  disabled={refreshing}
                  aria-label={t('Refresh forecast')}
                >
                  <RefreshCw size={16} />
                </button>
                <button
                  type="button"
                  className="header-icon-btn"
                  onClick={onToggleTheme}
                  aria-label={themeTitle}
                >
                  {themeMode === 'light' ? <Moon size={16} /> : <Sun size={16} />}
                </button>
              </div>
            </div>

            <span className="frank-nameplate" aria-hidden="true">FRANK</span>

            <LocationSwitcher label={location} />
          </div>
        </div>
      </div>
    </header>
  );
}
