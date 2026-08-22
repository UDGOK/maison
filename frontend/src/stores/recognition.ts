/**
 * Recognition store — v0.3. Owns the provider lifecycle, the candidate → match → attach
 * pipeline (with Undo), the enrolment / consent flow, the offline enrolment queue and the
 * local template cache. The camera stream itself belongs to RecognitionTile.vue.
 */
import { defineStore } from 'pinia'
import { api, IS_MOCK, type ConsentPayload, type Customer, type RecognitionMatch } from '@/api'
import { db, getSetting, setSetting } from '@/db'
import { EnrolmentQueue } from '@/recognition/enrolments'
import { matchEmbedding, TemplateCache, type MatchOutcome } from '@/recognition/matcher'
import { clampThreshold, effectiveThreshold } from '@/recognition/math'
import { FaceApiProvider, NullProvider, recognitionProvider, setRecognitionProvider, type ProviderStatus, type RecognitionCandidate, type RecognitionSample } from '@/recognition/provider'
import { useCartStore } from './cart'
import { useCatalogStore } from './catalog'
import { useSessionStore } from './session'
import { useSyncStore } from './sync'

export type TileState = 'off' | 'starting' | 'looking' | 'recognised' | 'new' | 'error' | 'nocamera'

export interface EnrolDraft {
  phone: string
  email: string
  name: string
  /** existing customer chosen from the lookup */
  customer: Customer | null
}

export type EnrolStep = 'details' | 'consent' | 'capture' | 'saving' | 'done'

interface RecognitionState {
  // device settings (persisted)
  deviceEnabled: boolean | null
  cameraId: string
  showPreview: boolean
  thresholdOverride: number | null
  testMode: boolean
  // runtime
  tile: TileState
  providerStatus: ProviderStatus
  cameraError: string
  last: { candidate: RecognitionCandidate; outcome: MatchOutcome; at: number } | null
  recognised: RecognitionMatch | null
  undoUntil: number
  matching: boolean
  cachedTemplates: number
  templatesVersion: string | null
  pendingEnrolments: number
  // enrolment flow
  enrolOpen: boolean
  enrolStep: EnrolStep
  enrolDraft: EnrolDraft
  captureSamples: RecognitionSample[]
  captureTarget: number
  enrolError: string
  /** injected by the test hook / Settings test mode */
  testLog: string[]
}

export const UNDO_MS = 5000
export const NEW_CLIENT_MS = 12000
export const CAPTURE_SAMPLES = 3
export const CAPTURE_SPACING_MS = 600

export const enrolmentQueue = new EnrolmentQueue(db, api)
export const templateCache = new TemplateCache(db)

let unsubscribe: (() => void)[] = []
let newTimer: number | null = null
let undoTimer: number | null = null
let lastCaptureAt = 0
let captureResolve: ((samples: RecognitionSample[]) => void) | null = null

