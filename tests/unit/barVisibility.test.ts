import { describe, expect, it, vi } from 'vitest'
import { createBarVisibility } from '../../src/main/barVisibility'

describe('bar visibility (pause the marquee while the bar cannot be seen)', () => {
  it('reports a change only when the first reason starts or the last one ends', () => {
    const onChange = vi.fn()
    const v = createBarVisibility(onChange)
    expect(v.visible()).toBe(true)
    v.set('screenLocked', true)
    v.set('suspended', true)
    expect(onChange.mock.calls).toEqual([[false, 'screenLocked']])
    v.set('screenLocked', false)
    expect(v.visible()).toBe(false)
    v.set('suspended', false)
    expect(onChange.mock.calls).toEqual([
      [false, 'screenLocked'],
      [true, 'suspended']
    ])
    expect(v.visible()).toBe(true)
  })

  it('ignores repeated signals', () => {
    const onChange = vi.fn()
    const v = createBarVisibility(onChange)
    v.set('windowHidden', false)
    v.set('windowHidden', true)
    v.set('windowHidden', true)
    v.set('windowHidden', false)
    v.set('windowHidden', false)
    expect(onChange.mock.calls).toEqual([
      [false, 'windowHidden'],
      [true, 'windowHidden']
    ])
  })
})
