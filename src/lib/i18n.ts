// Lightweight i18n. No external library — the catalog lives in
// memory + localStorage so message lookup is sync and zero-dep.
//
// Why hand-rolled vs react-intl / next-intl: those bring formatting
// engines (date, number, plural) we don't need yet, and a
// React-context plumbing tax that complicates server-render scope.
// When/if we ship server-rendered marketing pages, we can swap.
//
// Usage:
//   import { t } from '../../lib/i18n'
//   <span>{t('toolbar.open')}</span>
//
// Add language packs by importing them into LANG_CATALOGS below.
// The active language is read from localStorage; default 'en'.
//
// Pluralization is intentionally sketchy: keys that take a count get
// a suffix `_one` or `_other` and the helper picks based on count.
// English-style only; Russian-style 'few' requires a follow-up.

export type Locale = 'en' | 'es' | 'fr' | 'de' | 'zh-CN'

export const SUPPORTED_LOCALES: { id: Locale; label: string }[] = [
  { id: 'en', label: 'English' },
  { id: 'es', label: 'Español' },
  { id: 'fr', label: 'Français' },
  { id: 'de', label: 'Deutsch' },
  { id: 'zh-CN', label: '简体中文' },
]

const STORAGE_KEY = 'open-satchel:locale'

// Active-locale cache. Read once on module init from localStorage;
// subsequent setLocale calls update both this cache and the storage.
let activeLocale: Locale = 'en'
try {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null
  if (stored && SUPPORTED_LOCALES.some((l) => l.id === stored)) {
    activeLocale = stored as Locale
  }
} catch {
  /* no localStorage */
}

// English seed catalog — the source of truth. Other languages ship
// as overrides; missing keys fall back to en. Keys are dotted paths
// roughly mirroring the UI surface they originate from.
const EN: Record<string, string> = {
  // Top-bar
  'toolbar.open': 'Open',
  'toolbar.save': 'Save',
  'toolbar.find': 'Find',
  'toolbar.sidebar': 'Sidebar',
  'toolbar.preferences': 'Preferences',
  'toolbar.help': 'Help',

  // Empty state
  'empty.tagline': 'A universal file editor that lives on your machine, not in the cloud.',
  'empty.drop-cta': 'Drop a PDF, or click to open',
  'empty.drop-sub': 'pdf — full editor · other formats coming in M5 / M6',
  'empty.recent-header': 'Recent',
  'empty.pinned-header': 'Pinned',
  'empty.folders-header': 'Folders',
  'empty.add-folder': '+ Folder',
  'empty.no-recents': 'No recent files yet. Open one to get started.',
  'empty.no-folders': 'No favorite folders yet. Click + Folder to add one.',
  'empty.available-now': 'Available now',
  'empty.coming-soon': 'Coming in M5 · M6',

  // Ethos footer
  'empty.ethos.no-subs': 'No subscriptions',
  'empty.ethos.no-subs-body': "Buy it once, or don't buy it at all.",
  'empty.ethos.no-email': 'No email gate',
  'empty.ethos.no-email-body': 'It works the moment you launch it.',
  'empty.ethos.no-cloud': 'No cloud sync',
  'empty.ethos.no-cloud-body': 'Your files never leave your machine.',
  'empty.ethos.no-ai': 'No AI calls',
  'empty.ethos.no-ai-body': 'Local-first — no API dependencies.',

  // Common buttons
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.apply': 'Apply',
  'common.close': 'Close',
  'common.reset': 'Reset',
  'common.find': 'Find',
  'common.replace': 'Replace',
  'common.replace-all': 'Replace all',
  'common.next': 'Next',
  'common.prev': 'Back',
  'common.skip': 'Skip',
  'common.done': 'Done',
  'common.delete': 'Delete',
  'common.add': 'Add',
  'common.remove': 'Remove',
  'common.import': 'Import',
  'common.export': 'Export',

  // Find & Replace
  'find.placeholder': 'Find in document',
  'find.replace-placeholder': 'Replace with',
  'find.match-case': 'Match case',
  'find.whole-word': 'Whole word',
  'find.regex': 'Regex',
  'find.no-matches': 'No matches',
  'find.type-to-search': 'Type to search',

  // Pluralized
  'count.matches_one': '{count} match',
  'count.matches_other': '{count} matches',
  'count.pages_one': '{count} page',
  'count.pages_other': '{count} pages',
}

