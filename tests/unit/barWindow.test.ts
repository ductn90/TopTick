import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: {}, BrowserWindow: class {}, screen: {} }))

const { resizeEdge, snapToEdges } = await import('../../src/main/windows/barWindow')

describe('resizeEdge (edge resize handles)', () => {
  const start = { x: 200, width: 960 }
  const workArea = { x: 0, width: 1440 }
  it('left edge: moving left widens, moving right shrinks; the right edge stays at 1160', () => {
    expect(resizeEdge(start, 'left', -100, 320, workArea)).toEqual({ x: 100, width: 1060 })
    expect(resizeEdge(start, 'left', 200, 320, workArea)).toEqual({ x: 400, width: 760 })
  })
  it('right edge: moving right widens, moving left shrinks; the left edge stays at 200', () => {
    expect(resizeEdge(start, 'right', 100, 320, workArea)).toEqual({ x: 200, width: 1060 })
    expect(resizeEdge(start, 'right', -200, 320, workArea)).toEqual({ x: 200, width: 760 })
  })
  it('clamps to the minimum and keeps the dragged edge inside the work area', () => {
    expect(resizeEdge(start, 'left', 900, 320, workArea)).toEqual({ x: 840, width: 320 })
    // Left edge stops at workArea.x; right edge stops at workArea.x + workArea.width.
    expect(resizeEdge(start, 'left', -900, 320, workArea)).toEqual({ x: 0, width: 1160 })
    expect(resizeEdge(start, 'right', -900, 320, workArea)).toEqual({ x: 200, width: 320 })
    expect(resizeEdge(start, 'right', 900, 320, workArea)).toEqual({ x: 200, width: 1240 })
    // Work area on a secondary display left of the primary one.
    const left = { x: -1920, width: 1920 }
    expect(resizeEdge({ x: -1500, width: 960 }, 'left', -1000, 320, left)).toEqual({ x: -1920, width: 1380 })
    expect(resizeEdge({ x: -1500, width: 960 }, 'right', 1000, 320, left)).toEqual({ x: -1500, width: 1500 })
    // Never wider than the work area, even if the bar already sticks out on the other side.
    expect(resizeEdge({ x: -100, width: 960 }, 'right', 5000, 320, workArea)).toEqual({ x: -100, width: 1440 })
    // A work area narrower than the minimum still yields the minimum.
    expect(resizeEdge(start, 'right', 0, 320, { x: 0, width: 300 }).width).toBe(320)
  })
})

describe('snapToEdges', () => {
  const workArea = { x: 0, y: 25, width: 1440, height: 875 }
  it('snaps edges within 16 px and leaves others alone', () => {
    expect(snapToEdges({ x: 10, y: 35, width: 960, height: 56 }, workArea)).toEqual({ x: 0, y: 25 })
    expect(snapToEdges({ x: 470, y: 400, width: 960, height: 56 }, workArea)).toEqual({ x: 480, y: 400 })
    expect(snapToEdges({ x: 200, y: 300, width: 960, height: 56 }, workArea)).toEqual({ x: 200, y: 300 })
  })
})
