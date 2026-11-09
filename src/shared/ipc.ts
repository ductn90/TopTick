import { z } from 'zod'
import { INSTRUMENT_ID_RE } from './instruments'
import type { Command, Instrument } from './types'

export { IPC, type IpcChannel } from './channels'

const MAX_TEXT = 256

export const marketSchema = z.enum(['vn', 'us', 'crypto'])
export const instrumentIdSchema = z.string().regex(INSTRUMENT_ID_RE)

export const instrumentSchema: z.ZodType<Instrument> = z
  .strictObject({
    id: instrumentIdSchema,
    market: marketSchema,
    kind: z.enum(['stock', 'etf', 'index', 'crypto']),
    symbol: z.string().min(1).max(20),
    displaySymbol: z.string().min(1).max(40),
    nameEn: z.string().max(MAX_TEXT),
    nameVi: z.string().max(MAX_TEXT)
  })
  .refine((i) => i.id === `${i.market}:${i.symbol}`, { message: 'id must equal market:symbol' })

const listId = z.string().min(1).max(64)
/** Name length rules (1–32 after trim) are enforced by the reducer so it can return NAME_INVALID. */
const name = z.string().max(MAX_TEXT)
const index = z.number().int().nonnegative()

export const languageSchema = z.enum(['en', 'vi'])
export const themeSettingSchema = z.enum(['dark', 'light', 'system'])
export const scrollSpeedSchema = z.enum(['slow', 'normal', 'fast'])

export const barSettingsSchema = z.strictObject({
  x: z.number().int().nullable(),
  y: z.number().int().nullable(),
  width: z.number().int(),
  locked: z.boolean(),
  clickThrough: z.boolean(),
  speed: scrollSpeedSchema,
  paused: z.boolean(),
  visible: z.boolean()
})

export const commandSchema: z.ZodType<Command> = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('addItem'), watchlistId: listId, instrument: instrumentSchema }),
  z.strictObject({ type: z.literal('removeItem'), watchlistId: listId, id: instrumentIdSchema }),
  z.strictObject({ type: z.literal('moveItem'), watchlistId: listId, from: index, to: index }),
  z.strictObject({
    type: z.literal('setHidden'),
    watchlistId: listId,
    id: instrumentIdSchema,
    hidden: z.boolean()
  }),
  z.strictObject({ type: z.literal('createWatchlist'), name }),
  z.strictObject({ type: z.literal('renameWatchlist'), id: listId, name }),
  z.strictObject({ type: z.literal('deleteWatchlist'), id: listId }),
  z.strictObject({ type: z.literal('setActiveWatchlist'), id: listId }),
  z.strictObject({ type: z.literal('setLanguage'), lang: languageSchema }),
  z.strictObject({ type: z.literal('setTheme'), theme: themeSettingSchema }),
  z.strictObject({ type: z.literal('setBar'), bar: barSettingsSchema.partial() })
])

export const barGestureSchema = z.strictObject({
  kind: z.enum(['move', 'resizeLeft', 'resizeRight']),
  phase: z.enum(['start', 'move', 'end'])
})

export const searchMarketSchema = z.enum(['all', 'vn', 'us', 'crypto'])

export const searchRequestSchema = z.strictObject({
  market: searchMarketSchema,
  query: z.string().trim().min(1).max(40)
})

export type SearchRequest = z.infer<typeof searchRequestSchema>
