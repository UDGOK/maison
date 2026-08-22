import { defineStore } from 'pinia'
import { api, type POSInvoice } from '@/api'
import { db, type QueueRow, type ReceiptSnapshot } from '@/db'
import { QueueReplayer } from '@/sync/replay'
import { useSessionStore } from './session'
import { useCatalogStore } from './catalog'
import { replayUploads } from '@/images/uploads'
import { useRecognitionStore } from './recognition'

export interface SyncNotice {
  id: number
  kind: 'good' | 'warn' | 'crit'
  title: string
  detail?: string
  offline_uuid?: string
  /** optional action button (v0.2: "Search" on unknown scans; v0.3: "Undo" on a recognition) */
  action?: { label: string; action: 'search' | 'queue' | 'undo-recognition' }
}

interface SyncState {
  browserOnline: boolean
  /** last heartbeat succeeded */
  serverReachable: boolean
  lastHeartbeat: string | null
  queue: QueueRow[]
  replaying: boolean
  notices: SyncNotice[]
  heartbeatTimer: number | null
  replayTimer: number | null
  /** v0.2 — queued product-image uploads */
  uploadsPending: number
  uploadsReplaying: boolean
}

export const replayer = new QueueReplayer(db, api)
let noticeSeq = 0

export const useSyncStore = defineStore('sync', {
  state: (): SyncState => ({
    browserOnline: typeof navigator === 'undefined' ? true : navigator.onLine,
    serverReachable: false,
    lastHeartbeat: null,
    queue: [],
    replaying: false,
    notices: [],
    heartbeatTimer: null,
    replayTimer: null,
    uploadsPending: 0,
    uploadsReplaying: false
  }),
  getters: {
    online: (s) => s.browserOnline && s.serverReachable,
    queued: (s) => s.queue.filter((q) => q.status === 'pending' || q.status === 'sending').length,
    errored: (s) => s.queue.filter((q) => q.status === 'error').length,
    sentToday: (s) => s.queue.filter((q) => q.status === 'ok').length
  },
  actions: {
    async start() {
      if (typeof window !== 'undefined') {
        window.addEventListener('online', () => {
          this.browserOnline = true
          void this.heartbeat()
        })
        window.addEventListener('offline', () => {
          this.browserOnline = false
          this.serverReachable = false
        })
      }
      await this.loadQueue()
      await this.countUploads()
      await this.heartbeat()
      this.heartbeatTimer = window.setInterval(() => void this.heartbeat(), 60_000)
      // Every 5 s: replay when reachable; while unreachable, probe with a heartbeat every 15 s
      // so recovery is noticed well before the next 60 s heartbeat.
      let tick = 0
      this.replayTimer = window.setInterval(() => {
        tick++
        if (this.serverReachable) void this.replay()
        else if (tick % 3 === 0) void this.heartbeat()
      }, 5_000)
    },
    stop() {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
      if (this.replayTimer) clearInterval(this.replayTimer)
    },
    async loadQueue() {
      const rows = await db.queue.toArray()
      this.queue = rows.sort((a, b) => (b.seq ?? 0) - (a.seq ?? 0))
    },
    async heartbeat() {
      const session = useSessionStore()
      if (!session.boutique) return
      // Mock offline toggle flips navigator.onLine semantics for us
      if (typeof window !== 'undefined' && window.__maisonOffline) {
        this.serverReachable = false
        return
      }
      if (!this.browserOnline) return
      try {
        await api.dashboard.heartbeat(session.boutique.name, session.device_id, this.queued)
        const wasOffline = !this.serverReachable
        this.serverReachable = true
        this.lastHeartbeat = new Date().toISOString()
        if (wasOffline) {
          void this.replay()
          void useCatalogStore().refresh()
        }
        void this.replayUploads()
        void this.replayRecognition(wasOffline)
      } catch {
        this.serverReachable = false
      }
    },
    async enqueue(invoice: POSInvoice, receipt: ReceiptSnapshot) {
      const row = await replayer.enqueue(invoice, receipt)
      await this.loadQueue()
      if (this.online) void this.replay()
      return row
    },
    async replay() {
      if (this.replaying) return
      if (typeof window !== 'undefined' && window.__maisonOffline) {
        this.serverReachable = false
        return
      }
      if (!this.browserOnline) return
      this.replaying = true
      try {
        const before = new Map(this.queue.map((q) => [q.offline_uuid, q.status]))
        const out = await replayer.replay()
        await this.loadQueue()
        if (out.offline) this.serverReachable = false
        else if (out.sent) this.serverReachable = true
        for (const q of this.queue) {
          const prev = before.get(q.offline_uuid)
          if (prev !== q.status && q.status === 'error')
            this.notify('crit', `Sale ${q.offline_uuid.slice(0, 8).toUpperCase()} rejected`, q.error, q.offline_uuid)
          if (prev && prev !== 'ok' && q.status === 'ok' && prev !== 'pending')
            this.notify('good', `Sale synced as ${q.invoice_name}`, undefined, q.offline_uuid)
        }
      } finally {
        this.replaying = false
      }
    },
    async retry(offline_uuid: string) {
      await replayer.retry(offline_uuid)
      await this.loadQueue()
      void this.replay()
    },
    async discard(offline_uuid: string) {
      await replayer.discard(offline_uuid)
      await this.loadQueue()
    },
    /** v0.2 — drain queued product-image uploads (manager tile edits made offline). */
    async replayUploads() {
      if (this.uploadsReplaying || !this.serverReachable) return
      this.uploadsReplaying = true
      try {
        const out = await replayUploads()
        this.uploadsPending = out.pending
        for (const u of out.done) {
          useCatalogStore().setItemImage(u.item_code, u.url)
          this.notify('good', `Photo uploaded for ${u.item_code}`)
        }
        for (const f of out.failed) this.notify('crit', `Photo upload failed for ${f.item_code}`, f.error)
      } finally {
        this.uploadsReplaying = false
      }
    },
    /** v0.3 — queued enrolments / declines, then refresh the offline template cache. */
    async replayRecognition(full = false) {
      if (!this.serverReachable) return
      const rec = useRecognitionStore()
      try {
        if (rec.pendingEnrolments > 0) await rec.replayEnrolments()
        if (rec.boutiqueEnabled) await rec.syncTemplates(full || !rec.templatesVersion)
      } catch {
        /* best effort */
      }
    },
    async countUploads() {
      this.uploadsPending = await db.uploads.count()
    },
    notify(kind: SyncNotice['kind'], title: string, detail?: string, offline_uuid?: string, action?: SyncNotice['action']) {
      const id = ++noticeSeq
      this.notices.push({ id, kind, title, detail, offline_uuid, action })
      setTimeout(() => this.dismiss(id), kind === 'crit' ? 12000 : action ? 9000 : 5000)
    },
    dismiss(id: number) {
      this.notices = this.notices.filter((n) => n.id !== id)
    }
  }
})
