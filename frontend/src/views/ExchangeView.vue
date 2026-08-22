<script setup lang="ts">
/**
 * v0.4 E — Exchange: the lines picked on the Returns screen become a credit; pick the new pieces,
 * settle the difference (card / cash) or refund the remainder, all in one transaction.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { v4 as uuidv4 } from 'uuid'
import {
  api,
  type ExchangeResult,
  type Item,
  type RefundMethod,
  type ReturnLineRequest,
  type ReturnableInvoice
} from '@/api'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { usePrinterStore } from '@/stores/printer'
import { useSyncStore } from '@/stores/sync'
import { useLayoutStore } from '@/stores/layout'
import { computeExchange, computeReturnTotals, managerRequired } from '@/returns/math'
import { computeTotals } from '@/utils/totals'
import { fmtMoney } from '@/utils/money'
import type { CardResult, TerminalProgress } from '@/payments/terminal'
import ManagerPinModal from '@/components/ManagerPinModal.vue'
import type { ReceiptSnapshot } from '@/db'

const session = useSessionStore()
const catalog = useCatalogStore()
const printer = usePrinterStore()
const sync = useSyncStore()
const layout = useLayoutStore()
const route = useRoute()
const router = useRouter()

const invoice = ref<ReturnableInvoice | null>(null)
const returnLines = ref<ReturnLineRequest[]>([])
const error = ref('')
const busy = ref(false)
const pinOpen = ref(false)
const pinError = ref('')
const result = ref<ExchangeResult | null>(null)
const printed = ref<string | null>(null)

interface NewLine {
  item: Item
  qty: number
  rate: number
  serial_no?: string
}
const newLines = ref<NewLine[]>([])
const search = ref('')
const settle = ref<'card' | 'cash'>('card')
const refundMethod = ref<RefundMethod>('cash')
const progress = ref<TerminalProgress>({ step: 'idle', message: '' })
const offline_uuid = ref(uuidv4())

const credit = computed(() => {
  if (!invoice.value) return { net: 0, tax: 0, total: 0 }
  const lines = returnLines.value.map((r) => {
    const src = invoice.value!.lines.find((l) => l.row === r.row || l.item_code === r.item_code)!
    return { rate: src.rate, qty: r.qty, discount_amount: src.discount_amount, taxable: src.taxable }
  })
  return computeReturnTotals(lines, invoice.value.tax_rate)
})
const newTotals = computed(() =>
  computeTotals(
    newLines.value.map((l) => ({ qty: l.qty, rate: l.rate, taxable: l.item.maison_taxable === 1 })),
    catalog.taxRate
  )
)
const x = computed(() => computeExchange(credit.value.total, newTotals.value.grand_total))
const gate = computed(() =>
  managerRequired({
    credit: credit.value.total,
    threshold: invoice.value?.manager_threshold ?? catalog.settings.returns_manager_threshold,
    daysSince: invoice.value?.days_since ?? 0,
    windowDays: invoice.value?.exchange_window_days ?? catalog.settings.exchange_window_days,
    isManager: session.isManager
  })
)
const usedSerials = computed(
  () => new Set(newLines.value.map((l) => l.serial_no).filter(Boolean) as string[])
)
const matches = computed(() => {
  const s = search.value.trim().toLowerCase()
  const items = catalog.items.filter((i) => !i.disabled)
  const list = s
    ? items.filter(
        (i) =>
          i.item_name.toLowerCase().includes(s) ||
          i.item_code.toLowerCase().includes(s) ||
          (i.maison_barcode || '') === s
      )
    : items
  return list
    .filter(
      (i) =>
        i.is_stock_item === 0 ||
        (i.has_serial_no ? freeSerials(i).length > 0 : (catalog.stock[i.item_code] ?? 0) > 0)
    )
    .slice(0, 24)
})
function freeSerials(i: Item): string[] {
  return (catalog.serials[i.item_code] || []).filter((s) => !usedSerials.value.has(s))
}
function add(i: Item, serial?: string) {
  if (i.has_serial_no) {
    const s = serial || freeSerials(i)[0]
    if (!s) return
    newLines.value.push({ item: i, qty: 1, rate: catalog.rateFor(i.item_code), serial_no: s })
    return
  }
  const existing = newLines.value.find((l) => l.item.item_code === i.item_code)
  if (existing) existing.qty++
  else newLines.value.push({ item: i, qty: 1, rate: catalog.rateFor(i.item_code) })
}
function remove(idx: number) {
  newLines.value.splice(idx, 1)
}

async function confirm(manager?: string, pin?: string) {
  if (!invoice.value || !newLines.value.length || busy.value) return
  if (gate.value.required && !manager) {
    pinOpen.value = true
    return
  }
  busy.value = true
  error.value = ''
  pinError.value = ''
  try {
    let card: CardResult | undefined
    const payments: { mode_of_payment: 'Cash' | 'Card'; amount: number; stripe_payment_intent?: string }[] =
      []
    if (x.value.to_collect > 0) {
      if (settle.value === 'card') {
        card = await printer.terminal().charge({
          boutique: session.boutique!.name,
          amount: Math.round(x.value.to_collect * 100),
          currency: session.currency,
          offline_uuid: offline_uuid.value,
          customer: invoice.value.customer,
          onProgress: (p) => (progress.value = p)
        })
        payments.push({
          mode_of_payment: 'Card',
          amount: x.value.to_collect,
          stripe_payment_intent: card.payment_intent
        })
      } else payments.push({ mode_of_payment: 'Cash', amount: x.value.to_collect })
    }
    result.value = await api.returns.exchange({
      invoice: invoice.value.name,
      lines: returnLines.value,
      new_items: newLines.value.map((l) => ({
        item_code: l.item.item_code,
        qty: l.qty,
        rate: l.rate,
        serial_no: l.serial_no
      })),
      payments,
      refund_method: refundMethod.value,
      reason: returnLines.value[0]?.reason,
      // a manager unlocked on this device approves implicitly (server checks the session role)
      manager: manager || (session.isManager ? session.associate?.name : undefined),
      manager_pin: pin,
      offline_uuid: offline_uuid.value,
      device_id: session.device_id
    })
    pinOpen.value = false
    sync.notify('good', 'Exchange complete', `${result.value.credit_note} → ${result.value.new_invoice}`)
    if (session.boutique) void catalog.bootstrap(session.boutique.name).catch(() => undefined)
  } catch (e) {
    const msg = (e as Error).message
    if ((e as { code?: string }).code === 'MANAGER_REQUIRED' || /manager/i.test(msg)) {
      pinError.value = msg
      pinOpen.value = true
    } else error.value = msg
    progress.value = { step: 'error', message: msg }
  } finally {
    busy.value = false
  }
}

function snapshot(): ReceiptSnapshot | null {
  const r = result.value
  if (!r || !session.boutique || !invoice.value) return null
  return {
    boutique: session.boutique.name,
    boutique_name: session.boutique.boutique_name,
    address_line: session.boutique.address_line,
    city: session.boutique.city,
    phone: session.boutique.phone,
    associate_name: session.associate?.full_name || '',
    customer_name: invoice.value.customer_name,
    receipt_qr_base_url: catalog.receiptQrBase,
    lines: [
      ...r.lines.map((l) => ({
        item_code: l.item_code,
        item_name: `Returned · ${l.item_name}`,
        qty: l.qty,
        rate: l.rate,
        amount: l.amount,
        serial_no: l.serials.join(', ') || undefined
      })),
      ...newLines.value.map((l) => ({
        item_code: l.item.item_code,
        item_name: l.item.item_name,
        qty: l.qty,
        rate: l.rate,
        amount: l.qty * l.rate,
        serial_no: l.serial_no
      }))
    ],
    net_total: newTotals.value.net_total + r.net_total,
    discount: 0,
    total_taxes: newTotals.value.total_taxes + r.total_taxes,
    tax_rate: catalog.taxRate,
    loyalty_amount: 0,
    loyalty_points_redeemed: 0,
    grand_total: r.difference,
    payments: [...r.new_payments, ...r.payments]
      .filter((p) => p.mode_of_payment !== 'Exchange Credit')
      .map((p) => ({
        mode_of_payment: (p.mode_of_payment === 'Card' ? 'Card' : 'Cash') as 'Cash' | 'Card',
        amount: p.amount
      })),
    points_earned: 0,
    currency: invoice.value.currency
  }
}
async function print() {
  const snap = snapshot()
  const r = result.value
  if (!snap || !r) return
  printed.value = await printer.printSnapshot(snap, {
    invoice_name: r.new_invoice,
    offline_uuid: r.new_invoice,
    posting_datetime: new Date().toISOString(),
    receipt_token: r.new_receipt_token || undefined,
    receipt_qr_enabled: catalog.settings.receipt_qr_enabled,
    receipt_qr_base_url: catalog.receiptQrBase,
    kind: 'exchange',
    return_against: r.credit_note
  })
}

onMounted(async () => {
  try {
    returnLines.value = JSON.parse(String(route.query.lines || '[]'))
  } catch {
    returnLines.value = []
  }
  try {
    const res = await api.returns.lookup({ invoice: String(route.params.invoice) })
    invoice.value = res.invoices[0] || null
    if (!invoice.value) error.value = 'Sale not found.'
  } catch (e) {
    error.value = (e as Error).message
  }
})
onBeforeUnmount(() => void printer.terminal().cancel())
</script>

<template>
  <div class="page">
    <div class="page-body">
      <div class="between" style="margin-bottom: 18px">
        <div>
          <div class="page-title">Exchange</div>
          <div class="muted" style="margin-top: 4px; font-size: 13px">
            <span v-if="invoice"
              >Against {{ invoice.name
              }}<span v-if="invoice.customer_name"> · {{ invoice.customer_name }}</span> ·
              {{ invoice.days_since }} days ago</span
            >
            <span v-else>Loading…</span>
          </div>
        </div>
        <button
          class="btn btn-ghost"
          @click="router.push({ name: 'returns', query: { invoice: String(route.params.invoice) } })"
        >
          Back to return
        </button>
      </div>
      <div v-if="error" class="crit" style="font-size: 13px; margin-bottom: 12px">{{ error }}</div>

      <div v-if="!result" class="cols" :class="{ phone: layout.phone }">
        <div class="card block">
          <div class="section-title">New pieces</div>
          <input v-model="search" class="input" placeholder="Search the catalogue" />
          <div class="grid">
            <button v-for="i in matches" :key="i.item_code" class="tile" @click="add(i)">
              <span class="tname ellipsis">{{ i.item_name }}</span>
              <span class="label label-dim"
                >{{ i.item_code
                }}<span v-if="i.has_serial_no">
                  · {{ freeSerials(i).length }} serial{{ freeSerials(i).length === 1 ? '' : 's' }}</span
                ></span
              >
              <span class="num price">{{ fmtMoney(catalog.rateFor(i.item_code), session.currency) }}</span>
            </button>
          </div>
        </div>

        <div class="card block summary">
          <div class="section-title">Returned</div>
          <div v-for="r in returnLines" :key="r.row || r.item_code" class="between trow">
            <span
              >{{ invoice?.lines.find((l) => l.row === r.row)?.item_name || r.item_code }}
              <span class="muted small">× {{ r.qty }} · {{ r.condition }}</span></span
            >
            <span class="num">{{
              fmtMoney((invoice?.lines.find((l) => l.row === r.row)?.rate || 0) * r.qty, session.currency)
            }}</span>
          </div>
          <div class="between trow">
            <span class="label">Credit incl. tax</span
            ><span class="num">{{ fmtMoney(credit.total, session.currency) }}</span>
          </div>

          <div class="section-title">New sale</div>
          <div v-if="!newLines.length" class="label label-dim">Pick pieces from the catalogue</div>
          <div v-for="(l, idx) in newLines" :key="idx" class="between trow">
            <span
              >{{ l.item.item_name }}
              <span class="muted small"
                >× {{ l.qty }}<span v-if="l.serial_no"> · {{ l.serial_no }}</span></span
              ></span
            >
            <span class="row" style="gap: 8px"
              ><span class="num">{{ fmtMoney(l.qty * l.rate, session.currency) }}</span
              ><button class="icon-btn" aria-label="Remove" @click="remove(idx)">×</button></span
            >
          </div>
          <div class="between trow">
            <span class="label">New total incl. tax</span
            ><span class="num">{{ fmtMoney(newTotals.grand_total, session.currency) }}</span>
          </div>
          <div class="hr"></div>
          <div class="between">
            <span class="label">{{
              x.to_collect > 0 ? 'Client pays' : x.to_refund > 0 ? 'Refund to client' : 'Even exchange'
            }}</span>
            <span class="display total" :class="{ good: x.to_refund > 0 }">{{
              fmtMoney(x.to_collect || x.to_refund, session.currency)
            }}</span>
          </div>
          <div v-if="gate.required" class="warn small">
            Manager PIN required ({{
              gate.reason === 'window' ? 'outside the exchange window' : 'above the threshold'
            }}).
          </div>

          <div v-if="x.to_collect > 0" class="seg">
            <button class="chip" :class="{ active: settle === 'card' }" @click="settle = 'card'">
              Card · {{ printer.reader?.label || 'reader' }}
            </button>
            <button class="chip" :class="{ active: settle === 'cash' }" @click="settle = 'cash'">Cash</button>
          </div>
          <div v-else-if="x.to_refund > 0" class="seg">
            <button
              class="chip"
              :class="{ active: refundMethod === 'card' }"
              :disabled="!invoice?.terminal_ref"
              @click="refundMethod = 'card'"
            >
              Original card
            </button>
            <button class="chip" :class="{ active: refundMethod === 'cash' }" @click="refundMethod = 'cash'">
              Cash
            </button>
            <button
              class="chip"
              :class="{ active: refundMethod === 'store_credit' }"
              :disabled="!invoice?.customer"
              @click="refundMethod = 'store_credit'"
            >
              Store credit
            </button>
          </div>
          <div v-if="progress.step !== 'idle'" class="muted small">
            {{ progress.message }}<span v-if="progress.reader"> · {{ progress.reader }}</span>
          </div>
          <button
            class="btn btn-primary btn-big btn-block"
            :disabled="!newLines.length || busy || !invoice"
            @click="confirm()"
          >
            {{
              busy
                ? 'Processing'
                : x.to_collect > 0
                  ? `Charge ${fmtMoney(x.to_collect, session.currency)}`
                  : x.to_refund > 0
                    ? `Exchange & refund ${fmtMoney(x.to_refund, session.currency)}`
                    : 'Complete exchange'
            }}
          </button>
        </div>
      </div>

      <div v-else class="cols" :class="{ phone: layout.phone }">
        <div class="card block">
          <div class="section-title">Exchange complete</div>
          <div class="between trow">
            <span class="label">Credit note</span><span class="num">{{ result.credit_note }}</span>
          </div>
          <div class="between trow">
            <span class="label">New sale</span><span class="num">{{ result.new_invoice }}</span>
          </div>
          <div class="between trow">
            <span class="label">Credit</span
            ><span class="num">{{ fmtMoney(result.credit, session.currency) }}</span>
          </div>
          <div class="between trow">
            <span class="label">New total</span
            ><span class="num">{{ fmtMoney(result.new_grand_total, session.currency) }}</span>
          </div>
          <div class="hr"></div>
          <div class="between">
            <span class="label">{{
              result.difference > 0 ? 'Paid' : result.difference < 0 ? 'Refunded' : 'Even'
            }}</span
            ><span class="display total">{{ fmtMoney(Math.abs(result.difference), session.currency) }}</span>
          </div>
          <div v-if="result.refund_id" class="muted small">
            Stripe refund {{ result.refund_id }}<span v-if="result.simulated_refund"> (simulated)</span>
          </div>
        </div>
        <div class="card block summary">
          <button class="btn btn-primary btn-big btn-block" :disabled="printer.printing" @click="print">
            {{ printer.printing ? 'Printing' : printed ? 'Print again' : 'Print receipt' }}
          </button>
          <div v-if="printed" class="good small">
            {{
              printed === 'reader'
                ? `Printed on ${printer.reader?.label}`
                : printed === 'epos'
                  ? 'Sent to printer'
                  : 'Opened print dialog'
            }}
          </div>
          <button class="btn btn-block" @click="router.push({ name: 'returns' })">Another return</button>
          <button class="btn btn-ghost btn-block" @click="router.push({ name: 'sell' })">Back to Sell</button>
        </div>
      </div>
    </div>
    <ManagerPinModal
      v-if="pinOpen"
      :reason="
        gate.reason === 'window'
          ? `This sale is outside the ${invoice?.exchange_window_days}-day exchange window.`
          : `Exchange credit ${fmtMoney(credit.total, session.currency)} is above the manager threshold.`
      "
      :busy="busy"
      :error="pinError"
      @close="pinOpen = false"
      @approve="(m, p) => confirm(m, p)"
    />
  </div>
</template>

<style scoped>
.cols {
  display: grid;
  grid-template-columns: 1fr 380px;
  gap: 16px;
}
.cols.phone {
  grid-template-columns: 1fr;
}
.block {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(170px, 1fr));
  gap: var(--line-w);
  background: var(--line);
  border: var(--line-w) solid var(--line);
}
.tile {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  min-height: 96px;
  background: var(--surface);
  color: var(--text);
  text-align: left;
}
.tile:active {
  background: var(--surface-2);
}
.tname {
  font-weight: 500;
  font-size: 13px;
}
.price {
  margin-top: auto;
  color: var(--accent);
}
.trow {
  font-size: 14px;
}
.small {
  font-size: 12px;
}
.total {
  font-size: 24px;
  color: var(--accent);
}
.seg {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
@media (max-width: 767px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
