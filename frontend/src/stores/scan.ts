/**
 * Scan store — applies a scanned code (keyboard wedge or camera) to the POS:
 * barcode → add to basket, serial label → add that serial, `MC:<id>` → attach client,
 * `INV:<name>` → open the receipt, unknown → "Not in catalogue" notice with a search shortcut.
 */
import { defineStore } from 'pinia'
import { api, type Customer } from '@/api'
import { db } from '@/db'
import { router } from '@/router'
import { resolveScan, type Resolution } from '@/scan/resolve'
import { installWedgeListener } from '@/scan/wedge'
import { DEFAULT_SCANNER_CONFIG, normalizeScannerConfig, stripAffixes, type ScannerConfig } from '@/scan/affixes'
import { getSetting, setSetting } from '@/db'
import { useCartStore } from './cart'
import { useCatalogStore } from './catalog'
import { useSyncStore } from './sync'

export type ScanMode = 'any' | 'client' | 'raw'

interface ScanState {
  sheetOpen: boolean
  mode: ScanMode
  /** last scanned code (for the UI / tests) */
  last: { code: string; at: string; result: Resolution['kind'] } | null
  /** pending search text when the user taps "Search" on an unknown code */
  pendingSearch: string
  /** resolver for a one-off client scan (Client screen / client card) */
  clientResolver: ((c: Customer | null) => void) | null
  /** v0.4 D/E — raw-code consumer (Returns lookup, Cycle count): receives every scanned string untouched */
  rawResolver: ((code: string) => void) | null
  uninstall: (() => void) | null
  /** v0.4 J — device-level scanner prefix / suffix / terminator (Settings → Scanner) */
  scanner: ScannerConfig
}

