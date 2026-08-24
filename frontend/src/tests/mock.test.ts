import { beforeEach, describe, expect, it } from 'vitest'
import { mockApi, __resetMock } from '@/api/mock'
import type { POSInvoice } from '@/api/types'

describe('mock API', () => {
  beforeEach(() => __resetMock())

  it('bootstraps 40 items, 20 customers, 3 boutiques, 10.25% tax', async () => {
    const b = await mockApi.catalog.bootstrap('CHI-OAK')
    expect(b.items).toHaveLength(40)
    expect(b.taxes[0].rate).toBe(10.25)
    expect((await mockApi.boutiques())).toHaveLength(3)
    expect(await mockApi.customers.search('', 50)).toHaveLength(20)
  })

  it('is idempotent on offline_uuid and rejects serial conflicts', async () => {
    const b = await mockApi.catalog.bootstrap('CHI-OAK')
    const serial = b.serials['RG-SOL-001'][0]
    const inv: POSInvoice = {
      offline_uuid: 'u1', boutique: 'CHI-OAK', associate: 'MA-0001', device_id: 'd', posting_datetime: new Date().toISOString(),
      items: [{ item_code: 'RG-SOL-001', qty: 1, rate: 12400, serial_no: serial }],
      payments: [{ mode_of_payment: 'Cash', amount: 13671 }]
    }
    const r1 = await mockApi.sales.submit_batch([inv])
    expect(r1.results[0].status).toBe('ok')
    const r2 = await mockApi.sales.submit_batch([inv])
    expect(r2.results[0].status).toBe('duplicate')
    const r3 = await mockApi.sales.submit_batch([{ ...inv, offline_uuid: 'u2' }])
    expect(r3.results[0]).toMatchObject({ status: 'error', error_code: 'SerialConflict' })
  })

  it('fails with NETWORK when offline flag is set', async () => {
    ;(window as any).__awanzOffline = true
    await expect(mockApi.dashboard.heartbeat('CHI-OAK', 'd', 0)).rejects.toMatchObject({ code: 'NETWORK' })
    ;(window as any).__awanzOffline = false
  })
})
