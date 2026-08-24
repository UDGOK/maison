<script setup lang="ts">
/**
 * v1.0 §E — receiving a vendor delivery at the warehouse.
 *
 * The sibling of `CountSheet`: scan a barcode or tap +/− to count, but with the three things a
 * purchase receipt needs and a stock transfer does not —
 *
 *   · **an editable unit cost per line** (client decision 4), pre-filled with the PO rate and
 *     labelled as an override so nobody moves a cost by accident,
 *   · **freight on the receipt** (decision 3), which lands in valuation, with its per-unit share,
 *   · **a moving-average preview** (decision 1) — "cost moves $9.34 → $9.31" — so the manager sees
 *     what two vendors at two costs are doing to the item's value *before* the receipt is posted.
 *
 * "This is the whole delivery" is `final`: it closes the order and raises a Short for anything
 * missing. Off (the default — vendor orders arrive in parts) it is a partial receipt that raises
 * nothing.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ReceiveLineInput, StockRow } from '@/api/purchasing'
import { usePurchasingStore } from '@/stores/purchasing'
import { receiveVariance } from '@/warehouse/buying'
import {
  acceptedQty,
  acceptedUnits,
  atNoon,
  effectiveRate,
  isOverridden,
  maPreview,
  matchLine,
  receiptFreightForLine,
  receiptFreightShare,
  receiveOutcome,
  varianceLabel,
  varianceTone,
  type CountedLine,
  type MovingAveragePreview
} from '@/warehouse/inbound'
import { installWedgeListener } from '@/scan/wedge'
import { fmtMoney } from '@/utils/money'
import { fmtDate } from '@/utils/device'
import Modal from '@/components/Modal.vue'

const props = defineProps<{ po: string }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; received: [] }>()

const store = usePurchasingStore()

/** Counted quantities, keyed by Purchase Order Item row — exactly `CountSheet`'s shape. */
const received = ref<Record<string, number>>({})
const damaged = ref<Record<string, number>>({})
/** The cost override is held as text so a half-typed "9." does not fight the input. */
const rateText = ref<Record<string, string>>({})
const freightText = ref('')
const final = ref(false)
const notes = ref('')
const manual = ref('')
const lastScan = ref<{ code: string; ok: boolean } | null>(null)
const confirming = ref(false)
const result = ref<string | null>(null)
let seeded = false

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}
function parseText(text: string | undefined, fallback: number | null): number | null {
  if (text == null || String(text).trim() === '') return fallback
  const n = Number(text)
  return Number.isFinite(n) ? n : fallback
}

const order = computed(() => store.inbound?.expected.find((o) => o.name === props.po) ?? null)
const vendor = computed(() => order.value?.supplier_name || order.value?.supplier || '')
const stockByCode = computed(() => {
  const map: Record<string, StockRow> = {}
  for (const row of store.stock) map[row.item_code] = row
  return map
})

interface SheetLine extends CountedLine {
  key: string
  item_code: string
  item_name: string
  barcode: string | null
  image: string | null
  ordered: number
  already: number
}

/** The counted lines — the pure input to every figure below. */
const lines = computed<SheetLine[]>(() =>
  (order.value?.items || []).map((l) => ({
    key: l.name,
    item_code: l.item_code,
    item_name: l.item_name || l.item_code,
    barcode: l.barcode ?? null,
    image: stockByCode.value[l.item_code]?.image ?? null,
    ordered: num(l.qty),
    already: num(l.received_qty),
    pending_qty: num(l.pending_qty),
    received_qty: num(received.value[l.name]),
    damaged_qty: num(damaged.value[l.name]),
    po_rate: num(l.rate),
    rate: parseText(rateText.value[l.name], null)
  }))
)

const freight = computed(() => num(parseText(freightText.value, order.value?.freight ?? 0)))
const freightShare = computed(() => receiptFreightShare(lines.value, freight.value))
const unitsIn = computed(() => acceptedUnits(lines.value))

/** One render model per line: tone, chip, override delta and the moving-average preview. */
interface SheetRow extends SheetLine {
  tone: string
  chip: string
  overridden: boolean
  booked: number
  landed: number
  over: number
  preview: MovingAveragePreview | null
}
const rows = computed<SheetRow[]>(() =>
  lines.value.map((line, i) => {
    // Freight is allocated **by line amount**, the way ERPNext distributes an Actual + Valuation
    // charge — not evenly per unit. A cheap line and an expensive one do not carry the same
    // freight, and previewing it as if they did put this figure ~7% out on a mixed receipt.
    const share = receiptFreightForLine(lines.value, freight.value, i)
    return {
      ...line,
      tone: varianceTone(line, final.value),
      chip: varianceLabel(line, final.value),
      overridden: isOverridden(line),
      booked: effectiveRate(line),
      landed: effectiveRate(line) + share,
      over: receiveVariance(line).over,
      preview: maPreview(stockByCode.value[line.item_code], line, share)
    }
  })
)

