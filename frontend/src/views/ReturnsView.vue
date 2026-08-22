<script setup lang="ts">
/**
 * v0.4 E — Returns: find the sale (receipt QR / invoice no / client), pick lines + qty + reason +
 * condition, choose the refund (original card, cash, store credit) or switch to an exchange.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  api,
  ApiError,
  RETURN_CONDITIONS,
  RETURN_REASONS,
  type RefundMethod,
  type ReturnCondition,
  type ReturnReason,
  type ReturnResult,
  type ReturnableInvoice,
  type ReturnableLine
} from '@/api'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { usePrinterStore } from '@/stores/printer'
import { useSyncStore } from '@/stores/sync'
import { useLayoutStore } from '@/stores/layout'
import { computeReturnTotals, managerRequired } from '@/returns/math'
import { fmtMoney } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'
import ManagerPinModal from '@/components/ManagerPinModal.vue'
import { useScanStore } from '@/stores/scan'
import type { ReceiptSnapshot } from '@/db'

const session = useSessionStore()
const catalog = useCatalogStore()
const printer = usePrinterStore()
const sync = useSyncStore()
const layout = useLayoutStore()
const scan = useScanStore()
const route = useRoute()
const router = useRouter()

type Step = 'find' | 'lines' | 'refund' | 'done'
const step = ref<Step>('find')
const q = ref('')
const searching = ref(false)
const error = ref('')
const results = ref<ReturnableInvoice[]>([])
const invoice = ref<ReturnableInvoice | null>(null)

interface Pick {
  on: boolean
  qty: number
  serials: string[]
  reason: ReturnReason
  condition: ReturnCondition
}
const picks = reactive<Record<string, Pick>>({})
const refundMethod = ref<RefundMethod>('cash')
const busy = ref(false)
const pinOpen = ref(false)
const pinError = ref('')
const result = ref<ReturnResult | null>(null)
const printed = ref<string | null>(null)

function initPicks(inv: ReturnableInvoice) {
  for (const k of Object.keys(picks)) delete picks[k]
  for (const l of inv.lines)
    picks[l.row] = {
      on: false,
      qty: l.returnable_qty > 0 ? (l.serials.length ? 0 : 1) : 0,
      serials: [],
      reason: 'Change of mind',
      condition: 'Sellable'
    }
  refundMethod.value = inv.terminal_ref ? 'card' : 'cash'
}

const selected = computed(() =>
  invoice.value
    ? invoice.value.lines.filter(
        (l) => picks[l.row]?.on && (picks[l.row].serials.length || picks[l.row].qty > 0)
      )
    : []
)
const totals = computed(() =>
  computeReturnTotals(
    selected.value.map((l) => ({
      rate: l.rate,
      qty: l.serials.length ? picks[l.row].serials.length : picks[l.row].qty,
      discount_amount: l.discount_amount,
      taxable: l.taxable
    })),
    invoice.value?.tax_rate ?? catalog.taxRate
  )
)
const gate = computed(() =>
  managerRequired({
    credit: totals.value.total,
    threshold: invoice.value?.manager_threshold ?? catalog.settings.returns_manager_threshold,
    daysSince: invoice.value?.days_since ?? 0,
    windowDays: invoice.value?.return_window_days ?? catalog.settings.return_window_days,
    isManager: session.isManager
  })
)
const cardPaid = computed(
  () =>
    invoice.value?.payments.filter((p) => p.mode_of_payment !== 'Cash').reduce((s, p) => s + p.amount, 0) || 0
)

async function find(arg?: { token?: string; invoice?: string; q?: string }) {
  error.value = ''
  searching.value = true
  results.value = []
  try {
    const args = arg || parseQuery(q.value)
    if (!args) return
    const res = await api.returns.lookup(args)
    results.value = res.invoices
    if (!res.invoices.length) error.value = 'No sale found.'
    else if (res.invoices.length === 1) choose(res.invoices[0])
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    searching.value = false
  }
}
/** A receipt URL / token, an invoice number or a client name/phone/number. */
function parseQuery(raw: string): { token?: string; invoice?: string; q?: string } | null {
  const s = raw.trim()
  if (!s) return null
  if (s.includes('/r/')) return { token: s }
  if (/^INV:/i.test(s)) return { token: s.slice(4) }
  if (/^[A-Z]{2,5}-[A-Z0-9-]+\d{3,}$/i.test(s) && !/^MC/i.test(s)) return { invoice: s }
  return { q: s }
}
function choose(inv: ReturnableInvoice) {
  invoice.value = inv
  initPicks(inv)
  step.value = 'lines'
}
function onScan(code: string) {
  scan.closeSheet()
  q.value = code
  void find()
}
let uncapture: (() => void) | null = null
onMounted(() => {
  uncapture = scan.captureRaw(onScan)
})
onBeforeUnmount(() => uncapture?.())
function toggleLine(l: ReturnableLine) {
  if (l.returnable_qty <= 0) return
  const p = picks[l.row]
  p.on = !p.on
  if (p.on && l.serials.length && !p.serials.length) p.serials = [...l.returnable_serials]
}
function toggleSerial(l: ReturnableLine, s: string) {
  const p = picks[l.row]
  p.serials = p.serials.includes(s) ? p.serials.filter((x) => x !== s) : [...p.serials, s]
  p.on = p.serials.length > 0
}
function setQty(l: ReturnableLine, d: number) {
  const p = picks[l.row]
  p.qty = Math.max(0, Math.min(l.returnable_qty, p.qty + d))
  p.on = p.qty > 0
}

