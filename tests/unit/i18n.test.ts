import { describe, expect, it } from 'vitest'
import { detectLanguage, dictionaries, errorMessage, t } from '../../src/shared/i18n'
import type { ErrorCode } from '../../src/shared/types'

const ERROR_CODES: ErrorCode[] = [
  'NAME_INVALID',
  'NAME_TAKEN',
  'LIST_FULL',
  'DUPLICATE',
  'NOT_FOUND',
  'LAST_WATCHLIST',
  'TOO_MANY_WATCHLISTS',
  'BAD_REQUEST'
]

describe('dictionaries', () => {
  it('en and vi have identical key sets', () => {
    expect(Object.keys(dictionaries.vi).sort()).toEqual(Object.keys(dictionaries.en).sort())
  })

  it('has no empty messages and keeps the same placeholders', () => {
    for (const key of Object.keys(dictionaries.en) as (keyof typeof dictionaries.en)[]) {
      expect(dictionaries.en[key].length).toBeGreaterThan(0)
      expect(dictionaries.vi[key].length).toBeGreaterThan(0)
      const vars = (s: string): string[] => (s.match(/\{\w+\}/g) ?? []).sort()
      expect(vars(dictionaries.vi[key])).toEqual(vars(dictionaries.en[key]))
    }
  })

  it('localizes every error code', () => {
    for (const code of ERROR_CODES) {
      expect(errorMessage('en', code)).not.toBe(errorMessage('vi', code))
    }
    expect(errorMessage('en', 'DUPLICATE')).toBe('Already in list.')
  })

  it('has theme labels Dark/Light/System and Tối/Sáng/Theo hệ thống', () => {
    expect(['dark', 'light', 'system'].map((k) => t('en', `theme.${k}` as 'theme.dark'))).toEqual(['Dark', 'Light', 'System'])
    expect(['dark', 'light', 'system'].map((k) => t('vi', `theme.${k}` as 'theme.dark'))).toEqual([
      'Tối',
      'Sáng',
      'Theo hệ thống'
    ])
  })
})

describe('t', () => {
  it('interpolates variables and leaves unknown placeholders', () => {
    expect(t('en', 'settings.watchlists.deleteConfirm', { name: 'Tech' })).toBe('Delete watchlist “Tech”?')
    expect(t('vi', 'settings.items.hide', { symbol: 'FPT' })).toBe('Ẩn FPT')
    expect(t('en', 'settings.items.hide')).toBe('Hide {symbol}')
  })
})

describe('detectLanguage', () => {
  it.each([
    ['vi', 'vi'],
    ['vi-VN', 'vi'],
    ['VI', 'vi'],
    ['en-US', 'en'],
    ['fr-FR', 'en'],
    ['', 'en'],
    [undefined, 'en']
  ] as const)('%j -> %s', (locale, lang) => {
    expect(detectLanguage(locale)).toBe(lang)
  })
})
