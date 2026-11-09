import { t } from '../../shared/i18n'
import { VN_INDEX_INSTRUMENTS } from '../../shared/instruments'
import type { Instrument, InstrumentId, Language, Settings, Watchlist } from '../../shared/types'

/** Hard-coded metadata for the default symbols so the first run renders names offline. */
const DEFAULT_INSTRUMENTS: Instrument[] = [
  ...VN_INDEX_INSTRUMENTS,
  vnStock('FPT', 'FPT Corp', 'FPT Corp'),
  vnStock('VCB', 'Vietcombank', 'Vietcombank'),
  vnStock('HPG', 'Hoa Phat Group', 'Hòa Phát'),
  vnStock('VNM', 'Vinamilk', 'VINAMILK'),
  usInstrument('^GSPC', 'index', 'S&P 500', 'S&P 500'),
  usInstrument('^IXIC', 'index', 'NASDAQ', 'NASDAQ Composite'),
  usInstrument('AAPL', 'stock', 'AAPL', 'Apple Inc.'),
  usInstrument('NVDA', 'stock', 'NVDA', 'NVIDIA Corporation'),
  crypto('BTC', 'Bitcoin'),
  crypto('ETH', 'Ethereum'),
  crypto('BNB', 'BNB'),
  crypto('SOL', 'Solana'),
  crypto('XRP', 'XRP')
]

function vnStock(symbol: string, nameEn: string, nameVi: string): Instrument {
  return { id: `vn:${symbol}`, market: 'vn', kind: 'stock', symbol, displaySymbol: symbol, nameEn, nameVi }
}

function usInstrument(symbol: string, kind: 'stock' | 'index', displaySymbol: string, name: string): Instrument {
  return { id: `us:${symbol}`, market: 'us', kind, symbol, displaySymbol, nameEn: name, nameVi: name }
}

function crypto(base: string, name: string): Instrument {
  const symbol = `${base}USDT`
  return {
    id: `crypto:${symbol}`,
    market: 'crypto',
    kind: 'crypto',
    symbol,
    displaySymbol: `${base}/USDT`,
    nameEn: name,
    nameVi: name
  }
}

/** Default watchlists [A10], in order. Ids are fixed so a fresh install is deterministic. */
const DEFAULT_LISTS: { id: string; nameKey: Parameters<typeof t>[1]; items: InstrumentId[] }[] = [
  {
    id: 'default-ov',
    nameKey: 'watchlist.default.overview',
    items: ['vn:VNINDEX', 'us:^GSPC', 'us:^IXIC', 'crypto:BTCUSDT', 'crypto:ETHUSDT', 'vn:FPT', 'us:AAPL', 'us:NVDA']
  },
  {
    id: 'default-vn',
    nameKey: 'watchlist.default.vn',
    items: ['vn:VNINDEX', 'vn:VN30', 'vn:HNXIndex', 'vn:HNXUpcomIndex', 'vn:FPT', 'vn:VCB', 'vn:HPG', 'vn:VNM']
  },
  {
    id: 'default-us',
    nameKey: 'watchlist.default.us',
    items: ['us:^GSPC', 'us:^IXIC', 'us:AAPL', 'us:NVDA']
  },
  {
    id: 'default-cr',
    nameKey: 'watchlist.default.crypto',
    items: ['crypto:BTCUSDT', 'crypto:ETHUSDT', 'crypto:BNBUSDT', 'crypto:SOLUSDT', 'crypto:XRPUSDT']
  }
]

export const DEFAULT_BAR_WIDTH = 960

export function createDefaults(lang: Language): Settings {
  const watchlists: Watchlist[] = DEFAULT_LISTS.map((l) => ({
    id: l.id,
    name: t(lang, l.nameKey),
    items: l.items.map((id) => ({ id, hidden: false }))
  }))
  return {
    version: 1,
    language: lang,
    theme: 'system',
    activeWatchlistId: watchlists[0]!.id,
    watchlists,
    instruments: Object.fromEntries(DEFAULT_INSTRUMENTS.map((i) => [i.id, { ...i }])),
    bar: {
      x: null,
      y: null,
      width: DEFAULT_BAR_WIDTH,
      locked: false,
      clickThrough: false,
      speed: 'normal',
      paused: false,
      visible: true
    }
  }
}