export const useRecognitionStore = defineStore('recognition', {
  state: (): RecognitionState => ({
    deviceEnabled: null,
    cameraId: '',
    showPreview: true,
    thresholdOverride: null,
    testMode: false,
    tile: 'off',
    providerStatus: { phase: 'idle', fps: 0, face: false, hint: '', tracker: 'idle', lastMs: 0 },
    cameraError: '',
    last: null,
    recognised: null,
    undoUntil: 0,
    matching: false,
    cachedTemplates: 0,
    templatesVersion: null,
    pendingEnrolments: 0,
    enrolOpen: false,
    enrolStep: 'details',
    enrolDraft: { phone: '', email: '', name: '', customer: null },
    captureSamples: [],
    captureTarget: CAPTURE_SAMPLES,
    enrolError: '',
    testLog: []
  }),
  getters: {
    /** Boutique (Head Office) switch — the device cannot turn recognition on when this is off. */
    boutiqueEnabled: () => useCatalogStore().settings.face_recognition_enabled,
    /** Effective: boutique on AND device not switched off. */
    active(): boolean {
      return this.boutiqueEnabled && this.deviceEnabled !== false
    },
    /** Effective maximum distance: boutique value, tightened by the device override when set. */
    threshold(s): number {
      return effectiveThreshold(useCatalogStore().settings.match_threshold, s.thresholdOverride)
    },
    model: () => useCatalogStore().settings.recognition_model,
    consentText: () => useCatalogStore().settings.consent_text,
    consentVersion: () => useCatalogStore().settings.consent_text_version,
    offlineCache: () => useCatalogStore().settings.recognition_offline_cache,
    canUndo: (s) => !!s.recognised && Date.now() < s.undoUntil,
    e2e: () => isE2E(),
    stateLabel(s): string {
      switch (s.tile) {
        case 'recognised':
          return s.recognised ? `Recognised · ${pct(s.recognised.score)}%` : 'Recognised'
        case 'new':
          return 'New client'
        case 'looking':
          return 'Looking'
        case 'starting':
          return 'Starting'
        case 'nocamera':
          return 'No camera'
        case 'error':
          return 'Error'
        default:
          return 'Off'
      }
    }
  },
  actions: {
    async restore() {
      this.deviceEnabled = await getSetting<boolean | null>('recognition.enabled', null)
      this.cameraId = await getSetting<string>('recognition.camera', '')
      this.showPreview = await getSetting<boolean>('recognition.preview', true)
      this.thresholdOverride = await getSetting<number | null>('recognition.threshold', null)
      this.templatesVersion = await getSetting<string | null>('recognition.templates_version', null)
      this.cachedTemplates = await templateCache.count()
      this.pendingEnrolments = await enrolmentQueue.count()
      installTestHook(this)
    },
    async setDeviceEnabled(v: boolean | null) {
      this.deviceEnabled = v
      await setSetting('recognition.enabled', v)
      if (!this.active) this.tile = 'off'
    },
    async setCamera(id: string) {
      this.cameraId = id
      await setSetting('recognition.camera', id)
    },
    async setShowPreview(v: boolean) {
      this.showPreview = v
      await setSetting('recognition.preview', v)
    },
    /**
     * Device (manager) override of the maximum distance. It may only *tighten* the boutique value
     * (lower distance); anything looser is clamped to the boutique default and cleared.
     */
    async setThreshold(v: number | null) {
      const base = clampThreshold(useCatalogStore().settings.match_threshold)
      let next: number | null = null
      if (v !== null && Number.isFinite(v)) {
        next = Math.round(clampThreshold(v, base) * 100) / 100
        if (next >= base) next = null
      }
      this.thresholdOverride = next
      await setSetting('recognition.threshold', this.thresholdOverride)
    },
    setTestMode(v: boolean) {
      this.testMode = v
      if (!v) this.testLog = []
    },

    /** Called by the tile once it has a playing <video>; wires the provider. */
    async attach(video: HTMLVideoElement) {
      let p = recognitionProvider()
      if (!p.available) {
        p = new FaceApiProvider()
        setRecognitionProvider(p)
      }
      this.detachListeners()
      unsubscribe = [
        p.on('status', (s) => {
          this.providerStatus = { ...s }
          if (s.phase === 'error') {
            this.tile = 'error'
            this.cameraError = s.error || 'Model failed'
          } else if (s.phase === 'running' && (this.tile === 'starting' || this.tile === 'off')) this.tile = 'looking'
        }),
        p.on('candidate', (c) => void this.onCandidate(c)),
        p.on('sample', (s) => this.onSample(s))
      ]
      this.tile = 'starting'
      this.cameraError = ''
      try {
        await p.start(video)
      } catch (e) {
        this.tile = 'error'
        this.cameraError = (e as Error).message
      }
    },
    detachListeners() {
      for (const u of unsubscribe) u()
      unsubscribe = []
    },
    stop() {
      recognitionProvider().stop()
      this.detachListeners()
      this.tile = 'off'
      this.providerStatus = { phase: 'idle', fps: 0, face: false, hint: '', tracker: 'idle', lastMs: 0 }
    },
    setCameraState(s: 'nocamera' | 'error', msg = '') {
      this.tile = s
      this.cameraError = msg
    },
    pause(v: boolean) {
      recognitionProvider().pause(v)
    },

    /** Candidate from the provider (or injected by the test hook). */
    async onCandidate(c: RecognitionCandidate) {
      if (this.enrolOpen || this.matching) return
      if (!this.active && !this.testMode) return
      const session = useSessionStore()
      const sync = useSyncStore()
      if (!session.boutique) return
      this.matching = true
      try {
        const outcome = await matchEmbedding({ db, api, online: () => sync.online }, c.embedding, c.model, session.boutique.name, this.threshold)
        this.last = { candidate: c, outcome, at: Date.now() }
        if (this.testMode)
          this.testLog.unshift(
            `${new Date().toLocaleTimeString()} · ${c.liveness} · q ${c.quality.toFixed(2)} · ${outcome.match ? `${outcome.match.customer_name} ${(outcome.match.score * 100).toFixed(0)}% d=${(outcome.match.distance ?? 0).toFixed(3)} (${outcome.source})` : 'no match'}` +
              ` · max d ${outcome.threshold.toFixed(2)}` +
              (outcome.localDistance !== undefined ? ` · local d ${outcome.localDistance.toFixed(3)}` : '') +
              (outcome.serverDistance !== undefined ? ` · server d ${outcome.serverDistance.toFixed(3)}` : '')
          )
        if (outcome.match) this.recognise(outcome.match)
        else this.newClient()
      } catch (e) {
        if (this.testMode) this.testLog.unshift(`match failed: ${(e as Error).message}`)
      } finally {
        this.matching = false
      }
    },
    recognise(m: RecognitionMatch) {
      const cart = useCartStore()
      const sync = useSyncStore()
      this.clearTimers()
      this.recognised = m
      this.tile = 'recognised'
      this.undoUntil = Date.now() + UNDO_MS
      if (!this.testMode) {
        const cached = cart.customer?.name === m.customer ? cart.customer : null
        const customer: Customer = cached || {
          name: m.customer,
          customer_name: m.customer_name,
          client_number: m.client_number,
          tier: m.tier ?? null,
          loyalty_points: m.loyalty_points ?? 0,
          maison_face_consent: 1
        }
        cart.setCustomer(customer)
        // enrich from the local customer cache / server (points, last visit) without blocking
        void this.hydrateCustomer(m.customer)
        sync.notify('good', `Recognised · ${pct(m.score)}%`, m.customer_name, undefined, { label: 'Undo', action: 'undo-recognition' })
      }
      undoTimer = window.setTimeout(() => {
        if (this.tile === 'recognised') this.tile = this.active ? 'looking' : 'off'
      }, UNDO_MS)
    },
    async hydrateCustomer(name: string) {
      const cart = useCartStore()
      const sync = useSyncStore()
      let c = (await db.customers.get(name)) || null
      if (sync.online) {
        try {
          const fresh = await api.customers.lookup(`MC:${name}`)
          if (fresh) {
            c = fresh
            await db.customers.put(JSON.parse(JSON.stringify(fresh)))
          }
        } catch {
          /* keep cached */
        }
      }
      if (c && cart.customer?.name === name) cart.setCustomer({ ...c, maison_face_consent: 1 })
    },
    newClient() {
      this.clearTimers()
      this.recognised = null
      this.tile = 'new'
      newTimer = window.setTimeout(() => {
        if (this.tile === 'new') this.tile = this.active ? 'looking' : 'off'
      }, NEW_CLIENT_MS)
    },
    /** "Undo" on the Recognised toast: detach and log. */
    async undo() {
      const cart = useCartStore()
      const session = useSessionStore()
      const m = this.recognised
      if (!m) return
      if (cart.customer?.name === m.customer) cart.setCustomer(null)
      this.recognised = null
      this.tile = this.active ? 'looking' : 'off'
      this.clearTimers()
      try {
        await api.recognition.log_event({ customer: m.customer, outcome: 'Undone', score: m.score, boutique: session.boutique?.name, device_id: session.device_id })
      } catch {
        /* best effort */
      }
    },
    clearTimers() {
      if (newTimer) clearTimeout(newTimer)
      if (undoTimer) clearTimeout(undoTimer)
      newTimer = undoTimer = null
    },
    dismissNew() {
      if (this.tile === 'new') this.tile = this.active ? 'looking' : 'off'
    },

    // ---------------- enrolment ----------------
    openEnrol(prefill: Partial<EnrolDraft> = {}) {
      const cart = useCartStore()
      this.enrolDraft = { phone: '', email: '', name: '', customer: cart.customer && !cart.customer.maison_face_consent ? cart.customer : null, ...prefill }
      this.enrolStep = 'details'
      this.enrolError = ''
      this.captureSamples = []
      this.enrolOpen = true
      this.clearTimers()
    },
    closeEnrol() {
      this.enrolOpen = false
      this.enrolStep = 'details'
      this.captureSamples = []
      captureResolve = null
      if (this.tile === 'new') this.tile = this.active ? 'looking' : 'off'
    },
    toConsent() {
      this.enrolStep = 'consent'
    },
    onSample(s: RecognitionSample) {
      if (this.enrolStep !== 'capture') return
      if (s.t - lastCaptureAt < CAPTURE_SPACING_MS) return
      lastCaptureAt = s.t
      this.captureSamples.push(s)
      if (this.captureSamples.length >= this.captureTarget) {
        const done = this.captureSamples.slice(0, this.captureTarget)
        captureResolve?.(done)
        captureResolve = null
      }
    },
    /** Collect 3 good-quality embeddings spaced ≥ 600 ms (≈ 2 s). Resolves null on timeout. */
    capture(timeoutMs = 20000): Promise<RecognitionSample[] | null> {
      this.captureSamples = []
      lastCaptureAt = 0
      this.enrolStep = 'capture'
      return new Promise((resolve) => {
        const timer = window.setTimeout(() => {
          if (captureResolve) {
            captureResolve = null
            resolve(null)
          }
        }, timeoutMs)
        captureResolve = (samples) => {
          clearTimeout(timer)
          resolve(samples)
        }
      })
    },
    /** Test hook: feed capture samples directly. */
    injectSamples(samples: RecognitionSample[]) {
      for (const s of samples) this.onSample({ ...s, t: s.t || lastCaptureAt + CAPTURE_SPACING_MS + 1 })
    },
    /** Consent given → capture → enrol (online) or queue (offline) → attach. */
    async agree(consent: ConsentPayload): Promise<boolean> {
      const session = useSessionStore()
      const sync = useSyncStore()
      const cart = useCartStore()
      const d = this.enrolDraft
      this.enrolError = ''
      const samples = await this.capture()
      if (!this.enrolOpen) return false
      if (!samples) {
        this.enrolError = 'Could not capture a clear face. Ask the client to face the camera and try again.'
        this.enrolStep = 'consent'
        return false
      }
      this.enrolStep = 'saving'
      const payload = {
        embeddings: samples.map((s) => s.embedding),
        quality: samples.map((s) => s.quality),
        model: this.model,
        boutique: session.boutique!.name,
        device_id: session.device_id,
        consent,
        customer: d.customer?.name,
        phone: d.phone.trim() || undefined,
        email: d.email.trim() || undefined,
        name: d.name.trim() || undefined
      }
      try {
        if (!sync.online) throw Object.assign(new Error('offline'), { code: 'NETWORK' })
        const res = await api.recognition.enroll(payload)
        const customer = await this.customerFromResult(res.customer, res.customer_name || d.customer?.customer_name || d.name, res.client_number, d)
        cart.setCustomer(customer)
        this.recognised = { customer: res.customer, customer_name: customer.customer_name, client_number: res.client_number, distance: 0, score: 1 }
        sync.notify('good', 'Enrolled', `${customer.customer_name} · face recognition on`)
        void this.syncTemplates(true)
      } catch (e) {
        const code = (e as { code?: string }).code
        if (code === 'NETWORK' || (e as { status?: number }).status === 0) {
          await enrolmentQueue.enqueue({ kind: 'enroll', associate: session.associate?.name || '', ...payload })
          this.pendingEnrolments = await enrolmentQueue.count()
          // keep selling: attach a provisional client; the queue links the real record later
          const customer = d.customer || provisionalCustomer(d)
          cart.setCustomer(customer)
          sync.notify('warn', 'Enrolment queued', 'Offline — it will sync with the next heartbeat')
        } else {
          this.enrolError = (e as Error).message
          this.enrolStep = 'consent'
          return false
        }
      }
      this.enrolStep = 'done'
      this.closeEnrol()
      this.tile = this.active ? 'looking' : 'off'
      return true
    },
    /** "No thanks": create/link the client without biometrics. */
    async decline(): Promise<boolean> {
      const session = useSessionStore()
      const sync = useSyncStore()
      const cart = useCartStore()
      const d = this.enrolDraft
      this.enrolError = ''
      this.enrolStep = 'saving'
      const args = { boutique: session.boutique!.name, device_id: session.device_id, phone: d.phone.trim() || undefined, email: d.email.trim() || undefined, name: d.name.trim() || undefined }
      try {
        if (d.customer) {
          // existing client: attach immediately; the Declined event is logged server-side by `decline`
          cart.setCustomer(d.customer)
          void api.recognition.decline({ ...args, customer: d.customer.name }).catch(() => undefined)
        } else {
          if (!sync.online) throw Object.assign(new Error('offline'), { code: 'NETWORK' })
          const res = await api.recognition.decline(args)
          cart.setCustomer(await this.customerFromResult(res.customer, res.customer_name || d.name, res.client_number, d, false))
        }
      } catch (e) {
        if ((e as { code?: string }).code === 'NETWORK') {
          await enrolmentQueue.enqueue({ kind: 'decline', associate: session.associate?.name || '', model: this.model, embeddings: [], quality: [], ...args })
          this.pendingEnrolments = await enrolmentQueue.count()
          cart.setCustomer(provisionalCustomer(d))
          sync.notify('warn', 'Client queued', 'Offline — the record will be created on sync')
        } else {
          this.enrolError = (e as Error).message
          this.enrolStep = 'consent'
          return false
        }
      }
      this.closeEnrol()
      this.tile = this.active ? 'looking' : 'off'
      return true
    },
    async customerFromResult(name: string, customer_name: string | undefined, client_number: string | undefined, d: EnrolDraft, consented = true): Promise<Customer> {
      let c = (await db.customers.get(name)) || null
      try {
        c = (await api.customers.lookup(`MC:${name}`)) || c
      } catch {
        /* offline */
      }
      const out: Customer = {
        ...(c || { loyalty_points: 0, tier: 'Member' }),
        name,
        customer_name: c?.customer_name || customer_name || d.name || d.email || d.phone,
        client_number: c?.client_number || client_number,
        mobile_no: c?.mobile_no || d.phone || undefined,
        email_id: c?.email_id || d.email || undefined,
        maison_face_consent: consented ? 1 : (c?.maison_face_consent ?? 0)
      }
      await db.customers.put(JSON.parse(JSON.stringify(out)))
      return out
    },

    // ---------------- sync ----------------
    /** Replay queued enrolments/declines (called by the sync store on heartbeat). */
    async replayEnrolments() {
      const sync = useSyncStore()
      const cart = useCartStore()
      const out = await enrolmentQueue.replay()
      this.pendingEnrolments = out.pending
      for (const d of out.done) {
        const r = d.result
        const c = await this.customerFromResult(r.customer, r.customer_name || d.row.name, r.client_number, { phone: d.row.phone || '', email: d.row.email || '', name: d.row.name || '', customer: null }, d.row.kind === 'enroll')
        // swap the provisional client on the basket for the real record
        if (cart.customer?.name.startsWith('PENDING-') && (cart.customer.mobile_no === d.row.phone || cart.customer.email_id === d.row.email)) cart.setCustomer(c)
        sync.notify('good', d.row.kind === 'enroll' ? 'Enrolment synced' : 'Client synced', c.customer_name)
      }
      for (const f of out.failed) sync.notify('crit', 'Enrolment rejected', f.error)
      if (out.done.some((d) => d.row.kind === 'enroll')) void this.syncTemplates(true)
    },
    /** Refresh the local template cache from the server (consented clients only). */
    async syncTemplates(full = false) {
      const session = useSessionStore()
      const sync = useSyncStore()
      if (!session.boutique || !sync.online) return
      if (!this.offlineCache) {
        await templateCache.clear()
        this.cachedTemplates = 0
        return
      }
      try {
        const since = full ? undefined : this.templatesVersion || undefined
        const res = await api.recognition.templates(session.boutique.name, since)
        await templateCache.apply(res, !since)
        this.templatesVersion = res.version || new Date().toISOString()
        await setSetting('recognition.templates_version', this.templatesVersion)
        this.cachedTemplates = await templateCache.count()
      } catch {
        /* endpoint off or offline: keep what we have */
      }
    },
    /** Manager: purge biometric data for a client (server + local cache). */
    async revoke(customer: string, reason: string) {
      const cart = useCartStore()
      await api.recognition.revoke(customer, reason)
      await templateCache.remove(customer)
      this.cachedTemplates = await templateCache.count()
      const c = await db.customers.get(customer)
      if (c) await db.customers.put({ ...c, maison_face_consent: 0, maison_face_consent_at: undefined, face_templates: 0 })
      if (cart.customer?.name === customer) cart.setCustomer({ ...cart.customer, maison_face_consent: 0, maison_face_consent_at: undefined, face_templates: 0 })
    }
  }
})

