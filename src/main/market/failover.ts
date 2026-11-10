import type { Logger } from '../log'
import { SOURCE_LABEL } from '../../shared/sources'
import type { InstrumentId, Market, QuoteSource } from '../../shared/types'
import { Emitter, type PollingProvider, type Provider, type ProviderEvents, type Timers } from './providers/types'

export const FAILOVER_AFTER_CYCLES = 3
export const PROBE_INTERVAL_MS = 60_000

export interface FailoverDeps {
  market: Market
  /** Primary first, then the backups in the order they are tried. */
  chain: readonly [PollingProvider, ...Provider[]]
  log: Logger
  timers: Timers
}

export interface FailoverSource extends Provider {
  readonly mode: 'primary' | 'fallback'
  /** Id of the provider that is running now. */
  readonly active: QuoteSource
}

/**
 * Failover over a chain of providers (design §Failover). The active provider's
 * `health` is counted: 3 consecutive failed cycles stop it and start the next
 * one in the chain; on the last one the controller stays (the hub's stale dot
 * shows). While a backup is active only the primary is probed, every 60 s with
 * `pollOnce()`; a successful probe stops the backup and restarts the primary.
 * Inactive providers are stopped. Quotes keep their own `source`, so the bar
 * tooltip shows the real origin.
 */
export function createFailoverSource(deps: FailoverDeps): FailoverSource {
  const { market, chain, log, timers } = deps
  const primary = chain[0]
  const events = new Emitter<ProviderEvents>()
  let active = 0
  let started = false
  let failures = 0
  let ids: InstrumentId[] = []
  let probeTimer: unknown = null
  let probing = false
  const label = (i: number): string => SOURCE_LABEL[chain[i]!.id]

  chain.forEach((provider, i) => {
    // Primary output is always forwarded (probe results show); a backup's only while it is active.
    provider.on('quote', (q) => {
      if (i === 0 || i === active) events.emit('quote', q)
    })
    provider.on('series', (s) => {
      if (i === 0 || i === active) events.emit('series', s)
    })
    provider.on('health', (h) => {
      if (!started || i !== active) return
      events.emit('health', h)
      if (h.ok) {
        failures = 0
        return
      }
      failures++
      if (failures >= FAILOVER_AFTER_CYCLES && active < chain.length - 1) {
        switchTo(active + 1, `${failures} consecutive failed ${label(active)} cycles`)
      }
    })
  })

  function clearProbe(): void {
    if (probeTimer !== null) timers.clearTimeout(probeTimer)
    probeTimer = null
  }

  function scheduleProbe(): void {
    clearProbe()
    probeTimer = timers.setTimeout(() => void probe(), PROBE_INTERVAL_MS)
  }

  function switchTo(next: number, reason: string): void {
    log.warn(`${market}: switching to ${label(next)} (${reason})`)
    chain[active]!.stop()
    active = next
    failures = 0
    chain[next]!.setSubscriptions(ids)
    chain[next]!.start()
    if (probeTimer === null) scheduleProbe()
  }

  function toPrimary(reason: string): void {
    log.warn(`${market}: switching back to ${label(0)} (${reason})`)
    chain[active]!.stop()
    active = 0
    failures = 0
    clearProbe()
    primary.setSubscriptions(ids)
    primary.start()
  }

  async function probe(): Promise<void> {
    probeTimer = null
    if (!started || active === 0 || probing) return
    probing = true
    let ok = false
    try {
      ok = await primary.pollOnce()
    } finally {
      probing = false
    }
    if (!started || active === 0) return
    if (ok) toPrimary('probe succeeded')
    else {
      log.debug(`${market}: ${label(0)} probe failed, staying on ${label(active)}`)
      scheduleProbe()
    }
  }

  return {
    id: primary.id,
    get mode() {
      return active === 0 ? 'primary' : 'fallback'
    },
    get active() {
      return chain[active]!.id
    },
    setSubscriptions(next) {
      ids = next
      for (const p of chain) p.setSubscriptions(next)
    },
    start() {
      if (started) return
      started = true
      chain[active]!.start()
      if (active > 0) scheduleProbe()
    },
    stop() {
      started = false
      clearProbe()
      for (const p of chain) p.stop()
    },
    on: (event, cb) => events.on(event, cb),
    inSession: (id, t) => chain[active]!.inSession?.(id, t) ?? true
  }
}
