import type { Instrument, InstrumentId } from '../shared/types'

/** How long an instrument returned by `search` may be added afterwards. */
export const SEARCH_RESULT_TTL_MS = 10 * 60_000

export interface InstrumentProvenanceDeps {
  now(): number
  /** Instruments main already trusts: the built-in defaults and those stored in settings. */
  known(): Record<InstrumentId, Instrument>
  ttlMs?: number
}

export interface InstrumentProvenance {
  /** Record instruments that `directory.search` returned to a renderer. */
  remember(results: readonly Instrument[]): void
  /** Main's own copy of `id` if it came from a recent search or is already known, else null. */
  resolve(id: InstrumentId): Instrument | null
}

/**
 * Enforces design §Commands "addItem: the instrument must come from a directory result":
 * a renderer can only add instruments that main handed out itself.
 */
export function createInstrumentProvenance(deps: InstrumentProvenanceDeps): InstrumentProvenance {
  const ttl = deps.ttlMs ?? SEARCH_RESULT_TTL_MS
  const searched = new Map<InstrumentId, { instrument: Instrument; at: number }>()

  function prune(now: number): void {
    for (const [id, entry] of searched) if (now - entry.at > ttl) searched.delete(id)
  }

  return {
    remember(results) {
      const now = deps.now()
      prune(now)
      for (const instrument of results) searched.set(instrument.id, { instrument: { ...instrument }, at: now })
    },
    resolve(id) {
      const now = deps.now()
      prune(now)
      const hit = searched.get(id)?.instrument ?? deps.known()[id]
      return hit ? { ...hit } : null
    }
  }
}
