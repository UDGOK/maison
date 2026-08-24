/**
 * v0.6 N — the 21+ age gate.
 *
 * `cart.add` asks `useAgeStore().gate(item, serial)` before an age-restricted item is rung up.
 * The first restricted item of a transaction opens the ID sheet (scan the PDF417 on the licence
 * with the wedge / camera, or enter the date of birth by hand); the add is parked in `pending`
 * and replayed once the check passes. One successful check covers the whole transaction; it is
 * cleared with the basket. Under-age / expired IDs block: the parked adds are dropped.
 *
 * Online the server decides (`age.verify_scan` / `verify_manual`, audit row `AWANZ Age Check`
 * with masked fields only); offline the same pure rules run on the device (`scan/aamva.ts`)
 * and the audit row is written when the sale syncs (`age_check.offline = 1`).
 */
import { defineStore } from 'pinia'
import type { AgeCheckPayload, Item } from '@/api'
import { decideOffline, toPayload, v06, type AgeCheckResult } from '@/api/v06'
import { looksLikeAamva, parseAamva } from '@/scan/aamva'
import { useCartStore } from './cart'
import { useCatalogStore } from './catalog'
import { useSessionStore } from './session'
import { useSyncStore } from './sync'

export interface PendingAdd {
  item: Item
  serial_no?: string
}

interface AgeState {
  open: boolean
  mode: 'scan' | 'manual'
  pending: PendingAdd[]
  /** the passed check of the current transaction */
  verified: AgeCheckResult | null
  /** last failed / declined outcome (shown on the sheet, mirrored to the Salon) */
  last: AgeCheckResult | null
  busy: boolean
  error: string
  /** the item that triggered the sheet (for the copy) */
  trigger: string
}

export const useAgeStore = defineStore('age', {
  state: (): AgeState => ({ open: false, mode: 'scan', pending: [], verified: null, last: null, busy: false, error: '', trigger: '' }),
  getters: {
    settings: () => useCatalogStore().age,
    minimumAge(): number {
      return this.settings.minimum_age
    },
    required(): boolean {
      return this.settings.age_verification_required
    },
    isVerified: (s) => !!s.verified?.ok,
    /** What the invoice carries (undefined when nothing restricted was sold / no check ran). */
    payload(): AgeCheckPayload | undefined {
      if (!this.verified?.ok) return undefined
      return toPayload(this.verified, !this.verified.check)
    },
    /** Salon mirror: `{minimum_age, status}` — 'ask' | 'verified' | 'blocked'. */
    salonState(): { minimum_age: number; status: 'ask' | 'verified' | 'blocked'; outcome?: string } | null {
      if (this.open) return { minimum_age: this.minimumAge, status: this.last && !this.last.ok ? 'blocked' : 'ask', outcome: this.last?.outcome }
      return null
    }
  },
  actions: {
    /** Does this item need a passed check before it can be added? */
    needsGate(item: Item): boolean {
      return this.required && item.maison_age_restricted === 1 && !this.isVerified
    },
    /** Called by `cart.add`: true = go ahead, false = parked behind the ID sheet. */
    gate(item: Item, serial_no?: string): boolean {
      if (!this.needsGate(item)) return true
      this.pending.push({ item, serial_no })
      this.trigger = item.item_name
      this.error = ''
      this.last = null
      this.mode = this.settings.id_scan_enabled ? 'scan' : 'manual'
      this.open = true
      return false
    },
    close() {
      this.open = false
      this.busy = false
    },
    /** The client has no ID / refused: drop the parked items, log the decline. */
    async decline() {
      const dropped = this.pending.length
      this.pending = []
      this.open = false
      const session = useSessionStore()
      const sync = useSyncStore()
      if (sync.online) {
        try {
          this.last = await v06.age.decline(session.boutique?.name, session.device_id)
        } catch {
          /* logging only */
        }
      }
      if (dropped) sync.notify('warn', `Age-restricted item${dropped > 1 ? 's' : ''} not added`, 'No valid ID presented')
    },
    async scan(raw: string) {
      if (!looksLikeAamva(raw)) {
        this.error = 'That is not a driver’s licence barcode — scan the PDF417 on the back of the ID'
        return null
      }
      const session = useSessionStore()
      const sync = useSyncStore()
      this.busy = true
      this.error = ''
      try {
        let res: AgeCheckResult
        if (sync.online) {
          try {
            res = await v06.age.verify_scan(raw, session.boutique?.name, session.device_id)
          } catch (e) {
            const p = parseAamva(raw)
            res = decideOffline('Scan', p.dob, p.expiry, this.minimumAge, p.initials, p.jurisdiction)
            if (!p.ok) this.error = (e as Error).message
          }
        } else {
          const p = parseAamva(raw)
          res = decideOffline('Scan', p.dob, p.expiry, this.minimumAge, p.initials, p.jurisdiction)
        }
        return this.apply(res)
      } finally {
        this.busy = false
      }
    },
    async manual(dob: string, expiry?: string, initials?: string) {
      if (!dob) {
        this.error = 'Enter the date of birth printed on the ID'
        return null
      }
      const session = useSessionStore()
      const sync = useSyncStore()
      this.busy = true
      this.error = ''
      try {
        let res: AgeCheckResult
        if (sync.online) {
          try {
            res = await v06.age.verify_manual(dob, session.boutique?.name, expiry || undefined, initials || undefined, session.device_id)
          } catch {
            res = decideOffline('Manual', dob, expiry || null, this.minimumAge, initials)
          }
        } else res = decideOffline('Manual', dob, expiry || null, this.minimumAge, initials)
        return this.apply(res)
      } finally {
        this.busy = false
      }
    },
    /** Apply a decision: pass → replay the parked adds; fail → drop them and keep the sheet up with the reason. */
    apply(res: AgeCheckResult): AgeCheckResult {
      const sync = useSyncStore()
      if (res.ok) {
        this.verified = res
        this.last = null
        this.error = ''
        this.open = false
        const queue = this.pending
        this.pending = []
        const cart = useCartStore()
        for (const p of queue) cart.add(p.item, p.serial_no)
        sync.notify('good', res.message, res.initials ? `ID ${res.initials}${res.jurisdiction ? ' · ' + res.jurisdiction : ''}` : undefined)
      } else {
        this.last = res
        this.error = res.message
        if (res.outcome === 'Underage' || res.outcome === 'Expired') {
          this.pending = []
          sync.notify('crit', res.message, 'Age-restricted items were not added')
        }
      }
      return res
    },
    /** A new transaction: the check no longer applies. */
    reset() {
      this.verified = null
      this.last = null
      this.pending = []
      this.open = false
      this.error = ''
    }
  }
})
