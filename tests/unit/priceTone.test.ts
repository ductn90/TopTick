import { describe, expect, it } from 'vitest'
import { priceTone } from '../../src/shared/priceTone'

// FPT on 2026-11-06: reference 52,900, ceiling 56,600, floor 49,200 (Vietcap listingInfo).
const LIMITS = { refPrice: 52_900, ceiling: 56_600, floor: 49_200 }
const vn = (price: number, limits: Partial<typeof LIMITS> = LIMITS) => {
  const refPrice = limits.refPrice ?? LIMITS.refPrice
  return priceTone({ price, refPrice, change: price - refPrice, ceiling: limits.ceiling, floor: limits.floor }, 'vn')
}

describe('priceTone, VN stocks', () => {
  it('is yellow (ref) at the reference price', () => {
    expect(vn(52_900)).toBe('ref')
  })
  it('is purple (ceiling) at the ceiling', () => {
    expect(vn(56_600)).toBe('ceiling')
  })
  it('is cyan (floor) at the floor', () => {
    expect(vn(49_200)).toBe('floor')
  })
  it('is up between the reference and the ceiling', () => {
    expect(vn(53_000)).toBe('up')
    expect(vn(56_500)).toBe('up')
  })
  it('is down between the floor and the reference', () => {
    expect(vn(52_800)).toBe('down')
    expect(vn(49_300)).toBe('down')
  })
  it('falls back to up/down without a ceiling or floor, and keeps yellow at the reference', () => {
    const none = { refPrice: 52_900 }
    expect(vn(56_600, none)).toBe('up')
    expect(vn(49_200, none)).toBe('down')
    expect(vn(52_900, none)).toBe('ref')
    expect(vn(56_600, { refPrice: 52_900, ceiling: 0, floor: 0 })).toBe('up')
  })
})

describe('priceTone, other instruments', () => {
  it('VN indices: yellow when unchanged, otherwise up/down', () => {
    const idx = (price: number) => priceTone({ price, refPrice: 1740.73, change: price - 1740.73 }, 'vn')
    expect(idx(1740.73)).toBe('ref')
    expect(idx(1750)).toBe('up')
    expect(idx(1700)).toBe('down')
  })
  it.each(['us', 'crypto'] as const)('%s: up/down/flat only', (market) => {
    const q = (price: number) => priceTone({ price, refPrice: 100, change: price - 100, ceiling: 107, floor: 93 }, market)
    expect(q(100)).toBe('flat')
    expect(q(107)).toBe('up')
    expect(q(93)).toBe('down')
  })
})
