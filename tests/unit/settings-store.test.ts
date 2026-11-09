import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDefaults } from '../../src/main/settings/defaults'
import { createSettingsStore } from '../../src/main/settings/store'
import type { Settings } from '../../src/shared/types'

let dir: string
const NOW = 1_762_390_000_000
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

function store(extra: Partial<Parameters<typeof createSettingsStore>[0]> = {}) {
  return createSettingsStore({ dir, log, now: () => NOW, ...extra })
}

const file = (): string => join(dir, 'settings.json')
const backups = (): string[] => fs.readdirSync(dir).filter((f) => f.startsWith('settings.corrupt-'))
const readJson = (path: string): unknown => JSON.parse(fs.readFileSync(path, 'utf8'))

beforeEach(async () => {
  dir = await fs.promises.mkdtemp(join(os.tmpdir(), 'ticker-settings-'))
  vi.clearAllMocks()
})

afterEach(async () => {
  vi.useRealTimers()
  await fs.promises.rm(dir, { recursive: true, force: true })
})

describe('load', () => {
  it('uses defaults when the file is missing, without a backup or warning', () => {
    const s = store({ defaultLanguage: 'vi' })
    expect(s.get()).toEqual(createDefaults('vi'))
    expect(backups()).toEqual([])
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('backs up invalid JSON and uses defaults', () => {
    fs.writeFileSync(file(), '{ not json')
    const s = store()
    expect(s.get()).toEqual(createDefaults('en'))
    expect(backups()).toEqual([`settings.corrupt-${NOW}.json`])
    expect(fs.readFileSync(join(dir, backups()[0]!), 'utf8')).toBe('{ not json')
    expect(fs.existsSync(file())).toBe(false)
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('backs up a file that fails schema validation', () => {
    const bad = { ...createDefaults('en'), activeWatchlistId: 'missing' }
    fs.writeFileSync(file(), JSON.stringify(bad))
    expect(store().get()).toEqual(createDefaults('en'))
    expect(backups()).toHaveLength(1)
    expect(log.warn).toHaveBeenCalledOnce()
  })

  it('backs up a newer version and never overwrites it, even after saving', () => {
    vi.useFakeTimers()
    const newer = JSON.stringify({ version: 2, futureField: true })
    fs.writeFileSync(file(), newer)
    const s = store()
    expect(s.get()).toEqual(createDefaults('en'))
    const [backup] = backups()
    expect(backup).toBe(`settings.corrupt-${NOW}.json`)

    s.set({ ...s.get(), language: 'vi' })
    vi.advanceTimersByTime(300)
    expect(fs.readFileSync(join(dir, backup!), 'utf8')).toBe(newer)
    expect((readJson(file()) as Settings).version).toBe(1)
  })

  it('loads a valid file and round-trips it', () => {
    const saved: Settings = { ...createDefaults('en'), language: 'vi', theme: 'light' }
    fs.writeFileSync(file(), JSON.stringify(saved))
    expect(store().get()).toEqual(saved)
    expect(backups()).toEqual([])
  })

  it('defaults a missing theme to system (A16)', () => {
    const { theme: _theme, ...withoutTheme } = createDefaults('en')
    fs.writeFileSync(file(), JSON.stringify(withoutTheme))
    expect(store().get().theme).toBe('system')
    expect(backups()).toEqual([])
  })
})

describe('save', () => {
  it('debounces writes by 300 ms and writes atomically', () => {
    vi.useFakeTimers()
    const s = store()
    const a = { ...s.get(), language: 'vi' as const }
    s.set(a)
    vi.advanceTimersByTime(200)
    s.set({ ...a, theme: 'light' })
    vi.advanceTimersByTime(299)
    expect(fs.existsSync(file())).toBe(false)
    vi.advanceTimersByTime(1)
    expect(readJson(file())).toMatchObject({ language: 'vi', theme: 'light' })
    expect(fs.existsSync(`${file()}.tmp`)).toBe(false)
    expect(store().get()).toEqual(s.get())
  })

  it('flushSync writes pending changes immediately and cancels the timer', () => {
    vi.useFakeTimers()
    const s = store()
    s.set({ ...s.get(), theme: 'system' })
    s.flushSync()
    expect((readJson(file()) as Settings).theme).toBe('system')
    const mtime = fs.statSync(file()).mtimeMs
    vi.advanceTimersByTime(1000)
    expect(fs.statSync(file()).mtimeMs).toBe(mtime)
  })

  it('flushSync without changes does not write', () => {
    store().flushSync()
    expect(fs.existsSync(file())).toBe(false)
  })

  it('logs a write failure, keeps memory state, and retries on the next change', () => {
    vi.useFakeTimers()
    const s = store()
    fs.mkdirSync(`${file()}.tmp`) // writing the tmp file now fails with EISDIR
    s.set({ ...s.get(), language: 'vi' })
    vi.advanceTimersByTime(300)
    expect(log.error).toHaveBeenCalledOnce()
    expect(s.get().language).toBe('vi')
    expect(fs.existsSync(file())).toBe(false)

    fs.rmdirSync(`${file()}.tmp`)
    s.set({ ...s.get(), theme: 'light' })
    vi.advanceTimersByTime(300)
    expect(readJson(file())).toMatchObject({ language: 'vi', theme: 'light' })
  })

  it('creates the directory if needed', () => {
    const nested = join(dir, 'a', 'b')
    const s = createSettingsStore({ dir: nested, log, now: () => NOW })
    s.set(s.get())
    s.flushSync()
    expect(fs.existsSync(join(nested, 'settings.json'))).toBe(true)
  })
})
