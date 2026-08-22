import { defineStore } from 'pinia'
import { buildReceiptXml, sendToPrinter } from '@/printer/epos'
import { buildReceiptCanvas, type ReaderReceiptOptions } from '@/printer/canvas'
import { createTerminal, readerCanPrint } from '@/payments/terminal'
import type { QueueRow, ReceiptSnapshot } from '@/db'
import { getSetting, setSetting } from '@/db'
import type { BoutiqueReader } from '@/api'
import { useSessionStore } from './session'
import { useCatalogStore } from './catalog'

export type PrintRoute = 'reader' | 'epos' | 'browser'

interface PrinterState {
  /** overrides boutique.printer_ip when set in Settings */
  printer_ip: string
  openDrawerOnCash: boolean
  lastError: string | null
  printing: boolean
  lastXml: string | null
  /** v0.4 A — reader picked on this device (Maison Boutique Reader `stripe_reader_id` or row name) */
  reader_id: string | null
  /** v0.4 A — 'auto': reader printer when the picked reader has one, else ePOS; or force a route */
  route: 'auto' | 'reader' | 'epos' | 'browser'
  lastRoute: PrintRoute | null
  /** PNG data URL of the last bitmap sent to a reader printer (simulated reader / preview) */
  lastReaderPreview: string | null
}

export const usePrinterStore = defineStore('printer', {
  state: (): PrinterState => ({
    printer_ip: '',
    openDrawerOnCash: true,
    lastError: null,
    printing: false,
    lastXml: null,
    reader_id: null,
    route: 'auto',
    lastRoute: null,
    lastReaderPreview: null
  }),
  getters: {
    effectiveIp(s): string {
      return s.printer_ip || useSessionStore().boutique?.printer_ip || ''
    },
    /** Readers registered on the boutique (Maison Boutique.readers); a simulated one is offered when none. */
    readers(): BoutiqueReader[] {
      const list = (useSessionStore().boutique?.readers || []).filter(
        (r) => r.enabled === undefined || r.enabled
      )
      if (list.length) return list
      return [
        {
          name: 'simulated',
          label: 'Simulated reader (with printer)',
          stripe_reader_id: 'simulated',
          device_type: 'simulated',
          has_printer: 1,
          enabled: 1
        }
      ]
    },
    reader(s): BoutiqueReader | null {
      const readers: BoutiqueReader[] = (this as unknown as { readers: BoutiqueReader[] }).readers
      const id = s.reader_id
      return readers.find((r) => r.stripe_reader_id === id || r.name === id) || readers[0] || null
    },
    /** Effective route for the next receipt. */
    plannedRoute(s): PrintRoute {
      if (s.route !== 'auto') return s.route
      const reader: BoutiqueReader | null = (this as unknown as { reader: BoutiqueReader | null }).reader
      if (readerCanPrint(reader)) return 'reader'
      return (this as unknown as { effectiveIp: string }).effectiveIp ? 'epos' : 'browser'
    }
  },
  actions: {
    async restore() {
      this.printer_ip = await getSetting('printer_ip', '')
      this.openDrawerOnCash = await getSetting('open_drawer', true)
      this.reader_id = await getSetting<string | null>('reader_id', null)
      this.route = await getSetting('print_route', 'auto')
    },
    async save() {
      await setSetting('printer_ip', this.printer_ip)
      await setSetting('open_drawer', this.openDrawerOnCash)
      await setSetting('reader_id', this.reader_id)
      await setSetting('print_route', this.route)
    },
    async selectReader(id: string | null) {
      this.reader_id = id
      await setSetting('reader_id', id)
    },
    /** Terminal driver bound to the picked reader (shared with Pay). */
    terminal() {
      const session = useSessionStore()
      const r = this.reader
      return createTerminal({
        publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY,
        locationId: session.boutique?.stripe_location_id,
        reader: r
          ? {
              stripe_reader_id: r.stripe_reader_id,
              device_type: r.device_type,
              has_printer: !!r.has_printer,
              label: r.label
            }
          : null
      })
    },
    xmlFor(row: QueueRow): string {
      const openDrawer =
        this.openDrawerOnCash && row.receipt.payments.some((p) => p.mode_of_payment === 'Cash')
      const catalog = useCatalogStore()
      return buildReceiptXml(row.receipt, {
        invoice_name: row.invoice_name,
        offline_uuid: row.offline_uuid,
        posting_datetime: row.invoice.posting_datetime,
        openDrawer,
        receipt_token: row.receipt_token,
        receipt_qr_enabled: catalog.settings.receipt_qr_enabled,
        receipt_qr_base_url: row.receipt.receipt_qr_base_url || catalog.receiptQrBase
      })
    },
    /** v0.4 A — render the 384-px bitmap and hand it to the reader printer. */
    async printOnReader(receipt: ReceiptSnapshot, opts: ReaderReceiptOptions): Promise<void> {
      const session = useSessionStore()
      const canvas = await buildReceiptCanvas(receipt, opts)
      const res = await this.terminal().print(canvas, { boutique: session.boutique!.name })
      this.lastReaderPreview = res.preview || null
    },
    /**
     * Print a queued sale. Route: reader printer (V660p) when the picked reader has one, else
     * ePOS over LAN, else window.print() (80 mm ReceiptView via @media print). Any failure on a
     * route falls through to the next.
     */
    async print(row: QueueRow): Promise<PrintRoute> {
      const catalog = useCatalogStore()
      return this.printSnapshot(
        row.receipt,
        {
          invoice_name: row.invoice_name,
          offline_uuid: row.offline_uuid,
          posting_datetime: row.invoice.posting_datetime,
          receipt_token: row.receipt_token,
          receipt_qr_enabled: catalog.settings.receipt_qr_enabled,
          receipt_qr_base_url: row.receipt.receipt_qr_base_url || catalog.receiptQrBase,
          kind: 'sale'
        },
        row
      )
    },
    async printSnapshot(
      receipt: ReceiptSnapshot,
      opts: ReaderReceiptOptions,
      row?: QueueRow
    ): Promise<PrintRoute> {
      this.printing = true
      this.lastError = null
      try {
        const planned = this.plannedRoute
        if (planned === 'reader') {
          try {
            await this.printOnReader(receipt, opts)
            this.lastRoute = 'reader'
            return 'reader'
          } catch (e) {
            this.lastError = `Reader printer: ${(e as Error).message}`
          }
        }
        if (planned !== 'browser') {
          const ip = this.effectiveIp
          if (ip) {
            try {
              const xml = row
                ? this.xmlFor(row)
                : buildReceiptXml(receipt, {
                    invoice_name: opts.invoice_name,
                    offline_uuid: opts.offline_uuid,
                    posting_datetime: opts.posting_datetime,
                    receipt_token: opts.receipt_token,
                    receipt_qr_enabled: opts.receipt_qr_enabled,
                    receipt_qr_base_url: opts.receipt_qr_base_url
                  })
              this.lastXml = xml
              await sendToPrinter(ip, xml)
              this.lastRoute = 'epos'
              return 'epos'
            } catch (e) {
              this.lastError = `Printer ${ip} unreachable: ${(e as Error).message}`
            }
          } else if (!this.lastError) this.lastError = 'No printer IP configured'
        }
        window.print()
        this.lastRoute = 'browser'
        return 'browser'
      } finally {
        this.printing = false
      }
    }
  }
})
