import * as L from './lib-pos.mjs'
import fs from 'node:fs'
const boot = JSON.parse(fs.readFileSync('/tmp/boot.json', 'utf8'))
const admin = await L.adminApi()
const codes = ['ACC-002','ACC-003','ACC-009','ACC-010','ACC-011','ACC-015','ACC-016','HKA-012','HKA-013','HKA-017','DSP-004','DSP-005','DSP-006','DSP-007','DSP-009','DEV-007']
const bins = await admin.list('Bin', { item_code: ['in', codes], warehouse: L.WH }, ['item_code','actual_qty'], 60)
const dmg = await admin.list('Bin', { item_code: ['in', codes], warehouse: 'HOU-MTR Damaged - CCZ' }, ['item_code','actual_qty'], 60)
let drift = 0
for (const b of bins) {
  const was = boot.stock[b.item_code] ?? 0
  const now = Number(b.actual_qty)
  if (was !== now) { drift++; console.log(`${b.item_code}: ${was} -> ${now} (${now-was>0?'+':''}${now-was})`) }
}
console.log('items with drift:', drift, 'of', bins.length)
console.log('damaged warehouse:', JSON.stringify(dmg))
await admin.dispose()
