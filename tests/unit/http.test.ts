import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createFetchJson, describeFailure, FORCE_FAIL_TAGS, forceFailFromEnv, parseForceFail } from '../../src/main/http'

let server: http.Server
let base: string
let lastRequest: { method?: string; headers: http.IncomingHttpHeaders; body: string } | null = null

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c: Buffer) => (body += c.toString()))
    req.on('end', () => {
      lastRequest = { method: req.method, headers: req.headers, body }
      switch (req.url) {
        case '/ok':
          res.setHeader('Content-Type', 'application/json')
          res.end(JSON.stringify({ hello: 'world' }))
          return
        case '/invalid':
          res.end('{ not json')
          return
        case '/429':
          res.statusCode = 429
          res.end('slow down')
          return
        case '/hang':
          return // never respond
        default:
          res.statusCode = 404
          res.end()
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

const fetchJson = createFetchJson({ version: '9.9.9' })

describe('fetchJson', () => {
  it('returns parsed JSON and sends the TopTick User-Agent', async () => {
    await expect(fetchJson(`${base}/ok`)).resolves.toEqual({ ok: true, data: { hello: 'world' } })
    expect(lastRequest?.method).toBe('GET')
    expect(lastRequest?.headers['user-agent']).toBe('Mozilla/5.0 TopTick/9.9.9')
  })

  it('POSTs a JSON body', async () => {
    await fetchJson(`${base}/ok`, { method: 'POST', body: { symbols: ['FPT'] } })
    expect(lastRequest?.method).toBe('POST')
    expect(lastRequest?.headers['content-type']).toBe('application/json')
    expect(JSON.parse(lastRequest!.body)).toEqual({ symbols: ['FPT'] })
  })

  it('returns http with the status for non-2xx', async () => {
    await expect(fetchJson(`${base}/429`)).resolves.toEqual({ ok: false, kind: 'http', status: 429 })
  })

  it('returns parse for invalid JSON', async () => {
    await expect(fetchJson(`${base}/invalid`)).resolves.toEqual({ ok: false, kind: 'parse' })
  })

  it('returns timeout when the server never answers', async () => {
    await expect(fetchJson(`${base}/hang`, { timeoutMs: 150 })).resolves.toEqual({ ok: false, kind: 'timeout' })
  })

  it('returns network when the connection fails', async () => {
    await expect(fetchJson('http://127.0.0.1:1/nothing')).resolves.toEqual({ ok: false, kind: 'network' })
  })

  it('never throws, even when fetch itself throws synchronously', async () => {
    const broken = createFetchJson({
      version: '1',
      fetchImpl: (() => {
        throw new TypeError('boom')
      }) as unknown as typeof fetch
    })
    await expect(broken(`${base}/ok`)).resolves.toEqual({ ok: false, kind: 'network' })
  })

  it('forceFail fails only calls tagged with a matching provider', async () => {
    const forced = createFetchJson({ version: '1', forceFail: parseForceFail('vietcap') })
    await expect(forced(`${base}/ok`, { provider: 'vietcap' })).resolves.toEqual({ ok: false, kind: 'network' })
    await expect(forced(`${base}/ok`, { provider: 'cafef' })).resolves.toMatchObject({ ok: true })
    await expect(forced(`${base}/ok`)).resolves.toMatchObject({ ok: true })
  })
})

describe('parseForceFail', () => {
  it('maps the env values', () => {
    expect([...parseForceFail('vietcap')]).toEqual(['vietcap'])
    expect([...parseForceFail('cafef')]).toEqual(['cafef'])
    expect([...parseForceFail('ALL')].sort()).toEqual(['cafef', 'ssi', 'vietcap'])
    expect(parseForceFail(undefined).size).toBe(0)
    expect(parseForceFail('binance').size).toBe(0)
  })

  it('accepts comma lists and ignores unknown tags', () => {
    expect([...parseForceFail('vietcap,cafef')]).toEqual(['vietcap', 'cafef'])
    expect([...parseForceFail(' Vietcap , SSI ,nope')]).toEqual(['vietcap', 'ssi'])
    expect([...parseForceFail('', FORCE_FAIL_TAGS.crypto)]).toEqual([])
  })

  it('uses the allowed tags of each market', () => {
    expect([...parseForceFail('all', FORCE_FAIL_TAGS.crypto)]).toEqual(['binance', 'okx'])
    expect([...parseForceFail('yahoo,vietcap', FORCE_FAIL_TAGS.us)]).toEqual(['yahoo'])
    expect([...parseForceFail('binance', FORCE_FAIL_TAGS.us)]).toEqual([])
  })
})

describe('forceFailFromEnv', () => {
  it('is the union of the three market variables, each limited to its own tags', () => {
    const tags = forceFailFromEnv({
      TOPTICK_VN_FORCE_FAIL: 'vietcap,cafef',
      TOPTICK_CRYPTO_FORCE_FAIL: 'binance,yahoo',
      TOPTICK_US_FORCE_FAIL: 'all'
    })
    expect([...tags].sort()).toEqual(['binance', 'cafef', 'cnbc', 'vietcap', 'yahoo'])
    expect(forceFailFromEnv({}).size).toBe(0)
  })
})

describe('describeFailure', () => {
  it('includes the status when present', () => {
    expect(describeFailure({ kind: 'http', status: 503 })).toBe('http 503')
    expect(describeFailure({ kind: 'timeout' })).toBe('timeout')
  })
})
