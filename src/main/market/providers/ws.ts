/** Minimal WebSocket surface used by the providers (Node/Electron global `WebSocket` satisfies it). */
export interface WebSocketLike {
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onclose: ((ev: unknown) => void) | null
  onerror: ((ev: unknown) => void) | null
  close(): void
}

export type WebSocketCtor = new (url: string) => WebSocketLike

/** A socket the provider writes to (OKX subscribes and pings over the socket). */
export interface SendingWebSocketLike extends WebSocketLike {
  send(data: string): void
}

export type SendingWebSocketCtor = new (url: string) => SendingWebSocketLike

/**
 * Dev hook for `TOPTICK_*_FORCE_FAIL`: a socket that never opens. On the next
 * tick it reports an error and closes, unless `close()` ran first.
 */
export class ForcedFailWebSocket implements SendingWebSocketLike {
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  private closed = false

  constructor(readonly url: string) {
    setTimeout(() => {
      if (this.closed) return
      this.closed = true
      this.onerror?.({ message: 'forced failure' })
      this.onclose?.({})
    }, 0)
  }

  send(): void {}

  close(): void {
    this.closed = true
  }
}

/** `ForcedFailWebSocket` when the provider tag is forced to fail, else the real constructor. */
export function webSocketFor<C extends WebSocketCtor | SendingWebSocketCtor>(
  tag: string,
  forceFail: ReadonlySet<string>,
  real: C
): C {
  return forceFail.has(tag) ? (ForcedFailWebSocket as unknown as C) : real
}
