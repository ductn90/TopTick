import { describe, expect, it } from 'vitest'
import {
  CRYPTO_NAMES,
  cryptoBase,
  cryptoName,
  displaySymbol,
  formatInstrumentId,
  isInstrumentId,
  isVnIndexSymbol,
  parseInstrumentId,
  VN_INDEX_INSTRUMENTS
} from '../../src/shared/instruments'

describe('instrument ids', () => {
  it.each(['vn:FPT', 'vn:VNINDEX', 'vn:HNXUpcomIndex', 'us:AAPL', 'us:^GSPC', 'us:BRK.B', 'us:BF-B', 'crypto:BTCUSDT'])(
    'accepts %s',
    (id) => {
      expect(isInstrumentId(id)).toBe(true)
    }
  )

  it.each([
    '',
    'FPT',
    'vn:',
    'eu:SAP',
    'VN:FPT',
    'vn:FPT ',
    'vn:F P',
    'us:AAPL;rm',
    'crypto:' + 'A'.repeat(21),
    'us:<script>'
  ])('rejects %j', (id) => {
    expect(isInstrumentId(id)).toBe(false)
    expect(parseInstrumentId(id)).toBeNull()
  })

  it('parses and formats round-trip', () => {
    expect(parseInstrumentId('us:^GSPC')).toEqual({ market: 'us', symbol: '^GSPC' })
    expect(formatInstrumentId('crypto', 'ETHUSDT')).toBe('crypto:ETHUSDT')
    expect(parseInstrumentId(formatInstrumentId('vn', 'HNXIndex'))).toEqual({ market: 'vn', symbol: 'HNXIndex' })
  })
})

describe('displaySymbol', () => {
  it('maps VN indices and keeps VN tickers', () => {
    expect(displaySymbol('vn', 'VNINDEX')).toBe('VNINDEX')
    expect(displaySymbol('vn', 'VN30')).toBe('VN30')
    expect(displaySymbol('vn', 'HNXIndex')).toBe('HNX')
    expect(displaySymbol('vn', 'HNX30')).toBe('HNX30')
    expect(displaySymbol('vn', 'HNXUpcomIndex')).toBe('UPCOM')
    expect(displaySymbol('vn', 'FPT')).toBe('FPT')
  })

  it('maps US index symbols and keeps tickers', () => {
    expect(displaySymbol('us', '^GSPC')).toBe('S&P 500')
    expect(displaySymbol('us', '^IXIC')).toBe('NASDAQ')
    expect(displaySymbol('us', 'AAPL')).toBe('AAPL')
  })

  it('shows crypto USDT pairs as BASE/USDT', () => {
    expect(displaySymbol('crypto', 'BTCUSDT')).toBe('BTC/USDT')
    expect(displaySymbol('crypto', 'USDT')).toBe('USDT')
    expect(cryptoBase('SOLUSDT')).toBe('SOL')
  })
})

describe('built-in tables', () => {
  it('has the 5 VN indices with ids matching their symbols', () => {
    expect(VN_INDEX_INSTRUMENTS.map((i) => i.symbol)).toEqual(['VNINDEX', 'VN30', 'HNXIndex', 'HNX30', 'HNXUpcomIndex'])
    for (const i of VN_INDEX_INSTRUMENTS) {
      expect(i.id).toBe(`vn:${i.symbol}`)
      expect(i.kind).toBe('index')
      expect(isVnIndexSymbol(i.symbol)).toBe(true)
    }
    expect(isVnIndexSymbol('FPT')).toBe(false)
  })

  it('names about 50 crypto bases and falls back to the code', () => {
    expect(Object.keys(CRYPTO_NAMES).length).toBeGreaterThanOrEqual(50)
    expect(cryptoName('BTCUSDT')).toBe('Bitcoin')
    expect(cryptoName('ZZZUSDT')).toBe('ZZZ')
  })
})