export const useScanStore = defineStore('scan', {
  state: (): ScanState => ({ sheetOpen: false, mode: 'any', last: null, pendingSearch: '', clientResolver: null, rawResolver: null, uninstall: null, scanner: { ...DEFAULT_SCANNER_CONFIG } }),
  actions: {
    /** Install the global keyboard-wedge listener once. */
    startWedge() {
      if (this.uninstall || typeof window === 'undefined') return
      this.uninstall = installWedgeListener((code) => void this.handle(code), { terminator: this.scanner.terminator })
    },
    /** v0.4 J — load the scanner config from Dexie (call before startWedge). */
    async loadScannerConfig() {
      this.scanner = normalizeScannerConfig(await getSetting<Partial<ScannerConfig> | null>('scanner', null))
      return this.scanner
    },
    async setScannerConfig(cfg: Partial<ScannerConfig>) {
      this.scanner = normalizeScannerConfig({ ...this.scanner, ...cfg })
      await setSetting('scanner', { ...this.scanner })
      if (this.uninstall) {
        this.stopWedge()
        this.startWedge()
      }
    },
    stopWedge() {
      this.uninstall?.()
      this.uninstall = null
    },
    openSheet(mode: ScanMode = 'any') {
      this.mode = mode
      this.sheetOpen = true
    },
    closeSheet() {
      this.sheetOpen = false
      if (this.mode === 'raw') this.mode = 'any'
      if (this.clientResolver) {
        this.clientResolver(null)
        this.clientResolver = null
      }
    },
    /** Open the camera sheet for a client QR / number and resolve with the customer (or null). */
    scanClient(): Promise<Customer | null> {
      return new Promise((resolve) => {
        this.clientResolver = resolve
        this.openSheet('client')
      })
    },
    /**
     * v0.4 — route every code (wedge or camera) to *consumer* while a screen such as Cycle count
     * or Returns is active; returns the uninstall function. Camera sheet opens with `openSheet('raw')`.
     */
    captureRaw(consumer: (code: string) => void): () => void {
      this.mode = 'raw'
      this.rawResolver = consumer
      return () => {
        if (this.rawResolver === consumer) {
          this.rawResolver = null
          this.mode = 'any'
        }
      }
    },
    async lookupCustomer(code: string): Promise<Customer | null> {
      const local = await db.customers.where('client_number').equals(code).first().catch(() => undefined)
      if (local) return local
      const byId = await db.customers.get(code).catch(() => undefined)
      if (byId) return byId
      try {
        const c = await api.customers.lookup(code)
        if (c) await db.customers.put(JSON.parse(JSON.stringify(c)))
        return c
      } catch {
        return null
      }
    },
    async handle(raw: string): Promise<Resolution> {
      raw = stripAffixes(raw, this.scanner)
      if (this.mode === 'raw' && this.rawResolver) {
        this.last = { code: raw, at: new Date().toISOString(), result: 'unknown' }
        this.rawResolver(raw)
        return { kind: 'unknown', code: raw } as Resolution
      }
      const catalog = useCatalogStore()
      const cart = useCartStore()
      const sync = useSyncStore()
      const res = await resolveScan(raw, {
        resolveCode: (c) => catalog.resolveCode(c),
        customerById: (id) => db.customers.get(id).then((c) => c || null),
        invoiceUuid: async (name) => (await db.queue.filter((q) => q.invoice_name === name).first())?.offline_uuid ?? null
      })
      this.last = { code: raw, at: new Date().toISOString(), result: res.kind }

      // Client-only mode (client card / Client screen): anything that is not a client is a miss.
      if (this.mode === 'client' && this.clientResolver) {
        let customer: Customer | null = null
        if (res.kind === 'client') customer = res.customer
        else if (res.kind === 'client-remote') customer = await this.lookupCustomer(res.customer)
        else if (res.kind === 'unknown') customer = await this.lookupCustomer(res.code)
        if (!customer) {
          sync.notify('warn', 'No client for this code', raw)
          return res
        }
        const r = this.clientResolver
        this.clientResolver = null
        this.sheetOpen = false
        r(customer)
        return res
      }

      switch (res.kind) {
        case 'item': {
          if (res.item.has_serial_no && !res.serial_no) {
            const free = (catalog.serials[res.item.item_code] || []).filter((s) => !cart.usedSerials.has(s))
            if (free.length === 1) cart.add(res.item, free[0])
            else {
              this.pendingSearch = res.item.item_code
              sync.notify('warn', `${res.item.item_name}: choose a serial`, 'Scan the serial label or pick one on the tile')
            }
          } else if (res.serial_no && cart.usedSerials.has(res.serial_no)) {
            sync.notify('warn', `Serial ${res.serial_no} is already in the basket`)
          } else if (res.serial_no && !(catalog.serials[res.item.item_code] || []).includes(res.serial_no)) {
            sync.notify('crit', `Serial ${res.serial_no} not available here`, res.item.item_name)
          } else {
            cart.add(res.item, res.serial_no)
            sync.notify('good', `${res.item.item_name}${res.serial_no ? ' · ' + res.serial_no : ''}`, 'Added to basket')
            this.sheetOpen = false
            if (router.currentRoute.value.name !== 'sell') void router.push({ name: 'sell' })
          }
          break
        }
        case 'client':
          cart.setCustomer(res.customer)
          sync.notify('good', `${res.customer.customer_name} attached`, res.customer.client_number)
          this.sheetOpen = false
          break
        case 'client-remote': {
          const c = await this.lookupCustomer(res.customer)
          if (c) {
            cart.setCustomer(c)
            sync.notify('good', `${c.customer_name} attached`, c.client_number)
            this.sheetOpen = false
          } else sync.notify('warn', 'Client not found', res.customer)
          break
        }
        case 'invoice':
          this.sheetOpen = false
          if (res.offline_uuid) void router.push({ name: 'receipt', params: { uuid: res.offline_uuid } })
          else sync.notify('warn', `Invoice ${res.invoice} is not on this device`, 'Open it from the head-office desk')
          break
        case 'receipt':
          this.sheetOpen = false
          sync.notify('good', 'Receipt link', res.url)
          break
        case 'unknown':
          this.pendingSearch = res.code
          sync.notify('warn', 'Not in catalogue', `${res.code} — tap Search to look it up`, undefined, { label: 'Search', action: 'search' })
          break
      }
      return res
    },
    /** Called by the notice "Search" action: go to Sell with the code in the search box. */
    searchPending() {
      const q = this.pendingSearch
      this.pendingSearch = ''
      this.sheetOpen = false
      void router.push({ name: 'sell', query: { q } })
    }
  }
})
