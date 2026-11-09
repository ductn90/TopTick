/**
 * Why the bar cannot be seen right now (main-process signals). The renderer adds its own
 * `document.visibilityState` (window hidden or fully covered, reported by Chromium because the
 * bar window has `backgroundThrottling: true`). The marquee pauses while any reason is active.
 */
export type HiddenReason = 'windowHidden' | 'minimized' | 'screenLocked' | 'suspended' | 'userInactive'

export interface BarVisibility {
  set(reason: HiddenReason, active: boolean): void
  /** True when no reason is active. */
  visible(): boolean
}

export function createBarVisibility(onChange: (visible: boolean, reason: HiddenReason) => void): BarVisibility {
  const active = new Set<HiddenReason>()
  return {
    set(reason, on) {
      const before = active.size === 0
      if (on) active.add(reason)
      else active.delete(reason)
      const after = active.size === 0
      if (before !== after) onChange(after, reason)
    },
    visible: () => active.size === 0
  }
}
