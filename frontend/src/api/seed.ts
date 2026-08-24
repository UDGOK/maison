/** Deterministic seed data for the mock API. */
import type { Associate, Boutique, Customer, Item, LoyaltyProgram, PricingRule, TaxRow } from './types'

/** sha256("1234") etc. — precomputed so the mock matches what the server would ship. */
export const PIN_HASHES: Record<string, string> = {
  '1234': '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4',
  '2468': 'a1fb4e703a9ef1fa4936801721ff285a97ac85330856674412e054892afe6972',
  '0000': '9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0',
  '5555': 'c1f330d0aff31c1c87403f1e4347bcc21aff7c179908723535f2b31723702525',
  '1111': '0ffe1abd1a08215353c233d6e009613e95eec4253832a761af28ff37ac5a150c'
}

export const BOUTIQUES: Boutique[] = [
  {
    name: 'CHI-OAK',
    boutique_name: 'AWANZ Oak Street',
    company: 'AWANZ Jewelers',
    warehouse: 'CHI-OAK - MJ',
    cost_center: 'CHI-OAK - MJ',
    pos_profile: 'CHI-OAK POS',
    address_line: '118 East Oak Street',
    city: 'Chicago, IL 60611',
    phone: '+1 312 555 0118',
    email: 'oak@maison.example',
    tax_template: 'Chicago Sales Tax - MJ',
    stripe_location_id: 'tml_CHIOAK',
    printer_ip: '192.168.1.50',
    printer_model: 'TM-m30III',
    enabled: 1,
    currency: 'USD'
  },
  {
    name: 'NYC-MAD',
    boutique_name: 'AWANZ Madison Avenue',
    company: 'AWANZ Jewelers',
    warehouse: 'NYC-MAD - MJ',
    cost_center: 'NYC-MAD - MJ',
    pos_profile: 'NYC-MAD POS',
    address_line: '745 Madison Avenue',
    city: 'New York, NY 10065',
    phone: '+1 212 555 0745',
    email: 'madison@maison.example',
    tax_template: 'NYC Sales Tax - MJ',
    stripe_location_id: 'tml_NYCMAD',
    printer_ip: '192.168.2.50',
    printer_model: 'TM-m30III',
    enabled: 1,
    currency: 'USD'
  },
  {
    name: 'LA-RODEO',
    boutique_name: 'AWANZ Rodeo Drive',
    company: 'AWANZ Jewelers',
    warehouse: 'LA-RODEO - MJ',
    cost_center: 'LA-RODEO - MJ',
    pos_profile: 'LA-RODEO POS',
    address_line: '310 North Rodeo Drive',
    city: 'Beverly Hills, CA 90210',
    phone: '+1 310 555 0310',
    email: 'rodeo@maison.example',
    tax_template: 'LA Sales Tax - MJ',
    stripe_location_id: 'tml_LARODEO',
    printer_ip: '192.168.3.50',
    printer_model: 'TM-m30III',
    enabled: 1,
    currency: 'USD'
  }
]

export const ASSOCIATES: Associate[] = [
  { name: 'MA-0001', user: 'claire.dubois@maison.example', full_name: 'Claire Dubois', boutique: 'CHI-OAK', role: 'Manager', pin_hash: PIN_HASHES['1234'] },
  { name: 'MA-0002', user: 'marcus.lee@maison.example', full_name: 'Marcus Lee', boutique: 'CHI-OAK', role: 'Associate', pin_hash: PIN_HASHES['1111'] },
  { name: 'MA-0003', user: 'sofia.ramos@maison.example', full_name: 'Sofia Ramos', boutique: 'NYC-MAD', role: 'Manager', pin_hash: PIN_HASHES['1234'] },
  { name: 'MA-0004', user: 'theo.okafor@maison.example', full_name: 'Theo Okafor', boutique: 'NYC-MAD', role: 'Associate', pin_hash: PIN_HASHES['1111'] },
  { name: 'MA-0005', user: 'isabelle.moreau@maison.example', full_name: 'Isabelle Moreau', boutique: 'LA-RODEO', role: 'Manager', pin_hash: PIN_HASHES['1234'] },
  { name: 'MA-0006', user: 'daniel.kim@maison.example', full_name: 'Daniel Kim', boutique: 'LA-RODEO', role: 'Associate', pin_hash: PIN_HASHES['1111'] }
]

