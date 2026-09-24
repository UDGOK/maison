/**
 * v1.6 — a perfumery's Concierge: the vocabulary (pinned to the same literals as
 * `maison_pos/tests/test_v1_6_perfume_concierge.py`), the shelf matching the mock mirrors from
 * `perfume.suggest`, the copy that follows who the scent is for, and the mock endpoint's rule that
 * a gift's answers never land on the client's own profile.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { AVOID_NAMES, FAMILY_NAMES, FORM_NAMES, INTENSITY_NAMES, SCENT_MOMENTS, SHOPPING_FOR, joinList, splitList, suggest, summary, toggle, type ShelfItem } from '@/perfume/profile'
import { PERFUME_STEPS, voice } from '@/salon/views/SalonConciergePerfume.vue'
import { __mockSalon, mockSalon } from '@/api/salon'

const SHELF: ShelfItem[] = [
  { item_code: 'ARB-001', item_name: 'Nyla', family: 'Floral Fruity', concentration: 'EDP', gender: 'Women', on_hand: 2 },
  { item_code: 'ARB-002', item_name: 'His Confession', family: 'Woody Spicy', concentration: 'EDP', gender: 'Men', on_hand: 2 },
  { item_code: 'ARB-007', item_name: 'Casablanca', family: 'Oriental Woody', concentration: 'Extrait de Parfum', gender: 'Unisex', on_hand: 3 },
  { item_code: 'OIL-001', item_name: 'Assorted oil', family: 'Oud / Attar', concentration: 'Perfume Oil', gender: 'Unisex', on_hand: 5616 },
  { item_code: 'GFT-001', item_name: 'Aqua set', family: 'Aquatic Fresh', concentration: 'Gift Set', gender: 'Men', on_hand: 2 },
  { item_code: 'SWT-001', item_name: 'Sherbet', family: 'Fruity Gourmand', concentration: 'EDP', gender: 'Women', on_hand: 9 },
  { item_code: 'BLANK', item_name: 'No family', family: '', concentration: 'EDP', gender: '', on_hand: 9 }
]
const codes = (a: Parameters<typeof suggest>[1]) => suggest(SHELF, a).map((x) => x.item_code)

describe('v1.6 — the perfumery vocabulary', () => {
  it('matches the server lists word for word, and no name carries a comma', () => {
    expect(SHOPPING_FOR.map((o) => o.key)).toEqual(['Myself', 'A gift for him', 'A gift for her', 'A gift'])
    expect(FAMILY_NAMES).toEqual(['Oud & Woods', 'Amber & Spice', 'Rose & Florals', 'Musk & Powder', 'Fresh & Citrus', 'Aquatic & Green', 'Sweet & Gourmand', 'Leather & Smoke'])
    expect(AVOID_NAMES).toEqual(['Too sweet', 'Heavy oud', 'Smoky', 'Strong florals', 'Powdery', 'Too fresh or soapy'])
    expect(INTENSITY_NAMES).toEqual(['Close to the skin', 'Noticed nearby', 'Leaves a trail'])
    expect(FORM_NAMES).toEqual(['Spray', 'Perfume oil', 'Body mist', 'Bakhoor'])
    expect(SCENT_MOMENTS).toEqual(['Every day', 'Work', 'Evenings out', 'Date night', 'Weddings', "Eid & Jumu'ah", 'Summer', 'Winter'])
    for (const n of [...FAMILY_NAMES, ...AVOID_NAMES, ...FORM_NAMES, ...SCENT_MOMENTS]) expect(n).not.toContain(',')
  })

  it('toggles within a cap, swaps a single choice, and round-trips a stored list', () => {
    expect(toggle(['a', 'b', 'c'], 'd', 3)).toEqual(['a', 'b', 'c'])
    expect(toggle(['a', 'b'], 'a', 3)).toEqual(['b'])
    expect(toggle(['a'], 'b', 1)).toEqual(['b'])
    expect(splitList(' Oud & Woods, Rose & Florals ,, ')).toEqual(['Oud & Woods', 'Rose & Florals'])
    expect(splitList(joinList(['Oud & Woods', 'Amber & Spice']))).toEqual(['Oud & Woods', 'Amber & Spice'])
    expect(splitList(null)).toEqual([])
  })

  it('never asks a ring size — the consultation is who, love, avoid, wear, moments, occasion', () => {
    expect(PERFUME_STEPS).toEqual(['who', 'love', 'avoid', 'wear', 'moments', 'occasion', 'done'])
    expect(voice('Myself')).toEqual({ you: 'you', your: 'your', gift: false })
    expect(voice('A gift for her')).toEqual({ you: 'they', your: 'their', gift: true })
  })
})

describe('v1.6 — what on the shelf fits (mirror of perfume.suggest)', () => {
  it('lets loves decide and avoid rule out', () => {
    const out = codes({ shopping_for: 'Myself', scent_families: ['Oud & Woods', 'Amber & Spice'], scent_avoid: ['Too sweet'], scent_intensity: 'Leaves a trail', scent_forms: ['Spray'] })
    expect(out[0]).toBe('ARB-007')
    expect(out).not.toContain('SWT-001')
    expect(out).not.toContain('BLANK')
  })

  it('keeps a gift for him to his side of the shelf, made-for-him first', () => {
    const out = codes({ shopping_for: 'A gift for him', scent_families: ['Oud & Woods', 'Rose & Florals'] })
    expect(out).not.toContain('ARB-001')
    expect(out[0]).toBe('ARB-002')
    expect(codes({ shopping_for: 'A gift for him', scent_families: ['Rose & Florals'] })).toEqual([])
  })

  it('gives oil lovers the oil unless they avoid oud; nothing loved, nothing suggested', () => {
    expect(codes({ scent_families: ['Oud & Woods'], scent_forms: ['Perfume oil'] })[0]).toBe('OIL-001')
    expect(codes({ scent_families: ['Oud & Woods'], scent_avoid: ['Heavy oud'], scent_forms: ['Perfume oil'] })).not.toContain('OIL-001')
    expect(codes({ scent_avoid: ['Smoky'] })).toEqual([])
  })

  it('writes the associate the same line the server writes', () => {
    expect(
      summary({ shopping_for: 'A gift for her', scent_families: ['Rose & Florals'], scent_avoid: ['Too sweet'], scent_intensity: 'Noticed nearby', scent_forms: ['Perfume oil'], scent_moments: ["Eid & Jumu'ah"], signature_scent: 'Delina', occasions: ['Anniversary'] })
    ).toBe("A gift for her · Loves Rose & Florals · Avoids too sweet · Noticed nearby · Perfume oil · For Eid & Jumu'ah · Wears Delina · Coming up: Anniversary")
    expect(summary({ shopping_for: 'Myself' })).toBe('')
  })
})

describe('v1.6 — the mock Concierge endpoint', () => {
  beforeEach(() => {
    localStorage.clear()
    __mockSalon.reset()
  })
  async function pairedWithClient(pos: string) {
    const pc = await mockSalon.pairing_code('CHI-OAK', pos)
    const s = await mockSalon.pair(pc.code)
    const who = await mockSalon.identify(s.token, '412 555 1037')
    expect(who.found).toBe(true)
    return { token: s.token, customer: who.client!.customer }
  }

  it('saves the client’s own answers to their profile, tells the till, and names what to try', async () => {
    const { token, customer } = await pairedWithClient('POS-16A')
    const out = await mockSalon.preferences(token, { shopping_for: 'Myself', scent_families: ['Oud & Woods'], scent_intensity: 'Leaves a trail', signature_scent: 'Oud Wood', occasions: ['Birthday'], birthday: '1990-05-01' })
    expect(out.saved).toEqual(expect.arrayContaining(['scent_families', 'scent_intensity', 'signature_scent', 'birthday', 'style_notes']))
    expect(out.summary).toContain('Loves Oud & Woods')
    expect(out.suggestions?.length).toBeGreaterThan(0)
    const p = __mockSalon.profiles()[customer]
    expect(p.scent_families).toBe('Oud & Woods')
    expect(p.ring_size).toBeUndefined()
    const msg = (await mockSalon.pos_poll(token, 0)).messages.find((m) => m.type === 'preferences')!
    expect(msg.summary).toBe(out.summary)
    expect(msg.suggestions?.map((x) => x.item_code)).toEqual(out.suggestions?.map((x) => x.item_code))
  })

  it('keeps a gift’s answers off the client’s own profile', async () => {
    const { token, customer } = await pairedWithClient('POS-16B')
    const out = await mockSalon.preferences(token, { shopping_for: 'A gift for her', scent_families: ['Rose & Florals'], occasions: ['Birthday', 'Anniversary'], birthday: '1990-05-01', anniversary: '2015-06-20' })
    expect(out.saved).not.toContain('scent_families')
    expect(out.saved).not.toContain('birthday')
    expect(out.saved).toContain('anniversary') // shared, so it is theirs too
    expect(out.summary?.startsWith('A gift for her')).toBe(true)
    expect(out.suggestions?.every((x) => x.item_code !== 'ARB-002')).toBe(true) // his, not hers
    expect(__mockSalon.profiles()[customer].scent_families).toBeUndefined()
  })
})
