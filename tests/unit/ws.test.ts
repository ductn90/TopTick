import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ForcedFailWebSocket, webSocketFor, type WebSocketCtor } from '../../src/main/market/providers/ws'

describe('ForcedFailWebSocket', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('reports an error and closes on the next tick, never opening', () => {
    const ws = new ForcedFailWebSocket('wss://example.test')
    const events: string[] = []
    ws.onopen = () => events.push('open')
    ws.onerror = () => events.push('error')
    ws.onclose = () => events.push('close')
    expect(events).toEqual([])
    vi.advanceTimersByTime(0)
    expect(events).toEqual(['error', 'close'])
    vi.advanceTimersByTime(60_000)
    expect(events).toEqual(['error', 'close'])
  })

  it('stays silent when close() runs first', () => {
    const ws = new ForcedFailWebSocket('wss://example.test')
    const onclose = vi.fn()
    ws.onclose = onclose
    ws.close()
    vi.advanceTimersByTime(0)
    expect(onclose).not.toHaveBeenCalled()
  })
})

describe('webSocketFor', () => {
  const Real = class {} as unknown as WebSocketCtor

  it('returns the failing socket only for a forced tag', () => {
    expect(webSocketFor('binance', new Set(['binance']), Real)).toBe(ForcedFailWebSocket)
    expect(webSocketFor('okx', new Set(['binance']), Real)).toBe(Real)
    expect(webSocketFor('okx', new Set(), Real)).toBe(Real)
  })
})
