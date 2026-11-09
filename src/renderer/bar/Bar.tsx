import { useEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent } from 'react'
import { t } from '../../shared/i18n'
import { displaySymbol, parseInstrumentId } from '../../shared/instruments'
import type { AppState, BarGesture, Instrument, InstrumentId, MarketSnapshot, Settings } from '../../shared/types'
import { ChevronDownIcon } from '../icons'
import { Marquee } from './Marquee'
import type { ItemModel } from './TickerItem'
import styles from './Bar.module.css'

/** Metadata for an id missing from the settings cache (should not happen, but never crash). */
function fallbackInstrument(id: InstrumentId): Instrument {
  const parsed = parseInstrumentId(id)
  const market = parsed?.market ?? 'us'
  const symbol = parsed?.symbol ?? id
  return {
    id,
    market,
    kind: market === 'crypto' ? 'crypto' : 'stock',
    symbol,
    displaySymbol: displaySymbol(market, symbol),
    nameEn: symbol,
    nameVi: symbol
  }
}

function itemsOf(settings: Settings, market: MarketSnapshot): ItemModel[] {
  const list = settings.watchlists.find((w) => w.id === settings.activeWatchlistId)
  if (!list) return []
  return list.items
    .filter((it) => !it.hidden)
    .map((it) => ({
      id: it.id,
      instrument: settings.instruments[it.id] ?? fallbackInstrument(it.id),
      quote: market.quotes[it.id],
      series: market.series[it.id]
    }))
}

export function Bar({ initial }: { initial: AppState }): React.JSX.Element {
  const [settings, setSettings] = useState(initial.settings)
  const [market, setMarket] = useState<MarketSnapshot>(initial.snapshot)
  // The bar cannot be seen: main's signals (hidden, screen locked, asleep) or the page itself
  // hidden / fully covered (visibilitychange). Scrolling pauses; prices keep updating.
  const [hostVisible, setHostVisible] = useState(initial.barVisible)
  const [pageVisible, setPageVisible] = useState(document.visibilityState === 'visible')
  useEffect(() => {
    const onVisibility = (): void => setPageVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVisibility)
    const off = window.ticker.onBarVisibility(setHostVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      off()
    }
  }, [])

  useEffect(() => {
    const offSettings = window.ticker.onSettings((next) => {
      document.documentElement.lang = next.language
      setSettings(next)
    })
    const offTheme = window.ticker.onTheme((theme) => {
      document.documentElement.dataset.theme = theme
    })
    const offMarket = window.ticker.onMarket((diff) =>
      setMarket((prev) => ({
        quotes: { ...prev.quotes, ...diff.quotes },
        series: { ...prev.series, ...diff.series }
      }))
    )
    return () => {
      offSettings()
      offTheme()
      offMarket()
    }
  }, [])

  const lang = settings.language
  const { bar } = settings
  const items = useMemo(() => itemsOf(settings, market), [settings, market])
  const active = settings.watchlists.find((w) => w.id === settings.activeWatchlistId)

  const openMenu = (): void => {
    void window.ticker.openWatchlistMenu()
  }
  const onContextMenu = (e: MouseEvent): void => {
    e.preventDefault()
    openMenu()
  }

  // Drag anywhere to move; drag either edge to resize. Main reads the cursor position and
  // moves the window, so the renderer only reports start / move / end while the button is down.
  const movable = !bar.locked && !bar.clickThrough
  const rootRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<BarGesture['kind'] | null>(null)
  const [gesture, setGesture] = useState<BarGesture['kind'] | null>(null)

  const begin = (kind: BarGesture['kind'], e: PointerEvent): void => {
    if (!movable || e.button !== 0 || gestureRef.current) return
    e.preventDefault()
    rootRef.current?.setPointerCapture(e.pointerId)
    gestureRef.current = kind
    setGesture(kind)
    window.ticker.barGesture({ kind, phase: 'start' })
  }
  const finish = (): void => {
    const kind = gestureRef.current
    if (!kind) return
    gestureRef.current = null
    setGesture(null)
    window.ticker.barGesture({ kind, phase: 'end' })
  }
  const onPointerDown = (e: PointerEvent): void => {
    // Buttons (the watchlist pill) keep their click behavior.
    if ((e.target as Element).closest('button')) return
    begin('move', e)
  }
  const onPointerMove = (): void => {
    const kind = gestureRef.current
    if (kind) window.ticker.barGesture({ kind, phase: 'move' })
  }

  const className = [styles.bar, movable && styles.movable, gesture && styles[gesture]].filter(Boolean).join(' ')

  return (
    <div
      ref={rootRef}
      className={className}
      data-testid="bar"
      data-gesture={gesture ?? undefined}
      data-visible={hostVisible && pageVisible ? 'true' : 'false'}
      onContextMenu={onContextMenu}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={finish}
      onPointerCancel={finish}
      onLostPointerCapture={finish}
    >
      {movable &&
        (['resizeLeft', 'resizeRight'] as const).map((kind) => (
          <div
            key={kind}
            className={`${styles.resizeHandle} ${kind === 'resizeLeft' ? styles.left : styles.right}`}
            data-testid={kind === 'resizeLeft' ? 'resize-left' : 'resize-right'}
            title={t(lang, 'bar.resize')}
            aria-hidden="true"
            onPointerDown={(e) => {
              e.stopPropagation()
              begin(kind, e)
            }}
          />
        ))}
      <button
        type="button"
        className={styles.pill}
        data-testid="watchlist-pill"
        aria-label={`${t(lang, 'bar.watchlistMenu')}: ${active?.name ?? ''}`}
        title={t(lang, 'bar.watchlistMenu')}
        aria-haspopup="menu"
        onClick={openMenu}
      >
        <span className={styles.pillName}>{active?.name}</span>
        <ChevronDownIcon size={12} className={styles.chevron} />
      </button>
      <Marquee
        items={items}
        lang={lang}
        speed={bar.speed}
        paused={bar.paused || bar.clickThrough || !hostVisible || !pageVisible}
        emptyText={t(lang, 'bar.empty')}
      />
    </div>
  )
}
