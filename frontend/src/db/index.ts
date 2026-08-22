/**
 * Dexie (IndexedDB) schema. Everything the POS needs to sell while offline lives here.
 */
import Dexie, { type EntityTable } from 'dexie'
import type { Customer, Item, POSInvoice, PricingRule } from '@/api/types'

export type QueueStatus = 'pending' | 'sending' | 'ok' | 'error'

export interface QueueRow {
  offline_uuid: string
  /** FIFO ordering key */
  seq?: number
  invoice: POSInvoice
  status: QueueStatus
  attempts: number
  next_attempt_at: number
  created_at: string
  sent_at?: string
  invoice_name?: string
  /** v0.2 — set from submit_batch result; QR = `${receipt_qr_base_url}/r/${receipt_token}` */
  receipt_token?: string
  error?: string
  error_code?: string
  /** Snapshot for the receipt view — totals + payment meta (card brand/last4) */
  receipt: ReceiptSnapshot
}

export interface ReceiptSnapshot {
  boutique: string
  boutique_name: string
  address_line: string
  city: string
  phone: string
  associate_name: string
  customer_name?: string
  customer_tier?: string
  /** v0.2 — printed loyalty number */
  customer_client_number?: string
  /** v0.2 — base URL for the receipt QR, snapshotted at sale time */
  receipt_qr_base_url?: string
  lines: {
    item_code: string
    item_name: string
    qty: number
    rate: number
    amount: number
    serial_no?: string
    certificate_no?: string
    discount_amount?: number
  }[]
  net_total: number
  discount: number
  total_taxes: number
  tax_rate: number
  loyalty_amount: number
  loyalty_points_redeemed: number
  grand_total: number
  payments: { mode_of_payment: 'Cash' | 'Card'; amount: number; tendered?: number; change?: number; card_brand?: string; last4?: string; approval?: string }[]
  points_earned: number
  points_balance?: number
  currency: string
}

export interface PriceRow {
  item_code: string
  rate: number
}
export interface SerialRow {
  item_code: string
  serials: string[]
}
export interface StockRow {
  item_code: string
  qty: number
}
export interface SettingRow {
  key: string
  value: unknown
}
/** v0.2 — scannable code → item_code (EAN/Code-128/serial labels) */
export interface BarcodeRow {
  code: string
  item_code: string
}
/** v0.2 — product image upload waiting for the network */
export interface UploadRow {
  id?: number
  item_code: string
  blob: Blob
  filename: string
  created_at: string
  attempts: number
  error?: string
}

export class MaisonDB extends Dexie {
  catalog!: EntityTable<Item, 'item_code'>
  prices!: EntityTable<PriceRow, 'item_code'>
  pricing_rules!: EntityTable<PricingRule, 'name'>
  serials!: EntityTable<SerialRow, 'item_code'>
  stock!: EntityTable<StockRow, 'item_code'>
  customers!: EntityTable<Customer, 'name'>
  queue!: EntityTable<QueueRow, 'offline_uuid'>
  settings!: EntityTable<SettingRow, 'key'>
  barcodes!: EntityTable<BarcodeRow, 'code'>
  uploads!: EntityTable<UploadRow, 'id'>

  constructor(name = 'maison_pos') {
    super(name)
    this.version(1).stores({
      catalog: 'item_code, item_group, maison_department, item_name',
      prices: 'item_code',
      pricing_rules: 'name, item_code',
      serials: 'item_code',
      stock: 'item_code',
      customers: 'name, customer_name, mobile_no, email_id',
      queue: 'offline_uuid, seq, status, created_at',
      settings: 'key'
    })
    this.version(2).stores({
      catalog: 'item_code, item_group, maison_department, item_name, maison_barcode',
      prices: 'item_code',
      pricing_rules: 'name, item_code',
      serials: 'item_code',
      stock: 'item_code',
      customers: 'name, customer_name, mobile_no, email_id, client_number',
      queue: 'offline_uuid, seq, status, created_at',
      settings: 'key',
      barcodes: 'code, item_code',
      uploads: '++id, item_code, created_at'
    })
  }
}

export const db = new MaisonDB()

export async function getSetting<T>(key: string, fallback: T): Promise<T> {
  const row = await db.settings.get(key)
  return row ? (row.value as T) : fallback
}

export async function setSetting(key: string, value: unknown): Promise<void> {
  await db.settings.put({ key, value })
}
