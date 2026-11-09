import type { Logger } from '../log'
import type { InstrumentId } from '../../shared/types'
import { vnInSession } from './schedule'
import { Emitter, type PollingProvider, type Provider, type ProviderEvents, type Timers } from './providers/types'

export const FAILOVER_AFTER_CYCLES = 3
export const PROBE_INTERVAL_MS = 60_000

export type VnMode = 'primary' | 'fallback'

export interface VnSourceDeps {
  primary: PollingProvider
  fallback: Provider
  log: Logger
  timers: Timers
}

export interface VnSource extends Provider {
  readonly mode: VnMode
}

/**
 * VN failover (design §VN failover): Vietcap is primary; 3 consecutive failed
 * cycles switch to CafeF; while on CafeF, Vietcap is probed every 60 s and a
 * successful probe switches back and stops CafeF. Quotes keep their own
 * `source`, so the bar tooltip shows the real origin.
 */
export function createVnSource(deps: VnSourceDeps): VnSource {
  const { primary, fallback, log, timers } = deps
  const events = new Emitter<ProviderEvents>()

  let mode: VnMode = 'primary'
  let started = false
  let failures = 0
  let ids: InstrumentId[] = []
  let probeTimer: unknown = null
  let probing = false

  primary.on('quote', (q) => events.emit('quote', q))
  primary.on('series', (s) => events.emit('series', s))
  primary.on('health', (h) => {
    if (!started || mode !== 'primary') return
    if (h.ok) {
      failures = 0
      events.emit('health', h)
      return
    }
    failures++
    events.emit('health', h)
    if (failures >= FAILOVER_AFTER_CYCLES) toFallback(`${failures} consecutive failed Vietcap cycles`)
  })

  fallback.on('quote', (q) => {
    if (mode === 'fallback') events.emit('quote', q)
  })
  fallback.on('series', (s) => {
    if (mode === 'fallback') events.emit('series', s)
  })
  fallback.on('health', (h) => {
    if (mode === 'fallback') events.emit('health', h)
  })

  function clearProbe(): void {
    if (probeTimer !== null) timers.clearTimeout(probeTimer)
    probeTimer = null
  }

  function scheduleProbe(): void {
    clearProbe()
    probeTimer = timers.setTimeout(() => void probe(), PROBE_INTERVAL_MS)
  }

  function toFallback(reason: string): void {
    log.warn(`vn: switching to CafeF (${reason})`)
    mode = 'fallback'
    failures = 0
    primary.stop()
    fallback.setSubscriptions(ids)
    fallback.start()
    scheduleProbe()
  }

  function toPrimary(reason: string): void {
    log.warn(`vn: switching back to Vietcap (${reason})`)
    mode = 'primary'
    failures = 0
    clearProbe()
    fallback.stop()
    primary.setSubscriptions(ids)
    primary.start()
  }

  async function probe(): Promise<void> {
    probeTimer = null
    if (!started || mode !== 'fallback' || probing) return
    probing = true
    let ok = false
    try {
      ok = await primary.pollOnce()
    } finally {
      probing = false
    }
    if (!started || mode !== 'fallback') return
    if (ok) toPrimary('probe succeeded')
    else {
      log.debug('vn: Vietcap probe failed, staying on CafeF')
      scheduleProbe()
    }
  }

  return {
    id: 'vietcap',
    get mode() {
      return mode
    },
    setSubscriptions(next) {
      ids = next
      primary.setSubscriptions(next)
      fallback.setSubscriptions(next)
    },
    start() {
      if (started) return
      started = true
      if (mode === 'primary') primary.start()
      else {
        fallback.start()
        scheduleProbe()
      }
    },
    stop() {
      started = false
      clearProbe()
      primary.stop()
      fallback.stop()
    },
    on: (event, cb) => events.on(event, cb),
    inSession: (_id, t) => vnInSession(t)
  }
}
