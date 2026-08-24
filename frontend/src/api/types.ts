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
  /** v0.4 A — Stripe Terminal readers paired to the boutique (child table `readers`). */
  readers?: BoutiqueReader[]
  /** v0.4 E — returns in Damaged condition land here */
  damaged_warehouse?: string
  /** v0.6 N/R — the store's IANA zone ("America/Chicago"); every clock on the till renders in it */
  timezone?: string
  region?: string
}

/** v0.4 A — `Maison Boutique Reader` row. */
export type ReaderDeviceType = 'verifone_v660p' | 'stripe_s710' | 'bbpos_wisepos_e' | 'simulated'
export interface BoutiqueReader {
  name?: string
  label: string
  stripe_reader_id?: string
  device_type: ReaderDeviceType
  /** V660p prints through terminal.print(canvas); S710 / WisePOS E fall back to ePOS / browser */
  has_printer: 0 | 1 | boolean
  enabled?: 0 | 1 | boolean
  serial_number?: string
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
  // --- v0.6 N — smoke-shop vertical attributes ---
  maison_brand?: string | null
  maison_flavor?: string | null
  maison_nicotine_mg?: number
  maison_volume_ml?: number
  maison_puffs?: number
  /** 1 = 21+ item: the POS age gate must pass before it is rung up */
  maison_age_restricted?: 0 | 1
  maison_msrp?: number
  // --- end v0.6 N ---
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
  /** v0.4 E — returns policy (merged from Maison POS Settings). */
  return_window_days: number
  exchange_window_days: number
  /** refunds / exchange credits above this need a manager PIN (0 = always) */
  returns_manager_threshold: number
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
  const num = (k: 'match_threshold' | 'biometric_retention_months' | 'return_window_days' | 'exchange_window_days'): number => {
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
    recognition_offline_cache: flag('recognition_offline_cache'),
    return_window_days: Math.round(num('return_window_days')),
    exchange_window_days: Math.round(num('exchange_window_days')),
    returns_manager_threshold: Number.isFinite(Number(r.returns_manager_threshold)) && r.returns_manager_threshold !== undefined && r.returns_manager_threshold !== null && r.returns_manager_threshold !== '' ? Number(r.returns_manager_threshold) : DEFAULT_SETTINGS.returns_manager_threshold
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
  recognition_offline_cache: true,
  return_window_days: 30,
  exchange_window_days: 60,
  returns_manager_threshold: 2500
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
  // --- v0.6 N/Q — brand tokens + fixed reward tiers (see src/api/v06.ts) ---
  brand?: Brand
  reward_tiers?: RewardTier[]
  // --- end v0.6 N/Q ---
}

// --- v0.6 N/Q — brand tokens, vertical product attributes, reward tiers ---
/** `catalog.bootstrap.brand` — everything the user sees is driven by these (never hard-coded "Maison"). */
export interface Brand {
  brand_name: string
  product_name: string
  tagline: string
  wordmark_text: string
  sub_mark: string
  legal_name?: string
  support_email?: string
  brand_website?: string
  brand_logo?: string | null
  vertical: 'Smoke Shop' | 'Jewellery' | 'General'
  /** "Store" (smoke shop / general) or "Boutique" (jewellery) */
  store_noun: string
  rewards_program_name: string
  head_office_boutique?: string | null
  main_warehouse?: string | null
  /** v0.7 — platform developer credit ("Powered by ..."), blank to hide */
  developer_name?: string
  developer_website?: string
}

/** `Maison Reward Tier` row — fixed redemption tiers ($5 off at 100 points, …). */
export interface RewardTier {
  name: string
  title: string
  points: number
  amount: number
  description?: string | null
}
// --- end v0.6 N/Q ---

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
  /** whole-line discount (manual + automatic promotion) */
  discount_amount?: number
  /** v0.4 I — share of the coupon discount shown for this line (server recomputes and must agree) */
  coupon_discount?: number
}