function lineRequests() {
  return selected.value.map((l) => {
    const p = picks[l.row]
    return {
      row: l.row,
      item_code: l.item_code,
      qty: l.serials.length ? p.serials.length : p.qty,
      serial_no: p.serials.length ? p.serials.join('\n') : undefined,
      reason: p.reason,
      condition: p.condition
    }
  })
}

async function submit(manager?: string, pin?: string) {
  if (!invoice.value || !selected.value.length || busy.value) return
  if (gate.value.required && !manager) {
    pinOpen.value = true
    return
  }
  busy.value = true
  error.value = ''
  pinError.value = ''
  try {
    result.value = await api.returns.return_items({
      invoice: invoice.value.name,
      lines: lineRequests(),
      refund_method: refundMethod.value,
      reason: selected.value.length ? picks[selected.value[0].row].reason : undefined,
      // a manager unlocked on this device approves implicitly (server checks the session role)
      manager: manager || (session.isManager ? session.associate?.name : undefined),
      manager_pin: pin,
      device_id: session.device_id
    })
    pinOpen.value = false
    step.value = 'done'
    sync.notify(
      'good',
      'Return complete',
      `${result.value.credit_note} · ${fmtMoney(Math.abs(result.value.grand_total), session.currency)}`
    )
  } catch (e) {
    const code = (e as ApiError).code
    if (code === 'MANAGER_REQUIRED' || /manager/i.test((e as Error).message)) {
      pinError.value = (e as Error).message
      pinOpen.value = true
    } else error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function goExchange() {
  if (!invoice.value || !selected.value.length) return
  router.push({
    name: 'exchange',
    params: { invoice: invoice.value.name },
    query: { lines: JSON.stringify(lineRequests()) }
  })
}

function snapshot(): ReceiptSnapshot | null {
  const r = result.value
  const inv = invoice.value
  if (!r || !inv || !session.boutique) return null
  return {
    boutique: session.boutique.name,
    boutique_name: session.boutique.boutique_name,
    address_line: session.boutique.address_line,
    city: session.boutique.city,
    phone: session.boutique.phone,
    associate_name: session.associate?.full_name || '',
    customer_name: inv.customer_name,
    receipt_qr_base_url: catalog.receiptQrBase,
    lines: r.lines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      rate: l.rate,
      amount: l.amount,
      serial_no: l.serials.join(', ') || undefined
    })),
    net_total: r.net_total,
    discount: 0,
    total_taxes: r.total_taxes,
    tax_rate: inv.tax_rate,
    loyalty_amount: 0,
    loyalty_points_redeemed: 0,
    grand_total: r.grand_total,
    payments: r.payments.map((p) => ({
      mode_of_payment: (p.mode_of_payment === 'Card' ? 'Card' : 'Cash') as 'Cash' | 'Card',
      amount: p.amount,
      card_brand: p.mode_of_payment === 'Card' ? inv.card_brand || undefined : undefined,
      last4: p.mode_of_payment === 'Card' ? inv.card_last4 || undefined : undefined
    })),
    points_earned: 0,
    currency: inv.currency
  }
}
async function print() {
  const snap = snapshot()
  const r = result.value
  if (!snap || !r) return
  printed.value = await printer.printSnapshot(snap, {
    invoice_name: r.credit_note,
    offline_uuid: r.credit_note,
    posting_datetime: new Date().toISOString(),
    receipt_token: r.receipt_token || undefined,
    receipt_qr_enabled: catalog.settings.receipt_qr_enabled,
    receipt_qr_base_url: catalog.receiptQrBase,
    kind: 'return',
    return_against: r.return_against,
    refund_method: r.refund_method || undefined,
    store_credit: r.refund_method === 'Store Credit' ? Math.abs(r.grand_total) : 0
  })
}
function reset() {
  step.value = 'find'
  invoice.value = null
  result.value = null
  results.value = []
  q.value = ''
  printed.value = null
}

