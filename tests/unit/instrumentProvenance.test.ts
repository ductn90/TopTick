import { describe, expect, it } from 'vitest'
import { createInstrumentProvenance, SEARCH_RESULT_TTL_MS } from '../../src/main/instrumentProvenance'
import type { Instrument } from '../../src/shared/types'

const vn = (symbol: string): Instrument => ({
  id: `vn:${symbol}`,
  market: 'vn',
  kind: 'stock',
  symbol,
  displaySymbol: symbol,
  nameEn: symbol,
  nameVi: symbol
})

function setup() {
  let t = 1_000
  const known: Record<string, Instrument> = { 'vn:FPT': vn('FPT') }
  const p = createInstrumentProvenance({ now: () => t, known: () => known })
  return { p, advance: (ms: number) => (t += ms) }
}

describe('instrument provenance (addItem must come from a directory result)', () => {
  it('rejects ids that were neither searched nor known', () => {
    expect(setup().p.resolve('vn:MWG')).toBeNull()
  })

  it('accepts known instruments (defaults and settings) and returns main\'s copy', () => {
    expect(setup().p.resolve('vn:FPT')).toEqual(vn('FPT'))
  })

  it('accepts search results until the TTL ends', () => {
    const { p, advance } = setup()
    p.remember([vn('MWG')])
    advance(SEARCH_RESULT_TTL_MS)
    expect(p.resolve('vn:MWG')).toEqual(vn('MWG'))
    advance(1)
    expect(p.resolve('vn:MWG')).toBeNull()
  })

  it('returns the searched metadata, not whatever a renderer sends', () => {
    const { p } = setup()
    p.remember([vn('MWG')])
    const copy = p.resolve('vn:MWG')!
    copy.nameEn = 'changed'
    expect(p.resolve('vn:MWG')!.nameEn).toBe('MWG')
  })
})
