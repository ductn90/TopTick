import { z } from 'zod'
import {
  barSettingsSchema,
  instrumentIdSchema,
  instrumentSchema,
  languageSchema,
  themeSettingSchema
} from '../../shared/ipc'
import type { Settings } from '../../shared/types'

export const SETTINGS_VERSION = 1
export const MAX_WATCHLISTS = 20
export const MAX_ITEMS = 50
export const NAME_MAX = 32
export const MIN_BAR_WIDTH = 320

const watchlistSchema = z.strictObject({
  id: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(NAME_MAX),
  items: z
    .array(z.strictObject({ id: instrumentIdSchema, hidden: z.boolean() }))
    .max(MAX_ITEMS)
})

/** On-disk settings file, version 1 (design §Settings). */
export const settingsSchema: z.ZodType<Settings> = z
  .object({
    version: z.literal(SETTINGS_VERSION),
    language: languageSchema,
    theme: themeSettingSchema.default('system'),
    activeWatchlistId: z.string().min(1),
    watchlists: z.array(watchlistSchema).min(1).max(MAX_WATCHLISTS),
    instruments: z.record(instrumentIdSchema, instrumentSchema),
    bar: barSettingsSchema
  })
  .superRefine((s, ctx) => {
    const ids = new Set(s.watchlists.map((w) => w.id))
    if (ids.size !== s.watchlists.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate watchlist id', path: ['watchlists'] })
    }
    if (!ids.has(s.activeWatchlistId)) {
      ctx.addIssue({ code: 'custom', message: 'active watchlist missing', path: ['activeWatchlistId'] })
    }
    s.watchlists.forEach((w, i) => {
      if (new Set(w.items.map((it) => it.id)).size !== w.items.length) {
        ctx.addIssue({ code: 'custom', message: 'duplicate item id', path: ['watchlists', i, 'items'] })
      }
    })
  })
