/**
 * v0.5 K — privacy masking for the client-facing screen. Mirrors `maison_pos.api.salon`
 * (`mask_phone`, `mask_email`, `mask_client_number`, `sanitize_state`): the Salon never shows a
 * full phone number, e-mail or client number, and never any other client's data.
 */
export const PRIVATE_KEYS = new Set(['mobile_no', 'email_id', 'phone', 'email', 'address', 'address_line', 'birthday', 'anniversary', 'spouse_name'])

export function digitsOnly(v?: string | null): string {
  return (v || '').replace(/\D+/g, '')
}

/** `+1 312 555 0105` → `•••• 0105`; fewer than 4 digits → `••••`; empty → null. */
export function maskPhone(phone?: string | null): string | null {
  const d = digitsOnly(phone)
  if (!d) return null
  return d.length >= 4 ? `•••• ${d.slice(-4)}` : '••••'
}

/** `mei-lin.chen@example.com` → `m•••@example.com`; not an e-mail → null. */
export function maskEmail(email?: string | null): string | null {
  const e = (email || '').trim()
  const at = e.lastIndexOf('@')
  if (at < 0) return null
  const local = e.slice(0, at)
  const domain = e.slice(at + 1)
  return `${local.slice(0, 1)}•••@${domain}`
}

/** `MC595284` → `MC •• 284`. */
export function maskClientNumber(n?: string | null): string | null {
  if (!n) return null
  const s = String(n).trim()
  return s.length > 5 ? `${s.slice(0, 2)} •• ${s.slice(-3)}` : s
}

export function firstName(full?: string | null): string {
  return (full || '').trim().split(/\s+/)[0] || ''
}

/**
 * Strip private keys recursively, derive `first_name`, and replace a raw `client_number` with its mask.
 * Idempotent — safe to run on the server's (already sanitised) state again.
 */
export function sanitizeState<T>(payload: T): T {
  if (Array.isArray(payload)) return payload.map((v) => sanitizeState(v)) as unknown as T
  if (payload && typeof payload === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
      if (PRIVATE_KEYS.has(k)) continue
      out[k] = sanitizeState(v)
    }
    if ('customer_name' in out && !('first_name' in out)) out.first_name = firstName(out.customer_name as string)
    if ('client_number' in out) {
      out.client_number_masked = maskClientNumber(out.client_number as string)
      delete out.client_number
    }
    return out as T
  }
  return payload
}

/** Typed-code masking while the client types on the keypad: keep the last 4 visible. */
export function maskTyping(input: string): string {
  if (input.includes('@')) return input
  const d = digitsOnly(input)
  if (d.length <= 4) return d
  return '•'.repeat(d.length - 4) + d.slice(-4)
}