// Other locales: just overrides. Missing keys fall back to English.
const ES: Record<string, string> = {
  'toolbar.open': 'Abrir',
  'toolbar.save': 'Guardar',
  'toolbar.find': 'Buscar',
  'toolbar.sidebar': 'Barra lateral',
  'toolbar.preferences': 'Preferencias',
  'toolbar.help': 'Ayuda',
  'empty.drop-cta': 'Suelta un PDF o haz clic para abrir',
  'empty.recent-header': 'Recientes',
  'empty.pinned-header': 'Anclados',
  'empty.folders-header': 'Carpetas',
  'empty.no-recents': 'Aún no hay archivos recientes. Abre uno para empezar.',
  'common.cancel': 'Cancelar',
  'common.save': 'Guardar',
  'common.apply': 'Aplicar',
  'common.close': 'Cerrar',
  'common.reset': 'Restablecer',
}
const FR: Record<string, string> = {
  'toolbar.open': 'Ouvrir',
  'toolbar.save': 'Enregistrer',
  'toolbar.find': 'Rechercher',
  'toolbar.sidebar': 'Barre latérale',
  'toolbar.preferences': 'Préférences',
  'toolbar.help': 'Aide',
  'empty.drop-cta': 'Déposez un PDF ou cliquez pour ouvrir',
  'empty.recent-header': 'Récents',
  'empty.pinned-header': 'Épinglés',
  'empty.folders-header': 'Dossiers',
  'empty.no-recents': "Aucun fichier récent. Ouvrez-en un pour commencer.",
  'common.cancel': 'Annuler',
  'common.save': 'Enregistrer',
  'common.apply': 'Appliquer',
  'common.close': 'Fermer',
  'common.reset': 'Réinitialiser',
}
const DE: Record<string, string> = {
  'toolbar.open': 'Öffnen',
  'toolbar.save': 'Speichern',
  'toolbar.find': 'Suchen',
  'toolbar.sidebar': 'Seitenleiste',
  'toolbar.preferences': 'Einstellungen',
  'toolbar.help': 'Hilfe',
  'empty.drop-cta': 'PDF ablegen oder klicken zum Öffnen',
  'empty.recent-header': 'Zuletzt',
  'empty.pinned-header': 'Angepinnt',
  'empty.folders-header': 'Ordner',
  'empty.no-recents': 'Noch keine Dateien. Öffnen Sie eine, um zu beginnen.',
  'common.cancel': 'Abbrechen',
  'common.save': 'Speichern',
  'common.apply': 'Anwenden',
  'common.close': 'Schließen',
  'common.reset': 'Zurücksetzen',
}
const ZH_CN: Record<string, string> = {
  'toolbar.open': '打开',
  'toolbar.save': '保存',
  'toolbar.find': '查找',
  'toolbar.sidebar': '侧边栏',
  'toolbar.preferences': '偏好设置',
  'toolbar.help': '帮助',
  'empty.drop-cta': '拖入 PDF,或点击打开',
  'empty.recent-header': '最近',
  'empty.pinned-header': '已钉选',
  'empty.folders-header': '文件夹',
  'empty.no-recents': '暂无最近文件。打开一个开始使用。',
  'common.cancel': '取消',
  'common.save': '保存',
  'common.apply': '应用',
  'common.close': '关闭',
  'common.reset': '重置',
}

const LANG_CATALOGS: Record<Locale, Record<string, string>> = {
  en: EN,
  es: ES,
  fr: FR,
  de: DE,
  'zh-CN': ZH_CN,
}

/** Lookup a translated string. Falls back through:
 *    active locale → English → the key itself.
 *  Substitutes {param} placeholders from the optional vars map. */
export function t(key: string, vars?: Record<string, string | number>): string {
  const cat = LANG_CATALOGS[activeLocale] ?? EN
  let template = cat[key] ?? EN[key] ?? key
  if (vars) {
    template = template.replace(/\{(\w+)\}/g, (_, name) => {
      const v = vars[name]
      return v === undefined ? `{${name}}` : String(v)
    })
  }
  return template
}

/** Plural-aware variant. Picks _one for count===1, _other otherwise.
 *  English-style; locales with more plural forms (Russian: few/many)
 *  need a per-locale plural-rules layer — out of scope for v1. */
export function tn(keyBase: string, count: number, vars?: Record<string, string | number>): string {
  const suffix = count === 1 ? '_one' : '_other'
  return t(keyBase + suffix, { ...(vars ?? {}), count })
}

export function getLocale(): Locale {
  return activeLocale
}

export function setLocale(loc: Locale): void {
  if (!SUPPORTED_LOCALES.some((l) => l.id === loc)) return
  activeLocale = loc
  try {
    localStorage.setItem(STORAGE_KEY, loc)
  } catch {
    /* private mode */
  }
  // Notify listeners so React can re-render. We use a custom event
  // because the i18n module shouldn't depend on Zustand or React.
  try {
    window.dispatchEvent(new CustomEvent('open-satchel:locale-changed', { detail: { locale: loc } }))
  } catch {
    /* SSR / non-DOM context */
  }
}

/** Subscribe to locale changes from any non-React module. Returns an
 *  unsubscribe function. Use the useLocale React hook in
 *  components — this is the lower-level primitive. */
export function onLocaleChange(handler: (loc: Locale) => void): () => void {
  const wrapped = (e: Event) => {
    const detail = (e as CustomEvent).detail as { locale: Locale } | undefined
    if (detail?.locale) handler(detail.locale)
  }
  try {
    window.addEventListener('open-satchel:locale-changed', wrapped as EventListener)
  } catch {
    return () => {}
  }
  return () => {
    try {
      window.removeEventListener('open-satchel:locale-changed', wrapped as EventListener)
    } catch {
      /* noop */
    }
  }
}
