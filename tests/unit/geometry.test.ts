import { describe, expect, it } from 'vitest'
import {
  downsample,
  durationSec,
  needsScroll,
  sparklinePath,
  SPEED_PX_PER_SEC
} from '../../src/renderer/bar/geometry'

describe('needsScroll', () => {
  it('scrolls only when content is wider than the viewport', () => {
    expect(needsScroll(1200, 900)).toBe(true)
    expect(needsScroll(600, 900)).toBe(false)
    expect(needsScroll(900, 900)).toBe(false)
  })
})

describe('durationSec', () => {
  it('divides the half width by the speed', () => {
    expect(SPEED_PX_PER_SEC).toEqual({ slow: 24, normal: 40, fast: 64 })
    expect(durationSec(1200, 'slow')).toBe(50)
    expect(durationSec(1200, 'normal')).toBe(30)
    expect(durationSec(1280, 'fast')).toBe(20)
  })
  it('is 0 for an empty track', () => {
    expect(durationSec(0, 'normal')).toBe(0)
    expect(durationSec(Number.NaN, 'normal')).toBe(0)
  })
})

describe('downsample', () => {
  it('returns short series unchanged (as a copy)', () => {
    const pts = [1, 2, 3]
    const out = downsample(pts, 60)
    expect(out).toEqual(pts)
    expect(out).not.toBe(pts)
  })
  it.each([61, 96, 120, 300, 1000])('keeps <= 60 points and the last point for %i inputs', (n) => {
    const pts = Array.from({ length: n }, (_, i) => i)
    const out = downsample(pts, 60)
    expect(out.length).toBeLessThanOrEqual(60)
    expect(out[0]).toBe(0)
    expect(out[out.length - 1]).toBe(n - 1)
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!)
  })
})

describe('sparklinePath', () => {
  const ys = (d: string): number[] =>
    d
      .split(/[ML]/)
      .filter(Boolean)
      .map((s) => Number(s.trim().split(' ')[1]))

  it('includes the reference price in the y-domain', () => {
    // All points above ref: ref must sit at the bottom edge (h - pad).
    const g = sparklinePath([110, 120, 115], 100, 64, 24)!
    expect(g.refY).toBe(22)
    for (const y of ys(g.line)) expect(y).toBeLessThan(22)
    // All points below ref: ref at the top edge.
    const below = sparklinePath([90, 80, 85], 100, 64, 24)!
    expect(below.refY).toBe(2)
  })

  it('spans the full width and ends at the last point', () => {
    const g = sparklinePath([1, 3, 2], 2, 64, 24)!
    expect(g.line.startsWith('M0 ')).toBe(true)
    expect(g.lastX).toBe(64)
    expect(g.line.endsWith(`L64 ${g.lastY}`)).toBe(true)
    expect(g.area.endsWith('L64 24 L0 24 Z')).toBe(true)
  })

  it('draws a flat series at mid-height', () => {
    const g = sparklinePath([5, 5, 5], 5, 64, 24)!
    expect(ys(g.line)).toEqual([12, 12, 12])
    expect(g.refY).toBe(12)
  })

  it('handles a single point and empty input', () => {
    const g = sparklinePath([5], 4, 64, 24)!
    expect(g.lastX).toBe(64)
    expect(sparklinePath([], 4, 64, 24)).toBeNull()
  })
})