const countedUnits = computed(() => lines.value.reduce((s, l) => s + l.received_qty, 0))
const damagedUnits = computed(() => lines.value.reduce((s, l) => s + num(l.damaged_qty), 0))
const goodsValue = computed(() => lines.value.reduce((s, l) => s + acceptedQty(l) * effectiveRate(l), 0))
const overrides = computed(() => rows.value.filter((r) => r.overridden).length)
const overRows = computed(() => rows.value.filter((r) => r.over > 0))
const outstandingAfter = computed(() => lines.value.reduce((s, l) => s + Math.max(0, l.pending_qty - l.received_qty), 0))
const touched = computed(() => lines.value.some((l) => l.received_qty > 0 || num(l.damaged_qty) > 0))
const posting = computed(() => store.busy === props.po)
const canPost = computed(() => (touched.value || final.value) && !posting.value)
const needsConfirm = computed(() => overRows.value.length > 0 || (final.value && outstandingAfter.value > 0))

// ------------------------------------------------------------------ counting
function bump(key: string, delta: number, kind: 'received' | 'damaged' = 'received') {
  const bag = kind === 'received' ? received : damaged
  bag.value[key] = Math.max(0, num(bag.value[key]) + delta)
}
function fillAll() {
  for (const line of lines.value) received.value[line.key] = line.pending_qty
}
function clearAll() {
  for (const line of lines.value) {
    received.value[line.key] = 0
    damaged.value[line.key] = 0
  }
}
function resetCost(key: string, poRate: number) {
  rateText.value[key] = poRate.toFixed(2)
}

/** One scan = one unit on the line that owns the barcode. Exposed so the board can hand its scan on. */
function onCode(code: string) {
  const i = matchLine(lines.value, code)
  if (i >= 0) {
    const key = lines.value[i].key
    received.value[key] = num(received.value[key]) + 1
  }
  lastScan.value = { code, ok: i >= 0 }
}
function submitManual() {
  if (!manual.value.trim()) return
  onCode(manual.value)
  manual.value = ''
}

// ------------------------------------------------------------------ posting
function attempt() {
  if (needsConfirm.value && !confirming.value) {
    confirming.value = true
    return
  }
  void post()
}
async function post() {
  const who = vendor.value
  const payload: ReceiveLineInput[] = lines.value
    .filter((l) => l.received_qty > 0 || num(l.damaged_qty) > 0 || (final.value && l.pending_qty > 0))
    .map((l) => {
      const row: ReceiveLineInput = { name: l.key, item_code: l.item_code, qty: l.received_qty }
      if (num(l.damaged_qty) > 0) row.damaged_qty = num(l.damaged_qty)
      if (isOverridden(l)) row.rate = effectiveRate(l)
      return row
    })
  const out = await store.receive(props.po, payload, { freight: freight.value, final: final.value, notes: notes.value.trim() || undefined })
  confirming.value = false
  if (!out) return // the store holds the message; the banner shows it
  const outcome = receiveOutcome(out, who)
  store.clearNotice()
  emit('notice', outcome.message)
  emit('received')
  // a `final` receipt that only raised shorts posts nothing — say so in place rather than flashing
  // a success toast for a Purchase Receipt that does not exist
  if (outcome.posted) emit('close')
  else result.value = outcome.message
}

// ------------------------------------------------------------------ lifecycle
function seed() {
  const po = order.value
  if (!po || seeded) return
  for (const line of po.items) {
    if (received.value[line.name] === undefined) received.value[line.name] = 0
    if (damaged.value[line.name] === undefined) damaged.value[line.name] = 0
    if (rateText.value[line.name] === undefined) rateText.value[line.name] = num(line.rate).toFixed(2)
  }
  freightText.value = num(po.freight).toFixed(2)
  seeded = true
}

let uninstall: (() => void) | null = null
onMounted(async () => {
  seed()
  uninstall = installWedgeListener(onCode)
  // the moving-average preview needs on-hand + valuation for these items
  const have = new Set(store.stock.map((r) => r.item_code))
  if ((order.value?.items || []).some((l) => !have.has(l.item_code))) await store.loadStock()
  await nextTick()
  seed()
})
onBeforeUnmount(() => uninstall?.())
watch(order, () => seed())
defineExpose({ onCode, fillAll })
</script>

