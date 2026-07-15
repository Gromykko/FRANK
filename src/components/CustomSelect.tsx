import { useState, useRef, useEffect, type KeyboardEvent } from 'react';
import { ChevronDown } from 'lucide-react';

interface CustomSelectProps<T extends string | number> {
  value: T;
  onChange: (val: T) => void;
  options: { value: T; label: React.ReactNode }[];
  disabled?: boolean;
  compact?: boolean;
}

export default function CustomSelect<T extends string | number>({ value, onChange, options, disabled, compact = false }: CustomSelectProps<T>) {
  const [isOpen, setIsOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(-1);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useRef(`listbox-${Math.random().toString(36).slice(2, 9)}`).current;

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  useEffect(() => {
    if (isOpen) {
      const idx = options.findIndex(o => o.value === value);
      setFocusedIndex(idx >= 0 ? idx : 0);
    } else {
      setFocusedIndex(-1);
    }
  }, [isOpen, value, options]);

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
        onClick={() => !disabled && setIsOpen(!isOpen)}
        disabled={disabled}
        className="custom-select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
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
              aria-selected={opt.value === value}
              onClick={() => {
                if (opt.value !== value) onChange(opt.value);
                setIsOpen(false);
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
