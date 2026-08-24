/**
 * v0.4 C — clock-in / clock-out from the Unlock screen (HRMS Employee Checkin behind `hr.*`).
 * The open shift per associate is cached in Dexie so the Unlock screen can show "on shift since"
 * offline; clock actions themselves need a connection (they are attendance records).
 */
import { defineStore } from 'pinia'
import { v04, type ShiftInfo, type ShiftStatus } from '@/api/v04'
import { getSetting, setSetting } from '@/db'

export type ClockAction = 'unlock' | 'in' | 'out'

export function normalizeTs(ts: string): string {
  return /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(ts) ? ts.replace(' ', 'T').replace(/\.\d+$/, '') : ts
}

interface ShiftState {
  byAssociate: Record<string, ShiftInfo | null>
  busy: boolean
  error: string
  hrms: boolean
}

export function fmtMinutes(min: number): string {
  const h = Math.floor(Math.max(0, min) / 60)
  const m = Math.max(0, min) % 60
  return h ? `${h}h ${String(m).padStart(2, '0')}m` : `${m}m`
}

export const useShiftStore = defineStore('shift', {
  state: (): ShiftState => ({ byAssociate: {}, busy: false, error: '', hrms: false }),
  getters: {
    shiftFor: (s) => (associate: string | undefined | null): ShiftInfo | null => (associate ? s.byAssociate[associate] || null : null),
    onShift(): (associate: string | undefined | null) => boolean {
      return (a) => {
        const sh = this.shiftFor(a)
        return !!sh && sh.status !== 'Off shift'
      }
    }
  },
  actions: {
    async restore() {
      this.byAssociate = await getSetting<Record<string, ShiftInfo | null>>('shifts', {})
    },
    async persist() {
      await setSetting('shifts', JSON.parse(JSON.stringify(this.byAssociate)))
    },
    apply(associate: string, res: ShiftStatus) {
      // Frappe datetimes are "YYYY-MM-DD HH:MM:SS[.ffffff]" (site-local); make them Date-parsable on Safari
      const sh = res.on_shift && res.shift ? { ...res.shift, clock_in: normalizeTs(res.shift.clock_in), break_started: res.shift.break_started ? normalizeTs(res.shift.break_started) : null } : null
      this.byAssociate[associate] = sh
      if (typeof res.hrms === 'boolean') this.hrms = res.hrms
      void this.persist()
    },
    /** Refresh the open shift for an associate (silently keeps the cache when offline). */
    async refresh(associate: string) {
      if (typeof window !== 'undefined' && window.__awanzOffline) return
      try {
        this.apply(associate, await v04.hr.shift_status(associate))
      } catch {
        /* offline / not permitted: keep cache */
      }
    },
    async clockIn(associate: string, boutique: string, device_id: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      try {
        this.apply(associate, await v04.hr.clock_in(associate, boutique, device_id))
        return true
      } catch (e) {
        this.error = (e as { code?: string }).code === 'NETWORK' ? 'Clock-in needs a connection' : (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    async clockOut(associate: string, device_id: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      try {
        this.apply(associate, await v04.hr.clock_out(associate, device_id))
        return true
      } catch (e) {
        this.error = (e as { code?: string }).code === 'NETWORK' ? 'Clock-out needs a connection' : (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    },
    async toggleBreak(associate: string): Promise<boolean> {
      this.busy = true
      this.error = ''
      try {
        this.apply(associate, await v04.hr.toggle_break(associate))
        return true
      } catch (e) {
        this.error = (e as Error).message
        return false
      } finally {
        this.busy = false
      }
    }
  }
})
