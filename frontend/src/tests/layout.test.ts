import { describe, expect, it, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { isPhoneWidth, nextSheetState, useLayoutStore } from '@/stores/layout'

describe('phone layout logic', () => {
  it('classifies widths', () => {
    expect(isPhoneWidth(375)).toBe(true)
    expect(isPhoneWidth(390)).toBe(true)
    expect(isPhoneWidth(767)).toBe(true)
    expect(isPhoneWidth(768)).toBe(false)
    expect(isPhoneWidth(1366)).toBe(false)
  })
  it('sheet: desktop is always expanded', () => {
    expect(nextSheetState('collapsed', { phone: false, lines: 0 })).toBe('expanded')
    expect(nextSheetState('collapsed', { phone: false, lines: 3, toggle: true })).toBe('expanded')
  })
  it('sheet: phone collapses when empty, keeps state otherwise, toggles on demand', () => {
    expect(nextSheetState('expanded', { phone: true, lines: 0 })).toBe('collapsed')
    expect(nextSheetState('collapsed', { phone: true, lines: 1 })).toBe('collapsed')
    expect(nextSheetState('expanded', { phone: true, lines: 1 })).toBe('expanded')
    expect(nextSheetState('collapsed', { phone: true, lines: 2, toggle: true })).toBe('expanded')
    expect(nextSheetState('expanded', { phone: true, lines: 2, toggle: true })).toBe('collapsed')
  })
})

describe('layout store', () => {
  beforeEach(() => setActivePinia(createPinia()))
  it('derives phone + sheetExpanded from width', () => {
    const l = useLayoutStore()
    l.width = 390
    l.height = 844
    expect(l.phone).toBe(true)
    expect(l.portrait).toBe(true)
    expect(l.sheetExpanded).toBe(false)
    l.toggleSheet(2)
    expect(l.sheetExpanded).toBe(true)
    l.syncSheet(0)
    expect(l.sheetExpanded).toBe(false)
    l.width = 1366
    l.height = 1024
    expect(l.phone).toBe(false)
    expect(l.sheetExpanded).toBe(true)
  })
})
