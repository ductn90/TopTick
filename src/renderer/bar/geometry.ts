import type { ScrollSpeed } from '../../shared/types'

/** Marquee speeds in px/s [A6]. */
export const SPEED_PX_PER_SEC: Record<ScrollSpeed, number> = { slow: 24, normal: 40, fast: 64 }

export const MAX_SPARK_POINTS = 60

/** Scroll only when one copy of the items is wider than the viewport. */
export function needsScroll(contentWidth: number, viewportWidth: number): boolean {
  return contentWidth > viewportWidth
}

/** Seconds for the track to move by one copy (`-50%` of the doubled track). */
export function durationSec(halfWidth: number, speed: ScrollSpeed): number {
  if (!(halfWidth > 0)) return 0
  return halfWidth / SPEED_PX_PER_SEC[speed]
}

/** Every k-th point plus the last one, so the result has at most `max` points. */
export function downsample(points: readonly number[], max = MAX_SPARK_POINTS): number[] {
  if (points.length <= max) return [...points]
  if (max < 2) return points.length ? [points[points.length - 1]!] : []
  const last = points.length - 1
  const k = Math.ceil(last / (max - 1))
  const out: number[] = []
  for (let i = 0; i < last; i += k) out.push(points[i]!)
  out.push(points[last]!)
  return out
}

export interface SparkGeometry {
  /** SVG path `d` of the price line. */
  line: string
  /** Closed path `d` of the area under the line. */
  area: string
  /** y of the reference (dashed) line. */
  refY: number
  lastX: number
  lastY: number
}

const r2 = (n: number): number => Math.round(n * 100) / 100

/**
 * Maps points to a `w`×`h` box. The y-domain always includes `ref`; a flat
 * domain is drawn at mid-height. `pad` keeps the stroke inside the box.
 */
export function sparklinePath(
  points: readonly number[],
  ref: number,
  w: number,
  h: number,
  pad = 2
): SparkGeometry | null {
  const pts = points.filter((p) => Number.isFinite(p))
  if (pts.length === 0) return null
  const values = Number.isFinite(ref) && ref > 0 ? [...pts, ref] : pts
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min
  const y = (v: number): number => (span === 0 ? h / 2 : r2(pad + (1 - (v - min) / span) * (h - 2 * pad)))
  const series = pts.length === 1 ? [pts[0]!, pts[0]!] : pts
  const step = w / (series.length - 1)
  const coords = series.map((v, i) => [r2(i * step), y(v)] as const)
  const line = coords.map(([x, yy], i) => `${i === 0 ? 'M' : 'L'}${x} ${yy}`).join(' ')
  const [lastX, lastY] = coords[coords.length - 1]!
  const area = `${line} L${lastX} ${h} L${coords[0]![0]} ${h} Z`
  const refY = Number.isFinite(ref) && ref > 0 ? y(ref) : h / 2
  return { line, area, refY, lastX, lastY }
}
