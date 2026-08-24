/**
 * v0.6 P — state shared by the Warehouse Admin desk (`/warehouse`) and the 55" Wall (`/warehouse-wall`):
 * who am I (role gate), the board, realtime + 10 s polling, sound / flash toggle, auto-print dispatch.
 */
import { defineStore } from 'pinia'
import { warehouseApi, type Rate, type ShipmentStatus, type WallData, type WallEvent, type WarehouseMe } from '@/api/warehouse'
import { connectWallRealtime, POLL_MS } from '@/warehouse/realtime'
import { diffWall, printJobsFor } from '@/warehouse/wall'
import { packingListUrl, printDocument } from '@/warehouse/print'

const SOUND_KEY = 'awanz.wall.sound'
const PREFER_KEY = 'awanz.wall.prefer'

interface WarehouseState {
  me: WarehouseMe | null
  meError: string | null
  wall: WallData | null
  fetchedAt: number
  loading: boolean
  error: string | null
  connected: boolean
  polling: number | null
  unsubscribe: (() => void) | null
  /** sound + flash on a newly approved shipment (persisted per device) */
  sound: boolean
  flash: string | null
  /** last realtime events (newest first) for the wall ticker */
  events: WallEvent[]
  /** rate preference for "Buy label" (cheapest default, fastest toggle) */
  prefer: 'cheapest' | 'fastest'
  /** optimistic note shown on the wall while an action runs */
  busy: string | null
}

export const useWarehouseStore = defineStore('warehouse', {
  state: (): WarehouseState => ({
    me: null,
    meError: null,
    wall: null,
    fetchedAt: 0,
    loading: false,
    error: null,
    connected: false,
    polling: null,
    unsubscribe: null,
    sound: readBool(SOUND_KEY, true),
    flash: null,
    events: [],
    prefer: (readStr(PREFER_KEY, 'cheapest') as 'cheapest' | 'fastest') || 'cheapest',
    busy: null
  }),
  getters: {
    allowed: (s) => !!s.me?.supply_unrestricted,
    brand: (s) => s.me?.brand || { brand_name: 'CloudChaserz', wordmark_text: 'CLOUDCHASERZ', product_name: 'AWANZ POS by CloudChaserz' },
    totalOpen: (s) => (s.wall ? s.wall.counts.pending_approval + s.wall.counts.to_pick + s.wall.counts.packing + s.wall.counts.ready : 0)
  },
  actions: {
    async loadMe() {
      try {
        this.me = await warehouseApi.admin.me()
        this.meError = null
      } catch (e) {
        this.meError = (e as Error).message
      }
      return this.me
    },
    async refresh(silent = false) {
      if (!silent) this.loading = true
      try {
        const next = await warehouseApi.admin.wall()
        const diff = diffWall(this.wall?.columns || null, next.columns)
        this.wall = next
        this.fetchedAt = Date.now()
        this.error = null
        if (diff.approved.length) this.celebrate(diff.approved[0])
      } catch (e) {
        this.error = (e as Error).message
      } finally {
        this.loading = false
      }
    },
    /** Sound + flash for a newly approved shipment (wall). */
    celebrate(shipment: string) {
      this.flash = shipment
      setTimeout(() => {
        if (this.flash === shipment) this.flash = null
      }, 4000)
      if (this.sound) playChime()
    },
    start(autoPrint = false) {
      if (this.polling) return
      void this.refresh()
      this.polling = window.setInterval(() => void this.refresh(true), POLL_MS)
      this.unsubscribe = connectWallRealtime({
        onConnection: (c) => (this.connected = c),
        onEvent: (ev) => {
          this.events = [ev, ...this.events].slice(0, 30)
          if (autoPrint && this.wall) {
            for (const job of printJobsFor(ev, this.wall, packingListUrl)) void printDocument(job.kind, job.url, job.shipment)
          }
          void this.refresh(true)
        }
      })
    },
    stop() {
      if (this.polling) window.clearInterval(this.polling)
      this.polling = null
      this.unsubscribe?.()
      this.unsubscribe = null
    },
    setSound(on: boolean) {
      this.sound = on
      writeStr(SOUND_KEY, on ? '1' : '0')
    },
    setPrefer(p: 'cheapest' | 'fastest') {
      this.prefer = p
      writeStr(PREFER_KEY, p)
    },
    // ---------------------------------------------------------------- actions (wall + desk)
    async approve(request: string, lines?: { item_code: string; approved_qty: number }[], notes?: string) {
      this.busy = request
      try {
        const out = await warehouseApi.admin.approve(request, lines, notes)
        await this.refresh(true)
        return out
      } finally {
        this.busy = null
      }
    },
    async reject(request: string, reason: string) {
      this.busy = request
      try {
        const out = await warehouseApi.admin.reject(request, reason)
        await this.refresh(true)
        return out
      } finally {
        this.busy = null
      }
    },
    async mark(shipment: string, status: ShipmentStatus) {
      this.busy = shipment
      try {
        const out = await warehouseApi.admin.mark(shipment, status)
        await this.refresh(true)
        return out
      } finally {
        this.busy = null
      }
    },
    async buy(shipment: string, rate?: Rate | null) {
      this.busy = shipment
      try {
        const out = await warehouseApi.admin.buy(shipment, rate?.provider_rate_id || null, this.prefer)
        await this.refresh(true)
        return out
      } finally {
        this.busy = null
      }
    },
    async printPackingList(shipment: string) {
      return printDocument('packing_list', packingListUrl(shipment), shipment)
    },
    async printLabel(shipment: string, url: string) {
      return printDocument('label', url, shipment)
    }
  }
})

function readBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v === null ? def : v === '1'
  } catch {
    return def
  }
}
function readStr(key: string, def: string): string {
  try {
    return localStorage.getItem(key) || def
  } catch {
    return def
  }
}
function writeStr(key: string, v: string) {
  try {
    localStorage.setItem(key, v)
  } catch {
    /* private mode */
  }
}

/** Two-note chime through WebAudio (no asset needed). */
export function playChime() {
  try {
    const Ctx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    const ctx = new Ctx()
    const play = (freq: number, at: number) => {
      const o = ctx.createOscillator()
      const g = ctx.createGain()
      o.type = 'sine'
      o.frequency.value = freq
      g.gain.setValueAtTime(0.0001, ctx.currentTime + at)
      g.gain.exponentialRampToValueAtTime(0.3, ctx.currentTime + at + 0.02)
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + at + 0.5)
      o.connect(g).connect(ctx.destination)
      o.start(ctx.currentTime + at)
      o.stop(ctx.currentTime + at + 0.55)
    }
    play(880, 0)
    play(1320, 0.18)
    setTimeout(() => void ctx.close(), 1200)
  } catch {
    /* autoplay policy */
  }
}
