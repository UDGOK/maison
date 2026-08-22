import { v4 as uuidv4 } from 'uuid'

const KEY = 'maison.device_id'

/** Stable per-device id (persisted in localStorage). */
export function deviceId(): string {
  try {
    let id = localStorage.getItem(KEY)
    if (!id) {
      id = 'dev-' + uuidv4().slice(0, 8)
      localStorage.setItem(KEY, id)
    }
    return id
  } catch {
    return 'dev-unknown'
  }
}

export function fmtDateTime(iso: string | Date, opts: Intl.DateTimeFormatOptions = {}): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...opts
  }).format(d)
}

export function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso
  return new Intl.DateTimeFormat('en-US', { year: 'numeric', month: 'short', day: '2-digit' }).format(d)
}

export function todayISO(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
