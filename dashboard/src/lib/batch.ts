/**
 * v0.5 L — requestAnimationFrame batcher for socket events.
 *
 * Socket.io can deliver dozens of events in a burst (reconnect replay, a busy Saturday across
 * 100 boutiques). Pushing each one through Vue reactivity would re-render the wall per event;
 * instead events are queued and flushed once per animation frame (or via a timer when rAF is
 * unavailable — hidden tab, tests).
 */
export interface Batcher<T> {
  push: (e: T) => void
  flush: () => void
  dispose: () => void
  readonly pending: number
}

export function createBatcher<T>(apply: (events: T[]) => void, opts: { fallbackMs?: number; raf?: (cb: () => void) => number; caf?: (id: number) => void } = {}): Batcher<T> {
  const raf = opts.raf ?? (typeof requestAnimationFrame === 'function' ? (cb: () => void) => requestAnimationFrame(cb) : null)
  const caf = opts.caf ?? (typeof cancelAnimationFrame === 'function' ? (id: number) => cancelAnimationFrame(id) : null)
  const fallbackMs = opts.fallbackMs ?? 16
  let queue: T[] = []
  let handle: number | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const flush = () => {
    if (handle !== null && caf) caf(handle)
    handle = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    if (!queue.length) return
    const batch = queue
    queue = []
    apply(batch)
  }

  const schedule = () => {
    if (handle !== null || timer !== null) return
    if (raf) handle = raf(flush)
    // a hidden tab never fires rAF — a timer guarantees progress
    timer = setTimeout(flush, fallbackMs * 4)
  }

  return {
    push(e: T) {
      if (disposed) return
      queue.push(e)
      schedule()
    },
    flush,
    dispose() {
      disposed = true
      if (handle !== null && caf) caf(handle)
      if (timer !== null) clearTimeout(timer)
      queue = []
    },
    get pending() {
      return queue.length
    },
  }
}
