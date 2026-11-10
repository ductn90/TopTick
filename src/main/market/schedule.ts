/**
 * Market session rules. ICT is computed from UTC (UTC+7, no DST), so results do
 * not depend on the OS timezone. VN holidays are not modeled.
 */

export const ICT_OFFSET_MS = 7 * 3600_000

export interface IctParts {
  /** 0 = Sunday … 6 = Saturday, in ICT. */
  weekday: number
  /** Minutes since ICT midnight. */
  minutes: number
  /** ICT calendar date, `YYYY-MM-DD`. */
  dateKey: string
}

export function ictParts(nowMs: number): IctParts {
  const d = new Date(nowMs + ICT_OFFSET_MS)
  return {
    weekday: d.getUTCDay(),
    minutes: d.getUTCHours() * 60 + d.getUTCMinutes(),
    dateKey: d.toISOString().slice(0, 10)
  }
}

/** ICT calendar date (`YYYY-MM-DD`) of an epoch-ms instant. */
export function ictDateKey(epochMs: number): string {
  return ictParts(epochMs).dateKey
}

const hm = (h: number, m: number): number => h * 60 + m

/** VN polling windows (inclusive minutes): 08:55–11:35 and 12:55–15:05, Mon–Fri. */
const VN_WINDOWS: readonly [number, number][] = [
  [hm(8, 55), hm(11, 35)],
  [hm(12, 55), hm(15, 5)]
]

export type VnSessionState = 'open' | 'preopen' | 'closed'

/**
 * `open` inside a window, `preopen` on a weekday before the first window,
 * `closed` otherwise (lunch break, after close, weekends).
 */
export function vnSessionState(nowMs: number): VnSessionState {
  const { weekday, minutes } = ictParts(nowMs)
  if (weekday === 0 || weekday === 6) return 'closed'
  if (VN_WINDOWS.some(([start, end]) => minutes >= start && minutes <= end)) return 'open'
  return minutes < VN_WINDOWS[0]![0] ? 'preopen' : 'closed'
}

export function vnInSession(nowMs: number): boolean {
  return vnSessionState(nowMs) === 'open'
}

export const VN_POLL_MS = { vietcap: 3000, cafef: 10_000, ssi: 5000, outOfSession: 60_000 } as const

export function vnPollIntervalMs(source: 'vietcap' | 'cafef' | 'ssi', nowMs: number): number {
  return vnInSession(nowMs) ? VN_POLL_MS[source] : VN_POLL_MS.outOfSession
}

/** Yahoo `meta.currentTradingPeriod.regular`, epoch seconds. */
export interface TradingPeriod {
  start: number
  end: number
}

export const US_SESSION_MARGIN_MS = 5 * 60_000

/** True within the regular period widened by ±5 min. Unknown period -> false. */
export function usInSession(nowMs: number, period: TradingPeriod | null | undefined): boolean {
  if (!period) return false
  return nowMs >= period.start * 1000 - US_SESSION_MARGIN_MS && nowMs <= period.end * 1000 + US_SESSION_MARGIN_MS
}

/** True strictly within the regular period (used for the quote's `live`/`closed` state). */
export function usRegularOpen(nowMs: number, period: TradingPeriod | null | undefined): boolean {
  if (!period) return false
  return nowMs >= period.start * 1000 && nowMs < period.end * 1000
}

const ET_FORMAT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hourCycle: 'h23',
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit'
})

const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri'])
const US_OPEN_MIN = 9 * 60 + 30
const US_CLOSE_MIN = 16 * 60

/** New York weekday and minutes since midnight (fractional), DST included. */
function etParts(nowMs: number): { weekday: boolean; minutes: number } {
  const parts = Object.fromEntries(ET_FORMAT.formatToParts(nowMs).map((p) => [p.type, p.value]))
  const minutes = Number(parts.hour) * 60 + Number(parts.minute) + Number(parts.second) / 60
  return { weekday: WEEKDAYS.has(parts.weekday ?? ''), minutes }
}

/**
 * Scheduled US regular session, Mon–Fri 09:30 ≤ New York time < 16:00, for
 * sources without trading periods (CNBC). Holidays are not modeled.
 */
export function usScheduledRegularOpen(nowMs: number): boolean {
  const { weekday, minutes } = etParts(nowMs)
  return weekday && minutes >= US_OPEN_MIN && minutes < US_CLOSE_MIN
}

/** {@link usScheduledRegularOpen} widened by ±5 min (polling rate and staleness). */
export function usScheduledInSession(nowMs: number): boolean {
  const { weekday, minutes } = etParts(nowMs)
  const margin = US_SESSION_MARGIN_MS / 60_000
  return weekday && minutes >= US_OPEN_MIN - margin && minutes <= US_CLOSE_MIN + margin
}
