/**
 * v0.5 L — virtualisation helper: only the rows inside the viewport (+ overscan) are rendered.
 * Fixed row height keeps the math O(1); `VirtualList.vue` wraps it.
 */
export interface VirtualRange {
  start: number
  end: number // exclusive
  offsetTop: number
  totalHeight: number
}

export function virtualRange(total: number, rowHeight: number, scrollTop: number, viewportHeight: number, overscan = 4): VirtualRange {
  const rh = Math.max(1, rowHeight)
  const totalHeight = total * rh
  if (total <= 0) return { start: 0, end: 0, offsetTop: 0, totalHeight: 0 }
  const first = Math.floor(Math.max(0, scrollTop) / rh)
  const visible = Math.ceil(Math.max(0, viewportHeight) / rh) + 1
  const start = Math.max(0, first - overscan)
  const end = Math.min(total, first + visible + overscan)
  return { start, end, offsetTop: start * rh, totalHeight }
}

/** Row height for the wall vs laptop type scales (rem-based components scale with html font-size). */
export function rowHeightFor(baseRem: number, remPx: number): number {
  return Math.round(baseRem * remPx)
}