export const TAXES: TaxRow[] = [
  { charge_type: 'On Net Total', account_head: 'Sales Tax - MJ', description: 'Sales Tax 10.25%', rate: 10.25 }
]

export const ITEM_GROUPS = ['Rings', 'Necklaces', 'Bracelets', 'Earrings', 'Watches', 'High Jewelry', 'Accessories']
export const DEPARTMENTS = ['Bridal', 'Fine', 'Timepieces', 'Haute', 'Gifts']

export const LOYALTY: LoyaltyProgram = {
  name: 'AWANZ Cercle',
  collection_factor: 1, // 1 point per currency unit
  conversion_factor: 0.01, // 1 point = 0.01 USD
  tiers: [
    { tier: 'Member', min_spent: 0 },
    { tier: 'Silver', min_spent: 10000 },
    { tier: 'Gold', min_spent: 50000 },
    { tier: 'Platinum', min_spent: 150000 }
  ]
}

type Seed = [
  code: string,
  name: string,
  group: string,
  dept: string,
  price: number,
  serial: 0 | 1,
  metal: string,
  carat: string,
  stones: string,
  taxable: 0 | 1
]

const RAW: Seed[] = [
  ['RG-SOL-001', 'Solitaire Round 1.02ct', 'Rings', 'Bridal', 12400, 1, 'Platinum', '1.02', 'Diamond', 1],
  ['RG-SOL-002', 'Solitaire Oval 1.51ct', 'Rings', 'Bridal', 18900, 1, 'Platinum', '1.51', 'Diamond', 1],
  ['RG-HAL-003', 'Halo Cushion 2.03ct', 'Rings', 'Bridal', 28500, 1, '18k White Gold', '2.03', 'Diamond', 1],
  ['RG-ETE-004', 'Eternity Band 2mm', 'Rings', 'Bridal', 4200, 0, 'Platinum', '0.80', 'Diamond', 1],
  ['RG-SIG-005', 'Signet Onyx', 'Rings', 'Fine', 1850, 0, '18k Yellow Gold', '', 'Onyx', 1],
  ['RG-SAP-006', 'Ceylon Sapphire Trilogy', 'Rings', 'Fine', 9600, 1, '18k White Gold', '2.40', 'Sapphire, Diamond', 1],
  ['RG-EMR-007', 'Colombian Emerald 3.10ct', 'Rings', 'Haute', 46000, 1, 'Platinum', '3.10', 'Emerald', 1],
  ['RG-STK-008', 'Stacking Band Pave', 'Rings', 'Fine', 1350, 0, '18k Rose Gold', '0.25', 'Diamond', 1],
  ['NK-TEN-009', 'Tennis Necklace 12ct', 'Necklaces', 'Fine', 32000, 1, '18k White Gold', '12.00', 'Diamond', 1],
  ['NK-PND-010', 'Pear Drop Pendant', 'Necklaces', 'Fine', 5400, 0, '18k White Gold', '0.75', 'Diamond', 1],
  ['NK-PRL-011', 'South Sea Pearl Strand', 'Necklaces', 'Fine', 14800, 1, '18k Yellow Gold', '', 'South Sea Pearl', 1],
  ['NK-CHN-012', 'Curb Chain 50cm', 'Necklaces', 'Gifts', 2200, 0, '18k Yellow Gold', '', '', 1],
  ['NK-RIV-013', 'Riviere Sapphire', 'Necklaces', 'Haute', 68000, 1, 'Platinum', '18.50', 'Sapphire, Diamond', 1],
  ['NK-LCK-014', 'Locket Oval', 'Necklaces', 'Gifts', 1600, 0, '18k Rose Gold', '', '', 1],
  ['BR-TEN-015', 'Tennis Bracelet 5ct', 'Bracelets', 'Fine', 11900, 1, '18k White Gold', '5.00', 'Diamond', 1],
  ['BR-BNG-016', 'Hinged Bangle', 'Bracelets', 'Fine', 3900, 0, '18k Yellow Gold', '', '', 1],
  ['BR-CUF-017', 'Pave Cuff', 'Bracelets', 'Haute', 24500, 1, '18k White Gold', '6.20', 'Diamond', 1],
  ['BR-CHN-018', 'Link Bracelet', 'Bracelets', 'Gifts', 2600, 0, '18k Rose Gold', '', '', 1],
  ['BR-CHR-019', 'Charm Bracelet', 'Bracelets', 'Gifts', 1450, 0, 'Sterling Silver', '', '', 1],
  ['ER-STD-020', 'Diamond Studs 1ct tw', 'Earrings', 'Fine', 4800, 0, 'Platinum', '1.00', 'Diamond', 1],
  ['ER-STD-021', 'Diamond Studs 2ct tw', 'Earrings', 'Fine', 13500, 1, 'Platinum', '2.00', 'Diamond', 1],
  ['ER-HOP-022', 'Pave Hoops 25mm', 'Earrings', 'Fine', 6200, 0, '18k White Gold', '1.40', 'Diamond', 1],
  ['ER-DRP-023', 'Emerald Drops', 'Earrings', 'Haute', 38000, 1, 'Platinum', '4.80', 'Emerald, Diamond', 1],
  ['ER-PRL-024', 'Akoya Pearl Studs', 'Earrings', 'Gifts', 980, 0, '18k Yellow Gold', '', 'Akoya Pearl', 1],
  ['ER-HUG-025', 'Huggie Hoops', 'Earrings', 'Gifts', 1100, 0, '18k Yellow Gold', '', '', 1],
  ['WT-CHR-026', 'Chronograph 41mm Steel', 'Watches', 'Timepieces', 8900, 1, 'Stainless Steel', '', '', 1],
  ['WT-DRS-027', 'Dress Watch 38mm Rose', 'Watches', 'Timepieces', 21500, 1, '18k Rose Gold', '', '', 1],
  ['WT-DVR-028', 'Diver 42mm Ceramic', 'Watches', 'Timepieces', 11200, 1, 'Titanium', '', '', 1],
  ['WT-LAD-029', 'Ladies 29mm Diamond Bezel', 'Watches', 'Timepieces', 27800, 1, '18k White Gold', '1.10', 'Diamond', 1],
  ['WT-GMT-030', 'GMT 40mm Two-Tone', 'Watches', 'Timepieces', 15900, 1, 'Steel, 18k Yellow Gold', '', '', 1],
  ['WT-TOU-031', 'Tourbillon 42mm Platinum', 'Watches', 'Timepieces', 145000, 1, 'Platinum', '', '', 1],
  ['HJ-PAR-032', 'Parure Sapphire Suite', 'High Jewelry', 'Haute', 240000, 1, 'Platinum', '42.00', 'Sapphire, Diamond', 1],
  ['HJ-TIA-033', 'Diamond Tiara', 'High Jewelry', 'Haute', 185000, 1, 'Platinum', '30.00', 'Diamond', 1],
  ['HJ-BRO-034', 'Panther Brooch', 'High Jewelry', 'Haute', 56000, 1, '18k Yellow Gold', '3.40', 'Emerald, Onyx, Diamond', 1],
  ['AC-BOX-035', 'Travel Jewelry Case', 'Accessories', 'Gifts', 420, 0, 'Leather', '', '', 1],
  ['AC-CLN-036', 'Jewelry Cleaning Kit', 'Accessories', 'Gifts', 45, 0, '', '', '', 1],
  ['AC-STR-037', 'Watch Strap Alligator', 'Accessories', 'Timepieces', 390, 0, 'Alligator Leather', '', '', 1],
  ['AC-WND-038', 'Watch Winder Single', 'Accessories', 'Timepieces', 1250, 0, 'Walnut', '', '', 1],
  ['AC-GFT-039', 'Gift Card', 'Accessories', 'Gifts', 500, 0, '', '', '', 0],
  ['SV-APP-040', 'Appraisal Service', 'Accessories', 'Fine', 150, 0, '', '', '', 0]
]

