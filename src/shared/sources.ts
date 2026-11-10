import type { QuoteSource } from './types'

/** Display names of the data sources (bar tooltip, failover logs). */
export const SOURCE_LABEL: Record<QuoteSource, string> = {
  binance: 'Binance',
  okx: 'OKX',
  vietcap: 'Vietcap',
  cafef: 'CafeF',
  ssi: 'SSI iBoard',
  yahoo: 'Yahoo Finance',
  cnbc: 'CNBC',
  fake: 'Fake data'
}
