import { describe, expect, it } from 'vitest'
import {
  ictParts,
  usInSession,
  usRegularOpen,
  vnInSession,
  vnPollIntervalMs,
  vnSessionState
} from '../../src/main/market/schedule'
import { ict } from './helpers'

// 2026-11-06 is a Friday.
const fri = (h: number, m: number): number => ict(2026, 11, 6, h, m)

describe('vnSessionState', () => {
  it.each([
    [8, 54, 'preopen'],
    [8, 55, 'open'],
    [11, 35, 'open'],
    [11, 36, 'closed'],
    [12, 54, 'closed'],
    [12, 55, 'open'],
    [15, 5, 'open'],
    [15, 6, 'closed'],
    [0, 0, 'preopen'],
    [23, 59, 'closed']
  ] as const)('Friday %i:%i ICT -> %s', (h, m, expected) => {
    expect(vnSessionState(fri(h, m))).toBe(expected)
  })

  it('is closed all weekend', () => {
    expect(vnSessionState(ict(2026, 11, 7, 10, 0))).toBe('closed') // Saturday
    expect(vnSessionState(ict(2026, 11, 8, 10, 0))).toBe('closed') // Sunday
    expect(vnSessionState(ict(2026, 11, 9, 10, 0))).toBe('open') // Monday
  })

  it('uses the ICT calendar day, not the UTC one', () => {
    // Sunday 2026-11-08 20:00 UTC is Monday 03:00 ICT -> weekday, pre-open.
    const t = Date.UTC(2026, 10, 8, 20, 0)
    expect(ictParts(t)).toMatchObject({ weekday: 1, dateKey: '2026-11-09', minutes: 180 })
    expect(vnSessionState(t)).toBe('preopen')
    // Friday 2026-11-06 02:30 UTC is 09:30 ICT -> open.
    expect(vnInSession(Date.UTC(2026, 10, 6, 2, 30))).toBe(true)
    // Friday 2026-11-06 20:00 UTC is Saturday 03:00 ICT -> closed.
    expect(vnSessionState(Date.UTC(2026, 10, 6, 20, 0))).toBe('closed')
  })
})

describe('vnPollIntervalMs', () => {
  it('polls Vietcap every 3 s and CafeF every 10 s in session, 60 s outside', () => {
    expect(vnPollIntervalMs('vietcap', fri(10, 0))).toBe(3000)
    expect(vnPollIntervalMs('cafef', fri(10, 0))).toBe(10_000)
    expect(vnPollIntervalMs('vietcap', fri(12, 0))).toBe(60_000)
    expect(vnPollIntervalMs('cafef', fri(16, 0))).toBe(60_000)
  })
})

describe('usInSession', () => {
  const period = { start: 1_793_889_000, end: 1_793_912_400 } // 09:30–16:00 EST from the AAPL fixture
  const s = period.start * 1000
  const e = period.end * 1000

  it('includes a ±5 min margin', () => {
    expect(usInSession(s - 5 * 60_000 - 1, period)).toBe(false)
    expect(usInSession(s - 5 * 60_000, period)).toBe(true)
    expect(usInSession(e + 5 * 60_000, period)).toBe(true)
    expect(usInSession(e + 5 * 60_000 + 1, period)).toBe(false)
  })

  it('is false without a period', () => {
    expect(usInSession(s, null)).toBe(false)
    expect(usInSession(s, undefined)).toBe(false)
  })

  it('usRegularOpen has no margin', () => {
    expect(usRegularOpen(s - 1, period)).toBe(false)
    expect(usRegularOpen(s, period)).toBe(true)
    expect(usRegularOpen(e, period)).toBe(false)
  })
})
