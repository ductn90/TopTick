import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Language, ScrollSpeed } from '../../shared/types'
import { durationSec, needsScroll } from './geometry'
import { TickerItem, type ItemModel } from './TickerItem'
import styles from './Marquee.module.css'

interface MarqueeProps {
  items: ItemModel[]
  lang: Language
  speed: ScrollSpeed
  /** Tray "Pause scrolling", click-through (hover is impossible then), or the bar cannot be seen. */
  paused: boolean
  emptyText: string
}

/**
 * Continuous right-to-left scroll: the track holds two copies and a linear CSS keyframe
 * moves it from 0 to -50%. The animation only changes `transform` on the track's own layer,
 * so the compositor moves it on every display frame without main-thread work (no frame-rate
 * cap, A19/D20; measured about half the CPU of a requestAnimationFrame loop). When one copy
 * fits, a single static copy is rendered instead.
 */
export function Marquee({ items, lang, speed, paused, emptyText }: MarqueeProps): React.JSX.Element {
  const viewportRef = useRef<HTMLDivElement>(null)
  const copyRef = useRef<HTMLDivElement>(null)
  const [sizes, setSizes] = useState({ content: 0, viewport: 0 })

  useEffect(() => {
    const viewport = viewportRef.current
    const copy = copyRef.current
    if (!viewport || !copy) return
    const measure = (): void => {
      const content = Math.ceil(copy.getBoundingClientRect().width)
      const width = Math.floor(viewport.clientWidth)
      setSizes((prev) => (prev.content === content && prev.viewport === width ? prev : { content, viewport: width }))
    }
    const ro = new ResizeObserver(measure)
    ro.observe(viewport)
    ro.observe(copy)
    measure()
    return () => ro.disconnect()
  }, [])

  const scroll = needsScroll(sizes.content, sizes.viewport)
  const idKey = items.map((i) => i.id).join('|')
  const ready = items.every((i) => i.quote !== undefined && i.quote.state !== 'loading')

  // Recomputed only when the item set, the speed or scroll mode changes (and once
  // when data first arrives), so value updates never restart the animation.
  const [duration, setDuration] = useState(0)
  useLayoutEffect(() => {
    const copy = copyRef.current
    setDuration(copy ? durationSec(copy.getBoundingClientRect().width, speed) : 0)
  }, [idKey, speed, scroll, ready])

  const animate = scroll && duration > 0
  const trackClass = [styles.track, animate && styles.animate, animate && paused && styles.paused]
    .filter(Boolean)
    .join(' ')

  // Each item is its own tile; the copy's trailing padding equals the tile gap, so the
  // -50% loop point lands exactly on the next tile.
  const renderCopy = (): React.JSX.Element[] => items.map((item) => <TickerItem key={item.id} item={item} lang={lang} />)

  return (
    <div className={styles.viewport} ref={viewportRef} data-testid="marquee">
      <div
        className={trackClass}
        data-testid="track"
        data-scrolling={animate ? 'true' : 'false'}
        style={animate ? { animationDuration: `${duration.toFixed(2)}s` } : undefined}
      >
        <div className={styles.copy} ref={copyRef} data-copy="0">
          {renderCopy()}
        </div>
        {scroll && (
          <div className={styles.copy} data-copy="1" aria-hidden="true">
            {renderCopy()}
          </div>
        )}
      </div>
      {items.length === 0 && <div className={styles.empty}>{emptyText}</div>}
    </div>
  )
}
