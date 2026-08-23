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
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?\s*>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n• ')
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
