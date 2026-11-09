// E2E only: preloaded into the Electron main process with `electron -r <this file> .` (see
// `launch({ fixtures })`). Replaces the global `fetch` and `WebSocket` before the app starts, so
// the real providers (not the fake one) parse RECORDED REAL payloads from tests/fixtures:
// Vietcap getList / gap-chart / getAll. Every other request fails like an offline network.
// TOPTICK_FIXTURE_QUOTE_DELAY_MS delays the quote responses so the series arrives first.
const fs = require('node:fs')
const { join } = require('node:path')

const FIXTURES = join(__dirname, '..', 'fixtures')
const read = (p) => JSON.parse(fs.readFileSync(join(FIXTURES, p), 'utf8'))
const quoteDelay = Number(process.env.TOPTICK_FIXTURE_QUOTE_DELAY_MS ?? 0)

const quotes = read('vietcap/getList-limits.json')
const directory = read('vietcap/getAll-limits.json')
const symbols = new Set(quotes.map((r) => r.listingInfo.symbol))

function json(data, delayMs = 0) {
  const res = new Response(JSON.stringify(data), { status: 200, headers: { 'Content-Type': 'application/json' } })
  return delayMs > 0 ? new Promise((r) => setTimeout(() => r(res), delayMs)) : Promise.resolve(res)
}

globalThis.fetch = async (input, init = {}) => {
  const url = String(input?.url ?? input)
  const body = typeof init.body === 'string' ? JSON.parse(init.body) : {}
  if (url.endsWith('/api/price/symbols/getAll')) return json(directory)
  if (url.endsWith('/api/price/symbols/getList')) {
    const wanted = new Set(body.symbols ?? [])
    return json(quotes.filter((r) => wanted.has(r.listingInfo.symbol)), quoteDelay)
  }
  if (url.endsWith('/api/chart/OHLCChart/gap-chart')) {
    const sym = body.symbols?.[0]
    if (symbols.has(sym)) return json(read(`vietcap/gap-chart-${sym}.json`))
  }
  throw new TypeError(`fetch failed (offline e2e fixture): ${url}`)
}

/** Never connects: Binance stays on "loading" without touching the network. */
globalThis.WebSocket = class OfflineWebSocket extends EventTarget {
  constructor(url) {
    super()
    this.url = url
    this.readyState = 0
  }
  send() {}
  close() {
    this.readyState = 3
  }
}