<template>
  <Modal :title="`Receive ${po}`" width="1080px" @close="emit('close')">
    <!-- the receipt ran but booked nothing -->
    <div v-if="result" class="outcome" data-testid="receive-outcome">
      <div class="section-title warn">Nothing posted</div>
      <p class="muted">{{ result }}</p>
      <p class="label label-dim">The order is closed. The shorts are on the Inbound discrepancies list, against the vendor.</p>
    </div>

    <div v-else-if="!order" class="outcome" data-testid="receive-missing">
      <div class="section-title">This delivery is no longer expected</div>
      <p class="muted">{{ po }} is not on the inbound list — it may already be received, closed or cancelled.</p>
    </div>

    <template v-else>
      <div class="head">
        <div class="head-id">
          <div class="display vendor ellipsis">{{ vendor }}</div>
          <div class="label label-dim">
            {{ order.supplier }} · {{ order.dropship_store ? `drop-ship to ${order.dropship_store}` : order.set_warehouse }} · expected
            {{ fmtDate(atNoon(order.schedule_date)) }} · {{ Math.round(order.per_received) }}% received
          </div>
        </div>
        <div class="head-num">
          <div class="label">On the order</div>
          <div class="num v">{{ order.units }}<span class="label label-dim"> units</span></div>
        </div>
        <div class="head-num">
          <div class="label">Freight on order</div>
          <div class="num v">{{ fmtMoney(order.freight) }}</div>
        </div>
      </div>

      <div v-if="store.error" class="banner crit" data-testid="receive-error">{{ store.error }}</div>

      <div v-if="confirming" class="confirm" data-testid="receive-confirm-panel">
        <div class="section-title warn">Check before posting</div>
        <ul>
          <li v-for="r in overRows" :key="r.key">
            <strong>{{ r.item_code }}</strong> — {{ r.over }} over the outstanding {{ r.pending_qty }}. An Over discrepancy will be raised against {{ vendor }}.
          </li>
          <li v-if="final && outstandingAfter > 0">
            {{ outstandingAfter }} units are still outstanding. Closing the order raises a Short discrepancy against {{ vendor }} for all of them.
          </li>
        </ul>
      </div>

      <div class="scanbar">
        <input v-model="manual" class="input" placeholder="Scan barcode or type item code" data-testid="receive-scan" @keydown.enter.prevent="submitManual" />
        <button class="btn" data-testid="receive-add" @click="submitManual">Add</button>
        <button class="btn btn-ghost" data-testid="receive-fill-all" @click="fillAll">All as expected</button>
        <button class="btn btn-ghost" @click="clearAll">Clear</button>
        <span v-if="lastScan" class="pill" :class="lastScan.ok ? 'pill-good' : 'pill-crit'" data-testid="receive-last-scan">
          {{ lastScan.ok ? 'Counted' : 'Not on this delivery' }} · {{ lastScan.code }}
        </span>
      </div>

      <div class="lines" data-testid="receive-lines">
        <article v-for="row in rows" :key="row.key" class="line" :class="`tone-${row.tone}`" :data-testid="`receive-row-${row.item_code}`" :data-tone="row.tone">
          <div class="ident">
            <div v-if="row.image" class="thumb" aria-hidden="true"><img :src="row.image" alt="" /></div>
            <div class="ident-text">
              <div class="name ellipsis">{{ row.item_name }}</div>
              <div class="label label-dim ellipsis">{{ row.item_code }}<span v-if="row.barcode"> · {{ row.barcode }}</span></div>
              <div class="label label-dim">
                Ordered {{ row.ordered }} · received {{ row.already }} · <span :class="{ warn: row.pending_qty > 0 }">pending {{ row.pending_qty }}</span>
              </div>
            </div>
            <span v-if="row.chip !== '—'" class="pill" :class="`pill-${row.tone}`" :data-testid="`receive-variance-${row.item_code}`">{{ row.chip }}</span>
          </div>

          <div class="controls">
            <div class="ctl">
              <label class="label" :for="`got-${row.key}`">Received</label>
              <div class="stepper">
                <button class="step" :aria-label="`one less ${row.item_code}`" @click="bump(row.key, -1)">−</button>
                <input :id="`got-${row.key}`" v-model.number="received[row.key]" class="input qty" inputmode="numeric" :data-testid="`receive-qty-${row.item_code}`" />
                <button class="step" :aria-label="`one more ${row.item_code}`" :data-testid="`receive-plus-${row.item_code}`" @click="bump(row.key, 1)">+</button>
              </div>
            </div>

            <div class="ctl">
              <label class="label" :for="`dmg-${row.key}`">Damaged</label>
              <div class="stepper">
                <button class="step" :aria-label="`one less damaged ${row.item_code}`" @click="bump(row.key, -1, 'damaged')">−</button>
                <input :id="`dmg-${row.key}`" v-model.number="damaged[row.key]" class="input qty" inputmode="numeric" :data-testid="`receive-damaged-${row.item_code}`" />
                <button class="step" :aria-label="`one more damaged ${row.item_code}`" @click="bump(row.key, 1, 'damaged')">+</button>
              </div>
            </div>

            <div class="ctl">
              <label class="label" :for="`rate-${row.key}`">Unit cost <span class="accent">· override</span></label>
              <div class="stepper">
                <input :id="`rate-${row.key}`" v-model="rateText[row.key]" class="input rate" inputmode="decimal" :data-testid="`receive-rate-${row.item_code}`" />
                <button v-if="row.overridden" class="step wide" :aria-label="`reset cost for ${row.item_code}`" @click="resetCost(row.key, row.po_rate)">↺</button>
              </div>
              <div class="label label-dim">
                PO {{ fmtMoney(row.po_rate) }}
                <span v-if="row.overridden" class="accent"> · {{ row.booked > row.po_rate ? '+' : '−' }}{{ fmtMoney(Math.abs(row.booked - row.po_rate)) }}</span>
                <span v-if="freightShare"> · landed {{ fmtMoney(row.landed) }}</span>
              </div>
            </div>

            <div class="ctl preview">
              <div class="label">Moving average</div>
              <template v-if="row.preview">
                <div class="ma num" :data-testid="`receive-ma-${row.item_code}`">
                  {{ fmtMoney(row.preview.before) }}
                  <span class="arrow" :class="row.preview.after_minus_before > 0 ? 'warn' : row.preview.after_minus_before < 0 ? 'good' : 'muted'">→</span>
                  {{ fmtMoney(row.preview.after) }}
                </div>
                <div class="label label-dim">{{ row.preview.on_hand }} on hand + {{ row.preview.qty }} at {{ fmtMoney(row.preview.landed) }} landed</div>
              </template>
              <div v-else class="label label-dim">
                {{ stockByCode[row.item_code] ? 'count a unit to preview the move' : 'no stock row for this item yet' }}
              </div>
            </div>
          </div>
        </article>
        <div v-if="!rows.length" class="label label-dim empty">This order has no lines.</div>
      </div>

      <div class="foot">
        <div class="foot-grid">
          <div class="field">
            <label class="label" for="receive-freight">Freight on this receipt</label>
            <input id="receive-freight" v-model="freightText" class="input" inputmode="decimal" data-testid="receive-freight" />
            <div class="label label-dim">
              {{
                freightShare
                  ? `${fmtMoney(freightShare)} per unit over ${unitsIn} units received — it lands in valuation`
                  : freight > 0
                    ? 'shares over the units you count — it lands in valuation'
                    : 'no freight — cost lands at the unit price'
              }}
            </div>
          </div>

          <div class="field">
            <span class="label">Delivery</span>
            <button class="toggle" :class="{ on: final }" type="button" :aria-pressed="final" data-testid="receive-final" @click="final = !final">
              <span class="switch" :class="{ on: final }" aria-hidden="true"></span>
              <span class="toggle-text">This is the whole delivery</span>
            </button>
            <div class="label label-dim">
              {{
                final
                  ? 'Closes the order and raises a Short discrepancy against the vendor for anything missing.'
                  : 'Partial receipt — the rest stays on order and nothing is raised.'
              }}
            </div>
          </div>

          <div class="field">
            <label class="label" for="receive-notes">Notes</label>
            <input id="receive-notes" v-model="notes" class="input" placeholder="Pallet damaged in transit, driver noted it" data-testid="receive-notes" />
          </div>
        </div>

        <div class="totals" data-testid="receive-totals">
          <div><span class="label">Counted</span><span class="num">{{ countedUnits }}</span></div>
          <div><span class="label">Into stock</span><span class="num">{{ unitsIn }}</span></div>
          <div><span class="label">Damaged</span><span class="num" :class="{ warn: damagedUnits }">{{ damagedUnits }}</span></div>
          <div><span class="label">Goods</span><span class="num">{{ fmtMoney(goodsValue) }}</span></div>
          <div><span class="label">Landed</span><span class="num accent">{{ fmtMoney(goodsValue + freight) }}</span></div>
          <div v-if="overrides"><span class="label">Cost overrides</span><span class="num accent">{{ overrides }}</span></div>
        </div>
      </div>

    </template>

    <template #footer>
      <template v-if="result || !order">
        <button class="btn btn-primary" data-testid="receive-done" @click="emit('close')">Done</button>
      </template>
      <template v-else>
        <button v-if="confirming" class="btn" data-testid="receive-back" @click="confirming = false">Go back</button>
        <button class="btn btn-primary" :disabled="!canPost" data-testid="receive-post" @click="attempt">
          {{ posting ? 'Posting…' : confirming ? 'Post anyway' : 'Post Purchase Receipt' }}
        </button>
      </template>
    </template>
  </Modal>
