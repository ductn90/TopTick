import { useEffect, useRef, useState } from 'react'
import type { PriceTone } from '../../shared/priceTone'
import styles from './PriceText.module.css'

const FLASH_CLASS = { up: styles.flashUp, down: styles.flashDown } as const

/**
 * The price takes the item's tone color. A changed price shows on an up/down chip for TINT_MS,
 * then back. No transition: a fade repaints the scrolling track on every frame (NFR-1); two
 * paints suffice.
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

  const className = [styles.price, tone && styles[tone], flash && FLASH_CLASS[flash], 'num'].filter(Boolean).join(' ')
  return (
    <span className={className} data-testid="price" data-flash={flash ?? undefined}>
      {text}
    </span>
  )
}
