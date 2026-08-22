/** Shared API types — mirrors SPEC.md "API CONTRACT". */

import { DEFAULT_DISTANCE_THRESHOLD, clampThreshold } from '@/recognition/math'

export interface Boutique {
  name: string
  boutique_name: string
  company: string
  warehouse: string
  cost_center: string
  pos_profile: string
  address_line: string
  city: string
  phone: string
  email: string
  tax_template: string
  stripe_location_id?: string
  printer_ip?: string
  printer_model?: string
  enabled: 1 | 0
  currency: string
}

export interface Associate {
  name: string
  user: string
  full_name: string
  boutique: string
  role: 'Associate' | 'Manager' | 'Regional' | 'HeadOffice'
  /** SHA-256 hex of the PIN — the server never ships plaintext PINs. */
  pin_hash: string
}

export interface TaxRow {
  charge_type: string
  account_head: string
  description: string
  rate: number
}

export interface Item {
  item_code: string
  item_name: string
  item_group: string
  description?: string
  has_serial_no: 0 | 1
  /** 0 for services (non-stock): always sellable regardless of warehouse qty. */
  is_stock_item?: 0 | 1
  stock_uom: string
  maison_metal?: string
  maison_carat?: string
  maison_stones?: string
  maison_certificate_no?: string
  maison_appraisal_value?: number
  maison_department: string
  maison_taxable: 0 | 1
  /** Standard ERPNext Item.image (absolute URL) or null — v0.2 replaces maison_image_url. */
  image?: string | null
  /** Custom unique barcode (maison_barcode); standard Item Barcode rows are merged into `barcodes`. */
  maison_barcode?: string
  disabled?: 0 | 1
}

/** Maison POS Settings (global) merged with the boutique overrides — v0.2 `bootstrap.settings`. */
export interface PosSettings {
  show_product_images: boolean
  scan_enabled: boolean
  receipt_qr_enabled: boolean
  /** Absolute site URL; QR content is `${receipt_qr_base_url}/r/${token}`. */
  receipt_qr_base_url: string
  loyalty_lookup_enabled: boolean
  /** v0.3 — client recognition (camera). Off by default per boutique; Head Office switches it on. */
  face_recognition_enabled: boolean
  /** v0.3 — model id templates are tagged with, e.g. "face-api/faceRecognitionNet@1" */
  recognition_model: string
  /**
   * v0.3 — **maximum euclidean distance between RAW face-api descriptors** (lower = stricter;
   * face-api's rule: `distance < 0.6` = same person). The same rule runs on the server
   * (`maison_pos/biometrics.py`). Descriptors are not unit vectors (‖d‖ ≈ 1.5), so cosine would
   * false-match different people (0.85–0.90). A device may only tighten (lower) this value.
   */
  match_threshold: number
  biometric_retention_months: number
  consent_text: string
  consent_text_version: string
  recognition_offline_cache: boolean
}

/** Backend `catalog.upload_item_image` result: `image` is the absolute URL now on `Item.image`. */
export interface UploadItemImageResult {
  item_code: string
  image: string
  file_url?: string
  file_name?: string
}

/**
 * The backend returns Check fields as ints (0/1); coerce every flag to a real boolean so
 * strict comparisons (`=== false`) behave. Unknown keys are dropped.
 */