</template>

<style scoped>
.head {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  padding-bottom: 14px;
  border-bottom: var(--line-w) solid var(--line);
  margin-bottom: 12px;
}
.head-id {
  min-width: 0;
  flex: 1;
}
.vendor {
  font-size: 18px;
}
.head-num {
  text-align: right;
  flex: 0 0 auto;
}
.head-num .v {
  font-size: 20px;
  margin-top: 2px;
}
.banner {
  padding: 10px 12px;
  border: var(--line-w) solid currentColor;
  margin-bottom: 12px;
}
.scanbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.scanbar .input {
  flex: 1;
  min-width: 200px;
}
.lines {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: min(46vh, 520px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-right: 4px;
}
.empty {
  padding: 24px 0;
  text-align: center;
}
.line {
  border: var(--line-w) solid var(--line);
  border-left: 4px solid var(--line-strong);
  background: var(--surface-2);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.line.tone-good {
  border-left-color: var(--good);
}
.line.tone-warn {
  border-left-color: var(--warn);
}
.line.tone-crit {
  border-left-color: var(--crit);
  background: rgba(196, 115, 106, 0.06);
}
.ident {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.ident-text {
  min-width: 0;
  flex: 1;
}
.name {
  font-size: 15px;
}
.thumb {
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
  overflow: hidden;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.controls {
  display: grid;
  grid-template-columns: auto auto minmax(180px, 1fr) minmax(210px, 1.2fr);
  gap: 12px 18px;
  align-items: start;
}
.ctl {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.step {
  width: var(--touch);
  min-width: var(--touch);
  min-height: var(--touch);
  border: var(--line-w) solid var(--line-strong);
  font-size: 20px;
}
.step.wide {
  font-size: 16px;
}
.qty {
  width: 72px;
  text-align: center;
  min-height: var(--touch);
  padding: 0 6px;
}
.rate {
  width: 110px;
  text-align: right;
  min-height: var(--touch);
  font-variant-numeric: tabular-nums;
}
.preview {
  border-left: var(--line-w) solid var(--line);
  padding-left: 14px;
}
.ma {
  font-size: 17px;
  white-space: nowrap;
}
.arrow {
  padding: 0 4px;
}
.foot {
  margin-top: 14px;
  padding-top: 14px;
  border-top: var(--line-w) solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.foot-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(200px, 1fr));
  gap: 18px;
}
/* the design system's own switch (`styles/base.css`), the way BasketPanel wears it */
.toggle {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: var(--touch);
  width: 100%;
  padding: 0;
  text-align: left;
  color: var(--muted);
}
.toggle.on {
  color: var(--text);
}
.toggle-text {
  min-width: 0;
  font-size: 14px;
}
.totals {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 28px;
}
.totals > div {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.totals .num {
  font-size: 18px;
}
.confirm {
  margin-bottom: 14px;
  padding: 12px 14px;
  border: var(--line-w) solid var(--warn);
  background: rgba(211, 165, 91, 0.08);
}
.confirm ul {
  margin: 8px 0 0;
  padding-left: 18px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.6;
}
.outcome {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 0 4px;
  max-width: 60ch;
}
@media (max-width: 1023px) {
  .controls {
    grid-template-columns: repeat(2, minmax(160px, 1fr));
  }
  .preview {
    grid-column: 1 / -1;
    border-left: 0;
    padding-left: 0;
    border-top: var(--line-w) solid var(--line);
    padding-top: 8px;
  }
  .foot-grid {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 767px) {
  .head {
    flex-wrap: wrap;
    gap: 12px;
  }
  .head-num {
    text-align: left;
  }
  .controls {
    grid-template-columns: 1fr;
  }
  .lines {
    max-height: none;
    overflow: visible;
  }
  .qty,
  .rate {
    flex: 1;
    width: auto;
  }
}
</style>
