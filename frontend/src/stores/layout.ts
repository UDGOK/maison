/**
 * Layout store — phone vs. tablet/desktop. On phones (portrait, < 768 px) the basket is a bottom
 * sheet with a summary bar; the store holds that state so Sell/TopBar/BasketPanel agree.
 * Pure helpers (`isPhoneWidth`, `nextSheetState`) are unit-tested.
 */
import { defineStore } from 'pinia'

export const PHONE_MAX_WIDTH = 767

export function isPhoneWidth(width: number): boolean {
  return width <= PHONE_MAX_WIDTH
}

export type SheetState = 'collapsed' | 'expanded'

/**
 * Sheet transition rules:
 * - adding the first line while collapsed keeps it collapsed (the summary bar shows the total);
 * - an empty basket always collapses;
 * - leaving the phone layout forces "expanded" (the side panel is always visible).
 */
export function nextSheetState(current: SheetState, ctx: { phone: boolean; lines: number; toggle?: boolean }): SheetState {
  if (!ctx.phone) return 'expanded'
  if (ctx.lines === 0) return 'collapsed'
  if (ctx.toggle) return current === 'expanded' ? 'collapsed' : 'expanded'
  return current
}

interface LayoutState {
  width: number
  height: number
  sheet: SheetState
  /** mobile nav drawer (TopBar hamburger) */
  navOpen: boolean
}

export const useLayoutStore = defineStore('layout', {
  state: (): LayoutState => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1366,
    height: typeof window !== 'undefined' ? window.innerHeight : 1024,
    sheet: 'collapsed',
    navOpen: false
  }),
  getters: {
    phone: (s) => isPhoneWidth(s.width),
    portrait: (s) => s.height >= s.width,
    sheetExpanded(s): boolean {
      return !isPhoneWidth(s.width) || s.sheet === 'expanded'
    }
  },
  actions: {
    start() {
      if (typeof window === 'undefined') return
      const update = () => {
        this.width = window.innerWidth
        this.height = window.innerHeight
        if (!this.phone) this.navOpen = false
      }
      window.addEventListener('resize', update)
      window.visualViewport?.addEventListener('resize', update)
      update()
    },
    toggleSheet(lines: number) {
      this.sheet = nextSheetState(this.sheet, { phone: this.phone, lines, toggle: true })
    },
    syncSheet(lines: number) {
      this.sheet = nextSheetState(this.sheet, { phone: this.phone, lines })
    },
    openSheet() {
      this.sheet = 'expanded'
    },
    closeSheet() {
      this.sheet = 'collapsed'
    }
  }
})
