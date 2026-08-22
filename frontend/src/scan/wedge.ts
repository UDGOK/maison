/**
 * Keyboard-wedge scanner support.
 *
 * USB/Bluetooth scanners type the code as a fast burst of key events and finish with Enter.
 * `WedgeParser` is the pure state machine (unit-tested); `installWedgeListener` wires it to
 * `window` and ignores bursts while the user is typing in a text field.
 */

export interface WedgeOptions {
  /** max ms between two characters of the same burst (humans are slower than ~50 ms/char) */
  maxGapMs?: number
  /** min number of characters to accept as a scan */
  minLength?: number
  /** max ms from the first char to Enter — guards against a long human-typed line ending in Enter */
  maxBurstMs?: number
}

export interface WedgeKey {
  key: string
  /** event timestamp in ms (performance.now / Date.now — any monotonic clock) */
  time: number
}

export class WedgeParser {
  private buf = ''
  private start = 0
  private last = 0
  readonly maxGapMs: number
  readonly minLength: number
  readonly maxBurstMs: number

  constructor(opts: WedgeOptions = {}) {
    this.maxGapMs = opts.maxGapMs ?? 50
    this.minLength = opts.minLength ?? 4
    this.maxBurstMs = opts.maxBurstMs ?? 1500
  }

  /** Feed one key; returns the completed code when a burst ends with Enter, else null. */
  feed(k: WedgeKey): string | null {
    const gap = k.time - this.last
    if (this.buf && gap > this.maxGapMs) this.reset()
    if (k.key === 'Enter' || k.key === 'Tab') {
      const code = this.buf
      const dur = k.time - this.start
      this.reset()
      // Enter with no burst (or a slow human line) is not a scan.
      if (code.length >= this.minLength && dur <= this.maxBurstMs) return code
      return null
    }
    if (k.key.length !== 1) return null // modifiers, arrows, etc.
    if (!this.buf) this.start = k.time
    this.buf += k.key
    this.last = k.time
    return null
  }

  reset() {
    this.buf = ''
    this.start = 0
    this.last = 0
  }

  get pending(): string {
    return this.buf
  }
}

export function isTextTarget(el: EventTarget | null): boolean {
  if (!el || !(el instanceof HTMLElement)) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type
    return !['button', 'checkbox', 'radio', 'submit', 'range'].includes(type)
  }
  return el.isContentEditable
}

/**
 * Global listener. Bursts that end in Enter while focus is NOT in a text input are delivered to
 * `onScan`. Burst characters are swallowed (preventDefault) once we are confident it is a scan
 * (≥ minLength chars inside the gap window) so they do not trigger button shortcuts.
 */
export function installWedgeListener(onScan: (code: string) => void, opts: WedgeOptions = {}): () => void {
  const parser = new WedgeParser(opts)
  const handler = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return
    if (isTextTarget(e.target)) {
      parser.reset()
      return
    }
    const code = parser.feed({ key: e.key, time: e.timeStamp || performance.now() })
    if (e.key === 'Enter' && code) {
      e.preventDefault()
      onScan(code)
    } else if (parser.pending.length >= parser.minLength) e.preventDefault()
  }
  window.addEventListener('keydown', handler, true)
  return () => window.removeEventListener('keydown', handler, true)
}
