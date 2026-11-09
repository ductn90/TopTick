import type { Instrument, InstrumentId, Market } from './types'

/** Accepted instrument id format (design §Settings commands). */
export const INSTRUMENT_ID_RE = /^(vn|us|crypto):[A-Za-z0-9^.\-]{1,20}$/

export function isInstrumentId(value: string): boolean {
  return INSTRUMENT_ID_RE.test(value)
}

export function parseInstrumentId(id: string): { market: Market; symbol: string } | null {
  if (!INSTRUMENT_ID_RE.test(id)) return null
  const sep = id.indexOf(':')
  return { market: id.slice(0, sep) as Market, symbol: id.slice(sep + 1) }
}

export function formatInstrumentId(market: Market, symbol: string): InstrumentId {
  return `${market}:${symbol}`
}

/** Built-in VN indices, keyed by Vietcap code, with their display symbols. */
export const VN_INDEX_INSTRUMENTS: readonly Instrument[] = [
  vnIndex('VNINDEX', 'VNINDEX', 'VN-Index', 'VN-Index'),
  vnIndex('VN30', 'VN30', 'VN30 Index', 'Chỉ số VN30'),
  vnIndex('HNXIndex', 'HNX', 'HNX-Index', 'HNX-Index'),
  vnIndex('HNX30', 'HNX30', 'HNX30 Index', 'Chỉ số HNX30'),
  vnIndex('HNXUpcomIndex', 'UPCOM', 'UPCoM Index', 'Chỉ số UPCoM')
]

function vnIndex(symbol: string, displaySymbol: string, nameEn: string, nameVi: string): Instrument {
  return { id: `vn:${symbol}`, market: 'vn', kind: 'index', symbol, displaySymbol, nameEn, nameVi }
}

const VN_INDEX_DISPLAY: Record<string, string> = Object.fromEntries(
  VN_INDEX_INSTRUMENTS.map((i) => [i.symbol, i.displaySymbol])
)

export function isVnIndexSymbol(symbol: string): boolean {
  return symbol in VN_INDEX_DISPLAY
}

const US_DISPLAY: Record<string, string> = {
  '^GSPC': 'S&P 500',
  '^IXIC': 'NASDAQ'
}

/** Base asset names for the top crypto assets; other bases fall back to their code. */
export const CRYPTO_NAMES: Readonly<Record<string, string>> = {
  BTC: 'Bitcoin',
  ETH: 'Ethereum',
  BNB: 'BNB',
  SOL: 'Solana',
  XRP: 'XRP',
  DOGE: 'Dogecoin',
  ADA: 'Cardano',
  TRX: 'TRON',
  AVAX: 'Avalanche',
  LINK: 'Chainlink',
  DOT: 'Polkadot',
  TON: 'Toncoin',
  SHIB: 'Shiba Inu',
  LTC: 'Litecoin',
  BCH: 'Bitcoin Cash',
  NEAR: 'NEAR Protocol',
  UNI: 'Uniswap',
  APT: 'Aptos',
  ICP: 'Internet Computer',
  ETC: 'Ethereum Classic',
  XLM: 'Stellar',
  FIL: 'Filecoin',
  HBAR: 'Hedera',
  ATOM: 'Cosmos',
  ARB: 'Arbitrum',
  OP: 'Optimism',
  SUI: 'Sui',
  PEPE: 'Pepe',
  INJ: 'Injective',
  RENDER: 'Render',
  IMX: 'Immutable',
  AAVE: 'Aave',
  MKR: 'Maker',
  GRT: 'The Graph',
  ALGO: 'Algorand',
  VET: 'VeChain',
  SEI: 'Sei',
  TIA: 'Celestia',
  FET: 'Fetch.ai',
  RUNE: 'THORChain',
  STX: 'Stacks',
  LDO: 'Lido DAO',
  EGLD: 'MultiversX',
  SAND: 'The Sandbox',
  MANA: 'Decentraland',
  AXS: 'Axie Infinity',
  THETA: 'Theta Network',
  WLD: 'Worldcoin',
  ENA: 'Ethena',
  TAO: 'Bittensor',
  BONK: 'Bonk',
  FLOKI: 'FLOKI',
  JUP: 'Jupiter',
  WIF: 'dogwifhat',
  PAXG: 'PAX Gold'
}

const CRYPTO_QUOTE = 'USDT'

/** Base asset of a Binance USDT pair ("BTCUSDT" -> "BTC"); other symbols are returned unchanged. */
export function cryptoBase(symbol: string): string {
  return symbol.length > CRYPTO_QUOTE.length && symbol.endsWith(CRYPTO_QUOTE)
    ? symbol.slice(0, -CRYPTO_QUOTE.length)
    : symbol
}

export function cryptoName(symbol: string): string {
  const base = cryptoBase(symbol)
  return CRYPTO_NAMES[base] ?? base
}

/** Short label shown on the bar (design §Domain model, displaySymbol rules). */
export function displaySymbol(market: Market, symbol: string): string {
  switch (market) {
    case 'vn':
      return VN_INDEX_DISPLAY[symbol] ?? symbol
    case 'us':
      return US_DISPLAY[symbol] ?? symbol
    case 'crypto': {
      const base = cryptoBase(symbol)
      return base === symbol ? symbol : `${base}/${CRYPTO_QUOTE}`
    }
  }
}