export interface POSPayment {
  mode_of_payment: 'Cash' | 'Card'
  /**
   * What the client handed over on this tender. For cash this is the amount **tendered**, not the
   * amount due (v0.8 POS D11): ERPNext derives `change_amount` from `paid_amount - grand_total`,
   * so sending the due amount left the drawer unreconcilable and the change unauditable.
   */
  amount: number
  stripe_payment_intent?: string
  // --- v0.8 POS D7 — the terminal result belongs on the invoice, not only on the paper receipt ---
  // Without these, Returns offers "Original card — Card ••••" with no digits and card
  // reconciliation has nothing to match on. `maison_pos/api/sales.py` already reads all three.
  card_brand?: string
  last4?: string
  approval_code?: string
  // --- end v0.8 POS D7 ---
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
  /** v0.4 I — Maison Coupon code applied to the basket (validated server-side) */
  coupon_code?: string
  /** v0.4 I — promotions applied automatically (for the Promotion performance report) */
  promotions?: { name: string; title: string; discount: number }[]
  /** v0.4 G — collecting a web order: the Sales Order; the online payment is an advance, `payments` holds only the balance (may be empty). */
  sales_order?: string
  // --- v0.6 N/Q — age check outcome (from age.verify_scan / verify_manual) and the fixed reward tier redeemed ---
  age_check?: AgeCheckPayload
  reward_tier?: string
  reward_tiers?: string[]
  // --- end v0.6 N/Q ---
}

// --- v0.6 N — what the POS sends with an invoice carrying age-restricted lines (no PII) ---
export interface AgeCheckPayload {
  verified: 0 | 1
  method: 'Scan' | 'Manual'
  /** `Maison Age Check` name when the check ran online */
  check?: string
  checked_at?: string
  dob_year_ok?: 0 | 1
  age?: number
  initials?: string | null
  jurisdiction?: string | null
  /** 1 when verified on the device without reaching the server (audit row created on submit) */
  offline?: 0 | 1
}
// --- end v0.6 N ---

/** v0.8 POS D4 */
export interface EmailReceiptResult {
  ok: boolean
  queued: boolean
  invoice?: string
  email_masked?: string
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
  /** v0.6 Q — points earned / balance / next reward / giveaway entries (member sales) */
  rewards?: RewardsExtras | null
  /**
   * v0.8 POS D1 — set when the server booked a rounding-sized gap between the tenders and the
   * invoice total to the store's write-off account instead of refusing a completed sale.
   */
  rounding_adjustment?: { amount: number; account: string; note: string } | null
}

// --- v0.6 Q — `rewards.receipt_extras` (submit result + public receipt) ---
export interface RewardsExtras {
  program_name: string
  points_earned: number
  points_balance: number
  next_reward?: { name?: string; title: string; points: number; amount: number; points_needed: number } | null
  giveaway_entries: number
  giveaway?: { name: string; title: string; end_date: string; prize?: string | null; my_entries: number } | null
  reward_tier?: { title: string; points: number; amount: number } | null
}
// --- end v0.6 Q ---

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
  // --- v0.8 POS D11 — what was handed over and what went back, so the drawer reconciles ---
  /** cash tendered on the invoice (>= `cash`, which is net of the change given) */
  tendered?: number
  change_amount?: number
  // --- end v0.8 POS D11 ---
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
    /**
     * v0.8 POS D4 — actually e-mail the receipt link. `invoice_or_token` takes either the Sales
     * Invoice name or the public receipt token; throws with a readable message when the site has
     * no outgoing e-mail account, so the till can say so instead of claiming "Email queued".
     */
    email_receipt(invoice_or_token: string, email: string): Promise<EmailReceiptResult>
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
  /** v0.4 H — next-best-offer tiles (`maison_pos.api.insights`). */
  insights: {
    /** "Suggested for this client" — never an item the client already owns. */
    recommend_for_client(customer: string, n?: number, boutique?: string): Promise<RecommendForClientResult>
    /** "Pairs well with" for the basket lines (owned items of `customer` excluded). */
    recommend_for_basket(items: string[], n?: number, boutique?: string, customer?: string): Promise<RecommendForBasketResult>
  }
  /** v0.4 E — itemized returns & exchanges (`maison_pos.api.returns`). */
  returns: {
    lookup(args: { invoice?: string; token?: string; customer?: string; q?: string; limit?: number }): Promise<{ invoices: ReturnableInvoice[] }>
    return_items(req: ReturnRequest): Promise<ReturnResult>
    exchange(req: ExchangeRequest): Promise<ExchangeResult>
    policy(boutique?: string): Promise<ReturnPolicy>
    recent(boutique: string, limit?: number): Promise<{ boutique: string; returns: RecentReturn[] }>
  }
  /** v0.4 D — low-stock alerts, transfer requests, cycle counts (`maison_pos.api.inventory`). */
  inventory: {
    alerts(boutique?: string, status?: 'open' | 'all' | string): Promise<StockAlertList>
    acknowledge(alert: string): Promise<{ name: string; status: StockAlertStatus }>
    resolve(alert: string): Promise<{ name: string; status: StockAlertStatus }>
    request_transfer(args: { item: string; to: string; qty: number; from_warehouse?: string; alert?: string; reason?: string }): Promise<TransferRequestResult>
    cycle_count_expected(boutique?: string): Promise<CycleCountExpected>
    submit_cycle_count(args: { boutique: string; serials: string[]; qty: Record<string, number>; device_id?: string; notes?: string }): Promise<CycleCountResult>
  }
  /** Boutiques the current user may unlock — used by the Unlock screen. */
  boutiques(): Promise<Pick<Boutique, 'name' | 'boutique_name' | 'city'>[]>
  /**
   * Server-side PIN check (PBKDF2 hash + lockout after 5 failures). The PWA calls this when
   * online and caches a device-local digest so the same PIN keeps working offline.
   */
  verifyPin(associate: string, pin: string): Promise<{ ok: boolean; associate: string; full_name: string; boutique: string; role: string }>
}

