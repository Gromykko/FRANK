import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { interpolate } from './interpolate';
import type { Translate } from './interpolate';
import { da } from './da';
import { setDateLocale } from '../utils/date';
import { readStorage } from '../utils/storage';

export type Lang = 'en' | 'da';

const LANG_STORAGE_KEY = 'ffkajak_lang';

interface LangContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  // Keys are the full English source strings: readable call sites, and a
  // missing Danish entry soft-fails to the English text.
  t: Translate;
}

const LangContext = createContext<LangContextValue>({
  lang: 'en',
  setLang: () => {},
  t: interpolate,
});

const applyDateLocale = (lang: Lang) => setDateLocale(lang === 'da' ? 'da-DK' : 'en-GB');

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => {
    // Danish app for a Danish fjord: default 'da' unless English was chosen.
    const stored: Lang = readStorage(LANG_STORAGE_KEY) === 'en' ? 'en' : 'da';
    // Before the first render formats any date — a useEffect would flash en-GB.
    applyDateLocale(stored);
    document.documentElement.lang = stored;
    return stored;
  });

  const setLang = useCallback((next: Lang) => {
    applyDateLocale(next);
    document.documentElement.lang = next;
    try {
      localStorage.setItem(LANG_STORAGE_KEY, next);
    } catch {
      // Storage blocked (private mode) — the choice still applies this session.
    }
    setLangState(next);
  }, []);

  const t = useCallback<Translate>(
    (s, ...args) => interpolate(lang === 'da' ? da[s] ?? s : s, ...args),
    [lang]
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <LangContext.Provider value={value}>{children}</LangContext.Provider>;
}

// The hook lives beside its provider on purpose — they share the context
// object and are only ever imported together.
// oxlint-disable-next-line react/only-export-components
export function useLang(): LangContextValue {
  return useContext(LangContext);
}
