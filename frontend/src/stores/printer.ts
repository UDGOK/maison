import { defineStore } from 'pinia'
import { buildReceiptXml, sendToPrinter } from '@/printer/epos'
import type { QueueRow } from '@/db'
import { getSetting, setSetting } from '@/db'
import { useSessionStore } from './session'
import { useCatalogStore } from './catalog'

interface PrinterState {
  /** overrides boutique.printer_ip when set in Settings */
  printer_ip: string
  openDrawerOnCash: boolean
  lastError: string | null
  printing: boolean
  lastXml: string | null
}

export const usePrinterStore = defineStore('printer', {
  state: (): PrinterState => ({ printer_ip: '', openDrawerOnCash: true, lastError: null, printing: false, lastXml: null }),
  getters: {
    effectiveIp(s): string {
      return s.printer_ip || useSessionStore().boutique?.printer_ip || ''
    }
  },
  actions: {
    async restore() {
      this.printer_ip = await getSetting('printer_ip', '')
      this.openDrawerOnCash = await getSetting('open_drawer', true)
    },
    async save() {
      await setSetting('printer_ip', this.printer_ip)
      await setSetting('open_drawer', this.openDrawerOnCash)
    },
    xmlFor(row: QueueRow): string {
      const openDrawer = this.openDrawerOnCash && row.receipt.payments.some((p) => p.mode_of_payment === 'Cash')
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
    /**
     * Print via ePOS over LAN; on any failure (no IP, timeout, network) fall back to window.print()
     * which renders the 80 mm ReceiptView via @media print styles.
     */
    async print(row: QueueRow): Promise<'epos' | 'browser'> {
      this.printing = true
      this.lastError = null
      try {
        const xml = this.xmlFor(row)
        this.lastXml = xml
        const ip = this.effectiveIp
        if (ip) {
          try {
            await sendToPrinter(ip, xml)
            return 'epos'
          } catch (e) {
            this.lastError = `Printer ${ip} unreachable: ${(e as Error).message}`
          }
        } else this.lastError = 'No printer IP configured'
        window.print()
        return 'browser'
      } finally {
        this.printing = false
      }
    }
  }
})
