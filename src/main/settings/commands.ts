import type { Command, CommandResult, ErrorCode, Settings, Watchlist } from '../../shared/types'
import { MAX_ITEMS, MAX_WATCHLISTS, MIN_BAR_WIDTH, NAME_MAX } from './schema'

export interface CommandContext {
  /** Work-area width of the display the bar is on; upper bound for bar.width. */
  workAreaWidth: number
  /** Generates a new watchlist id (10 chars in production, deterministic in tests). */
  newId: () => string
}

type Result = CommandResult<Settings>

const fail = (code: ErrorCode): Result => ({ ok: false, code })
const ok = (settings: Settings): Result => ({ ok: true, settings })

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'

/** 10-char random id, nanoid-like. */
export function randomId(random: () => number = Math.random): string {
  let id = ''
  for (let i = 0; i < 10; i++) id += ID_ALPHABET[Math.floor(random() * ID_ALPHABET.length)]
  return id
}

export function clampBarWidth(width: number, workAreaWidth: number): number {
  const max = Math.max(MIN_BAR_WIDTH, Math.floor(workAreaWidth))
  return Math.min(max, Math.max(MIN_BAR_WIDTH, Math.round(width)))
}

function normalizeName(name: string): string | null {
  const trimmed = name.trim()
  const length = [...trimmed].length
  return length >= 1 && length <= NAME_MAX ? trimmed : null
}

function nameTaken(settings: Settings, name: string, exceptId?: string): boolean {
  const lower = name.toLocaleLowerCase()
  return settings.watchlists.some((w) => w.id !== exceptId && w.name.toLocaleLowerCase() === lower)
}

function updateList(settings: Settings, id: string, fn: (w: Watchlist) => Watchlist): Settings {
  return { ...settings, watchlists: settings.watchlists.map((w) => (w.id === id ? fn(w) : w)) }
}

/**
 * Pure settings reducer. Enforces every invariant in design §Invariants and
 * never mutates `settings`.
 */
export function applyCommand(settings: Settings, cmd: Command, ctx: CommandContext): Result {
  switch (cmd.type) {
    case 'addItem': {
      const list = settings.watchlists.find((w) => w.id === cmd.watchlistId)
      if (!list) return fail('NOT_FOUND')
      const { instrument } = cmd
      if (list.items.some((it) => it.id === instrument.id)) return fail('DUPLICATE')
      if (list.items.length >= MAX_ITEMS) return fail('LIST_FULL')
      const next = updateList(settings, list.id, (w) => ({
        ...w,
        items: [...w.items, { id: instrument.id, hidden: false }]
      }))
      return ok({ ...next, instruments: { ...settings.instruments, [instrument.id]: { ...instrument } } })
    }

    case 'removeItem': {
      const list = settings.watchlists.find((w) => w.id === cmd.watchlistId)
      if (!list || !list.items.some((it) => it.id === cmd.id)) return fail('NOT_FOUND')
      return ok(updateList(settings, list.id, (w) => ({ ...w, items: w.items.filter((it) => it.id !== cmd.id) })))
    }

    case 'moveItem': {
      const list = settings.watchlists.find((w) => w.id === cmd.watchlistId)
      if (!list) return fail('NOT_FOUND')
      const n = list.items.length
      const inRange = (i: number): boolean => Number.isInteger(i) && i >= 0 && i < n
      if (!inRange(cmd.from) || !inRange(cmd.to)) return fail('BAD_REQUEST')
      const items = [...list.items]
      const [moved] = items.splice(cmd.from, 1)
      items.splice(cmd.to, 0, moved!)
      return ok(updateList(settings, list.id, (w) => ({ ...w, items })))
    }

    case 'setHidden': {
      const list = settings.watchlists.find((w) => w.id === cmd.watchlistId)
      if (!list || !list.items.some((it) => it.id === cmd.id)) return fail('NOT_FOUND')
      return ok(
        updateList(settings, list.id, (w) => ({
          ...w,
          items: w.items.map((it) => (it.id === cmd.id ? { ...it, hidden: cmd.hidden } : it))
        }))
      )
    }

    case 'createWatchlist': {
      const name = normalizeName(cmd.name)
      if (name === null) return fail('NAME_INVALID')
      if (nameTaken(settings, name)) return fail('NAME_TAKEN')
      if (settings.watchlists.length >= MAX_WATCHLISTS) return fail('TOO_MANY_WATCHLISTS')
      let id = ctx.newId()
      while (settings.watchlists.some((w) => w.id === id)) id = ctx.newId()
      return ok({ ...settings, watchlists: [...settings.watchlists, { id, name, items: [] }] })
    }

    case 'renameWatchlist': {
      if (!settings.watchlists.some((w) => w.id === cmd.id)) return fail('NOT_FOUND')
      const name = normalizeName(cmd.name)
      if (name === null) return fail('NAME_INVALID')
      if (nameTaken(settings, name, cmd.id)) return fail('NAME_TAKEN')
      return ok(updateList(settings, cmd.id, (w) => ({ ...w, name })))
    }

    case 'deleteWatchlist': {
      if (!settings.watchlists.some((w) => w.id === cmd.id)) return fail('NOT_FOUND')
      if (settings.watchlists.length <= 1) return fail('LAST_WATCHLIST')
      const watchlists = settings.watchlists.filter((w) => w.id !== cmd.id)
      const activeWatchlistId =
        settings.activeWatchlistId === cmd.id ? watchlists[0]!.id : settings.activeWatchlistId
      return ok({ ...settings, watchlists, activeWatchlistId })
    }

    case 'setActiveWatchlist': {
      if (!settings.watchlists.some((w) => w.id === cmd.id)) return fail('NOT_FOUND')
      return ok({ ...settings, activeWatchlistId: cmd.id })
    }

    case 'setLanguage':
      return ok({ ...settings, language: cmd.lang })

    case 'setTheme':
      return ok({ ...settings, theme: cmd.theme })

    case 'setBar': {
      const bar = { ...settings.bar }
      for (const [key, value] of Object.entries(cmd.bar)) {
        if (value !== undefined) (bar as Record<string, unknown>)[key] = value
      }
      if (cmd.bar.width !== undefined) bar.width = clampBarWidth(cmd.bar.width, ctx.workAreaWidth)
      return ok({ ...settings, bar })
    }
  }
}
