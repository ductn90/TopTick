import { useMemo } from 'react'
import { downsample, sparklinePath } from './geometry'
import styles from './Sparkline.module.css'

export type Direction = 'up' | 'down' | 'flat'

const W = 64
const H = 24

interface SparklineProps {
  points: readonly number[]
  refPrice: number
  direction: Direction
}

export function Sparkline({ points, refPrice, direction }: SparklineProps): React.JSX.Element {
  const geo = useMemo(() => sparklinePath(downsample(points), refPrice, W, H), [points, refPrice])
  return (
    <svg
      className={`${styles.spark} ${styles[direction]}`}
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid="sparkline"
    >
      {geo && (
        <>
          <path className={styles.area} d={geo.area} />
          <line
            className={styles.ref}
            x1={0}
            x2={W}
            y1={geo.refY}
            y2={geo.refY}
            strokeDasharray="2 2"
            data-testid="ref-line"
          />
          <path className={styles.line} d={geo.line} />
          <circle className={styles.dot} cx={geo.lastX} cy={geo.lastY} r={1.5} />
        </>
      )}
    </svg>
  )
}
