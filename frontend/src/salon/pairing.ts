/**
 * v0.5 K — pairing code helpers shared by the POS "Client display" card and the Salon pairing screen.
 * Codes are 6 digits and live 10 minutes on the server; the UI counts down locally.
 */
export const PAIR_CODE_TTL_MS = 10 * 60 * 1000
export const PAIR_CODE_LENGTH = 6
export const SALON_TOKEN_KEY = 'awanz.salon.session'
export const SALON_DEVICE_KEY = 'awanz.salon.device'

export function normalizeCode(raw: string): string {
  return (raw || '').toUpperCase().replace(/^MS:/, '').replace(/\D+/g, '').slice(0, PAIR_CODE_LENGTH)
}

export function isCompleteCode(raw: string): boolean {
  return normalizeCode(raw).length === PAIR_CODE_LENGTH
}

/** `123456` → `123 456` for display. */
export function formatCode(code: string): string {
  const c = normalizeCode(code)
  return c.length > 3 ? `${c.slice(0, 3)} ${c.slice(3)}` : c
}

/** Milliseconds left before `expires_at` (server time string, ISO or `YYYY-MM-DD HH:mm:ss.ffffff`). */
export function remainingMs(expires_at: string | null | undefined, now: number = Date.now()): number {
  if (!expires_at) return 0
  const t = parseServerTime(expires_at)
  return Math.max(0, t - now)
}

export function isCodeValid(expires_at: string | null | undefined, now: number = Date.now()): boolean {
  return remainingMs(expires_at, now) > 0
}

/** `mm:ss` countdown. */
export function formatRemaining(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Frappe emits site-local `YYYY-MM-DD HH:mm:ss[.ffffff]`; treat it as local time. ISO strings pass through. */
export function parseServerTime(v: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(v)) return new Date(v.replace(' ', 'T').replace(/\.\d+$/, '')).getTime()
  return new Date(v).getTime()
}

/** The pairing QR shown on the POS encodes `MS:<code>`; a URL `…/salon?code=<code>` is accepted too. */
export function codeFromScan(payload: string): string | null {
  const p = (payload || '').trim()
  const m = p.match(/^MS:(\d{6})$/i) || p.match(/[?&]code=(\d{6})/)
  return m ? m[1] : isCompleteCode(p) ? normalizeCode(p) : null
}
