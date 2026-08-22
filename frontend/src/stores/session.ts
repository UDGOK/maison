import { defineStore } from 'pinia'
import { api, type Associate, type Boutique } from '@/api'
import { db, getSetting, setSetting } from '@/db'
import { sha256Hex } from '@/utils/hash'
import { deviceId } from '@/utils/device'

const UNLOCK_KEY = 'maison.unlock'

interface SessionState {
  boutique: Boutique | null
  associates: Associate[]
  associate: Associate | null
  boutiqueList: { name: string; boutique_name: string; city: string }[]
  unlockedAt: string | null
  ready: boolean
  device_id: string
}

export const useSessionStore = defineStore('session', {
  state: (): SessionState => ({
    boutique: null,
    associates: [],
    associate: null,
    boutiqueList: [],
    unlockedAt: null,
    ready: false,
    device_id: deviceId()
  }),
  getters: {
    unlocked: (s) => !!s.associate && !!s.boutique,
    isManager: (s) => !!s.associate && s.associate.role !== 'Associate',
    currency: (s) => s.boutique?.currency || 'USD'
  },
  actions: {
    /** Restore the last boutique + associates from Dexie so PIN unlock works offline. */
    async restore() {
      this.boutique = await getSetting<Boutique | null>('boutique', null)
      this.associates = await getSetting<Associate[]>('associates', [])
      this.boutiqueList = await getSetting('boutiqueList', [])
      // Survive an accidental reload within the same browsing session (8 h cap).
      try {
        const raw = sessionStorage.getItem(UNLOCK_KEY)
        if (raw) {
          const { name, at } = JSON.parse(raw) as { name: string; at: string }
          const a = this.associates.find((x) => x.name === name)
          if (a && Date.now() - new Date(at).getTime() < 8 * 3600 * 1000) {
            this.associate = a
            this.unlockedAt = at
          } else sessionStorage.removeItem(UNLOCK_KEY)
        }
      } catch {
        /* storage unavailable */
      }
      this.ready = true
    },
    async loadBoutiques() {
      try {
        this.boutiqueList = await api.boutiques()
        await setSetting('boutiqueList', JSON.parse(JSON.stringify(this.boutiqueList)))
      } catch {
        /* offline: keep cached list */
      }
      return this.boutiqueList
    },
    /** Called by the catalog store after a successful bootstrap. */
    async setBoutique(boutique: Boutique, associates: Associate[]) {
      this.boutique = boutique
      this.associates = associates
      await setSetting('boutique', JSON.parse(JSON.stringify(boutique)))
      await setSetting('associates', JSON.parse(JSON.stringify(associates)))
    },
    /**
     * PIN check. Online: the server verifies (PBKDF2 hash, lockout) and we cache a device-local
     * SHA-256 digest of the accepted PIN. Offline (or server unreachable): compare against that
     * cached digest — or one shipped in the bootstrap (mock mode).
     */
    async unlock(associateName: string, pin: string): Promise<boolean> {
      const a = this.associates.find((x) => x.name === associateName)
      if (!a) return false
      const hash = await sha256Hex(pin)
      let ok: boolean | null = null
      const offline = (typeof navigator !== 'undefined' && !navigator.onLine) || (typeof window !== 'undefined' && window.__maisonOffline)
      if (!offline) {
        try {
          const r = await api.verifyPin(a.name, pin)
          ok = !!r.ok
          if (ok && a.pin_hash !== hash) {
            a.pin_hash = hash
            await setSetting('associates', JSON.parse(JSON.stringify(this.associates)))
          }
        } catch (e) {
          const code = (e as { code?: string }).code
          // Locked PIN / permission errors are authoritative; network errors fall back to the cache.
          if (code && code !== 'NETWORK' && !code.startsWith('HTTP_5')) ok = false
        }
      }
      if (ok === null) ok = !!a.pin_hash && hash === a.pin_hash
      if (!ok) return false
      this.associate = a
      this.unlockedAt = new Date().toISOString()
      try {
        sessionStorage.setItem(UNLOCK_KEY, JSON.stringify({ name: a.name, at: this.unlockedAt }))
      } catch {
        /* ignore */
      }
      return true
    },
    lock() {
      this.associate = null
      this.unlockedAt = null
      try {
        sessionStorage.removeItem(UNLOCK_KEY)
      } catch {
        /* ignore */
      }
    },
    async forgetBoutique() {
      this.lock()
      this.boutique = null
      this.associates = []
      await db.settings.delete('boutique')
      await db.settings.delete('associates')
    }
  }
})
