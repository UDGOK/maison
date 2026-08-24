/**
 * v0.8 — the till / warehouse-desk half of the QA defects.
 *
 * W-D2 the desk aged a replenishment request by parsing the server's **zone-less** `requested_at`
 *      in the *browser's* zone, so off-zone every brand-new request rendered amber ("5h 04m" for a
 *      four-minute-old request) while the wall and the Shipments tab — which use the server's
 *      `age_seconds` — showed the truth. Two screens, same document, different answers.
 * W-N3 framework errors quote the document they are about as a raw `/app/...` desk link, a screen
 *      this product does not have and its staff cannot open.
 * U2   the keyboard focus ring was the browser default (≈1:1 on the near-black ground), i.e.
 *      invisible — WCAG 2.4.7 / 2.4.11.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { liveAge } from '@/warehouse/wall'
import { humanizeServerMessage } from '@/utils/text'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')

describe('W-D2 — the request age comes from the server', () => {
  it('ticks the server age locally instead of parsing a zone-less timestamp', () => {
    const fetchedAt = Date.parse('2026-08-23T15:39:30Z')
    const card = { age_seconds: 254 } // what `shipping.wall` / `request_dict` reported
    expect(liveAge(card, fetchedAt, fetchedAt + 60_000)).toBe(314)
    // the old maths: `now - new Date('2026-08-23 15:39:26')` in a UTC browser on a CDT site
    const wrong = Math.round((fetchedAt + 60_000 - Date.parse('2026-08-23T15:39:26')) / 1000)
    expect(wrong).toBeGreaterThan(0)
    expect(liveAge(card, fetchedAt, fetchedAt + 60_000)).toBeLessThan(4 * 3600)
  })

  it('the desk never derives a request age from `requested_at`', () => {
    const desk = read('../warehouse/views/WarehouseDesk.vue')
    expect(desk).toContain('liveAge(x, wh.fetchedAt, now)')
    expect(desk).not.toMatch(/new Date\(x\.requested_at\)/)
  })
})

describe('W-N3 — no desk links in messages shown to staff', () => {
  it('keeps the document name and drops the /app route', () => {
    const linkExists =
      'Cannot delete or cancel because Material Request https://cloudchaserz.frappe.cloud/app/material-request/MAT-MR-2026-00017 is linked with Maison Stock Alert MSA-2026-00017'
    const out = humanizeServerMessage(linkExists)
    expect(out).toContain('MAT-MR-2026-00017')
    expect(out).toContain('MSA-2026-00017')
    expect(out).not.toContain('/app/')
    expect(out).not.toContain('cloudchaserz.frappe.cloud')
  })

  it('handles the relative desk form too', () => {
    const negative = 'Negative stock error: 12 units of HKA-002 needed in OK-JENKS - CCZ. /app/Form/Item/HKA-002'
    const out = humanizeServerMessage(negative)
    expect(out).toContain('HKA-002')
    expect(out).not.toContain('/app/')
  })

  it('leaves an ordinary message alone', () => {
    expect(humanizeServerMessage('Shipment MSH-2026-00021 is already Shipped')).toBe('Shipment MSH-2026-00021 is already Shipped')
  })
})

describe('U2 — the keyboard focus ring is visible', () => {
  it('every focusable control gets a gold ring on the dark ground', () => {
    const css = read('../styles/base.css')
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent\)/)
    // the search box turns the resting outline off; the keyboard ring must come back
    expect(css).toMatch(/\.search input:focus-visible/)
    // and a gold-filled button inverts the ring rather than drawing gold on gold
    expect(css).toMatch(/\.btn-primary:focus-visible/)
  })
})
