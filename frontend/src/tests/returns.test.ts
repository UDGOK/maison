import { beforeEach, describe, expect, it } from 'vitest'
import {
  clampReturnQty,
  computeExchange,
  computeReturnTotals,
  managerRequired,
  returnLineNet,
  returnableSerials
} from '@/returns/math'
import { mockApi, __resetMock, __mockOps, RETURNS_POLICY } from '@/api/mock'
import type { POSInvoice } from '@/api/types'

describe('return line math', () => {
  it('credits rate × qty with tax only on taxable lines', () => {
    const t = computeReturnTotals(
      [
        { rate: 160, qty: 2, taxable: true },
        { rate: 150, qty: 1, taxable: false }
      ],
      10.25
    )
    expect(t.net).toBe(470)
    expect(t.tax).toBe(32.8) // 320 × 10.25 %
    expect(t.total).toBe(502.8)
  })
  it('keeps the original per-unit discount and ignores zero-qty lines', () => {
    expect(returnLineNet({ rate: 100, qty: 3, discount_amount: 10 })).toBe(270)
    const t = computeReturnTotals([{ rate: 100, qty: 0 }], 10)
    expect(t.total).toBe(0)
  })
  it('rounds per line like ERPNext', () => {
    const t = computeReturnTotals([{ rate: 6900, qty: 1 }], 8.875)
    expect(t.tax).toBe(612.38)
    expect(t.total).toBe(7512.38)
  })
  it('serial helpers', () => {
    expect(returnableSerials(['A', 'B', 'C'], ['B'])).toEqual(['A', 'C'])
    expect(clampReturnQty(5, 2)).toBe(2)
    expect(clampReturnQty(-1, 2)).toBe(0)
    expect(clampReturnQty(9, 1, ['S1'])).toBe(1)
  })
})

describe('exchange difference', () => {
  it('client pays the difference when trading up', () => {
    const x = computeExchange(176.4, 2646)
    expect(x.applied).toBe(176.4)
    expect(x.difference).toBe(2469.6)
    expect(x.to_collect).toBe(2469.6)
    expect(x.to_refund).toBe(0)
  })
  it('remainder is refunded when trading down', () => {
    const x = computeExchange(2646, 176.4)
    expect(x.applied).toBe(176.4)
    expect(x.difference).toBe(-2469.6)
    expect(x.to_refund).toBe(2469.6)
    expect(x.to_collect).toBe(0)
  })
  it('even exchange moves nothing', () => {
    const x = computeExchange(500, 500)
    expect(x.difference).toBe(0)
    expect(x.to_collect + x.to_refund).toBe(0)
  })
})

describe('manager gate', () => {
  it('threshold, window, manager bypass', () => {
    expect(managerRequired({ credit: 100, threshold: 2500, daysSince: 3, windowDays: 30 })).toEqual({
      required: false,
      reason: null
    })
    expect(managerRequired({ credit: 3000, threshold: 2500, daysSince: 3, windowDays: 30 }).reason).toBe(
      'threshold'
    )
    expect(managerRequired({ credit: 100, threshold: 2500, daysSince: 40, windowDays: 30 }).reason).toBe(
      'window'
    )
    expect(managerRequired({ credit: 1, threshold: 0, daysSince: 0, windowDays: 30 }).reason).toBe(
      'threshold'
    )
    expect(
      managerRequired({ credit: 9999, threshold: 0, daysSince: 99, windowDays: 30, isManager: true }).required
    ).toBe(false)
  })
})

