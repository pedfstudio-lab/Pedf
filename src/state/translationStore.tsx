/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { defaultProviders } from '@/lib/providers';
import type { LanguageProvider } from '@/lib/providers/types';
import { CleanPageCache } from '@/lib/translate/cleanPages';
import { PageTranslationCache } from '@/lib/translate/pageTranslation';
import { useDocumentStore } from './documentStore';
import { usePrefs } from './prefsStore';
import type { SupportedLanguageCode } from './prefsStore';

interface TranslationState {
  readonly language: SupportedLanguageCode;
  readonly preferredLanguage: SupportedLanguageCode;
  readonly cache: PageTranslationCache;
  readonly cleanPages: CleanPageCache;
  readonly provider: Pick<LanguageProvider, 'translate'>;
  readonly privacyNotice: boolean;
  setLanguage(language: SupportedLanguageCode): void;
  showOriginal(): void;
  notePrivacy(): void;
  dismissPrivacy(): void;
}
const Context = createContext<TranslationState | null>(null);

/** Ephemeral view state: deliberately separate from edits, chat preferences and projects. */
export function TranslationStoreProvider({ children, provider: supplied }: {
  readonly children: ReactNode; readonly provider?: Pick<LanguageProvider, 'translate'>;
}) {
  const { document } = useDocumentStore();
  const { preferredLanguage } = usePrefs();
  const [view, setView] = useState({ document, language: 'en-IN' as SupportedLanguageCode });
  const [privacy, setPrivacy] = useState<'unseen' | 'visible' | 'dismissed'>('unseen');
  // Reopening a PDF deliberately drops all translation text, including cached snippets.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cache = useMemo(() => new PageTranslationCache(), [document]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const cleanPages = useMemo(() => new CleanPageCache(), [document]);
  useEffect(() => () => cleanPages.clear(), [cleanPages]);
  const provider = useMemo(() => supplied ?? defaultProviders(), [supplied]);
  const language = view.document === document ? view.language : 'en-IN';
  const notePrivacy = useCallback(() => setPrivacy(current => current === 'unseen' ? 'visible' : current), []);
  const setLanguage = useCallback((next: SupportedLanguageCode) => {
    if (next !== 'en-IN') notePrivacy();
    setView({ document, language: next });
  }, [document, notePrivacy]);
  const showOriginal = useCallback(() => setLanguage('en-IN'), [setLanguage]);
  const dismissPrivacy = useCallback(() => setPrivacy('dismissed'), []);
  const value = useMemo(() => ({ language, preferredLanguage, cache, cleanPages, provider, setLanguage, showOriginal,
    privacyNotice: privacy === 'visible', notePrivacy, dismissPrivacy }),
  [language, preferredLanguage, cache, cleanPages, provider, setLanguage, showOriginal, privacy, notePrivacy, dismissPrivacy]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

/** Optional so standalone PDF/editor consumers keep their existing behaviour. */
export function useTranslation(): TranslationState | null { return useContext(Context); }
