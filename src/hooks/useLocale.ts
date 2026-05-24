// React hook that subscribes to i18n locale changes and triggers a
// re-render when the active locale flips. Components that call t()
// inline don't need this — they pick up the new locale on their
// next render. But components whose render depends on the active
// locale (e.g. RTL flip, lang attribute) need a re-render trigger.
//
// Pure tiny hook so the i18n module stays React-free.

import { useEffect, useState } from 'react'
import { getLocale, onLocaleChange, type Locale } from '../lib/i18n'

/** Returns the active locale and re-renders the calling component
 *  whenever setLocale is called from anywhere. Cheap to use — the
 *  subscription is a single addEventListener / removeEventListener
 *  cycle per component instance. */
export function useLocale(): Locale {
  const [locale, setLocaleState] = useState<Locale>(() => getLocale())
  useEffect(() => {
    const unsubscribe = onLocaleChange((next) => setLocaleState(next))
    return unsubscribe
  }, [])
  return locale
}