export function normalizeSettings(raw?: Partial<Record<keyof PosSettings, unknown>> | null): PosSettings {
  const r = raw || {}
  const flag = (k: keyof PosSettings): boolean => {
    const v = r[k]
    if (v === undefined || v === null || v === '') return DEFAULT_SETTINGS[k] as boolean
    if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true'
    return !!v
  }
  const num = (k: 'match_threshold' | 'biometric_retention_months'): number => {
    const v = Number(r[k])
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_SETTINGS[k]
  }
  return {
    show_product_images: flag('show_product_images'),
    scan_enabled: flag('scan_enabled'),
    receipt_qr_enabled: flag('receipt_qr_enabled'),
    receipt_qr_base_url: String(r.receipt_qr_base_url || DEFAULT_SETTINGS.receipt_qr_base_url).replace(/\/+$/, ''),
    loyalty_lookup_enabled: flag('loyalty_lookup_enabled'),
    face_recognition_enabled: flag('face_recognition_enabled'),
    recognition_model: String(r.recognition_model || DEFAULT_SETTINGS.recognition_model),
    match_threshold: clampThreshold(r.match_threshold, DEFAULT_SETTINGS.match_threshold),
    biometric_retention_months: Math.round(num('biometric_retention_months')),
    consent_text: String(r.consent_text || DEFAULT_SETTINGS.consent_text),
    consent_text_version: String(r.consent_text_version || DEFAULT_SETTINGS.consent_text_version),
    recognition_offline_cache: flag('recognition_offline_cache')
  }
}

/** Default consent text (EN). The backend ships its own; this is the offline / mock fallback. */
export const DEFAULT_CONSENT_TEXT =
  'I agree that Maison may create and store a mathematical template of my facial geometry from a camera image, ' +
  'and use it only to recognise me in Maison boutiques so that my client profile and loyalty benefits can be ' +
  'offered to me at the point of sale. No photograph of my face is kept. Maison will not sell, lease or share this ' +
  'template, will protect it with reasonable security, and will permanently destroy it when I ask, when I have not ' +
  'visited for 36 months, or when it is no longer needed — whichever comes first. I can withdraw this consent at any ' +
  'time by asking any Maison associate, and withdrawing never affects my purchases or loyalty balance.'

export const RECOGNITION_MODEL = 'face-api/faceRecognitionNet@1'
export const RECOGNITION_DIMS = 128

export const DEFAULT_SETTINGS: PosSettings = {
  show_product_images: false,
  scan_enabled: true,
  receipt_qr_enabled: true,
  receipt_qr_base_url: '',
  loyalty_lookup_enabled: true,
  face_recognition_enabled: false,
  recognition_model: RECOGNITION_MODEL,
  match_threshold: DEFAULT_DISTANCE_THRESHOLD,
  biometric_retention_months: 36,
  consent_text: DEFAULT_CONSENT_TEXT,
  consent_text_version: '2026-08-1',
  recognition_offline_cache: true
}

export interface PricingRule {
  name: string
  item_code: string
  warehouse: string
  rate: number
  valid_from?: string
  valid_upto?: string
}

export interface LoyaltyProgram {
  name: string
  /** points earned per currency unit spent */
  collection_factor: number
  /** currency value of one point */
  conversion_factor: number
  tiers: { tier: string; min_spent: number }[]
}

export interface Bootstrap {
  boutique: Boutique
  associates: Associate[]
  pos_profile: string
  taxes: TaxRow[]
  modes_of_payment: string[]
  item_groups: string[]
  departments: string[]
  items: Item[]
  prices: Record<string, number>
  pricing_rules: PricingRule[]
  serials: Record<string, string[]>
  stock: Record<string, number>
  loyalty_program: LoyaltyProgram
  /**
   * v0.2 — every scannable code → item_code: `maison_barcode`, standard Item Barcode rows and
   * every serial number (Code-128 label = serial no). Serial codes are also present in `serials`.
   */
  barcodes: Record<string, string>
  /** v0.2 — merged Maison POS Settings (boutique overrides global). */
  settings: PosSettings
  version: string
}

export interface Delta extends Bootstrap {
  deleted: string[]
}

export interface Customer {
  name: string
  customer_name: string
  mobile_no?: string
  email_id?: string
  loyalty_points: number
  /** v0.2 — redeemable currency value of the balance (points × conversion factor), from the backend. */
  points_value?: number
  tier: string | null
  last_visit?: string
  last_boutique?: string
  /** v0.2 — printed loyalty number `maison_client_number` (e.g. MC482910), unique. */
  client_number?: string
  /** v0.2 — reserved; never populated by the POS. */
  maison_face_id?: string
  /** v0.3 — biometric consent flag (kept in sync with the Active Maison Biometric Consent). */
  maison_face_consent?: 0 | 1
  /** v0.3 — datetime of the active consent (`maison_face_consent_at`; `_on` is the v0.2 alias). */
  maison_face_consent_at?: string
  maison_face_consent_on?: string
  /** v0.3 — number of stored face templates (0 when none / revoked). */
  face_templates?: number
}

