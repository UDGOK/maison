/**
 * v0.6 N — AAMVA PDF417 (US / Canadian driver's licence & ID card) parser for the 21+ age gate.
 *
 * The wedge scanner (or the camera) hands us the raw barcode text. We read only what the gate
 * needs — date of birth, expiry, the two initials and the issuing jurisdiction — and never keep
 * the payload: the store mirrors `maison_pos/api/age.py` (`parse_aamva`, `evaluate`) so the
 * decision is the same on the device (offline) and on the server.
 *
 * Layout (DL/ID card design standard, versions 1 … 10):
 *
 *     @\n\x1e\rANSI 636026080102DL00410278ZT03190024DLDAQ12345678\nDCSDOE\nDACJOHN\n…
 *     DBB05151990\nDBA05152030\nDAJTX\nDCGUSA\n…
 *
 * Three-letter element ids at line starts. `DBB` = DOB, `DBA` = expiry, `DCS` family name,
 * `DAC` / `DCT` given name, `DAJ` jurisdiction, `DCG` country. Dates are `MMDDCCYY` for US cards
 * (AAMVA ≥ 2) and `CCYYMMDD` for Canada and AAMVA version 1.
 */

export interface AamvaParsed {
  ok: boolean
  /** ISO date `YYYY-MM-DD` */
  dob: string | null
  expiry: string | null
  initials: string | null
  jurisdiction: string | null
  country: string
  version: number
  reason?: 'empty' | 'no_dob' | 'not_aamva'
}

export type AgeOutcome = 'Verified' | 'Underage' | 'Expired' | 'Unreadable'

export interface AgeDecision {
  outcome: AgeOutcome
  ok: boolean
  age: number | null
  dob_year_ok: 0 | 1
  expired: 0 | 1
}

const TAG_RE = /^(D[A-Z]{2}|Z[A-Z]{2})(.*)$/

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function isoDate(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${pad(m)}-${pad(d)}`
}

/** `MMDDCCYY` (US) or `CCYYMMDD` (Canada / AAMVA v1) → ISO date; null when unreadable. */
export function parseAamvaDate(raw: string, country = 'USA', version = 0): string | null {
  const digits = (raw || '').replace(/\D/g, '')
  if (digits.length !== 8) return null
  let yearFirst = country.toUpperCase().startsWith('CAN') || version === 1
  if (!yearFirst && parseInt(digits.slice(0, 2), 10) > 12) yearFirst = true // "20xx…" cannot be a month
  if (yearFirst) return isoDate(parseInt(digits.slice(0, 4), 10), parseInt(digits.slice(4, 6), 10), parseInt(digits.slice(6, 8), 10))
  return isoDate(parseInt(digits.slice(4, 8), 10), parseInt(digits.slice(0, 2), 10), parseInt(digits.slice(2, 4), 10))
}

/** True when the text looks like a PDF417 licence payload (vs. a product barcode or client QR). */
export function looksLikeAamva(raw: string): boolean {
  const t = raw || ''
  return /ANSI\s?\d{6}/.test(t) || t.includes('AAMVA') || (/(^|[\n\r\x1e\x1d])DBB\d{8}/.test(t) && /(^|[\n\r\x1e\x1d])D[A-Z]{2}/.test(t))
}

export function parseAamva(raw: string): AamvaParsed {
  const text = (raw || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const base: AamvaParsed = { ok: false, dob: null, expiry: null, initials: null, jurisdiction: null, country: 'USA', version: 0 }
  if (!text.trim()) return { ...base, reason: 'empty' }
  let version = 0
  const m = /ANSI\s?(\d{6})(\d{2})/.exec(text)
  if (m) version = parseInt(m[2], 10) || 0
  else if (text.includes('AAMVA')) version = 1
  const fields: Record<string, string> = {}
  for (let line of text.split(/[\n\x1e\x1d]/)) {
    line = line.replace(/^[\x1e\x1d\r ]+|[\x1e\x1d\r ]+$/g, '')
    if (!line) continue
    const idx = line.indexOf('DAQ')
    if (idx > 0 && !TAG_RE.test(line)) line = line.slice(idx) // first data element glued to the header
    const mm = TAG_RE.exec(line)
    if (!mm) continue
    if (!(mm[1] in fields)) fields[mm[1]] = mm[2].trim()
  }
  if (!Object.keys(fields).length) return { ...base, reason: 'not_aamva', version }
  const country = (fields.DCG || 'USA').toUpperCase()
  const dob = parseAamvaDate(fields.DBB || '', country, version)
  const expiry = parseAamvaDate(fields.DBA || '', country, version)
  let family = fields.DCS || ''
  let given = fields.DAC || fields.DCT || ''
  if (!family && !given && fields.DAA) {
    const parts = fields.DAA.split(/[,\s]+/).filter(Boolean)
    family = parts[0] || ''
    given = parts[1] || ''
  }
  const initials = ((given[0] || '') + (family[0] || '')).toUpperCase() || null
  return { ok: dob !== null, dob, expiry, initials, jurisdiction: fields.DAJ || null, country, version, ...(dob === null ? { reason: 'no_dob' as const } : {}) }
}

/** Full years between `dob` and `on` (ISO dates). */
export function ageOn(dob: string, on: string): number {
  const [y, m, d] = dob.split('-').map((x) => parseInt(x, 10))
  const [oy, om, od] = on.split('-').map((x) => parseInt(x, 10))
  let years = oy - y
  if (om < m || (om === m && od < d)) years -= 1
  return years
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Pure decision, identical to the server's `evaluate`: under `minimumAge` → Underage, expired ID → Expired. */
export function evaluateAge(dob: string | null, expiry: string | null, minimumAge: number, today: string = todayIso()): AgeDecision {
  if (!dob) return { outcome: 'Unreadable', ok: false, age: null, dob_year_ok: 0, expired: 0 }
  const age = ageOn(dob, today)
  const expired: 0 | 1 = expiry && expiry < today ? 1 : 0
  const dob_year_ok: 0 | 1 = parseInt(today.slice(0, 4), 10) - parseInt(dob.slice(0, 4), 10) >= minimumAge ? 1 : 0
  if (age < minimumAge) return { outcome: 'Underage', ok: false, age, dob_year_ok, expired }
  if (expired) return { outcome: 'Expired', ok: false, age, dob_year_ok, expired: 1 }
  return { outcome: 'Verified', ok: true, age, dob_year_ok, expired: 0 }
}

/** Build a synthetic AAMVA payload (tests / e2e / the mock scanner). Dates ISO. */
export function syntheticAamva(opts: { dob: string; expiry: string; family?: string; given?: string; jurisdiction?: string; country?: string }): string {
  const us = (iso: string) => `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}`
  const j = opts.jurisdiction || 'TX'
  const body = [`DAQ${Math.floor(Math.random() * 1e8)}`, `DCS${opts.family || 'SAMPLE'}`, `DDEN`, `DAC${opts.given || 'ALEX'}`, `DDFN`, `DAD`, `DDGN`, `DCAC`, `DCBNONE`, `DCDNONE`, `DBD01012024`, `DBB${us(opts.dob)}`, `DBA${us(opts.expiry)}`, `DBC1`, `DAU070 in`, `DAYBRO`, `DAG123 MAIN ST`, `DAIHOUSTON`, `DAJ${j}`, `DAK770980000  `, `DCF00000000`, `DCG${opts.country || 'USA'}`, `DCK0000000000`, `DDAF`, `DDB01012020`].join('\n')
  return `@\n\x1e\rANSI 636015090102DL00410${String(body.length).padStart(3, '0')}DL${body}\r`
}
