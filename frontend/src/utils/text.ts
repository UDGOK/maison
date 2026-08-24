/** v0.6 R — "1 item" / "2 items" (the Receive screen and the wall card both printed "1 items"). */
export function plural(n: number, singular: string, pluralForm?: string): string {
  return `${n} ${Math.abs(n) === 1 ? singular : pluralForm || singular + 's'}`
}

/**
 * v0.6 R — the display name of a store, without the brand prefix every store name repeats.
 *
 * Eleven stores called "CloudChaserz Montrose", "CloudChaserz Broken Arrow", … truncate to eleven
 * identical "CloudChaser…" labels in any tight column: the brand is the part everybody already
 * knows and the location is the part that identifies the row. Falls back to the full name when
 * stripping the prefix would leave nothing (a store literally called "CloudChaserz").
 */
export function storeShortName(storeName: string | null | undefined, brandName: string | null | undefined): string {
  const name = (storeName || '').trim()
  const brand = (brandName || '').trim()
  if (!name || !brand) return name
  if (!name.toLowerCase().startsWith(brand.toLowerCase())) return name
  const rest = name.slice(brand.length).replace(/^[\s—–-]+/, '').trim()
  return rest || name
}

/**
 * Reduce an ERPNext/Frappe error message (often HTML: `<br>`, `<ul><li>`, `<a href>`)
 * to plain text for display in the PWA. Keeps list items and line breaks as separate lines.
 */
export function stripHtml(input: unknown): string {
  if (input == null) return ''
  let s = String(input)
  if (!/[<&]/.test(s)) return s.trim()
  s = s
    // v0.8 POS D5 — `<summary>` / `</summary>` had no separator rule, so Frappe's collapsible
    // permission error ran two sentences together ("…resource.Login to access**Function …**").
    // Every block-level tag, opening or closing, is a line break.
    .replace(/<\s*li\b[^>]*>/gi, '\n• ')
    .replace(/<\s*\/?\s*(br|p|div|tr|td|th|h[1-6]|summary|details|blockquote|pre|ul|ol|li)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
  // decode the handful of entities Frappe emits
  s = s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&amp;/g, '&')
  return s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
}

// --- v0.8 POS D5 / D9 — never show the associate our source tree -----------------------------
//
// Two server paths leak internal Python identifiers into the till:
//   D5  a stale session on `sales.submit_batch` answers 403 with
//       "You are not permitted to access this resource. Login to access</summary>Function
//        <strong>maison_pos.api.sales.submit_batch</strong> is not whitelisted."
//       — which names a module path *and* asserts something untrue (the method is whitelisted;
//       the till is simply signed out).
//   D9  a `ManagerRequiredError` carries no `_server_messages`, so the client falls back to
//       `exception` and renders "maison_pos.api.returns.ManagerRequiredError: Manager PIN incorrect".
//
// `humanizeServerMessage` is the single place both are cleaned up, used by every API client.
// ---------------------------------------------------------------------------------------------

/** `module.path.SomeError: real message` → `real message` (Frappe's `exception` field). */
const EXC_PREFIX = /^\s*(?:[A-Za-z_][\w]*\.)*[A-Za-z_][\w]*(?:Error|Exception|Exceptions)\s*:\s*/

/** "Function maison_pos.api.sales.submit_batch is not whitelisted." — true only for the framework. */
const NOT_WHITELISTED = /\bFunction\s+[\w.]+\s+is not whitelisted\.?/gi

/** Any bare dotted path into our own (or the framework's) source. */
const MODULE_PATH = /\b(?:maison_pos|frappe|erpnext|hrms|webshop|payments)(?:\.[A-Za-z_]\w*)+\b/g

// --- v0.8 QA W-N3 — never show a warehouse user the underlying desk -------------------------
// Framework errors quote the document they are about as a desk URL:
//   "Cannot delete or cancel because Material Request https://site/app/material-request/MAT-MR-…"
//   "NegativeStockError … /app/Form/Item/HKA-002"
// The record's name is the useful half; the `/app/...` route is a screen this product does not
// have and its staff cannot open. Keep the name, drop the link.
const DESK_LINK = /(?:https?:\/\/[^\s/]+)?\/app\/(?:[A-Za-z0-9%_.-]+\/)*([A-Za-z0-9%_.:-]+)\/?/g

/**
 * Turn a raw server error into something an associate can act on: no module paths, no exception
 * class names, no untrue "not whitelisted" claim. Returns `''` when nothing readable is left, so
 * callers can fall back to their own wording.
 */
export function humanizeServerMessage(input: unknown): string {
  let s = stripHtml(input)
  if (!s) return ''
  s = s
    .split('\n')
    .map((line) => line.replace(EXC_PREFIX, ''))
    .join('\n')
    .replace(NOT_WHITELISTED, '')
    .replace(DESK_LINK, '$1')
    .replace(MODULE_PATH, '')
  return s
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').replace(/\s+([.,;:])/g, '$1').replace(/^[\s.:;,-]+/, '').trim())
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** The one sentence a signed-out till should see instead of a permission traceback. */
export const SESSION_EXPIRED_MESSAGE = 'Signed out — sign in again to sync this sale.'

/**
 * True when a failed response means "this device's session expired", not "this device may not do
 * this". Frappe sets `session_expired` on the body; a 401/403 on an endpoint the till uses all day
 * is the same thing in practice, and treating it as transient only costs a retry.
 */
export function isSessionExpired(err: unknown): boolean {
  const e = err as { status?: number; code?: string; body?: { session_expired?: unknown; exc_type?: string } } | null
  if (!e) return false
  if (e.body?.session_expired) return true
  if (e.body?.exc_type === 'SessionExpired' || e.code === 'SessionExpired') return true
  return e.code === 'AUTH' || e.status === 401 || e.status === 403
}
// --- end v0.8 POS D5 / D9 ---