/** Display percentage: never claim 100% — a biometric match is a probability, not a certainty. */
export function pct(score: number): number {
  return Math.max(0, Math.min(99, Math.round(score * 100)))
}

function provisionalCustomer(d: EnrolDraft): Customer {
  return {
    name: `PENDING-${Date.now().toString(36)}`,
    customer_name: d.name.trim() || d.email.trim() || d.phone.trim() || 'New client',
    mobile_no: d.phone.trim() || undefined,
    email_id: d.email.trim() || undefined,
    loyalty_points: 0,
    tier: 'Member'
  }
}

export function isE2E(): boolean {
  if (import.meta.env.VITE_E2E === '1') return true
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('maisonE2E') === '1'
  } catch {
    return false
  }
}

export interface RecognitionTestHook {
  emit(candidate: { embedding: number[]; quality?: number; bbox?: { x: number; y: number; width: number; height: number } }): Promise<void>
  setTemplates(list: { customer: string; embedding: number[]; model?: string; customer_name?: string; client_number?: string }[]): Promise<void>
  /** feed enrolment capture samples (3 needed) */
  samples(list: { embedding: number[]; quality?: number }[]): void
  state(): { tile: TileState; recognised: RecognitionMatch | null; cached: number; pending: number; enrolStep: EnrolStep; enrolOpen: boolean; last?: { local?: number; server?: number; localDistance?: number; serverDistance?: number; source: string; threshold: number } }
  /** drop the camera requirement: mark the tile as looking without a provider */
  fake(): void
}

