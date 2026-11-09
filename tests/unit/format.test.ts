import { describe, expect, it } from 'vitest'
import { directionGlyph, formatPct, formatPrice, formatTime, priceDecimals } from '../../src/shared/format'

describe('formatPrice', () => {
  it('formats VN stocks in full VND with 0 dp', () => {
    expect(formatPrice(57500, 'vn', 'stock')).toBe('57,500')
    expect(formatPrice(76146, 'vn', 'stock')).toBe('76,146')
  })

  it('formats VN and US indices with 2 dp', () => {
    expect(formatPrice(1740.73, 'vn', 'index')).toBe('1,740.73')
    expect(formatPrice(256.6, 'vn', 'index')).toBe('256.60')
    expect(formatPrice(6801.5, 'us', 'index')).toBe('6,801.50')
  })

  it('formats US stocks and ETFs with 2 dp', () => {
    expect(formatPrice(271.4, 'us', 'stock')).toBe('271.40')
    expect(formatPrice(1234.567, 'us', 'etf')).toBe('1,234.57')
  })

  it('formats crypto by magnitude', () => {
    expect(formatPrice(101234.56, 'crypto', 'crypto')).toBe('101,235')
    expect(formatPrice(10000, 'crypto', 'crypto')).toBe('10,000')
    expect(formatPrice(3456.789, 'crypto', 'crypto')).toBe('3,456.79')
    expect(formatPrice(1, 'crypto', 'crypto')).toBe('1.00')
  })

  it('uses 4 significant digits for crypto below 1, at most 8 dp', () => {
    expect(formatPrice(0.5432, 'crypto', 'crypto')).toBe('0.5432')
    expect(formatPrice(0.0123456, 'crypto', 'crypto')).toBe('0.01235')
    expect(formatPrice(0.00001234, 'crypto', 'crypto')).toBe('0.00001234')
    expect(formatPrice(0.000000012345, 'crypto', 'crypto')).toBe('0.00000001')
    expect(priceDecimals('crypto', 'crypto', 0.00001234)).toBe(8)
    expect(priceDecimals('crypto', 'crypto', 0)).toBe(4)
  })
})

describe('formatPct', () => {
  it('always uses 2 dp and an explicit sign', () => {
    expect(formatPct(0.44)).toBe('+0.44%')
    expect(formatPct(-5.37)).toBe('-5.37%')
    expect(formatPct(0)).toBe('0.00%')
    expect(formatPct(12.3)).toBe('+12.30%')
  })

  it('never shows a sign for values that round to zero', () => {
    expect(formatPct(-0.001)).toBe('0.00%')
    expect(formatPct(0.004)).toBe('0.00%')
    expect(formatPct(-0)).toBe('0.00%')
  })

  it('uses en-US group separators', () => {
    expect(formatPct(1234.5)).toBe('+1,234.50%')
  })
})

describe('directionGlyph', () => {
  it('maps the sign of the change', () => {
    expect(directionGlyph(1.5)).toBe('▲')
    expect(directionGlyph(-0.01)).toBe('▼')
    expect(directionGlyph(0)).toBe('•')
  })
})

describe('formatTime', () => {
  it('formats local time as HH:mm:ss', () => {
    expect(formatTime(new Date(2026, 10, 6, 10, 31, 5).getTime())).toBe('10:31:05')
    expect(formatTime(new Date(2026, 10, 6, 0, 0, 0).getTime())).toBe('00:00:00')
  })
})
