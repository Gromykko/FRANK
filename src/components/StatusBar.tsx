import { useEffect, useState } from 'react';
import { Moon, RefreshCw, Sun } from 'lucide-react';
import GertyFace from './GertyFace';
import LocationSwitcher from './LocationSwitcher';
import { FlagDK, FlagUK } from './FlagIcons';
import { useLang } from '../i18n';
import type { DisplayStatus } from '../features/safety/analyzeSafetyConditions';

// Matches the device shell's own breakpoint in components.css.
const NARROW_SCREEN = '(max-width: 480px)';

// The glass is a different size on a phone, so it says a different thing. Wide,
// it has room for FRANK's one-liner on a single line. Narrow, that same line
// wrapped to three or four rows of tiny text, so it shows the verdict instead -
// which is the part worth reading at a glance anyway.
function useNarrowScreen(): boolean {
  const [narrow, setNarrow] = useState(false);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia(NARROW_SCREEN);
    const update = () => setNarrow(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  return narrow;
}


interface StatusBarProps {
  // DisplayStatus: 'none' when every check is off, so the bar renders
  // neutral instead of claiming a verdict.
  rating: DisplayStatus;
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
  const { lang, setLang, t } = useLang();
  const narrow = useNarrowScreen();

  return (
    <header className="frank-device">
      <div className="container">
        <div className={`frank-device-shell rating-${rating}`}>
          <div
            className={`frank-cache ${cacheClass}`}
            aria-busy={refreshing}
            // role is required: aria-label is PROHIBITED on a generic element,
            // so screen readers dropped it — and with it the whole long-form
            // honesty sentence ("You're offline, so FRANK is showing your last
            // saved forecast from …"), which is computed and rendered nowhere
            // else. `group` rather than `status` so it doesn't compete with the
            // display's live region for announcements.
            role="group"
            aria-label={cacheAriaLabel}
          >
            {/* aria-busy changes are not a reliable spoken announcement on a
                labelled group. Keep one real atomic live-region text node so
                refresh start and its settled result are both announced while
                focus remains on the refresh button. */}
            <span className="sr-only" role="status" aria-atomic="true">
              {cacheAriaLabel}
            </span>
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
                className="frank-display"
                role="status"
                aria-live="polite"
                aria-atomic="true"
              >
                {/* The explicit safety verdict is the primary visible answer.
                    The personality line is secondary and never makes a user
                    wait for a scrolling animation to discover the decision. */}
                {/* Both kept for screen readers, both dropped from the glass.
                    The device says one thing now, in its own voice; the verdict
                    itself reads above the conditions that justify it, which is
                    where someone looks for the reasoning anyway. Three stacked
                    messages here wrapped to five lines on a phone. */}
                <span className="sr-only">{srTitle}</span>
                <span className="sr-only">{srSubtitle}</span>
                <span
                  className={`frank-display-text ${narrow ? 'is-verdict' : ''}`}
                  aria-hidden="true"
                >
                  {narrow ? srTitle : phrase}
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
                  aria-label={t(lang === 'da' ? 'Switch to English' : 'Switch to Danish')}
                >
                  {lang === 'da' ? <FlagDK /> : <FlagUK />}
                </button>
                <button
                  type="button"
                  className="header-icon-btn header-refresh-btn"
                  // aria-disabled, not disabled: disabling the element the user
                  // just activated makes the browser blur it, dropping keyboard
                  // focus to <body> and losing a screen reader's place at the
                  // top of the page. The refresh state is already announced via
                  // aria-busy on the cache group above.
                  onClick={() => { if (!refreshing) onRefresh(); }}
                  aria-disabled={refreshing}
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
