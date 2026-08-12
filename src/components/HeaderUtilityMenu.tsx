import { useEffect, useRef, useState } from 'react';
import type { FocusEvent as ReactFocusEvent } from 'react';
import { Check, MoreHorizontal } from 'lucide-react';
import { useLang } from '../i18n';
import type { Lang } from '../i18n';
import type { ThemeMode } from '../hooks/useTheme';

interface HeaderUtilityMenuProps {
  themeMode: ThemeMode;
  onThemeChange: (mode: ThemeMode) => void;
}

export default function HeaderUtilityMenu({ themeMode, onThemeChange }: HeaderUtilityMenuProps) {
  const { lang, setLang, t } = useLang();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onOutside = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setOpen(false);
      triggerRef.current?.focus();
    };

    document.addEventListener('pointerdown', onOutside);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onOutside);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    panelRef.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, [open]);

  const onRootBlur = (event: ReactFocusEvent<HTMLDivElement>) => {
    if (!open) return;
    if (event.relatedTarget && rootRef.current?.contains(event.relatedTarget as Node)) return;
    setOpen(false);
  };

  const languageOption = (value: Lang, label: string) => (
    <button
      type="button"
      className={`frank-utility-option ${lang === value ? 'is-selected' : ''}`}
      aria-pressed={lang === value}
      onClick={() => setLang(value)}
    >
      <span>{label}</span>
      <span className="frank-utility-check" aria-hidden="true">
        {lang === value && <Check size={15} />}
      </span>
    </button>
  );

  const themeOption = (value: ThemeMode, label: string) => (
    <button
      type="button"
      className={`frank-utility-option ${themeMode === value ? 'is-selected' : ''}`}
      aria-pressed={themeMode === value}
      onClick={() => onThemeChange(value)}
    >
      <span>{label}</span>
      <span className="frank-utility-check" aria-hidden="true">
        {themeMode === value && <Check size={15} />}
      </span>
    </button>
  );

  return (
    <div className="frank-utility" ref={rootRef} onBlur={onRootBlur}>
      <button
        type="button"
        ref={triggerRef}
        className="frank-utility-trigger"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={t('Language and appearance')}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="frank-utility-disc" aria-hidden="true">
          <MoreHorizontal size={20} />
        </span>
      </button>

      {open && (
        <div
          ref={panelRef}
          className="frank-utility-panel"
          role="dialog"
          aria-label={t('Language and appearance')}
        >
          <div className="frank-utility-group" role="group" aria-labelledby="frank-language-label">
            <span className="frank-utility-label" id="frank-language-label">{t('Language')}</span>
            {languageOption('da', 'Dansk')}
            {languageOption('en', 'English')}
          </div>

          <div className="frank-utility-group" role="group" aria-labelledby="frank-appearance-label">
            <span className="frank-utility-label" id="frank-appearance-label">{t('Appearance')}</span>
            {themeOption('light', t('Light'))}
            {themeOption('dark', t('Dark'))}
          </div>
        </div>
      )}
    </div>
  );
}