// ---------------------------------------------------------------------------------------------
// v0.4 H — insights (`maison_pos.api.insights`)
// ---------------------------------------------------------------------------------------------
export interface Recommendation {
  item_code: string
  item_name: string
  item_group: string
  department?: string
  metal?: string
  image?: string | null
  has_serial_no: 0 | 1
  is_stock_item: 0 | 1
  rate: number
  /** aggregated lift score (higher = stronger affinity) */
  score: number
  lift: number
  confidence: number
  /** item that triggered the suggestion, if any */
  because?: string | null
  because_name?: string | null
  /** human reason shown under the tile, e.g. "Bought with Curb Chain in 45% of baskets" */
  reason: string
  /** in stock at the boutique (null for services / when no boutique given) */
  in_stock: boolean | null
}

export interface RecommendForClientResult {
  customer: string
  items: Recommendation[]
  owned: string[]
  source: 'cache' | 'live'
}

export interface RecommendForBasketResult {
  basket: string[]
  items: Recommendation[]
}

// ---------------------------------------------------------------------------------------------
// v0.4 E — returns & exchanges (`maison_pos.api.returns`)
// ---------------------------------------------------------------------------------------------
export type ReturnReason = 'Change of mind' | 'Defect' | 'Sizing' | 'Gift return' | 'Other'
export type ReturnCondition = 'Sellable' | 'Damaged'
export type RefundMethod = 'card' | 'cash' | 'store_credit'
export const RETURN_REASONS: ReturnReason[] = ['Change of mind', 'Defect', 'Sizing', 'Gift return', 'Other']
export const RETURN_CONDITIONS: ReturnCondition[] = ['Sellable', 'Damaged']

export interface ReturnableLine {
  /** Sales Invoice Item row name */
  row: string
  item_code: string
  item_name: string
  qty: number
  rate: number
  amount: number
  discount_amount: number
  serials: string[]
  returned_qty: number
  returned_serials: string[]
  returnable_qty: number
  returnable_serials: string[]
  taxable: 0 | 1
  is_stock_item: 0 | 1
}

export interface ReturnableInvoice {
  name: string
  posting_date: string
  posting_datetime: string
  boutique: string
  associate?: string
  customer?: string
  customer_name?: string
  currency: string
  net_total: number
  total_taxes: number
  tax_rate: number
  grand_total: number
  loyalty_amount: number
  payments: { mode_of_payment: string; amount: number }[]
  terminal_ref?: string | null
  card_brand?: string | null
  card_last4?: string | null
  receipt_token?: string | null
  days_since: number
  within_return_window: boolean
  within_exchange_window: boolean
  return_window_days: number
  exchange_window_days: number
  manager_threshold: number
  credit_notes: string[]
  fully_returned: boolean
  lines: ReturnableLine[]
}

