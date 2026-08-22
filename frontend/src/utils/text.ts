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
