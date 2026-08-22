/** v0.4 G — web orders queue: status machine (mock parity with the backend), collection into the cart, balance math. */
import { beforeEach, describe, expect, it } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mockWebshop } from '@/api/webshop'
import { useWebOrdersStore } from '@/stores/webOrders'
import { useCartStore } from '@/stores/cart'
import { useCatalogStore } from '@/stores/catalog'
import { ITEMS, PRICES } from '@/api/seed'
import { round } from '@/utils/money'

describe('web orders — mock status machine mirrors core.STATUS_NEXT', () => {
  it('New → Picking → Ready; Collected only through the sale; no skipping', async () => {
    const q = await mockWebshop.web_orders('CHI-OAK')
    const fresh = q.orders.find((o) => o.status === 'New')!
    await expect(mockWebshop.set_web_order_status(fresh.name, 'Ready')).rejects.toThrow(/Cannot move/)
    await mockWebshop.set_web_order_status(fresh.name, 'Picking')
    await mockWebshop.set_web_order_status(fresh.name, 'Ready')
    expect((await mockWebshop.web_order(fresh.name)).status).toBe('Ready')
    // back to picking is allowed, collected is not a manual transition from New
    await mockWebshop.set_web_order_status(fresh.name, 'Picking')
    await mockWebshop.set_web_order_status(fresh.name, 'Ready')
  })
  it('only lists open orders of the boutique unless include_done', async () => {
    const q = await mockWebshop.web_orders('CHI-OAK')
    expect(q.orders.every((o) => ['New', 'Picking', 'Ready'].includes(o.status))).toBe(true)
    expect(q.orders.every((o) => o.boutique === 'CHI-OAK')).toBe(true)
    expect((await mockWebshop.web_orders('NYC-5AV')).orders).toHaveLength(0)
    expect(q.counts.New + q.counts.Picking + q.counts.Ready).toBe(q.orders.length)
  })
})

describe('web orders — collection into the cart', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    const catalog = useCatalogStore()
    catalog.items = ITEMS
    catalog.prices = PRICES
    catalog.serials = Object.fromEntries(ITEMS.filter((i) => i.has_serial_no).map((i) => [i.item_code, [`${i.item_code}-CHI-001`, `${i.item_code}-CHI-002`]]))
    catalog.taxes = [{ description: 'IL Sales Tax', rate: 10.25 }] as any
  })

  it('loads lines + client, keeps the web price, remembers the prepaid amount', async () => {
    const store = useWebOrdersStore()
    const cart = useCartStore()
    const q = await mockWebshop.web_orders('CHI-OAK', true)
    const paid = q.orders.find((o) => o.name === 'SAL-ORD-2026-00101')!
    const missing = await store.loadForCollection(paid, mockWebshop)
    expect(missing).toEqual([])
    expect(cart.lines).toHaveLength(1)
    expect(cart.lines[0].item_code).toBe('NK-CHN-012')
    expect(cart.lines[0].rate).toBe(paid.items[0].rate)
    expect(cart.customer?.name).toBe(paid.customer)
    expect(store.active?.name).toBe(paid.name)
    expect(store.prepaid).toBe(paid.prepaid_amount)
    // fully prepaid: balance at the counter is zero
    expect(round(Math.max(0, cart.totals.grand_total - store.prepaid))).toBe(0)
    cart.clear()
    expect(store.active).toBeNull()
  })

  it('picks a serial from the boutique for serialized pieces and computes the balance after a deposit', async () => {
    const store = useWebOrdersStore()
    const cart = useCartStore()
    const reserve = (await mockWebshop.web_orders('CHI-OAK', true)).orders.find((o) => o.web_mode === 'Reserve-with-deposit')!
    const missing = await store.loadForCollection(reserve, mockWebshop)
    expect(missing).toEqual([])
    expect(cart.lines[0].serial_no).toBe('RG-SOL-001-CHI-001')
    const due = round(Math.max(0, cart.totals.grand_total - store.prepaid))
    expect(due).toBeGreaterThan(0)
    expect(due).toBeLessThan(cart.totals.grand_total)
    expect(round(cart.totals.grand_total - due)).toBe(reserve.deposit_amount)
  })
})
