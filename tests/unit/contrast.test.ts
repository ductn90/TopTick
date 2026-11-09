import fs from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const css = fs.readFileSync(join(__dirname, '../../src/renderer/styles/tokens.css'), 'utf8')

function themeTokens(theme: 'dark' | 'light'): Record<string, string> {
  const block = new RegExp(`:root\\[data-theme="${theme}"\\]\\s*\\{([^}]*)\\}`).exec(css)
  if (!block) throw new Error(`no ${theme} block in tokens.css`)
  const tokens: Record<string, string> = {}
  for (const m of block[1]!.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) tokens[m[1]!] = m[2]!.trim()
  return tokens
}

function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) throw new Error(`expected #RRGGBB, got ${hex}`)
  const channel = (i: number): number => {
    const c = parseInt(m[1]!.slice(i, i + 2), 16) / 255
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4)
}

/** WCAG 2.x contrast ratio. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number]
  return (hi + 0.05) / (lo + 0.05)
}

const FOREGROUNDS = ['--up', '--down', '--text-2', '--flat', '--ref', '--ceiling', '--floor'] as const
const BACKGROUNDS = ['--surface-0-base', '--surface-1'] as const

describe('tokens.css', () => {
  it('defines the same token names in both themes', () => {
    expect(Object.keys(themeTokens('light')).sort()).toEqual(Object.keys(themeTokens('dark')).sort())
  })

  it('declares --surface-0-base as the opaque base of --surface-0', () => {
    expect(themeTokens('dark')['--surface-0-base']).toBe('#0B0D12')
    expect(themeTokens('dark')['--surface-0']).toBe('rgba(11, 13, 18, 0.92)')
    expect(themeTokens('light')['--surface-0-base']).toBe('#FFFFFF')
    expect(themeTokens('light')['--surface-0']).toBe('rgba(255, 255, 255, 0.94)')
  })
})

describe.each(['dark', 'light'] as const)('NFR-6 contrast, %s theme', (theme) => {
  const tokens = themeTokens(theme)
  for (const bg of BACKGROUNDS) {
    for (const fg of FOREGROUNDS) {
      it(`${fg} on ${bg} >= 4.5:1`, () => {
        expect(contrast(tokens[fg]!, tokens[bg]!)).toBeGreaterThanOrEqual(4.5)
      })
    }
  }
})

describe.each(['dark', 'light'] as const)('green accent (Settings), %s theme', (theme) => {
  const t = themeTokens(theme)
  it('is the app up-green, not a blue', () => {
    expect(t['--accent']).toBe(t['--up'])
  })
  it('text on the accent (primary buttons) >= 4.5:1', () => {
    expect(contrast(t['--surface-0-base']!, t['--accent']!)).toBeGreaterThanOrEqual(4.5)
  })
  it.each(['--surface-0-base', '--surface-1', '--surface-2', '--surface-3'])(
    'accent as a UI component (focus ring, tab icon, dot, switch track) on %s >= 3:1',
    (bg) => {
      expect(contrast(t['--accent']!, t[bg]!)).toBeGreaterThanOrEqual(3)
    }
  )
  it('the switch knob boundary on the green track >= 3:1', () => {
    const ring = t['--knob-ring']!
    expect(contrast(t['--knob']!, ring)).toBeGreaterThanOrEqual(3)
    if (ring !== t['--accent']) expect(contrast(ring, t['--accent']!)).toBeGreaterThanOrEqual(3)
  })
  it('selected text on the selection highlight >= 4.5:1', () => {
    expect(contrast(t['--text-1']!, t['--selection']!)).toBeGreaterThanOrEqual(4.5)
  })
})

describe('the icon green is the dark accent', () => {
  it('gen-icons fills the app icon with the dark --accent', () => {
    const script = fs.readFileSync(join(__dirname, '../../scripts/gen-icons.mjs'), 'utf8')
    expect(script).toContain(`const UP = hex('${themeTokens('dark')['--accent']}')`)
  })
})

describe('measured ratios match the design table', () => {
  it.each([
    ['dark', '--up', '--surface-0-base', 8.83],
    ['dark', '--down', '--surface-0-base', 5.38],
    ['dark', '--down', '--surface-1', 4.87],
    ['dark', '--text-2', '--surface-1', 6.83],
    ['light', '--up', '--surface-0-base', 5.4],
    ['light', '--down', '--surface-0-base', 5.21],
    ['light', '--down', '--surface-1', 4.86],
    ['light', '--flat', '--surface-1', 5.04]
  ] as const)('%s %s on %s = %s', (theme, fg, bg, expected) => {
    const t = themeTokens(theme)
    expect(contrast(t[fg]!, t[bg]!)).toBeCloseTo(expected, 1)
  })
})
