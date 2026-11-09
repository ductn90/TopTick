import { useMemo } from 'react'
import type { PriceTone } from '../../shared/priceTone'
import { downsample, sparklinePath } from './geometry'
import styles from './Sparkline.module.css'

const W = 64
const H = 24

interface SparklineProps {
  points: readonly number[]
  refPrice: number
  /** The item's price tone; line, area and end dot use its color (the reference line stays neutral). */
  tone: PriceTone
}

export function Sparkline({ points, refPrice, tone }: SparklineProps): React.JSX.Element {
  const geo = useMemo(() => sparklinePath(downsample(points), refPrice, W, H), [points, refPrice])
  return (
    <svg
      className={`${styles.spark} ${styles[tone]}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="sparkline"
      data-tone={tone}
    >
      {geo && (
        <>
          <path className={styles.area} d={geo.area} data-testid="spark-area" />
          <line
            className={styles.refLine}
            x1={0}
            x2={W}
            y1={geo.refY}
            y2={geo.refY}
            strokeDasharray="2 2"
            data-testid="ref-line"
          />
          <path className={styles.line} d={geo.line} data-testid="spark-line" />
          <circle className={styles.dot} cx={geo.lastX} cy={geo.lastY} r={1.5} data-testid="spark-dot" />
        </>
      )}
    </svg>
  )
}
