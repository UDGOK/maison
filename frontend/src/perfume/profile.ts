/**
 * v1.6 — **the perfumery's vocabulary** for the screens: what the Concierge asks on the client
 * display, what the till's Client panel shows and edits. The mirror of `maison_pos/perfume.py`;
 * the lists must stay identical (both test files pin the same literals).
 *
 * The server does the shelf matching for real (`salon.preferences` → `perfume.suggest`); the
 * TypeScript `suggest` exists for the mock API and the unit tests, and follows the same rules.
 */

export type ShoppingFor = 'Myself' | 'A gift for him' | 'A gift for her' | 'A gift'

export const SHOPPING_FOR: { key: ShoppingFor; title: string; line: string }[] = [
  { key: 'Myself', title: 'For me', line: 'A scent of my own' },
  { key: 'A gift for him', title: 'A gift for him', line: 'Something he will wear' },
  { key: 'A gift for her', title: 'A gift for her', line: 'Something she will love' },
  { key: 'A gift', title: 'A gift', line: 'Not sure yet — help me choose' }
]

/** family → [the card's line, the words it matches in `Item.maison_fragrance_family`, its swatch] */
export const SCENT_FAMILIES: [string, string, string[], string][] = [
  ['Oud & Woods', 'Agarwood, sandalwood, cedar', ['oud', 'attar', 'wood', 'sandal', 'cedar', 'vetiver'], 'linear-gradient(135deg, #7a5230, #2c1a0e)'],
  ['Amber & Spice', 'Warm resins, saffron, cardamom', ['oriental', 'amber', 'spic', 'saffron', 'resin'], 'linear-gradient(135deg, #e3a04a, #8a4513)'],
  ['Rose & Florals', 'Taif rose, jasmine, orange blossom', ['floral', 'rose', 'jasmin', 'blossom'], 'linear-gradient(135deg, #f0b8c0, #9c3f55)'],
  ['Musk & Powder', 'Soft, clean, close to the skin', ['musk', 'powder', 'aldehyd', 'iris'], 'linear-gradient(135deg, #f6efe6, #b9ab9c)'],
  ['Fresh & Citrus', 'Bergamot, lemon, neroli', ['citrus', 'fresh', 'bergamot', 'neroli'], 'linear-gradient(135deg, #f4e58a, #a3b53a)'],
  ['Aquatic & Green', 'Sea air, herbs, cut grass', ['aquatic', 'marine', 'green', 'aromatic', 'herb'], 'linear-gradient(135deg, #9fd4d1, #2f6f73)'],
  ['Sweet & Gourmand', 'Vanilla, caramel, ripe fruit', ['gourmand', 'vanilla', 'sweet', 'fruity', 'caramel'], 'linear-gradient(135deg, #f1cf9a, #9b5f2a)'],
  ['Leather & Smoke', 'Incense, leather, bakhoor', ['leather', 'smok', 'incense', 'bakhoor', 'tobacco'], 'linear-gradient(135deg, #6b5d6e, #1d1a20)']
]
export const FAMILY_NAMES = SCENT_FAMILIES.map(([n]) => n)

export const SCENT_AVOID: [string, string[]][] = [
  ['Too sweet', ['gourmand', 'sweet', 'vanilla', 'caramel']],
  ['Heavy oud', ['oud', 'attar']],
  ['Smoky', ['smok', 'incense', 'bakhoor', 'leather', 'tobacco']],
  ['Strong florals', ['floral', 'rose', 'jasmin', 'tuberose']],
  ['Powdery', ['powder', 'aldehyd', 'iris']],
  ['Too fresh or soapy', ['fresh', 'aquatic', 'marine', 'soap']]
]
export const AVOID_NAMES = SCENT_AVOID.map(([n]) => n)

export type Intensity = 'Close to the skin' | 'Noticed nearby' | 'Leaves a trail'
export const SCENT_INTENSITY: [Intensity, string, string[]][] = [
  ['Close to the skin', 'Only you, and whoever you hug', ['EDT', 'Perfume Oil', 'Body Mist', 'Body Spray', 'Cologne']],
  ['Noticed nearby', 'Present in a room, never loud', ['EDP', 'EDT', 'Perfume Oil']],
  ['Leaves a trail', 'They know you were here', ['Parfum', 'Extrait de Parfum', 'EDP']]
]
export const INTENSITY_NAMES = SCENT_INTENSITY.map(([n]) => n)

export const SCENT_FORMS: [string, string, string[]][] = [
  ['Spray', 'Eau de parfum, eau de toilette', ['EDP', 'EDT', 'Parfum', 'Extrait de Parfum', 'Cologne']],
  ['Perfume oil', 'Attar — alcohol-free', ['Perfume Oil']],
  ['Body mist', 'Light, all over', ['Body Mist', 'Body Spray']],
  ['Bakhoor', 'For the home and the clothes', ['Bakhoor', 'Incense']]
]
export const FORM_NAMES = SCENT_FORMS.map(([n]) => n)

