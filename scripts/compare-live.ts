/**
 * Runs each real provider once and prints the values next to the website to
 * compare them with (AC 7). Honors TOPTICK_VN_FORCE_FAIL=vietcap|cafef|all.
 *
 *   npm run compare-live
 */
import fs from 'node:fs'
import { join } from 'node:path'
import { createFetchJson, parseForceFail } from '../src/main/http'
import { createConsoleLogger } from '../src/main/log'
import { createBinanceProvider, type WebSocketCtor } from '../src/main/market/providers/binance'
import { createCafefProvider } from '../src/main/market/providers/cafef'
import { realTimers, type PollingProvider } from '../src/main/market/providers/types'
import { createVietcapProvider } from '../src/main/market/providers/vietcap'
import { createYahooProvider } from '../src/main/market/providers/yahoo'
import { FAILOVER_AFTER_CYCLES } from '../src/main/market/vnSource'
import { formatPct, formatPrice } from '../src/shared/format'
import { parseInstrumentId } from '../src/shared/instruments'
import type { InstrumentId, Kind, Quote } from '../src/shared/types'

const ROWS: { id: InstrumentId; kind: Kind; url: string }[] = [
  { id: 'crypto:BTCUSDT', kind: 'crypto', url: 'https://www.binance.com/en/trade/BTC_USDT' },
  { id: 'crypto:ETHUSDT', kind: 'crypto', url: 'https://www.binance.com/en/trade/ETH_USDT' },
  { id: 'vn:FPT', kind: 'stock', url: 'https://trading.vietcap.com.vn (or banggia.cafef.vn)' },
  { id: 'vn:VNINDEX', kind: 'index', url: 'https://trading.vietcap.com.vn (or banggia.cafef.vn)' },
  { id: 'us:AAPL', kind: 'stock', url: 'https://finance.yahoo.com/quote/AAPL' },
  { id: 'us:^GSPC', kind: 'index', url: 'https://finance.yahoo.com/quote/%5EGSPC' }
]

const pkg = JSON.parse(fs.readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string }
const log = createConsoleLogger(false)
const fetchJson = createFetchJson({ version: pkg.version, forceFail: parseForceFail(process.env.TOPTICK_VN_FORCE_FAIL) })
const deps = { fetchJson, log, now: Date.now, timers: realTimers }
const ids = ROWS.map((r) => r.id)

const quotes = new Map<InstrumentId, Quote>()
const errors = new Map<InstrumentId, string>()
const collect = (p: PollingProvider): PollingProvider => {
  p.on('quote', (q) => quotes.set(q.id, q))
  p.setSubscriptions(ids)
  return p
}

const binance = collect(
  createBinanceProvider({ ...deps, WebSocket: globalThis.WebSocket as unknown as WebSocketCtor })
)
const vietcap = collect(createVietcapProvider(deps))
const cafef = collect(createCafefProvider(deps))
const yahoo = collect(createYahooProvider(deps))

function failRows(prefix: string, message: string): void {
  for (const id of ids) if (id.startsWith(prefix) && !quotes.has(id)) errors.set(id, message)
}

async function runVn(): Promise<void> {
  // Same rule as the app: FAILOVER_AFTER_CYCLES failed Vietcap cycles -> CafeF.
  for (let i = 0; i < FAILOVER_AFTER_CYCLES; i++) {
    if (await vietcap.pollOnce()) return
  }
  log.warn(`vietcap failed ${FAILOVER_AFTER_CYCLES} cycles, using CafeF`)
  if (!(await cafef.pollOnce())) failRows('vn:', 'ERROR vietcap and cafef failed')
}

async function main(): Promise<void> {
  const startedAt = new Date()
  await Promise.all([
    binance.pollOnce().then((ok) => ok || failRows('crypto:', 'ERROR binance failed')),
    runVn(),
    yahoo.pollOnce().then((ok) => ok || failRows('us:', 'ERROR yahoo failed'))
  ])

  const ict = (ms: number): string =>
    new Date(ms + 7 * 3600_000).toISOString().replace('T', ' ').slice(0, 19) + ' ICT'
  console.log(`compare-live run at ${ict(startedAt.getTime())} (TOPTICK_VN_FORCE_FAIL=${process.env.TOPTICK_VN_FORCE_FAIL ?? ''})`)
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
