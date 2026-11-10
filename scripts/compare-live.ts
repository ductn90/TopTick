/**
 * Runs each market's chain of real providers once, with the app's failover
 * rule, and prints the values next to the website to compare them with (AC 7).
 * Honors TOPTICK_VN_FORCE_FAIL (vietcap, cafef, ssi), TOPTICK_CRYPTO_FORCE_FAIL
 * (binance, okx) and TOPTICK_US_FORCE_FAIL (yahoo, cnbc): comma lists or `all`.
 *
 *   npm run compare-live
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { createFetchJson, forceFailFromEnv } from '../src/main/http'
import { createConsoleLogger } from '../src/main/log'
import { FAILOVER_AFTER_CYCLES } from '../src/main/market/failover'
import { createBinanceProvider } from '../src/main/market/providers/binance'
import { createCafefProvider } from '../src/main/market/providers/cafef'
import { createCnbcProvider } from '../src/main/market/providers/cnbc'
import { createOkxProvider } from '../src/main/market/providers/okx'
import { createSsiProvider } from '../src/main/market/providers/ssi'
import { realTimers, type PollingProvider } from '../src/main/market/providers/types'
import { createVietcapProvider } from '../src/main/market/providers/vietcap'
import type { SendingWebSocketCtor } from '../src/main/market/providers/ws'
import { createYahooProvider } from '../src/main/market/providers/yahoo'
import { formatPct, formatPrice } from '../src/shared/format'
import { parseInstrumentId } from '../src/shared/instruments'
import { SOURCE_LABEL } from '../src/shared/sources'
import type { InstrumentId, Kind, Quote } from '../src/shared/types'

const VN_URL = 'https://trading.vietcap.com.vn (or banggia.cafef.vn, iboard.ssi.com.vn)'
const ROWS: { id: InstrumentId; kind: Kind; url: string }[] = [
  { id: 'crypto:BTCUSDT', kind: 'crypto', url: 'https://www.binance.com/en/trade/BTC_USDT (or okx.com/trade-spot/btc-usdt)' },
  { id: 'crypto:ETHUSDT', kind: 'crypto', url: 'https://www.binance.com/en/trade/ETH_USDT (or okx.com/trade-spot/eth-usdt)' },
  { id: 'vn:FPT', kind: 'stock', url: VN_URL },
  { id: 'vn:VNINDEX', kind: 'index', url: VN_URL },
  { id: 'us:AAPL', kind: 'stock', url: 'https://finance.yahoo.com/quote/AAPL (or cnbc.com/quotes/AAPL)' },
  { id: 'us:^GSPC', kind: 'index', url: 'https://finance.yahoo.com/quote/%5EGSPC (or cnbc.com/quotes/.SPX)' }
]

const pkg = JSON.parse(fs.readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
const log = createConsoleLogger(false)
const fetchJson = createFetchJson({ version: pkg.version, forceFail: forceFailFromEnv(process.env) })
const deps = { fetchJson, log, now: Date.now, timers: realTimers }
const ids = ROWS.map((r) => r.id)
const quotes = new Map<InstrumentId, Quote>()
const errors = new Map<InstrumentId, string>()

// pollOnce only uses REST; the socket constructor is never called.
const noSocket = globalThis.WebSocket as unknown as SendingWebSocketCtor
const chains: { prefix: string; market: string; chain: PollingProvider[] }[] = [
  {
    prefix: 'crypto:',
    market: 'crypto',
    chain: [createBinanceProvider({ ...deps, WebSocket: noSocket }), createOkxProvider({ ...deps, WebSocket: noSocket })]
  },
  {
    prefix: 'vn:',
    market: 'vn',
    chain: [createVietcapProvider(deps), createCafefProvider(deps), createSsiProvider(deps)]
  },
  { prefix: 'us:', market: 'us', chain: [createYahooProvider(deps), createCnbcProvider(deps)] }
]

/** Same rule as the app: FAILOVER_AFTER_CYCLES failed cycles -> the next provider. */
async function runChain(prefix: string, market: string, chain: PollingProvider[]): Promise<void> {
  for (const [i, p] of chain.entries()) {
    // Only the provider that succeeds for this market contributes rows.
    const got = new Map<InstrumentId, Quote>()
    const off = p.on('quote', (q) => got.set(q.id, q))
    p.setSubscriptions(ids)
    let ok = false
    for (let n = 0; n < FAILOVER_AFTER_CYCLES && !ok; n++) ok = await p.pollOnce()
    off()
    if (ok) {
      for (const [id, q] of got) if (id.startsWith(prefix)) quotes.set(id, q)
      return
    }
    const next = chain[i + 1]
    if (next) log.warn(`${market}: ${p.id} failed ${FAILOVER_AFTER_CYCLES} cycles, using ${SOURCE_LABEL[next.id]}`)
  }
  const message = `ERROR ${chain.map((p) => p.id).join(', ')} failed`
  for (const id of ids) if (id.startsWith(prefix) && !quotes.has(id)) errors.set(id, message)
}

async function main(): Promise<void> {
  const startedAt = new Date()
  await Promise.all(chains.map((c) => runChain(c.prefix, c.market, c.chain)))
  const ict = (ms: number): string =>
    new Date(ms + 7 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) + ' ICT'
  const env = ['TOPTICK_VN_FORCE_FAIL', 'TOPTICK_CRYPTO_FORCE_FAIL', 'TOPTICK_US_FORCE_FAIL']
    .map((k) => `${k}=${process.env[k] ?? ''}`)
    .join(' ')
  console.log(`compare-live run at ${ict(startedAt.getTime())} (${env})`)
  console.log('symbol | price | changePct | state | source | updatedAt | URL to compare')
  let failed = 0
  for (const row of ROWS) {
    const { market, symbol } = parseInstrumentId(row.id)!
    const q = quotes.get(row.id)
    if (!q) {
      failed++
      console.log(`${symbol} | ${errors.get(row.id) ?? 'ERROR no data'} | - | - | - | - | ${row.url}`)
      continue
    }
    console.log(
      [symbol, formatPrice(q.price, market, row.kind), formatPct(q.changePct), q.state, q.source, ict(q.updatedAt), row.url].join(
        ' | '
      )
    )
  }
  process.exitCode = failed > 0 ? 1 : 0
}

void main()
