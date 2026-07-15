import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MapPin, Check, ChevronDown } from 'lucide-react';
import { AVAILABLE_LOCATIONS, CURRENT_LOCATION, setLocation } from '../config/locations';
import { useLang } from '../i18n';

// The header's location readout, made switchable. With a single configured
// location it stays a plain label; with more it becomes a button that opens a
// small city picker (choosing one persists it and reloads - each city keeps
// its own settings and cache, so nothing is lost). The picker implements the
// ARIA menu keyboard contract: focus moves into the menu on open, arrows/Home/
// End walk the items, Escape closes and returns focus to the trigger.
export default function LocationSwitcher({ label }: { label: string }) {
  const { t } = useLang();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
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
      </span>
    );
  }

  return (
    <div className="frank-location location-switcher" ref={rootRef}>
      <button
        type="button"
        ref={triggerRef}
        className="location-switcher-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MapPin size={12} />
        {label}
        <ChevronDown size={12} className="location-switcher-chevron" aria-hidden="true" />
      </button>

      {open && (
        <ul
          className="location-switcher-menu"
          role="menu"
          aria-label={t('Choose location')}
          ref={menuRef}
          onKeyDown={onMenuKeyDown}
        >
          {AVAILABLE_LOCATIONS.map((loc) => {
            const isCurrent = loc.id === CURRENT_LOCATION.id;
            return (
              <li key={loc.id} role="none">
                <button
                  type="button"
                  role="menuitem"
                  aria-current={isCurrent ? 'true' : undefined}
                  className={`location-switcher-option ${isCurrent ? 'is-current' : ''}`}
                  onClick={() => (isCurrent ? setOpen(false) : setLocation(loc.id))}
                >
                  <span className="location-switcher-check">{isCurrent && <Check size={13} />}</span>
                  {loc.areaName}
                  {loc.provisional && (
                    <span className="location-switcher-pill" title={t('Provisional — limits not yet locally calibrated')}>{t('provisional')}</span>
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