declare global {
  interface Window {
    __maisonRecognitionTest?: RecognitionTestHook
  }
}

/**
 * E2E hook (`VITE_E2E=1` or `localStorage.maisonE2E === '1'`): lets Playwright inject
 * embeddings and seed templates without a face in front of the camera.
 */
function installTestHook(store: ReturnType<typeof useRecognitionStore>) {
  if (typeof window === 'undefined' || !isE2E()) return
  window.__maisonRecognitionTest = {
    async emit(c) {
      const bbox = c.bbox || { x: 200, y: 100, width: 240, height: 240 }
      const cand: RecognitionCandidate = { embedding: c.embedding, quality: c.quality ?? 0.9, bbox, model: store.model, liveness: 'injected', t: performance.now() }
      const p = recognitionProvider()
      if (p instanceof FaceApiProvider && store.tile !== 'off') p.inject(cand)
      else await store.onCandidate(cand)
    },
    async setTemplates(list) {
      if (IS_MOCK) {
        const { __mockRecognition } = await import('@/api/mock')
        __mockRecognition.setTemplates(list)
      }
      await templateCache.apply(
        { templates: list.map((l) => ({ customer: l.customer, customer_name: l.customer_name || l.customer, client_number: l.client_number, embedding: l.embedding, model: l.model || store.model })), deleted: [] },
        true
      )
      store.cachedTemplates = await templateCache.count()
    },
    samples(list) {
      const bbox = { x: 200, y: 100, width: 240, height: 240 }
      store.injectSamples(list.map((s, i) => ({ embedding: s.embedding, quality: s.quality ?? 0.9, bbox, model: store.model, t: (i + 1) * (CAPTURE_SPACING_MS + 50) + performance.now() })))
    },
    state: () => ({
      tile: store.tile,
      recognised: store.recognised,
      cached: store.cachedTemplates,
      pending: store.pendingEnrolments,
      enrolStep: store.enrolStep,
      enrolOpen: store.enrolOpen,
      last: store.last
        ? {
            local: store.last.outcome.localScore,
            server: store.last.outcome.serverScore,
            localDistance: store.last.outcome.localDistance,
            serverDistance: store.last.outcome.serverDistance,
            source: store.last.outcome.source,
            threshold: store.last.outcome.threshold
          }
        : undefined
    }),
    fake() {
      if (!(recognitionProvider() instanceof FaceApiProvider)) setRecognitionProvider(new NullProvider())
      store.tile = 'looking'
    }
  }
}