// ---------------------------------------------------------------------------------------------
// v0.3 — client recognition (`maison_pos.api.recognition`)
// ---------------------------------------------------------------------------------------------

export interface RecognitionMatch {
  customer: string
  customer_name: string
  client_number?: string
  /** euclidean distance on the raw descriptors (lower is better); the match rule is `distance < threshold`. */
  distance?: number
  /** display only: clamp(1 − distance / 1.2, 0, 1) */
  score: number
  tier?: string | null
  loyalty_points?: number
}

export interface MatchResult {
  matches: RecognitionMatch[]
  /** maximum distance used by the server (authoritative) */
  threshold_distance?: number
  /** alias of `threshold_distance` */
  threshold: number
  best_distance?: number | null
  best_score?: number
}

export type ConsentMethod = 'Hold-to-agree' | 'Signature'

export interface ConsentPayload {
  method: ConsentMethod
  text_version: string
  /** PNG data URL of the signature stroke when `method === 'Signature'` */
  signature_data_url?: string
}

export interface EnrollRequest {
  embeddings: number[][]
  model: string
  quality: number[]
  boutique: string
  device_id: string
  consent: ConsentPayload
  customer?: string
  phone?: string
  email?: string
  name?: string
  /** replay idempotency key (queued enrolments) */
  offline_uuid?: string
}

export interface EnrollResult {
  customer: string
  client_number?: string
  customer_name?: string
  consent: string
  /** row names of the stored templates */
  templates?: string[]
  /** number of stored templates */
  template_count: number
  created?: boolean
  duplicate?: boolean
}

export interface TemplateRow {
  customer: string
  customer_name: string
  client_number?: string
  embedding: number[]
  model: string
}

export interface TemplatesResult {
  templates: TemplateRow[]
  deleted: string[]
  /** server time of this snapshot, pass back as `since` */
  version?: string
}

export type RecognitionOutcome = 'Matched' | 'NoMatch' | 'Enrolled' | 'Undone' | 'Declined'

export interface CustomerHistoryRow {
  invoice: string
  date: string
  boutique: string
  items: string[]
  grand_total: number
}

export interface POSInvoiceItem {
  item_code: string
  qty: number
  rate: number
  serial_no?: string
  discount_amount?: number
}

export interface POSPayment {
  mode_of_payment: 'Cash' | 'Card'
  amount: number
  stripe_payment_intent?: string
}

export interface POSInvoice {
  offline_uuid: string
  boutique: string
  associate: string
  device_id: string
  customer?: string
  posting_datetime: string
  items: POSInvoiceItem[]
  payments: POSPayment[]
  loyalty_points_redeemed?: number
  notes?: string
}

export type SubmitStatus = 'ok' | 'duplicate' | 'error'

export interface SubmitResult {
  offline_uuid: string
  status: SubmitStatus
  invoice_name?: string
  /** v0.2 — Sales Invoice `maison_receipt_token` (16-char urlsafe); QR = `${base}/r/${token}`. */
  receipt_token?: string
  error?: string
  error_code?: string
}

/** v0.2 — guest `sales.receipt(token)` payload (no PII beyond what is printed). */
export interface PublicReceipt {
  token: string
  invoice: string
  boutique: string
  boutique_name: string
  posting_datetime: string
  lines: { item_name: string; qty: number; rate: number; amount: number; serial_no?: string }[]
  net_total: number
  total_taxes: number
  grand_total: number
  currency: string
  payments: { mode_of_payment: string; amount: number; last4?: string }[]
}

export interface SalesSummaryRow {
  invoice: string
  offline_uuid: string
  posting_datetime: string
  associate: string
  customer?: string
  net_total: number
  total_taxes: number
  grand_total: number
  cash: number
  card: number
  items: number
}

