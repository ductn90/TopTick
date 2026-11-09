import { useEffect, useId, useRef, useState } from 'react'
import { t } from '../../shared/i18n'
import type { Instrument, Language, SearchMarket, SearchResponse, Watchlist } from '../../shared/types'
import { ChevronDownIcon, CloseCircleIcon, SearchIcon } from '../icons'
import type { Run } from './Settings'
import styles from './SymbolSearch.module.css'

const DEBOUNCE_MS = 300
const MARKETS: SearchMarket[] = ['all', 'vn', 'us', 'crypto']

interface SymbolSearchProps {
  watchlist: Watchlist
  run: Run
  lang: Language
}

/** A search response plus the query and market it answers, so Enter never acts on stale results. */
type Answer = SearchResponse & { query: string; market: SearchMarket }

export function SymbolSearch({ watchlist, run, lang }: SymbolSearchProps): React.JSX.Element {
  const [market, setMarket] = useState<SearchMarket>('all')
  const [query, setQuery] = useState('')
  const [response, setResponse] = useState<Answer | null>(null)
  const [failed, setFailed] = useState<Record<string, string>>({})
  const inputRef = useRef<HTMLInputElement>(null)
  const listId = useId()

  useEffect(() => {
    const q = query.trim()
    if (q === '') {
      setResponse(null)
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      void window.ticker.search(market, q).then((r) => {
        if (cancelled) return
        setResponse({ ...r, query: q, market })
        setFailed({})
      })
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [query, market])

  const inList = new Set(watchlist.items.map((i) => i.id))

  const add = async (instrument: Instrument): Promise<void> => {
    const result = await run({ type: 'addItem', watchlistId: watchlist.id, instrument }, { quiet: true })
    if (!result.ok) {
      setFailed((f) => ({ ...f, [instrument.id]: t(lang, `error.${result.code}`) }))
      return
    }
    // Ready for the next symbol.
    setQuery('')
    setResponse(null)
    setFailed({})
    inputRef.current?.focus()
  }

  const results = response?.results ?? []
  const current = response !== null && response.query === query.trim() && response.market === market

  return (
    <div className={styles.root}>
      <div className={styles.field}>
        <SearchIcon size={14} className={styles.searchIcon} />
        <input
          ref={inputRef}
          type="search"
          className={styles.input}
          data-testid="search-input"
          placeholder={t(lang, 'settings.search.placeholder')}
          aria-label={t(lang, 'settings.search.placeholder')}
          aria-controls={listId}
          value={query}
          maxLength={40}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setQuery('')
            if (e.key === 'Enter') {
              e.preventDefault()
              // Exactly one result for what is typed: Enter adds it.
              const only = current && results.length === 1 ? results[0]! : null
              if (only && !inList.has(only.id)) void add(only)
            }
          }}
        />
        {query !== '' && (
          <button
            type="button"
            className={styles.clear}
            data-testid="search-clear"
            aria-label={t(lang, 'settings.search.clear')}
            title={t(lang, 'settings.search.clear')}
            onClick={() => {
              setQuery('')
              inputRef.current?.focus()
            }}
          >
            <CloseCircleIcon size={14} />
          </button>
        )}
        <span className={styles.fieldDivider} aria-hidden="true" />
        <div className={styles.marketWrap}>
          <select
            className={styles.market}
            data-testid="search-market"
            aria-label={t(lang, 'settings.search.market')}
            title={t(lang, 'settings.search.market')}
            value={market}
            onChange={(e) => setMarket(e.target.value as SearchMarket)}
          >
            {MARKETS.map((m) => (
              <option key={m} value={m}>
                {t(lang, `market.${m}`)}
              </option>
            ))}
          </select>
          <ChevronDownIcon size={12} className={styles.marketChevron} />
        </div>
      </div>
      {response && (
        <div className={styles.results} id={listId} aria-live="polite">
          {response.unavailable && (
            <p className={styles.note} data-testid="search-unavailable">
              {t(lang, 'settings.search.unavailable')}
            </p>
          )}
          {results.length === 0 && !response.unavailable && (
            <p className={styles.note} data-testid="search-empty">
              {t(lang, 'settings.search.noResults')}
            </p>
          )}
          {results.length > 0 && (
            <ul className={styles.list} aria-label={t(lang, 'settings.search.placeholder')}>
              {results.map((r) => {
                const already = inList.has(r.id)
                const error = failed[r.id]
                return (
                  <li key={r.id} className={styles.result} data-testid="search-result" data-id={r.id}>
                    <span className={styles.symbol}>{r.displaySymbol}</span>
                    <span className={styles.name}>{lang === 'vi' ? r.nameVi : r.nameEn}</span>
                    <span className={styles.badge}>{t(lang, `market.${r.market}`)}</span>
                    {already || error ? (
                      <span className={styles.status} data-testid="result-status">
                        {already ? t(lang, 'error.DUPLICATE') : error}
                      </span>
                    ) : (
                      <button
                        type="button"
                        className={styles.add}
                        data-testid="add-result"
                        aria-label={`${t(lang, 'settings.search.add')} ${r.displaySymbol}`}
                        onClick={() => void add(r)}
                      >
                        {t(lang, 'settings.search.add')}
                      </button>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