/* ---------- v0.2: placeholder product images (SVG data URIs), EAN-13 barcodes ---------- */

const IMG_PALETTE: Record<string, [string, string]> = {
  Rings: ['#2a2420', '#c9a96e'],
  Necklaces: ['#1f2226', '#d8d3c6'],
  Bracelets: ['#26201c', '#b98f5a'],
  Earrings: ['#20242a', '#e6dfd0'],
  Watches: ['#1a1c1f', '#9aa3ad'],
  'High Jewelry': ['#2b2117', '#e3c27f'],
  Accessories: ['#1d1b18', '#8f8677']
}

/** Solid-colour SVG "product photo" with a monogram — small enough to ship inline in the seed. */
export function placeholderImage(code: string, name: string, group: string): string {
  const [bg, fg] = IMG_PALETTE[group] || ['#1b1916', '#c9a96e']
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='600' height='450' viewBox='0 0 600 450'>` +
    `<rect width='600' height='450' fill='${bg}'/>` +
    `<circle cx='300' cy='205' r='120' fill='none' stroke='${fg}' stroke-width='3' opacity='.55'/>` +
    `<circle cx='300' cy='205' r='78' fill='none' stroke='${fg}' stroke-width='1.5' opacity='.35'/>` +
    `<text x='300' y='228' text-anchor='middle' font-family='Arial Black,Arial,sans-serif' font-weight='900' font-size='64' fill='${fg}'>${initials}</text>` +
    `<text x='300' y='405' text-anchor='middle' font-family='Arial,sans-serif' font-size='22' letter-spacing='6' fill='${fg}' opacity='.7'>${code}</text>` +
    `</svg>`
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
}

/** EAN-13 check digit. */
export function ean13CheckDigit(d12: string): string {
  let sum = 0
  for (let i = 0; i < 12; i++) sum += parseInt(d12[i], 10) * (i % 2 === 0 ? 1 : 3)
  return String((10 - (sum % 10)) % 10)
}

/** Deterministic EAN-13 for a seed index: prefix 200 (internal) + 9-digit body + check. */
export function ean13For(index: number): string {
  const body = `200${String(100000 + index * 7331).padStart(9, '0')}`.slice(0, 12)
  return body + ean13CheckDigit(body)
}

export const ITEMS: Item[] = RAW.map(([code, name, group, dept, , serial, metal, carat, stones, taxable], i) => ({
  item_code: code,
  item_name: name,
  item_group: group,
  description: `${name}${metal ? ' in ' + metal : ''}${stones ? ', ' + stones : ''}`,
  has_serial_no: serial,
  stock_uom: 'Nos',
  maison_metal: metal || undefined,
  maison_carat: carat || undefined,
  maison_stones: stones || undefined,
  maison_certificate_no: serial ? `GIA-${(2200000000 + i * 7919).toString()}` : undefined,
  maison_appraisal_value: serial ? Math.round(RAW[i][4] * 1.35) : undefined,
  maison_department: dept,
  maison_taxable: taxable,
  // ~half of the catalogue ships with a photo; the rest exercises the no-image tile
  image: i % 2 === 0 ? placeholderImage(code, name, group) : null,
  maison_barcode: ean13For(i + 1)
}))

/** AWANZ POS Settings (global) — the mock boutique overrides live in `settingsFor`. */
export const SETTINGS_GLOBAL = {
  show_product_images_default: false,
  scan_enabled: true,
  receipt_qr_enabled: true,
  receipt_qr_base_url: 'https://maison-demo.frappe.cloud',
  loyalty_lookup_enabled: true
}

/** Per-boutique `show_product_images` (AWANZ Store check) — CHI-OAK shows photos by default. */
export const BOUTIQUE_SHOW_IMAGES: Record<string, boolean> = { 'CHI-OAK': true, 'NYC-MAD': false, 'LA-RODEO': false }

/** Barcode map for bootstrap: EAN-13 per item + every serial label (Code-128 = serial no). */
export function barcodesFor(serials: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const it of ITEMS) if (it.maison_barcode) out[it.maison_barcode] = it.item_code
  for (const [code, list] of Object.entries(serials)) for (const sn of list) out[sn] = code
  return out
}

/** `MC` + 6 digits, deterministic per seed index (the server assigns on insert). */
export function clientNumberFor(index: number): string {
  return `MC${String(482910 + index * 1373).slice(-6).padStart(6, '0')}`
}

export const PRICES: Record<string, number> = Object.fromEntries(RAW.map((r) => [r[0], r[4]]))

export const PRICING_RULES: PricingRule[] = [
  { name: 'PR-CHI-OAK-WT-CHR-026', item_code: 'WT-CHR-026', warehouse: 'CHI-OAK - MJ', rate: 8500 },
  { name: 'PR-NYC-MAD-RG-SOL-001', item_code: 'RG-SOL-001', warehouse: 'NYC-MAD - MJ', rate: 12900 },
  { name: 'PR-LA-RODEO-HJ-BRO-034', item_code: 'HJ-BRO-034', warehouse: 'LA-RODEO - MJ', rate: 54000 }
]

/** Serials per boutique: each serialized item gets 1–3 units, prefixed by boutique code. */
export function serialsFor(boutique: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  const bIdx = BOUTIQUES.findIndex((b) => b.name === boutique)
  ITEMS.forEach((it, i) => {
    if (!it.has_serial_no) return
    const n = ((i + bIdx) % 3) + 1
    out[it.item_code] = Array.from({ length: n }, (_, k) => `${boutique.slice(0, 3)}${String(i + 1).padStart(3, '0')}${String(k + 1).padStart(2, '0')}`)
  })
  return out
}

export function stockFor(boutique: string): Record<string, number> {
  const serials = serialsFor(boutique)
  const bIdx = BOUTIQUES.findIndex((b) => b.name === boutique)
  const out: Record<string, number> = {}
  ITEMS.forEach((it, i) => {
    out[it.item_code] = it.has_serial_no ? (serials[it.item_code]?.length ?? 0) : ((i * 3 + bIdx * 5) % 12) + 2
  })
  return out
}

const FIRST = ['Eleanor', 'James', 'Amara', 'Hiroshi', 'Camille', 'Victor', 'Priya', 'Sebastian', 'Noor', 'Leonard', 'Valentina', 'Omar', 'Margaux', 'Kenji', 'Adaeze', 'Rafael', 'Ingrid', 'Tobias', 'Yasmin', 'Harrison']
const LAST = ['Whitmore', 'Castellano', 'Okonkwo', 'Tanaka', 'Beaumont', 'Lindqvist', 'Raghavan', 'Ashford', 'Haddad', 'Vance', 'Moretti', 'Farouk', 'Delacroix', 'Sato', 'Nwosu', 'Ortega', 'Halvorsen', 'Brandt', 'Al-Sayed', 'Pemberton']

export const CUSTOMERS: Customer[] = FIRST.map((f, i) => {
  const spent = [0, 1200, 4800, 12000, 9500, 55000, 160000, 22000, 3100, 75000, 210000, 640, 18000, 99000, 7200, 31000, 150500, 2000, 48000, 500][i]
  const tier = [...LOYALTY.tiers].reverse().find((t) => spent >= t.min_spent)!.tier
  const d = new Date(Date.UTC(2026, 7, 21 - (i * 5) % 60, 14, 30))
  return {
    name: `CUST-${String(i + 1).padStart(4, '0')}`,
    customer_name: `${f} ${LAST[i]}`,
    mobile_no: `+1 ${312 + (i % 3) * 100} 555 ${String(1000 + i * 37).slice(-4)}`,
    email_id: `${f.toLowerCase()}.${LAST[i].toLowerCase().replace(/[^a-z]/g, '')}@example.com`,
    loyalty_points: Math.round(spent * 0.12),
    tier,
    last_visit: spent ? d.toISOString() : undefined,
    last_boutique: spent ? BOUTIQUES[i % 3].name : undefined,
    client_number: clientNumberFor(i),
    maison_face_consent: 0
  }
})
