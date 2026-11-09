import { useEffect, useRef, useState } from 'react'
import type { PriceTone } from '../../shared/priceTone'
import styles from './PriceText.module.css'

/** Tones that color the price itself; up/down/flat prices stay in the text color. */
const PRICE_TONES = new Set<PriceTone>(['ref', 'ceiling', 'floor'])

/**
 * The changed price switches to the up/down color for TINT_MS, then back. No color
 * transition: a fade repaints the scrolling track on every frame (NFR-1); two paints suffice.
 */
const TINT_MS = 600

const reducedMotion = (): boolean => window.matchMedia('(prefers-reduced-motion: reduce)').matches

export function PriceText({ price, text, tone }: { price: number; text: string; tone?: PriceTone }): React.JSX.Element {
  const prev = useRef(price)
  const [flash, setFlash] = useState<'up' | 'down' | null>(null)

  useEffect(() => {
    const before = prev.current
    prev.current = price
    if (before === price || !(before > 0) || !(price > 0) || reducedMotion()) return
    setFlash(price > before ? 'up' : 'down')
    const id = setTimeout(() => setFlash(null), TINT_MS)
    return () => clearTimeout(id)
  }, [price])

  const base = tone && PRICE_TONES.has(tone) ? styles[tone] : undefined
  const className = [styles.price, base, flash && styles[flash], 'num'].filter(Boolean).join(' ')
  return (
    <span className={className} data-testid="price" data-flash={flash ?? undefined}>
      {text}
    </span>
  )
}
