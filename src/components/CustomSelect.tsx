import { useState, useRef, useEffect, useId, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';

interface CustomSelectProps<T extends string | number> {
  value: T;
  onChange: (val: T) => void;
  options: { value: T; label: React.ReactNode }[];
  disabled?: boolean;
  compact?: boolean;
  // Accessible name for the trigger. The visible caption beside these selects
  // is a plain span, so without it the control announces only its value.
  ariaLabel?: string;
}

export default function CustomSelect<T extends string | number>({ value, onChange, options, disabled, compact = false, ariaLabel }: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listboxId = useId();

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Syncs on OPEN only. `options` and `value` are intentionally out of the
  // deps: the parent rebuilds the options array on every render (including the
  // 60s forecast heartbeat), and re-running this mid-interaction snapped the
  // arrow-key focus ring back to the selected item.
  useEffect(() => {
    if (isOpen) {
      const idx = options.findIndex(o => o.value === value);
      setFocusedIndex(idx >= 0 ? idx : 0);
    } else {
      setFocusedIndex(-1);
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  // Keep the arrow-key-focused option visible: the dropdown is capped at
  // max-height, so a focused option past the fold would otherwise never scroll
  // into view (it only gets a visual .is-focused class, no real DOM focus).
  useEffect(() => {
    if (isOpen && focusedIndex >= 0) {
      document.getElementById(`${listboxId}-opt-${focusedIndex}`)?.scrollIntoView({ block: 'nearest' });
    }
  }, [isOpen, focusedIndex, listboxId]);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (disabled) return;
    
    switch (e.key) {
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (isOpen && focusedIndex >= 0 && focusedIndex < options.length) {
          // Reselecting the current option is a no-op (live-apply settings
          // would otherwise flip a preset user into Custom mode for nothing)
          if (options[focusedIndex].value !== value) onChange(options[focusedIndex].value);
          setIsOpen(false);
        } else if (!isOpen) {
          setIsOpen(true);
        }
        break;
      case 'Escape':
        if (isOpen) {
          e.preventDefault();
          setIsOpen(false);
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setFocusedIndex(prev => Math.min(prev + 1, options.length - 1));
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          setFocusedIndex(prev => Math.max(prev - 1, 0));
        }
        break;
      // Required by the listbox pattern, and both were missing.
      case 'Home':
        if (isOpen) { e.preventDefault(); setFocusedIndex(0); }
        break;
      case 'End':
        if (isOpen) { e.preventDefault(); setFocusedIndex(options.length - 1); }
        break;
      // Deliberately NOT prevented — let Tab move focus on. Without this the
      // popup stayed rendered at z-index 1000 over the content below, with
      // aria-expanded="true" on a control the user had already left.
      case 'Tab':
        setIsOpen(false);
        break;
    }
  };

  const selectedOption = options.find(o => o.value === value);

  return (
    <div
      ref={containerRef}
      className={`custom-select-container ${compact ? 'is-compact' : ''} ${isOpen ? 'is-open' : ''}`}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        ref={triggerRef}
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="custom-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        // The visible "Min Duration"/"Water level" text is a sibling span, not
        // a <label>, so without this a screen reader announces only the value.
        aria-label={ariaLabel}
        // Lives on the FOCUSED element (this button), not the listbox -
        // otherwise screen readers never hear arrow-key navigation
        aria-activedescendant={isOpen && focusedIndex >= 0 ? `${listboxId}-opt-${focusedIndex}` : undefined}
      >
        <span className="custom-select-value">
          {selectedOption ? selectedOption.label : value}
        </span>
        <ChevronDown size={compact ? 12 : 14} className="custom-select-chevron" />
      </button>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          className="custom-select-dropdown"
        >
          {options.map((opt, i) => (
            <button
              id={`${listboxId}-opt-${i}`}
              key={opt.value}
              type="button"
              role="option"
              // Focus stays on the trigger and moves via aria-activedescendant;
              // tabbable options would fight that model and trap Tab in the list.
              tabIndex={-1}
              aria-selected={opt.value === value}
              onMouseDown={(event) => {
                // A pointer press otherwise focuses this temporary option;
                // closing the popup then unmounts it and drops focus to body.
                event.preventDefault();
              }}
              onClick={() => {
                if (opt.value !== value) onChange(opt.value);
                setIsOpen(false);
                triggerRef.current?.focus();
              }}
              className={`custom-select-option ${opt.value === value ? 'is-selected' : ''} ${i === focusedIndex ? 'is-focused' : ''}`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
