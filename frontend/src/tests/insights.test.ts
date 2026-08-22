import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mockApi, __resetMock } from '@/api/mock'
import type { POSInvoice } from '@/api/types'

vi.mock('@/api', async () => {
  const mod = await import('@/api/mock')
  return { api: mod.mockApi, IS_MOCK: true }
})

async function sell(customer: string, codes: string[], uuid: string) {
  const b = await mockApi.catalog.bootstrap('CHI-OAK')
  const items = codes.map((c) => {
    const it = b.items.find((i) => i.item_code === c)!
    return { item_code: c, qty: 1, rate: b.prices[c], serial_no: it.has_serial_no ? b.serials[c][0] : undefined }
  })
  const net = items.reduce((s, l) => s + l.rate, 0)
  const inv: POSInvoice = {
    offline_uuid: uuid, boutique: 'CHI-OAK', associate: 'MA-0001', device_id: 'd', posting_datetime: new Date().toISOString(),
    customer, items, payments: [{ mode_of_payment: 'Cash', amount: Math.round(net * 1.1025 * 100) / 100 }]
  }
  const r = await mockApi.sales.submit_batch([inv])
  expect(r.results[0].status).toBe('ok')
}

describe('v0.4 H insights mock (parity with maison_pos.api.insights)', () => {
  beforeEach(() => __resetMock())

  it('pairs well with: watch → strap, chain → pendant; basket items never suggested', async () => {
    const r = await mockApi.insights.recommend_for_basket(['WT-CHR-026'], 3, 'CHI-OAK')
    expect(r.basket).toEqual(['WT-CHR-026'])
    expect(r.items[0].item_code).toBe('AC-STR-037')
    expect(r.items[0].reason).toMatch(/Bought with Chronograph 41mm Steel in 38% of baskets/)
    expect(r.items.map((i) => i.item_code)).not.toContain('WT-CHR-026')
    expect(r.items).toHaveLength(3)
    expect(r.items.every((i) => typeof i.rate === 'number' && i.rate > 0)).toBe(true)
    expect(r.items[0].in_stock).toBe(true)
    const chain = await mockApi.insights.recommend_for_basket(['NK-CHN-012'], 3)
    expect(chain.items[0].item_code).toBe('NK-PND-010')
    expect(chain.items[0].in_stock).toBeNull()
    expect((await mockApi.insights.recommend_for_basket([], 3)).items).toEqual([])
  })

  it('suggested for this client excludes everything the client owns', async () => {
    const customers = await mockApi.customers.search('', 50)
    const c = customers[0].name
    await sell(c, ['RG-SOL-001'], 'ins-1')
    await sell(c, ['RG-ETE-004'], 'ins-2')
    const r = await mockApi.insights.recommend_for_client(c, 3, 'CHI-OAK')
    expect(r.source).toBe('cache')
    expect(r.owned).toContain('RG-SOL-001')
    expect(r.owned).toContain('RG-ETE-004')
    const codes = r.items.map((i) => i.item_code)
    expect(codes).not.toContain('RG-SOL-001')
    expect(codes).not.toContain('RG-ETE-004') // the natural partner of a solitaire, but already owned
    expect(codes).toContain('AC-CLN-036')
    expect(r.items.length).toBeLessThanOrEqual(3)
    // owned items are excluded from basket pairings too
    const b = await mockApi.insights.recommend_for_basket(['RG-HAL-003'], 3, 'CHI-OAK', c)
    expect(b.items.map((i) => i.item_code)).not.toContain('RG-ETE-004')
  })

  it('falls back to bestsellers for a client with no history', async () => {
    const customers = await mockApi.customers.search('', 50)
    const fresh = customers.find((c) => !c.last_visit) ?? customers[customers.length - 1]
    const r = await mockApi.insights.recommend_for_client(fresh.name, 3)
    expect(r.items.length).toBeGreaterThan(0)
    expect(r.items.every((i) => !r.owned.includes(i.item_code))).toBe(true)
  })
})

describe('insights store', () => {
  beforeEach(() => {
    __resetMock()
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  it('debounces basket lookups and hides owned items / dismissed tiles', async () => {
    const { useInsightsStore } = await import('@/stores/insights')
    const s = useInsightsStore()
    const spy = vi.spyOn(mockApi.insights, 'recommend_for_basket')
    s.scheduleBasket(['WT-CHR-026'], 'CHI-OAK')
    s.scheduleBasket(['WT-CHR-026', 'NK-CHN-012'], 'CHI-OAK')
    s.scheduleBasket(['WT-CHR-026', 'NK-CHN-012'], 'CHI-OAK') // same key: ignored
    expect(spy).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(400)
    expect(spy).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(600) // mock latency
    expect(s.basketItems.length).toBeGreaterThan(0)
    expect(s.basketItems.map((i) => i.item_code)).not.toContain('WT-CHR-026')
    const first = s.basketItems[0].item_code
    s.dismiss(first)
    expect(s.visibleBasketItems.map((i) => i.item_code)).not.toContain(first)
    s.scheduleBasket([], 'CHI-OAK')
    expect(s.basketItems).toEqual([])
  })

  it('loads client suggestions once per client and clears on detach', async () => {
    const { useInsightsStore } = await import('@/stores/insights')
    const s = useInsightsStore()
    vi.useRealTimers()
    const customers = await mockApi.customers.search('', 50)
    vi.useFakeTimers()
    const spy = vi.spyOn(mockApi.insights, 'recommend_for_client')
    const p = s.loadClient(customers[0].name, 'CHI-OAK')
    await vi.advanceTimersByTimeAsync(600)
    await p
    expect(s.clientItems.length).toBeGreaterThan(0)
    const p2 = s.loadClient(customers[0].name, 'CHI-OAK')
    await vi.advanceTimersByTimeAsync(600)
    await p2
    expect(spy).toHaveBeenCalledTimes(1)
    await s.loadClient(null)
    expect(s.clientItems).toEqual([])
    expect(s.clientFor).toBeNull()
  })
})