describe('mock returns parity', () => {
  beforeEach(() => __resetMock())

  async function sell(serial = true) {
    const b = await mockApi.catalog.bootstrap('CHI-OAK')
    const item = serial
      ? b.items.find((i) => i.item_code === 'RG-SOL-001') || b.items.find((i) => i.has_serial_no)!
      : [...b.items]
          .filter((i) => !i.has_serial_no && i.is_stock_item !== 0 && (b.stock[i.item_code] ?? 0) >= 2)
          .sort((x, y) => b.prices[x.item_code] - b.prices[y.item_code])[0]
    const serialNo = item.has_serial_no ? b.serials[item.item_code][0] : undefined
    const rate = b.prices[item.item_code]
    const qty = serialNo ? 1 : 2
    const total = Math.round(rate * qty * 1.1025 * 100) / 100
    const inv: POSInvoice = {
      offline_uuid: `t-${Math.random()}`,
      boutique: 'CHI-OAK',
      associate: 'MA-0002',
      device_id: 'd',
      posting_datetime: new Date().toISOString(),
      customer: 'CUST-0003',
      items: [{ item_code: item.item_code, qty, rate, serial_no: serialNo }],
      payments: [{ mode_of_payment: 'Card', amount: total, stripe_payment_intent: 'pi_sim_t1' }]
    }
    const r = await mockApi.sales.submit_batch([inv])
    expect(r.results[0].status).toBe('ok')
    return {
      invoice: r.results[0].invoice_name!,
      item,
      serialNo,
      rate,
      qty,
      total,
      token: r.results[0].receipt_token!
    }
  }

  it('lookup by invoice / token / customer reports returnable serials', async () => {
    const s = await sell()
    const byInv = await mockApi.returns.lookup({ invoice: s.invoice })
    expect(byInv.invoices[0].lines[0].returnable_serials).toEqual([s.serialNo])
    expect(byInv.invoices[0].within_return_window).toBe(true)
    const byTok = await mockApi.returns.lookup({ token: `https://x/r/${s.token}` })
    expect(byTok.invoices[0].name).toBe(s.invoice)
    const byCust = await mockApi.returns.lookup({ customer: 'CUST-0003' })
    expect(byCust.invoices.map((i) => i.name)).toContain(s.invoice)
  })

  it('sellable serial goes back to stock, damaged does not; second return refused', async () => {
    const s = await sell()
    const before = __mockOps.serials('CHI-OAK')[s.item.item_code]
    expect(before).not.toContain(s.serialNo)
    const lines = [
      {
        item_code: s.item.item_code,
        qty: 1,
        serial_no: s.serialNo,
        reason: 'Change of mind' as const,
        condition: 'Sellable' as const
      }
    ]
    const gate = managerRequired({
      credit: s.total,
      threshold: RETURNS_POLICY.returns_manager_threshold,
      daysSince: 0,
      windowDays: 30
    })
    const res = await mockApi.returns.return_items({
      invoice: s.invoice,
      lines,
      refund_method: 'card',
      ...(gate.required ? { manager: 'MA-0001', manager_pin: '1234' } : {})
    })
    expect(res.grand_total).toBeCloseTo(-s.total, 2)
    expect(res.refund_method).toBe('Card')
    expect(res.refund_id).toMatch(/^re_sim_/)
    expect(res.lines[0].warehouse).toBe('CHI-OAK - MJ')
    expect(__mockOps.serials('CHI-OAK')[s.item.item_code]).toContain(s.serialNo)
    await expect(
      mockApi.returns.return_items({
        invoice: s.invoice,
        lines,
        refund_method: 'cash',
        manager: 'MA-0001',
        manager_pin: '1234'
      })
    ).rejects.toThrow(/nothing left|not sold/)
    // damaged path on a fresh sale
    const s2 = await sell()
    const res2 = await mockApi.returns.return_items({
      invoice: s2.invoice,
      lines: [{ ...lines[0], serial_no: s2.serialNo, condition: 'Damaged' }],
      refund_method: 'cash',
      manager: 'MA-0001',
      manager_pin: '1234'
    })
    expect(res2.lines[0].warehouse).toBe('CHI-OAK Damaged - MJ')
    expect(__mockOps.serials('CHI-OAK')[s2.item.item_code]).not.toContain(s2.serialNo)
  })

  it('manager PIN is required above the threshold and checked', async () => {
    const s = await sell()
    expect(s.total).toBeGreaterThan(RETURNS_POLICY.returns_manager_threshold)
    const lines = [
      {
        item_code: s.item.item_code,
        qty: 1,
        serial_no: s.serialNo,
        reason: 'Defect' as const,
        condition: 'Sellable' as const
      }
    ]
    await expect(
      mockApi.returns.return_items({ invoice: s.invoice, lines, refund_method: 'cash' })
    ).rejects.toMatchObject({ code: 'MANAGER_REQUIRED' })
    await expect(
      mockApi.returns.return_items({
        invoice: s.invoice,
        lines,
        refund_method: 'cash',
        manager: 'MA-0001',
        manager_pin: '0000'
      })
    ).rejects.toMatchObject({ code: 'MANAGER_REQUIRED' })
    await expect(
      mockApi.returns.return_items({
        invoice: s.invoice,
        lines,
        refund_method: 'cash',
        manager: 'MA-0002',
        manager_pin: '1111'
      })
    ).rejects.toMatchObject({ code: 'MANAGER_REQUIRED' })
    const ok = await mockApi.returns.return_items({
      invoice: s.invoice,
      lines,
      refund_method: 'store_credit',
      manager: 'MA-0001',
      manager_pin: '1234'
    })
    expect(ok.refund_method).toBe('Store Credit')
    expect(ok.payments).toHaveLength(0)
  })

  it('partial qty return and store credit', async () => {
    const s = await sell(false)
    const res = await mockApi.returns.return_items({
      invoice: s.invoice,
      lines: [{ item_code: s.item.item_code, qty: 1, reason: 'Sizing', condition: 'Sellable' }],
      refund_method: 'cash'
    })
    expect(Math.abs(res.grand_total)).toBeCloseTo(Math.round(s.rate * 1.1025 * 100) / 100, 2)
    const look = await mockApi.returns.lookup({ invoice: s.invoice })
    expect(look.invoices[0].lines[0].returned_qty).toBe(1)
    expect(look.invoices[0].lines[0].returnable_qty).toBe(1)
    expect((await mockApi.returns.recent('CHI-OAK')).returns[0].name).toBe(res.credit_note)
  })

  it('exchange settles only the difference through Exchange Credit', async () => {
    const s = await sell(false)
    const b = await mockApi.catalog.bootstrap('CHI-OAK')
    const up = [...b.items]
      .filter(
        (i) =>
          !i.has_serial_no &&
          i.is_stock_item !== 0 &&
          (b.stock[i.item_code] ?? 0) > 0 &&
          b.prices[i.item_code] < 2000
      )
      .sort((x, y) => b.prices[y.item_code] - b.prices[x.item_code])[0]
    expect(b.prices[up.item_code]).toBeGreaterThan(s.rate)
    const newTotal = Math.round(b.prices[up.item_code] * 1.1025 * 100) / 100
    const credit = Math.round(s.rate * 1.1025 * 100) / 100
    const x = computeExchange(credit, newTotal)
    await expect(
      mockApi.returns.exchange({
        invoice: s.invoice,
        lines: [{ item_code: s.item.item_code, qty: 1, reason: 'Sizing', condition: 'Sellable' }],
        new_items: [{ item_code: up.item_code, qty: 1, rate: b.prices[up.item_code] }],
        payments: [{ mode_of_payment: 'Card', amount: 1 }]
      })
    ).rejects.toThrow(/do not cover/)
    const res = await mockApi.returns.exchange({
      invoice: s.invoice,
      lines: [{ item_code: s.item.item_code, qty: 1, reason: 'Sizing', condition: 'Sellable' }],
      new_items: [{ item_code: up.item_code, qty: 1, rate: b.prices[up.item_code] }],
      payments: [{ mode_of_payment: 'Card', amount: x.to_collect, stripe_payment_intent: 'pi_sim_x' }]
    })
    expect(res.credit).toBeCloseTo(credit, 2)
    expect(res.new_grand_total).toBeCloseTo(newTotal, 2)
    expect(res.difference).toBeCloseTo(x.difference, 2)
    expect(res.payments).toEqual([{ mode_of_payment: 'Exchange Credit', amount: -credit }])
    expect(res.new_payments.find((p) => p.mode_of_payment === 'Exchange Credit')?.amount).toBeCloseTo(
      credit,
      2
    )
    expect(res.new_payments.find((p) => p.mode_of_payment === 'Card')?.amount).toBeCloseTo(x.to_collect, 2)
    expect(__mockOps.invoices().some((i) => i.invoice === res.new_invoice)).toBe(true)
  })
})
