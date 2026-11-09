import fs from 'node:fs'
import { join } from 'node:path'
import { vi, type Mock } from 'vitest'
import type { FetchJson, FetchJsonOptions, FetchResult } from '../../src/main/http'
import type { Logger } from '../../src/main/log'
import { realTimers } from '../../src/main/market/providers/types'

const FIXTURES = join(__dirname, '..', 'fixtures')

export function fixture(path: string): unknown {
  return JSON.parse(fs.readFileSync(join(FIXTURES, path), 'utf8'))
}

/** Epoch ms for an ICT wall-clock time (UTC+7). */
export function ict(y: number, mo: number, d: number, h: number, m = 0, s = 0): number {
  return Date.UTC(y, mo - 1, d, h, m, s) - 7 * 3600_000
}

type LogFn = (...args: unknown[]) => void

export function mockLogger(): { [K in keyof Logger]: Mock<LogFn> } {
  return { debug: vi.fn<LogFn>(), info: vi.fn<LogFn>(), warn: vi.fn<LogFn>(), error: vi.fn<LogFn>() }
}

export interface FakeCall {
  url: string
  options: FetchJsonOptions
}

/**
 * Fake `fetchJson`: `route(url, options)` returns the result (or raw data,
 * wrapped in `{ok:true}`); every call is recorded.
 */
export function fakeFetch(route: (url: string, options: FetchJsonOptions) => FetchResult | Promise<FetchResult>) {
  const calls: FakeCall[] = []
  const fetchJson: FetchJson = async (url, options = {}) => {
    calls.push({ url, options })
    return route(url, options)
  }
  return { fetchJson, calls }
}

export const ok = (data: unknown): FetchResult => ({ ok: true, data })
export const fail = (kind: 'network' | 'timeout' | 'http' | 'parse' = 'network', status?: number): FetchResult =>
  status === undefined ? { ok: false, kind } : { ok: false, kind, status }

/** Provider deps on top of Vitest fake timers (`vi.useFakeTimers()` must be active). */
export function timerDeps(fetchJson: FetchJson) {
  return { fetchJson, log: mockLogger(), now: () => Date.now(), timers: realTimers }
}

/** Let pending promise callbacks run. */
export async function flushPromises(rounds = 5): Promise<void> {
  for (let i = 0; i < rounds; i++) await Promise.resolve()
}