onMounted(() => {
  const inv = route.query.invoice as string | undefined
  const token = route.query.token as string | undefined
  if (inv) void find({ invoice: inv })
  else if (token) void find({ token })
})
watch(
  () => route.query.invoice,
  (v) => v && void find({ invoice: String(v) })
)
</script>

<template>
  <div class="page">
    <div class="page-body">
      <div class="between" style="margin-bottom: 18px">
        <div>
          <div class="page-title">Returns</div>
          <div class="muted" style="margin-top: 4px; font-size: 13px">
            {{ session.boutique?.boutique_name }} · refunds within
            {{ catalog.settings.return_window_days }} days · manager above
            {{ fmtMoney(catalog.settings.returns_manager_threshold, session.currency) }}
          </div>
        </div>
        <div class="steps label">
          <span :class="{ on: step === 'find' }">1 Find</span>
          <span :class="{ on: step === 'lines' }">2 Items</span>
          <span :class="{ on: step === 'refund' }">3 Refund</span>
          <span :class="{ on: step === 'done' }">4 Done</span>
        </div>
      </div>

      <!-- 1. find -->
      <div v-if="step === 'find'" class="card block find">
        <div class="section-title">Find the sale</div>
        <div class="row">
          <input
            v-model="q"
            class="input"
            placeholder="Scan receipt QR · invoice no · client name / phone / №"
            autofocus
            @keydown.enter="find()"
          />
          <button class="btn" :disabled="searching || !q.trim()" @click="find()">
            {{ searching ? 'Searching' : 'Find' }}
          </button>
          <button v-if="catalog.settings.scan_enabled" class="btn btn-ghost" @click="scan.openSheet('raw')">
            Scan
          </button>
        </div>
        <div v-if="error" class="crit" style="font-size: 13px">{{ error }}</div>
        <div
          v-if="results.length > 1"
          class="stack"
          style="gap: var(--line-w); background: var(--line); border: var(--line-w) solid var(--line)"
        >
          <button v-for="r in results" :key="r.name" class="result between" @click="choose(r)">
            <span>
              <span class="num">{{ r.name }}</span>
              <span class="muted" style="margin-left: 10px">{{ fmtDateTime(r.posting_datetime) }}</span>
              <span v-if="r.customer_name" class="muted"> · {{ r.customer_name }}</span>
            </span>
            <span class="num"
              >{{ fmtMoney(r.grand_total, r.currency)
              }}<span v-if="r.fully_returned" class="pill pill-warn" style="margin-left: 10px"
                >Returned</span
              ></span
            >
          </button>
        </div>
        <div class="label label-dim">
          The receipt QR, the invoice number (e.g. ACC-SINV-2026-00012) or the client (name, phone, client №)
          all work.
        </div>
      </div>

      <!-- 2 + 3. lines & refund -->
      <div v-else-if="invoice && step !== 'done'" class="cols" :class="{ phone: layout.phone }">
        <div class="card block">
          <div class="between">
            <div>
              <div class="section-title">{{ invoice.name }}</div>
              <div class="muted" style="font-size: 13px">
                {{ fmtDateTime(invoice.posting_datetime) }} · {{ invoice.days_since }} day{{
                  invoice.days_since === 1 ? '' : 's'
                }}
                ago
                <span v-if="invoice.customer_name"> · {{ invoice.customer_name }}</span>
              </div>
            </div>
            <span class="pill" :class="invoice.within_return_window ? 'pill-good' : 'pill-warn'">{{
              invoice.within_return_window ? 'In window' : 'Outside window'
            }}</span>
          </div>
          <div class="lines">
            <div
              v-for="l in invoice.lines"
              :key="l.row"
              class="line"
              :class="{ on: picks[l.row]?.on, off: l.returnable_qty <= 0 }"
            >
              <button class="line-head between" :disabled="l.returnable_qty <= 0" @click="toggleLine(l)">
                <span>
                  <span class="check" :class="{ on: picks[l.row]?.on }"></span>
                  <span class="name">{{ l.item_name }}</span>
                  <span class="muted small"> · {{ l.item_code }}</span>
                  <span v-if="l.returned_qty" class="pill pill-warn small-pill"
                    >{{ l.returned_qty }} returned</span
                  >
                </span>
                <span class="num"
                  >{{ fmtMoney(l.rate, invoice.currency)
                  }}<span v-if="l.qty !== 1" class="muted"> × {{ l.qty }}</span></span
                >
              </button>
              <div v-if="picks[l.row]?.on" class="line-body">
                <div v-if="l.serials.length" class="serials">
                  <button
                    v-for="s in l.returnable_serials"
                    :key="s"
                    class="chip"
                    :class="{ active: picks[l.row].serials.includes(s) }"
                    @click="toggleSerial(l, s)"
                  >
                    {{ s }}
                  </button>
                </div>
                <div v-else class="qty row">
                  <span class="label">Qty</span>
                  <button class="btn" @click="setQty(l, -1)">−</button>
                  <span class="num big">{{ picks[l.row].qty }}</span>
                  <button class="btn" @click="setQty(l, 1)">+</button>
                  <span class="muted small">of {{ l.returnable_qty }}</span>
                </div>
                <div class="row wrap">
                  <div class="field grow">
                    <label class="label">Reason</label>
                    <select v-model="picks[l.row].reason" class="input">
                      <option v-for="r in RETURN_REASONS" :key="r" :value="r">{{ r }}</option>
                    </select>
                  </div>
                  <div class="field">
                    <label class="label">Condition</label>
                    <div class="seg">
                      <button
                        v-for="c in RETURN_CONDITIONS"
                        :key="c"
                        class="chip"
                        :class="{
                          active: picks[l.row].condition === c,
                          crit: c === 'Damaged' && picks[l.row].condition === c
                        }"
                        @click="picks[l.row].condition = c"
                      >
                        {{ c }}
                      </button>
                    </div>
                  </div>
                </div>
                <div v-if="picks[l.row].condition === 'Damaged' && l.is_stock_item" class="label label-dim">
                  Goes to the {{ session.boutique?.name }} Damaged warehouse, not back on the floor.
                </div>
              </div>
            </div>
          </div>
          <div class="row">
            <button class="btn btn-ghost" @click="reset">Back</button>
          </div>
        </div>

        <div class="card block summary">
          <div class="section-title">Credit</div>
          <div class="between trow">
            <span class="label">Items</span><span class="num">{{ selected.length }}</span>
          </div>
          <div class="between trow">
            <span class="label">Subtotal</span
            ><span class="num">{{ fmtMoney(totals.net, invoice.currency) }}</span>
          </div>
          <div class="between trow">
            <span class="label">Tax {{ invoice.tax_rate }}%</span
            ><span class="num">{{ fmtMoney(totals.tax, invoice.currency) }}</span>
          </div>
          <div class="hr"></div>
          <div class="between">
            <span class="label">Refund</span
            ><span class="display total">{{ fmtMoney(totals.total, invoice.currency) }}</span>
          </div>
          <div v-if="gate.required" class="warn small">
            Manager PIN required —
            {{
              gate.reason === 'window'
                ? `sale is ${invoice.days_since} days old (policy ${invoice.return_window_days})`
                : `above ${fmtMoney(invoice.manager_threshold, invoice.currency)}`
            }}
          </div>

          <div class="section-title" style="margin-top: 8px">Refund to</div>
          <div class="methods">
            <button
              class="method"
              :class="{ on: refundMethod === 'card' }"
              :disabled="!invoice.terminal_ref || totals.total > cardPaid + 0.005"
              @click="refundMethod = 'card'"
            >
              <span class="label">Original card</span>
              <span class="muted small">{{
                invoice.terminal_ref
                  ? `${invoice.card_brand || 'Card'} •••• ${invoice.card_last4 || ''}`
                  : 'not a card sale'
              }}</span>
            </button>
            <button class="method" :class="{ on: refundMethod === 'cash' }" @click="refundMethod = 'cash'">
              <span class="label">Cash</span><span class="muted small">from the drawer</span>
            </button>
            <button
              class="method"
              :class="{ on: refundMethod === 'store_credit' }"
              @click="refundMethod = 'store_credit'"
            >
              <span class="label">Store credit</span
              ><span class="muted small">{{
                invoice.customer_name ? 'on the client account' : 'needs a client'
              }}</span>
            </button>
          </div>
          <div v-if="error" class="crit small">{{ error }}</div>
          <button
            class="btn btn-primary btn-big btn-block"
            :disabled="!selected.length || busy || (refundMethod === 'store_credit' && !invoice.customer)"
            @click="submit()"
          >
            {{
              busy
                ? 'Processing'
                : gate.required
                  ? 'Refund with manager PIN'
                  : 'Refund ' + fmtMoney(totals.total, invoice.currency)
            }}
          </button>
          <button class="btn btn-block" :disabled="!selected.length || busy" @click="goExchange">
            Exchange instead
          </button>
        </div>
      </div>

      <!-- 4. done -->
      <div v-else-if="result && invoice" class="cols" :class="{ phone: layout.phone }">
        <div class="card block">
          <div class="section-title">Credit note {{ result.credit_note }}</div>
          <div class="between trow">
            <span class="label">Against</span><span class="num">{{ result.return_against }}</span>
          </div>
          <div v-for="l in result.lines" :key="l.item_code + l.serials.join()" class="between trow">
            <span
              >{{ l.item_name }}
              <span class="muted small"
                >× {{ Math.abs(l.qty) }} · {{ l.condition
                }}<span v-if="l.serials.length"> · {{ l.serials.join(', ') }}</span></span
              ></span
            >
            <span class="num">{{ fmtMoney(Math.abs(l.amount), invoice.currency) }}</span>
          </div>
          <div class="hr"></div>
          <div class="between">
            <span class="label">Refunded · {{ result.refund_method }}</span
            ><span class="display total">{{ fmtMoney(Math.abs(result.grand_total), invoice.currency) }}</span>
          </div>
          <div v-if="result.refund_id" class="muted small">
            Stripe refund {{ result.refund_id }}<span v-if="result.simulated_refund"> (simulated)</span>
          </div>
          <div v-if="result.refund_method === 'Store Credit'" class="muted small">
            Credit stays on {{ invoice.customer_name }}'s account.
          </div>
          <div v-if="result.manager_approved_by" class="muted small">
            Approved by {{ result.manager_approved_by }}
          </div>
        </div>
        <div class="card block summary">
          <button class="btn btn-primary btn-big btn-block" :disabled="printer.printing" @click="print">
            {{ printer.printing ? 'Printing' : printed ? 'Print again' : 'Print return receipt' }}
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
          <div v-if="printer.lastError" class="warn small">{{ printer.lastError }}</div>
          <button class="btn btn-block" @click="reset">New return</button>
          <button class="btn btn-ghost btn-block" @click="router.push({ name: 'sell' })">Back to Sell</button>
        </div>
      </div>
    </div>

    <ManagerPinModal
      v-if="pinOpen"
      :reason="
        gate.reason === 'window'
          ? `This sale is ${invoice?.days_since} days old (policy ${invoice?.return_window_days} days).`
          : `Refund ${fmtMoney(totals.total, session.currency)} is above the manager threshold.`
      "
      :busy="busy"
      :error="pinError"
      @close="pinOpen = false"
      @approve="(m, p) => submit(m, p)"
    />
  </div>
