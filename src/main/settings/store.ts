import fs from 'node:fs'
import { join } from 'node:path'
import type { Language, Settings } from '../../shared/types'
import { createDefaults } from './defaults'
import { SETTINGS_VERSION, settingsSchema } from './schema'

export interface StoreLogger {
  info(...args: unknown[]): void
  warn(...args: unknown[]): void
  error(...args: unknown[]): void
}

export interface SettingsStoreOptions {
  /** Directory holding settings.json (Electron userData in production). */
  dir: string
  log: StoreLogger
  now: () => number
  /** Language used for defaults when no valid file exists. */
  defaultLanguage?: Language
  debounceMs?: number
}

export interface SettingsStore {
  get(): Settings
  /** Replace the in-memory settings and schedule a debounced atomic save. */
  set(next: Settings): void
  /** Write pending changes synchronously (call from `before-quit`). */
  flushSync(): void
  readonly path: string
}

const FILE = 'settings.json'
const SAVE_DEBOUNCE_MS = 300

/**
 * Loads settings once, keeps them in memory, and saves with a debounce via
 * `settings.json.tmp` + rename. Unreadable, invalid or newer-version files are
 * moved to `settings.corrupt-<epochms>.json` and never overwritten in place.
 */
export function createSettingsStore(opts: SettingsStoreOptions): SettingsStore {
  const { dir, log, now } = opts
  const debounceMs = opts.debounceMs ?? SAVE_DEBOUNCE_MS
  const path = join(dir, FILE)
  const tmpPath = `${path}.tmp`

  let saveBlocked = false
  let current = load()
  let dirty = false
  let timer: ReturnType<typeof setTimeout> | null = null

  function defaults(): Settings {
    return createDefaults(opts.defaultLanguage ?? 'en')
  }

  function quarantine(reason: string): Settings {
    const backup = join(dir, `settings.corrupt-${now()}.json`)
    try {
      fs.renameSync(path, backup)
      log.warn(`settings: ${reason}; moved to ${backup} and using defaults`)
    } catch (err) {
      // Never overwrite a file we could not move aside.
      saveBlocked = true
      log.error(`settings: ${reason}; backup to ${backup} failed, saving disabled`, err)
    }
    return defaults()
  }

  function load(): Settings {
    let text: string
    try {
      text = fs.readFileSync(path, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        log.warn('settings: could not read file, using defaults', err)
      }
      return defaults()
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return quarantine('invalid JSON')
    }

    const version = (raw as { version?: unknown } | null)?.version
    if (typeof version === 'number' && version > SETTINGS_VERSION) {
      return quarantine(`unsupported version ${version}`)
    }

    const parsed = settingsSchema.safeParse(raw)
    if (!parsed.success) return quarantine(`schema validation failed: ${parsed.error.message}`)
    return parsed.data
  }

  function write(): void {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!dirty || saveBlocked) return
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmpPath, JSON.stringify(current, null, 2), 'utf8')
      fs.renameSync(tmpPath, path)
      dirty = false
    } catch (err) {
      // In-memory state stays authoritative; the next change retries.
      log.error('settings: save failed', err)
    }
  }

  return {
    path,
    get: () => current,
    set(next) {
      current = next
      dirty = true
      if (timer) clearTimeout(timer)
      timer = setTimeout(write, debounceMs)
    },
    flushSync: write
  }
}
