/**
 * v0.4 D — low-stock alerts for the boutique (badge on Shift / Settings, list with acknowledge
 * and "Request transfer"). Refreshed on demand and after every heartbeat while online.
 */
import { defineStore } from 'pinia'
import { api, type StockAlert } from '@/api'
import { getSetting, setSetting } from '@/db'
import { useSessionStore } from './session'

interface InventoryState {
  alerts: StockAlert[]
  loading: boolean
  error: string | null
  fetchedAt: string | null
}

export const useInventoryStore = defineStore('inventory', {
  state: (): InventoryState => ({ alerts: [], loading: false, error: null, fetchedAt: null }),
  getters: {
    open: (s) => s.alerts.filter((a) => a.status !== 'Resolved'),
    openCount(): number {
      return this.open.length
    },
    unacknowledged: (s) => s.alerts.filter((a) => a.status === 'Open').length
  },
  actions: {
    async restore() {
      this.alerts = await getSetting<StockAlert[]>('stock_alerts', [])
      this.fetchedAt = await getSetting<string | null>('stock_alerts_at', null)
    },
    async refresh(): Promise<void> {
      const session = useSessionStore()
      if (!session.boutique) return
      this.loading = true
      this.error = null
      try {
        const res = await api.inventory.alerts(session.boutique.name, 'open')
        this.alerts = res.alerts
        this.fetchedAt = new Date().toISOString()
        await setSetting('stock_alerts', JSON.parse(JSON.stringify(this.alerts)))
        await setSetting('stock_alerts_at', this.fetchedAt)
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.loading = false
      }
    },
    async acknowledge(name: string) {
      const res = await api.inventory.acknowledge(name)
      const a = this.alerts.find((x) => x.name === name)
      if (a) a.status = res.status
    },
    async resolve(name: string) {
      await api.inventory.resolve(name)
      this.alerts = this.alerts.filter((x) => x.name !== name)
    },
    async requestTransfer(alert: StockAlert, qty: number, from?: string) {
      const session = useSessionStore()
      const res = await api.inventory.request_transfer({
        item: alert.item_code,
        to: session.boutique!.name,
        qty,
        from_warehouse: from,
        alert: alert.name
      })
      alert.material_request = res.material_request
      return res
    },
    // --- v0.6 O — one-tap "Request from warehouse" (Maison Replenishment Request + draft Material Request) ---
    async requestFromWarehouse(alert: StockAlert, qty: number) {
      const { warehouseApi } = await import('@/api/warehouse')
      const session = useSessionStore()
      const res = await warehouseApi.store.replenish({ boutique: session.boutique!.name, item: alert.item_code, qty, alert: alert.name })
      alert.material_request = res.material_request || res.name
      alert.status = 'Acknowledged'
      return res
    }
    // --- end v0.6 O ---
  }
})
