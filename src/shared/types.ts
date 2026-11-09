export type Market = 'vn' | 'us' | 'crypto'
export type Kind = 'stock' | 'etf' | 'index' | 'crypto'

/** Market-prefixed id: "vn:FPT", "vn:VNINDEX", "us:AAPL", "us:^GSPC", "crypto:BTCUSDT". */
export type InstrumentId = string

export interface Instrument {
  id: InstrumentId
  market: Market
  kind: Kind
  symbol: string
  displaySymbol: string
  nameEn: string
  nameVi: string
}

export type QuoteState = 'live' | 'preopen' | 'closed' | 'stale' | 'loading' | 'error'
export type QuoteSource = 'binance' | 'vietcap' | 'cafef' | 'yahoo' | 'fake'

export interface Quote {
  id: InstrumentId
  price: number
  refPrice: number
  change: number
  changePct: number
  state: QuoteState
  source: QuoteSource
  /** Epoch ms of the provider data. */
  updatedAt: number
  /** Daily price limits; VN stocks and ETFs only, when the source sends them. */
  ceiling?: number
  floor?: number
}

/** Intraday close series, at most 120 points (downsampled). */
export interface Series {
  id: InstrumentId
  points: number[]
  refPrice: number
  updatedAt: number
}

export interface MarketSnapshot {
  quotes: Record<InstrumentId, Quote>
  series: Record<InstrumentId, Series>
}

export type Language = 'en' | 'vi'
export type ThemeSetting = 'dark' | 'light' | 'system'
export type ResolvedTheme = 'dark' | 'light'
export type ScrollSpeed = 'slow' | 'normal' | 'fast'

export interface WatchlistItem {
  id: InstrumentId
  hidden: boolean
}

export interface Watchlist {
  id: string
  name: string
  items: WatchlistItem[]
}

export interface BarSettings {
  x: number | null
  y: number | null
  width: number
  locked: boolean
  clickThrough: boolean
  speed: ScrollSpeed
  paused: boolean
  visible: boolean
}

export interface Settings {
  version: 1
  language: Language
  theme: ThemeSetting
  activeWatchlistId: string
  watchlists: Watchlist[]
  /** Metadata cache so names render offline. */
  instruments: Record<InstrumentId, Instrument>
  bar: BarSettings
}

export type ErrorCode =
  | 'NAME_INVALID'
  | 'NAME_TAKEN'
  | 'LIST_FULL'
  | 'DUPLICATE'
  | 'NOT_FOUND'
  | 'LAST_WATCHLIST'
  | 'TOO_MANY_WATCHLISTS'
  | 'BAD_REQUEST'

export type CommandResult<T> = { ok: true; settings: T } | { ok: false; code: ErrorCode }

export type Command =
  | { type: 'addItem'; watchlistId: string; instrument: Instrument }
  | { type: 'removeItem'; watchlistId: string; id: InstrumentId }
  | { type: 'moveItem'; watchlistId: string; from: number; to: number }
  | { type: 'setHidden'; watchlistId: string; id: InstrumentId; hidden: boolean }
  | { type: 'createWatchlist'; name: string }
  | { type: 'renameWatchlist'; id: string; name: string }
  | { type: 'deleteWatchlist'; id: string }
  | { type: 'setActiveWatchlist'; id: string }
  | { type: 'setLanguage'; lang: Language }
  | { type: 'setTheme'; theme: ThemeSetting }
  | { type: 'setBar'; bar: Partial<BarSettings> }

export type SearchMarket = 'all' | Market

/** Bar drag (anywhere on the bar) or edge resize, sent while the pointer is down. */
export interface BarGesture {
  kind: 'move' | 'resizeLeft' | 'resizeRight'
  phase: 'start' | 'move' | 'end'
}

/** Returned by `getState()` to every renderer before first paint. */
export interface AppState {
  settings: Settings
  snapshot: MarketSnapshot
  resolvedTheme: ResolvedTheme
  /** Main's view of whether the bar can be seen at the time of the call (see `onBarVisibility`). */
  barVisible: boolean
  /** `process.platform` of main; Settings uses it for the macOS inset title bar. */
  platform: string
}

export interface SearchResponse {
  results: Instrument[]
  /** A directory source failed; `results` holds cached matches, if any. */
  unavailable: boolean
}

/** `window.ticker`, exposed by the preload (design §IPC). `on*` return an unsubscribe function. */
export interface TickerApi {
  getState(): Promise<AppState>
  onSettings(cb: (settings: Settings) => void): () => void
  onTheme(cb: (theme: ResolvedTheme) => void): () => void
  /** Receives `market:update` diffs and `market:snapshot` full states; merge both. */
  onMarket(cb: (diff: MarketSnapshot) => void): () => void
  command(cmd: Command): Promise<CommandResult<Settings>>
  search(market: SearchMarket, query: string): Promise<SearchResponse>
  openSettings(): Promise<void>
  openWatchlistMenu(): Promise<void>
  /** Fire-and-forget; main moves or resizes the bar window from the cursor position. */
  barGesture(gesture: BarGesture): void
  /** Main's view of whether the bar can be seen (window shown, screen unlocked, system awake). */
  onBarVisibility(cb: (visible: boolean) => void): () => void
}
