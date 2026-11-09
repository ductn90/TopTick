import { memo } from 'react'
import { directionGlyph, formatPct, formatPrice, formatTime } from '../../shared/format'
import { t, type MessageKey } from '../../shared/i18n'
import { priceTone, type PriceTone } from '../../shared/priceTone'
import type { Instrument, InstrumentId, Language, Quote, QuoteSource, Series } from '../../shared/types'
import { PriceText } from './PriceText'
import { Sparkline, type Direction } from './Sparkline'
import styles from './TickerItem.module.css'

export interface ItemModel {
  id: InstrumentId
  instrument: Instrument
  quote: Quote | undefined
  series: Series | undefined
}

const SOURCE_LABEL: Record<QuoteSource, string> = {
  binance: 'Binance',
  vietcap: 'Vietcap',
  cafef: 'CafeF',
  yahoo: 'Yahoo Finance',
  fake: 'Fake data'
}

const STATE_NOTE: Partial<Record<Quote['state'], MessageKey>> = {
  stale: 'bar.stale',
  preopen: 'bar.preopen',
  closed: 'bar.closed',
  error: 'bar.error'
}

function tone(item: ItemModel): PriceTone {
  const q = item.quote
  if (!q || q.state === 'loading' || q.state === 'error') return 'flat'
  return priceTone(q, item.instrument.market)
}

/** The sparkline keeps the plain direction: purple/cyan/yellow apply to the glyph and numbers only. */
function direction(q: Quote | undefined, tn: PriceTone): Direction {
  if (tn === 'up' || tn === 'down' || tn === 'flat') return tn
  if (!q || q.change === 0) return 'flat'
  return q.change > 0 ? 'up' : 'down'
}

/** "FPT · Vietcap · 10:31:05", plus the state note when not live. */
function tooltip(item: ItemModel, lang: Language): string {
  const { instrument, quote } = item
  const parts = [instrument.displaySymbol]
  if (quote) {
    parts.push(SOURCE_LABEL[quote.source])
    if (quote.updatedAt > 0) parts.push(formatTime(quote.updatedAt))
    const note = STATE_NOTE[quote.state]
    if (note) parts.push(t(lang, note))
  }
  return parts.join(' · ')
}

function TickerItemImpl({ item, lang }: { item: ItemModel; lang: Language }): React.JSX.Element {
  const { instrument, quote, series } = item
  const state = quote?.state ?? 'loading'
  const loading = state === 'loading'
  const error = state === 'error'
  const tn = tone(item)
  const dir = direction(quote, tn)
  const name = (lang === 'vi' ? instrument.nameVi : instrument.nameEn) || instrument.nameEn || instrument.symbol
  const className = [styles.item, state === 'stale' && styles.stale].filter(Boolean).join(' ')

  return (
    <div className={className} data-testid="ticker-item" data-id={item.id} data-state={state} title={tooltip(item, lang)}>
      <div className={styles.left}>
        <div className={styles.line1}>
          <span className={`${styles.glyph} ${styles[tn]}`} data-testid="glyph" data-tone={tn} aria-hidden="true">
            {loading || error ? '•' : directionGlyph(quote!.change)}
          </span>
          <span className={styles.symbol} data-testid="symbol">
            {instrument.displaySymbol}
          </span>
          {state === 'stale' && <span className={styles.staleDot} data-testid="stale-dot" aria-label={t(lang, 'bar.stale')} />}
        </div>
        <div className={styles.name} data-testid="name">
          {name}
        </div>
      </div>
      {loading ? (
        <span className={`${styles.skeleton} ${styles.skelSpark}`} data-testid="skeleton" />
      ) : (
        <Sparkline
          points={series?.points ?? []}
          refPrice={series?.refPrice ?? quote?.refPrice ?? 0}
          direction={dir}
        />
      )}
      <div className={styles.right}>
        {loading ? (
          <>
            <span className={`${styles.skeleton} ${styles.skelPrice}`} />
            <span className={`${styles.skeleton} ${styles.skelPct}`} />
          </>
        ) : error ? (
          <>
            <span className={`${styles.priceDash} ${styles.flat}`} data-testid="price">
              —
            </span>
            <span className={`${styles.pct} ${styles.flat}`} data-testid="pct">
              —
            </span>
          </>
        ) : (
          <>
            <PriceText
              price={quote!.price}
              text={formatPrice(quote!.price, instrument.market, instrument.kind)}
              tone={tn}
            />
            <span className={`${styles.pct} ${styles[tn]} num`} data-testid="pct">
              {formatPct(quote!.changePct)}
            </span>
          </>
        )}
      </div>
    </div>
  )
}

export const TickerItem = memo(TickerItemImpl)
