export type FetchFailureKind = 'network' | 'timeout' | 'http' | 'parse'

export type FetchResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; kind: FetchFailureKind; status?: number }

export interface FetchJsonOptions {
  method?: 'GET' | 'POST'
  /** JSON-serialized and sent with `Content-Type: application/json`. */
  body?: unknown
  timeoutMs?: number
  /** Provider tag, used by the `TOPTICK_VN_FORCE_FAIL` dev hook. */
  provider?: string
}

export type FetchJson = (url: string, options?: FetchJsonOptions) => Promise<FetchResult>

export interface FetchJsonConfig {
  version: string
  /** Provider tags whose calls fail with `network` (see {@link parseForceFail}). */
  forceFail?: ReadonlySet<string>
  /** Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
}

export const DEFAULT_TIMEOUT_MS = 8000

/** `TOPTICK_VN_FORCE_FAIL=vietcap|cafef|all` -> provider tags to fail. Unknown values are ignored. */
export function parseForceFail(value: string | undefined): Set<string> {
  switch (value?.trim().toLowerCase()) {
    case 'vietcap':
      return new Set(['vietcap'])
    case 'cafef':
      return new Set(['cafef'])
    case 'all':
      return new Set(['vietcap', 'cafef'])
    default:
      return new Set()
  }
}

function isTimeout(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name
  return name === 'TimeoutError' || name === 'AbortError'
}

/** Builds a JSON fetcher that never throws; every failure is returned as a value. */
export function createFetchJson(config: FetchJsonConfig): FetchJson {
  const userAgent = `Mozilla/5.0 TopTick/${config.version}`
  const forceFail = config.forceFail ?? new Set<string>()

  return async (url, options = {}) => {
    if (options.provider && forceFail.has(options.provider)) return { ok: false, kind: 'network' }
    const fetchImpl = config.fetchImpl ?? fetch
    const headers: Record<string, string> = {
      'User-Agent': userAgent,
      Accept: 'application/json',
      'Accept-Encoding': 'gzip'
    }
    if (options.body !== undefined) headers['Content-Type'] = 'application/json'

    let text: string
    try {
      const res = await fetchImpl(url, {
        method: options.method ?? (options.body !== undefined ? 'POST' : 'GET'),
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      })
      if (!res.ok) {
        // Release the connection; the body is not needed.
        res.body?.cancel().catch(() => {})
        return { ok: false, kind: 'http', status: res.status }
      }
      text = await res.text()
    } catch (err) {
      return { ok: false, kind: isTimeout(err) ? 'timeout' : 'network' }
    }

    try {
      return { ok: true, data: JSON.parse(text) as unknown }
    } catch {
      return { ok: false, kind: 'parse' }
    }
  }
}

/** Short description of a failed result for logs. */
export function describeFailure(r: { kind: FetchFailureKind; status?: number }): string {
  return r.status !== undefined ? `${r.kind} ${r.status}` : r.kind
}
