import { describe, expect, it } from 'vitest'
import { virtualRange } from './virtual'
import { createBatcher } from './batch'

describe('virtualRange', () => {
  it('renders only the visible window plus overscan', () => {
    const r = virtualRange(100, 56, 0, 560, 4)
    expect(r.start).toBe(0)
    expect(r.end).toBe(10 + 1 + 4)
    expect(r.totalHeight).toBe(5600)
    expect(r.offsetTop).toBe(0)
  })
  it('scrolls', () => {
    const r = virtualRange(100, 56, 56 * 50, 560, 4)
    expect(r.start).toBe(46)
    expect(r.end).toBe(50 + 11 + 4)
    expect(r.offsetTop).toBe(46 * 56)
  })
  it('clamps at the end and handles empty lists', () => {
    const r = virtualRange(100, 56, 56 * 95, 560, 4)
    expect(r.end).toBe(100)
    expect(virtualRange(0, 56, 0, 560)).toEqual({ start: 0, end: 0, offsetTop: 0, totalHeight: 0 })
  })
  it('never renders more than viewport + 2×overscan rows for 100 boutiques', () => {
    for (let top = 0; top < 5600; top += 37) {
      const r = virtualRange(100, 56, top, 560, 4)
      expect(r.end - r.start).toBeLessThanOrEqual(11 + 8)
    }
  })
})

describe('createBatcher', () => {
  it('applies a burst of events in one flush', () => {
    const batches: number[][] = []
    let cb: (() => void) | null = null
    const b = createBatcher<number>((e) => batches.push(e), { raf: (f) => ((cb = f), 1), caf: () => {} })
    for (let i = 0; i < 50; i++) b.push(i)
    expect(b.pending).toBe(50)
    expect(batches).toHaveLength(0)
    cb!()
    expect(batches).toHaveLength(1)
    expect(batches[0]).toHaveLength(50)
    expect(b.pending).toBe(0)
    b.dispose()
  })
  it('flush() is idempotent and dispose() drops the queue', () => {
    const batches: number[][] = []
    const b = createBatcher<number>((e) => batches.push(e), { raf: () => 1, caf: () => {} })
    b.push(1)
    b.flush()
    b.flush()
    expect(batches).toEqual([[1]])
    b.push(2)
    b.dispose()
    b.flush()
    expect(batches).toEqual([[1]])
  })
})