export const SCENT_MOMENTS = ['Every day', 'Work', 'Evenings out', 'Date night', 'Weddings', "Eid & Jumu'ah", 'Summer', 'Winter']

export const SCENT_OCCASIONS = ['Birthday', 'Anniversary', 'Eid', 'Wedding', 'Graduation', "Mother's Day", "Father's Day", "Valentine's Day", 'Just because']

/** What the Concierge sends (`salon.preferences`) — every part optional, every list capped. */
export interface PerfumeAnswers {
  shopping_for?: ShoppingFor
  scent_families?: string[]
  scent_avoid?: string[]
  scent_intensity?: Intensity | null
  scent_forms?: string[]
  scent_moments?: string[]
  signature_scent?: string | null
  occasions?: string[]
  birthday?: string
  anniversary?: string
}

/** What comes back to put on the counter. Never a price — the associate brings them to try. */
export interface ScentSuggestion {
  item_code: string
  item_name: string
  image?: string | null
  family?: string | null
  concentration?: string | null
  size?: string | null
}

/** Toggle *v* in *list* (at most *max*); a single-choice list passes max 1 and swaps. */
export function toggle(list: string[], v: string, max: number): string[] {
  if (list.includes(v)) return list.filter((x) => x !== v)
  if (max === 1) return [v]
  return list.length < max ? [...list, v] : list
}

/** Profile Data fields hold their list comma-separated (no name here carries a comma). */
export function splitList(value: string | null | undefined): string[] {
  return (value || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}
export function joinList(values: string[]): string {
  return values.join(', ')
}

/** One line for the associate — the same wording as `perfume.summary` on the server. */
export function summary(a: PerfumeAnswers): string {
  const bits: string[] = []
  if (a.shopping_for && a.shopping_for !== 'Myself') bits.push(a.shopping_for)
  if (a.scent_families?.length) bits.push('Loves ' + a.scent_families.join(', '))
  if (a.scent_avoid?.length) bits.push('Avoids ' + a.scent_avoid.join(', ').toLowerCase())
  const how = [a.scent_intensity || '', ...(a.scent_forms || [])].filter(Boolean)
  if (how.length) bits.push(how.join(' · '))
  if (a.scent_moments?.length) bits.push('For ' + a.scent_moments.join(', '))
  if (a.signature_scent) bits.push('Wears ' + a.signature_scent)
  if (a.occasions?.length) bits.push('Coming up: ' + a.occasions.join(', '))
  return bits.join(' · ')
}

export interface ShelfItem extends ScentSuggestion {
  gender?: string | null
  on_hand: number
}

const hits = (family: string, words: string[]) => {
  const f = (family || '').toLowerCase()
  return words.some((w) => f.includes(w))
}

/** How well one shelf item fits — `null` when it must not be suggested (mirror of `score_item`). */
export function scoreItem(item: ShelfItem, a: PerfumeAnswers): number | null {
  const family = item.family || ''
  const conc = item.concentration || ''
  const loves = a.scent_families || []
  if (!family && !loves.length) return null
  for (const av of a.scent_avoid || []) if (hits(family, SCENT_AVOID.find(([n]) => n === av)?.[1] || [])) return null
  const allowed = a.shopping_for === 'A gift for him' ? ['Men', 'Unisex', ''] : a.shopping_for === 'A gift for her' ? ['Women', 'Unisex', ''] : null
  if (allowed && !allowed.includes(item.gender || '')) return null
  let score = allowed && item.gender === allowed[0] ? 0.5 : 0
  let loved = 0
  for (const fam of loves) if (hits(family, SCENT_FAMILIES.find(([n]) => n === fam)?.[2] || [])) loved += 3
  if (loves.length && !loved) return null
  score += loved
  if (a.scent_intensity && (SCENT_INTENSITY.find(([n]) => n === a.scent_intensity)?.[2] || []).includes(conc)) score += 1
  if ((a.scent_forms || []).some((f) => (SCENT_FORMS.find(([n]) => n === f)?.[2] || []).includes(conc))) score += 1.5
  const gift = (a.shopping_for || 'Myself') !== 'Myself'
  if (conc === 'Gift Set') score += gift ? 1 : -1
  return score
}

export function suggest(items: ShelfItem[], a: PerfumeAnswers, limit = 3): ScentSuggestion[] {
  if (!a.scent_families?.length) return []
  return items
    .map((it) => ({ it, s: scoreItem(it, a) }))
    .filter((r): r is { it: ShelfItem; s: number } => r.s !== null && r.s > 0)
    .sort((x, y) => y.s - x.s || Math.min(y.it.on_hand, 6) - Math.min(x.it.on_hand, 6) || x.it.item_name.localeCompare(y.it.item_name))
    .slice(0, limit)
    .map(({ it }) => ({ item_code: it.item_code, item_name: it.item_name, image: it.image ?? null, family: it.family ?? null, concentration: it.concentration ?? null, size: it.size ?? null }))
}
