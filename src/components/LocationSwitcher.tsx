import { useEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MapPin, Check, ChevronDown } from 'lucide-react';
import { AVAILABLE_LOCATIONS, CURRENT_LOCATION, setLocation } from '../config/locations';
import { useForecastAvailability } from '../features/forecast/useForecastAvailability';
import { useLang } from '../i18n';

// The header's location readout, made switchable. With a single configured
// location it stays a plain label; with more it becomes a button that opens a
// small city picker (choosing one persists it and reloads - each city keeps
// its own settings and cache, so nothing is lost). The picker implements the
// ARIA menu keyboard contract: focus moves into the menu on open, arrows/Home/
// End walk the items, Escape closes and returns focus to the trigger.
export default function LocationSwitcher({
  label,
  currentState,
}: {
  label: string;
  currentState?: 'initializing';
}) {
  const { t } = useLang();
  const currentStateLabel = currentState === 'initializing' ? t('preparing') : null;
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);
  const { availability, settled } = useForecastAvailability(open ? openedAt : 0);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  const handleToggle = () => {
    setOpen((prev) => {
      const next = !prev;
      if (next) setOpenedAt(Date.now());
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: PointerEvent) => {
      if (rootRef.current?.contains(e.target as Node)) return;
      setOpen(false);
      // Opening moved focus INTO the menu, so closing this way unmounts the
      // focused button and focus falls to <body> — the user's next Tab
      // restarts from the top of the document. Same restore as Escape.
      triggerRef.current?.focus();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Menu pattern: Tab closes the menu. Handled as focus LEAVING the root rather
  // than as a Tab keydown — closing on keydown unmounts the focused item before
  // the browser resolves the default action, so focus fell to <body> and the
  // next Tab restarted from the top of the document.
  const onRootBlur = (e: ReactFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    if (e.relatedTarget && rootRef.current?.contains(e.relatedTarget as Node)) return;
    setOpen(false);
  };

  // Per the menu pattern, opening moves focus to the first item.
  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>('.location-switcher-option')?.focus();
  }, [open]);

  const onMenuKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>('.location-switcher-option') ?? [])];
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    let next = -1;
    if (e.key === 'ArrowDown') next = (idx + 1) % items.length;
    else if (e.key === 'ArrowUp') next = (idx - 1 + items.length) % items.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = items.length - 1;
    if (next === -1) return;
    e.preventDefault();
    items[next].focus();
  };

  if (AVAILABLE_LOCATIONS.length < 2) {
    return (
      <span className="frank-location">
        <MapPin size={12} />
        {label}
        {currentStateLabel && <span className="location-switcher-state">{currentStateLabel}</span>}
      </span>
    );
  }

  return (
    <div className="frank-location location-switcher" ref={rootRef} onBlur={onRootBlur}>
      <button
        type="button"
        ref={triggerRef}
        className="location-switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="location-switcher-menu"
        onClick={handleToggle}
      >
        <MapPin size={12} />
        {label}
        {currentStateLabel && <span className="location-switcher-state">{currentStateLabel}</span>}
        <ChevronDown size={12} className="location-switcher-chevron" aria-hidden="true" />
      </button>

      {open && (
        <ul
          id="location-switcher-menu"
          className="location-switcher-menu"
          role="menu"
          aria-label={t('Choose location')}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {AVAILABLE_LOCATIONS.map((loc) => {
            const isCurrent = loc.id === CURRENT_LOCATION.id;
            const isAvailable = availability ? availability.availableLocationIds.includes(loc.id) : true;
            const isPreparing = settled && availability && !isAvailable;
            return (
              <li key={loc.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`location-switcher-option ${isCurrent ? 'is-current' : ''}`}
                  onClick={() => {
                    if (isCurrent) {
                      setOpen(false);
                      // The focused menu item is about to unmount; return focus
                      // to the control that opened it instead of dropping to body.
                      triggerRef.current?.focus();
                      return;
                    }
                    // On a blocked-storage failure setLocation deliberately
                    // does not reload. Leave the open menu and focused item in
                    // place so another choice (or Escape) still works.
                    if (!setLocation(loc.id)) return;
                  }}
                >
                  <span className="location-switcher-check">{isCurrent && <Check size={13} />}</span>
                  {loc.areaName}
                  {isCurrent && currentStateLabel && (
                    <span className="location-switcher-pill is-initializing">{currentStateLabel}</span>
                  )}
                  {!isCurrent && isPreparing && (
                    <span className="location-switcher-pill is-initializing">{t('preparing')}</span>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