export interface SalesList {
  boutique: string
  date: string
  totals: { net: number; tax: number; gross: number; cash: number; card: number; invoices: number; avg_ticket: number }
  invoices: SalesSummaryRow[]
}

export interface LiveSummary {
  totals: { net: number; invoices: number; cash: number; card: number; avg_ticket: number }
  by_boutique: {
    boutique: string
    name: string
    net: number
    cash: number
    card: number
    invoices: number
    status: 'online' | 'offline' | 'pending_approval'
    last_seen: string
  }[]
  by_hour: { hour: number; net: number; invoices: number }[]
  pending_approvals: number
  /** v0.3 */
  recognition?: { matched_today: number; enrolled_today: number }
}

/** Structured error thrown by the API client. */
export class ApiError extends Error {
  constructor(
    message: string,
    public code: string = 'UNKNOWN',
    public status: number = 0,
    public details?: unknown
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

export interface MaisonApi {
  catalog: {
    bootstrap(boutique: string): Promise<Bootstrap>
    delta(boutique: string, since: string): Promise<Delta>
    /** v0.2 — multipart upload (Maison Manager+); attaches a File to the Item and sets Item.image. */
    upload_item_image(item_code: string, file: Blob, filename?: string): Promise<UploadItemImageResult>
  }
  customers: {
    /** v0.2 — also matches client number, phone digits (last 4+), email, name. */
    search(q: string, limit?: number): Promise<Customer[]>
    /** v0.2 — exact match on client number / phone / QR payload (`MC:<customer_id>`); null when none. */
    lookup(code: string): Promise<Customer | null>
    upsert(customer: Partial<Customer>): Promise<{ name: string }>
    history(customer: string, limit?: number): Promise<CustomerHistoryRow[]>
  }
  sales: {
    submit_batch(invoices: POSInvoice[]): Promise<{ results: SubmitResult[] }>
    list(boutique: string, date: string): Promise<SalesList>
    void(invoice: string, reason: string): Promise<{ credit_note: string }>
    /** v0.2 — guest endpoint; JSON of a receipt by token. */
    receipt(token: string): Promise<PublicReceipt>
  }
  stripe_terminal: {
    connection_token(boutique: string): Promise<{ secret: string }>
    create_payment_intent(
      amount: number,
      currency: string,
      offline_uuid: string,
      customer?: string
    ): Promise<{ id: string; client_secret: string }>
    capture(payment_intent_id: string): Promise<{ status: string; charge_id: string; card_brand: string; last4: string }>
  }
  /** v0.3 — on-device embeddings in, customers out. Never sends frames. */
  recognition: {
    match(embedding: number[], model: string, boutique: string): Promise<MatchResult>
    enroll(req: EnrollRequest): Promise<EnrollResult>
    decline(args: { boutique: string; device_id: string; customer?: string; phone?: string; email?: string; name?: string }): Promise<{ customer: string; client_number?: string; customer_name?: string; created?: boolean }>
    templates(boutique: string, since?: string): Promise<TemplatesResult>
    /** Maison Manager+: purges templates, revokes consent, logs. */
    revoke(customer: string, reason: string): Promise<{ ok: boolean }>
    log_event(args: { customer?: string; outcome: RecognitionOutcome; score?: number; sales_invoice?: string; boutique?: string; device_id?: string }): Promise<{ ok: boolean }>
  }
  dashboard: {
    live_summary(date?: string): Promise<LiveSummary>
    heartbeat(boutique: string, device_id: string, queued: number): Promise<{ ok: boolean }>
  }
  /** Boutiques the current user may unlock — used by the Unlock screen. */
  boutiques(): Promise<Pick<Boutique, 'name' | 'boutique_name' | 'city'>[]>
  /**
   * Server-side PIN check (PBKDF2 hash + lockout after 5 failures). The PWA calls this when
   * online and caches a device-local digest so the same PIN keeps working offline.
   */
  verifyPin(associate: string, pin: string): Promise<{ ok: boolean; associate: string; full_name: string; boutique: string; role: string }>
}
