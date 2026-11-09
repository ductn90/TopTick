import type { ErrorCode, Language } from '../types'
import { en, type MessageKey } from './en'
import { vi } from './vi'

export type { MessageKey }

export const dictionaries: Record<Language, Record<MessageKey, string>> = { en, vi }

/** Look up a message and replace `{name}` placeholders with `vars`. */
export function t(lang: Language, key: MessageKey, vars?: Record<string, string | number>): string {
  const template = dictionaries[lang][key] ?? en[key]
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match
  )
}

export function errorMessage(lang: Language, code: ErrorCode): string {
  return t(lang, `error.${code}`)
}

/** First-run language from the OS locale [A9]: vi* -> vi, everything else -> en. */
export function detectLanguage(locale: string | undefined | null): Language {
  return locale && locale.toLowerCase().startsWith('vi') ? 'vi' : 'en'
}