export interface ReturnLineRequest {
  row?: string
  item_code: string
  qty: number
  serial_no?: string
  reason: ReturnReason
  condition: ReturnCondition
}

export interface ReturnRequest {
  invoice: string
  lines: ReturnLineRequest[]
  refund_method: RefundMethod
  reason?: ReturnReason
  manager?: string
  manager_pin?: string
  device_id?: string
  notes?: string
}

export interface ReturnResultLine {
  item_code: string
  item_name: string
  qty: number
  rate: number
  amount: number
  serials: string[]
  warehouse?: string
  reason?: string
  condition?: string
}

export interface ReturnResult {
  credit_note: string
  return_against: string
  /** negative */
  grand_total: number
  net_total: number
  total_taxes: number
  refund_method: string | null
  refund_id?: string | null
  receipt_token?: string | null
  payments: { mode_of_payment: string; amount: number }[]
  lines: ReturnResultLine[]
  loyalty_points_reversed: number
  manager_approved_by?: string | null
  simulated_refund?: boolean
  /** `sales.receipt`-shaped payload of the credit note (for printing) */
  receipt: Record<string, unknown>
}

export interface ExchangeRequest {
  invoice: string
  lines: ReturnLineRequest[]
  new_items: POSInvoiceItem[]
  payments?: POSPayment[]
  refund_method?: RefundMethod
  reason?: ReturnReason
  manager?: string
  manager_pin?: string
  offline_uuid?: string
  device_id?: string
  customer?: string
  notes?: string
}

export interface ExchangeResult extends ReturnResult {
  new_invoice: string
  new_grand_total: number
  credit: number
  applied: number
  /** > 0 = client paid the difference, < 0 = remainder refunded */
  difference: number
  refund_remainder: number
  new_receipt_token?: string | null
  new_receipt: Record<string, unknown>
  new_payments: { mode_of_payment: string; amount: number }[]
}

export interface ReturnPolicy {
  return_window_days: number
  exchange_window_days: number
  returns_manager_threshold: number
  reasons: ReturnReason[]
  conditions: ReturnCondition[]
  refund_methods: string[]
  stripe_configured: boolean
}

export interface RecentReturn {
  name: string
  posting_date: string
  posting_time: string
  return_against: string
  customer_name?: string
  grand_total: number
  maison_refund_method?: string
  maison_return_reason?: string
  maison_exchange_invoice?: string
  maison_receipt_token?: string
}

// ---------------------------------------------------------------------------------------------
// v0.4 D — inventory (`maison_pos.api.inventory`)
// ---------------------------------------------------------------------------------------------
export type StockAlertStatus = 'Open' | 'Acknowledged' | 'Resolved'
export interface StockAlert {
  name: string
  item_code: string
  item_name?: string
  warehouse: string
  boutique: string
  status: StockAlertStatus
  qty: number
  reorder_level: number
  reorder_qty: number
  first_seen?: string
  last_seen?: string
  acknowledged_by?: string
  acknowledged_at?: string
  resolved_at?: string
  material_request?: string
}
export interface StockAlertList {
  boutiques: string[]
  alerts: StockAlert[]
  open: number
  counts: Record<string, number>
}
export interface TransferRequestResult {
  material_request: string
  status: string
  item: string
  qty: number
  to_warehouse: string
  from_warehouse?: string | null
}
export interface CycleCountExpected {
  boutique: string
  warehouse: string
  serials: Record<string, string[]>
  qty: Record<string, number>
  items: Record<string, string>
  as_of: string
}
export interface CycleCountResult {
  cycle_count: string
  warehouse: string
  expected_serials: number
  scanned_serials: number
  missing: { serial_no: string; item_code: string }[]
  unexpected: { serial_no: string; item_code?: string | null; warehouse?: string | null; status: string }[]
  qty_differences: { item_code: string; expected: number; counted: number; diff: number }[]
  stock_reconciliation: string | null
  clean: boolean
}