</template>

<style scoped>
.steps {
  display: flex;
  gap: 18px;
}
.steps span {
  color: var(--dim);
}
.steps span.on {
  color: var(--accent);
}
.find,
.block {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.result {
  padding: 12px 14px;
  background: var(--surface);
  text-align: left;
  color: var(--text);
  min-height: var(--touch);
}
.result:active {
  background: var(--surface-2);
}
.cols {
  display: grid;
  grid-template-columns: 1fr 360px;
  gap: 16px;
}
.cols.phone {
  grid-template-columns: 1fr;
}
.lines {
  display: flex;
  flex-direction: column;
  gap: var(--line-w);
  background: var(--line);
  border: var(--line-w) solid var(--line);
}
.line {
  background: var(--surface);
}
.line.off {
  opacity: 0.45;
}
.line.on {
  background: var(--surface-2);
}
.line-head {
  width: 100%;
  min-height: var(--touch);
  padding: 10px 14px;
  color: var(--text);
  text-align: left;
  gap: 12px;
}
.line-head .name {
  font-weight: 500;
}
.check {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: var(--line-w) solid var(--line-strong);
  margin-right: 10px;
  vertical-align: -2px;
}
.check.on {
  background: var(--accent);
  border-color: var(--accent);
}
.line-body {
  padding: 0 14px 14px 38px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.serials {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.qty .big {
  font-size: 20px;
  min-width: 32px;
  text-align: center;
}
.row.wrap {
  flex-wrap: wrap;
  align-items: flex-end;
}
.grow {
  flex: 1 1 200px;
}
.seg {
  display: flex;
  gap: 4px;
}
.chip.crit {
  border-color: var(--crit);
  color: var(--crit);
}
.small {
  font-size: 12px;
}
.small-pill {
  margin-left: 10px;
  height: 20px;
}
.trow {
  font-size: 14px;
}
.total {
  font-size: 24px;
  color: var(--accent);
}
.methods {
  display: flex;
  flex-direction: column;
  gap: var(--line-w);
  background: var(--line);
  border: var(--line-w) solid var(--line);
}
.method {
  display: flex;
  justify-content: space-between;
  align-items: center;
  min-height: var(--touch);
  padding: 10px 14px;
  background: var(--surface);
  color: var(--text);
  text-align: left;
}
.method.on {
  background: var(--accent-soft);
  box-shadow: inset 3px 0 0 var(--accent);
}
.method:disabled {
  opacity: 0.4;
}
@media (max-width: 767px) {
  .cols {
    grid-template-columns: 1fr;
  }
  .steps {
    display: none;
  }
}
</style>
