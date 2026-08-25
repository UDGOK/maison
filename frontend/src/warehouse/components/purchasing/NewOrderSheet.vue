<script lang="ts">
/**
 * v1.1 §C — **New order**: a purchase order built from scratch.
 *
 * v1.0's Buying screen builds orders from the suggestion list only, so a one-off trial case of
 * something with no reorder level has no path to a vendor. This is that path: pick a vendor, then
 * search or **scan** their catalogue and put quantities against it.
 *
 * Nothing new happens on the server — `create_order` already existed. What was missing was the way
 * in, and `vendor_catalogue` is it: the vendor's items with cost, case pack, MOQ and last purchase
 * rate, searchable by our code, our name, the barcode, or **their** SKU, which is the number
 * printed on the sheet the rep left behind.
 *
 * Quantities default to a **whole case** and the − / + buttons move a case at a time, so nobody
 * orders 7 of something sold in 12s. Rates default from the vendor's own price list and stay
 * editable on every line (client decision 4 of v1.0 — every price is manually overridable).
 * Creating hands the draft to the existing `OrderSheet`, which is where freight, the destination
 * and submitting live.
 */
import type { VendorCatalogueItem } from '@/api/purchasing'

/** One line in the basket. `rate` is held as text so a half-typed "9." does not fight the input. */
export interface BasketLine {
  item_code: string
  item_name: string
  vendor_sku: string | null
  qty: number
  rate: string
  case_pack: number
  moq: number
  on_hand: number
}

export interface BasketTotals {
  lines: number
  units: number
  value: number
}

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

function round(value: number, places = 2): number {
  const f = 10 ** places
  return Math.round((value + Number.EPSILON) * f) / f
}

/** The basket's running totals — lines, units, value at the rates as typed. */
export function basketTotals(lines: BasketLine[]): BasketTotals {
  const rows = (lines || []).filter((l) => num(l.qty) > 0)
  return {
    lines: rows.length,
    units: rows.reduce((sum, l) => sum + num(l.qty), 0),
    value: round(rows.reduce((sum, l) => sum + num(l.qty) * num(l.rate), 0))
  }
}

/** The basket line a catalogue row starts as: a whole case, at the vendor's rate. */
export function lineFromCatalogue(row: VendorCatalogueItem): BasketLine {
  const casePack = Math.max(1, Math.trunc(row.case_pack) || 1)
  return {
    item_code: row.item_code,
    item_name: row.item_name || row.item_code,
    vendor_sku: row.vendor_sku ?? null,
    qty: Math.max(casePack, Math.trunc(row.default_qty) || casePack),
    rate: String(row.rate ?? row.cost ?? 0),
    case_pack: casePack,
    moq: Math.max(0, Math.trunc(row.moq)),
    on_hand: num(row.on_hand)
  }
}

/**
 * What the row says under its name: how it is packed, what the minimum is, and what Houston is
 * already sitting on — the last one is what stops a buyer re-ordering 300 of something.
 */
export function packNote(row: Pick<VendorCatalogueItem, 'case_pack' | 'moq' | 'on_hand' | 'lead_time_days'>): string {
  const parts: string[] = []
  const pack = Math.max(1, Math.trunc(row.case_pack) || 1)
  parts.push(pack > 1 ? `${pack} to a case` : 'sold singly')
  if (row.moq) parts.push(`min ${row.moq}`)
  if (row.lead_time_days) parts.push(`${row.lead_time_days} d lead`)
  parts.push(row.on_hand > 0 ? `${row.on_hand} at Houston` : 'none at Houston')
  return parts.join(' · ')
}

/**
 * A quantity that is not a whole case, or is under the vendor's MOQ. It is a **warning**, not a
 * block: the rep may well have agreed a broken case, and every price and quantity on this screen
 * is the buyer's to set.
 */
export function packWarning(line: Pick<BasketLine, 'qty' | 'case_pack' | 'moq'>): string {
  const qty = num(line.qty)
  if (qty <= 0) return ''
  const pack = Math.max(1, Math.trunc(line.case_pack) || 1)
  if (line.moq && qty < line.moq) return `Under their minimum of ${line.moq}`
  if (pack > 1 && qty % pack !== 0) return `Not a whole case of ${pack}`
  return ''
}
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { purchasingApi, type VendorCatalogueResult } from '@/api/purchasing'
import { usePurchasingStore } from '@/stores/purchasing'
import { installWedgeListener } from '@/scan/wedge'
import { fmtInt, fmtMoney } from '@/utils/money'

const props = defineProps<{ supplier?: string | null; itemCode?: string | null }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; created: [name: string] }>()

const store = usePurchasingStore()

const supplier = ref(props.supplier || '')
const catalogue = ref<VendorCatalogueResult | null>(null)
const basket = ref<BasketLine[]>([])
const q = ref('')
const manual = ref('')
const lastScan = ref<{ code: string; ok: boolean } | null>(null)
const loading = ref(false)
const error = ref('')

const vendors = computed(() => store.vendors.filter((v) => v.active))
const vendor = computed(() => store.vendors.find((v) => v.name === supplier.value) || null)
const rows = computed(() => catalogue.value?.items ?? [])
const visible = computed(() => {
  const needle = q.value.trim().toLowerCase()
  if (!needle) return rows.value
  return rows.value.filter((r) => `${r.item_code} ${r.item_name || ''} ${r.vendor_sku || ''} ${r.barcode || ''}`.toLowerCase().includes(needle))
})
const totals = computed(() => basketTotals(basket.value))
const busy = computed(() => store.busy === 'create-order')
const inBasket = computed(() => new Set(basket.value.map((l) => l.item_code)))

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

async function loadCatalogue() {
  if (!supplier.value) return
  loading.value = true
  error.value = ''
  try {
    catalogue.value = await purchasingApi.vendor_catalogue(supplier.value)
    // "Order it now" arrives with the product the manager just created — put it in the basket
    if (props.itemCode) {
      const row = catalogue.value.items.find((r) => r.item_code === props.itemCode)
      if (row) add(row)
    }
  } catch (e) {
    error.value = (e as Error)?.message || 'That catalogue could not be read'
  } finally {
    loading.value = false
  }
}

function chooseVendor(name: string) {
  supplier.value = name
  basket.value = []
  q.value = ''
  void loadCatalogue()
}

function backToVendors() {
  supplier.value = ''
  catalogue.value = null
  basket.value = []
}

// ------------------------------------------------------------------ the basket
function add(row: VendorCatalogueItem) {
  const seen = basket.value.find((l) => l.item_code === row.item_code)
  if (seen) {
    // a second tap adds another case rather than silently doing nothing
    seen.qty += Math.max(1, seen.case_pack)
    return
  }
  basket.value = [...basket.value, lineFromCatalogue(row)]
}
function drop(itemCode: string) {
  basket.value = basket.value.filter((l) => l.item_code !== itemCode)
}
function bumpCase(line: BasketLine, cases: number) {
  const pack = Math.max(1, line.case_pack)
  line.qty = Math.max(0, line.qty + cases * pack)
  if (line.qty === 0) drop(line.item_code)
}
function setQty(line: BasketLine, value: unknown) {
  line.qty = Math.max(0, Math.trunc(num(value)))
}

// ------------------------------------------------------------------ scanning
function onCode(code: string) {
  const needle = (code || '').trim().toLowerCase()
  if (!needle || !rows.value.length) return
  const row = rows.value.find((r) => (r.barcode || '').toLowerCase() === needle || r.item_code.toLowerCase() === needle || (r.vendor_sku || '').toLowerCase() === needle)
  lastScan.value = { code, ok: !!row }
  if (row) add(row)
}
function submitManual() {
  if (!manual.value.trim()) return
  onCode(manual.value)
  manual.value = ''
}

let uninstall: (() => void) | null = null
onMounted(async () => {
  uninstall = installWedgeListener(onCode)
  if (!store.vendors.length) await store.loadVendors(undefined, true)
  await nextTick()
  if (supplier.value) await loadCatalogue()
})
onBeforeUnmount(() => uninstall?.())
watch(() => props.supplier, (s) => {
  if (s && s !== supplier.value) chooseVendor(s)
})

// ------------------------------------------------------------------ create
async function create() {
  const lines = basket.value.filter((l) => l.qty > 0).map((l) => ({ item_code: l.item_code, qty: l.qty, rate: num(l.rate) }))
  if (!lines.length) {
    error.value = 'Put something in the order first'
    return
  }
  const out = await store.createOrder(supplier.value, lines)
  if (!out) {
    error.value = store.error || 'The order was not created'
    return
  }
  store.clearNotice()
  emit('notice', `Draft ${out.name} created · ${totals.value.units} units from ${vendor.value?.supplier_name || supplier.value}`)
  emit('created', out.name)
}
</script>

<template>
  <Modal :title="supplier ? `New order · ${vendor?.supplier_name || supplier}` : 'New order'" width="1120px" @close="emit('close')">
    <!-- ============================================================ pick a vendor -->
    <div v-if="!supplier" class="sheet" data-testid="new-order-vendors">
      <p class="muted intro">Which vendor is this order going to? Every rate on it comes from their negotiated price list, and stays editable.</p>
      <div v-if="store.loading && !vendors.length" class="empty"><div class="label label-dim">Loading vendors…</div></div>
      <div v-else-if="!vendors.length" class="empty" data-testid="new-order-no-vendors">
        <div class="display" style="font-size: 18px">No active vendor</div>
        <p class="muted">Add a vendor on the Vendors board first — an order needs somebody to send it to.</p>
      </div>
      <div v-else class="vgrid">
        <button v-for="v in vendors" :key="v.name" class="vcard" :data-testid="`new-order-vendor-${v.name}`" @click="chooseVendor(v.name)">
          <span class="vname ellipsis">{{ v.supplier_name }}</span>
          <span class="label label-dim">{{ v.name }} · {{ v.lead_time_days || '?' }} d lead · {{ v.order_method }}</span>
          <span v-if="v.min_order_value" class="label label-dim">Minimum {{ fmtMoney(v.min_order_value) }}</span>
        </button>
      </div>
    </div>

    <!-- ============================================================ their catalogue -->
    <div v-else class="sheet" data-testid="new-order-sheet">
      <div v-if="error" class="banner crit pre" data-testid="new-order-error">{{ error }}</div>

      <div class="scanbar">
        <input v-model="q" class="input" placeholder="Search their catalogue — our code, our name, or their SKU" data-testid="new-order-search" />
        <input v-model="manual" class="input scan" placeholder="Scan barcode" data-testid="new-order-scan" @keydown.enter.prevent="submitManual" />
        <button class="btn" data-testid="new-order-add" @click="submitManual">Add</button>
        <span v-if="lastScan" class="pill" :class="lastScan.ok ? 'pill-good' : 'pill-crit'" data-testid="new-order-last-scan">
          {{ lastScan.ok ? 'Added' : 'Not their line' }} · {{ lastScan.code }}
        </span>
      </div>

      <div class="cols">
        <section class="col cat">
          <div class="between colhead">
            <span class="label">{{ vendor?.supplier_name || supplier }}'s catalogue</span>
            <span class="label label-dim">{{ visible.length }} of {{ catalogue?.total ?? 0 }}</span>
          </div>
          <div v-if="loading" class="empty"><div class="label label-dim">Reading their catalogue…</div></div>
          <div v-else-if="!rows.length" class="empty" data-testid="new-order-empty">
            <div class="display" style="font-size: 16px">Nothing on their catalogue yet</div>
            <p class="muted">No item names this vendor. Add them from the item's catalogue, or create the product first.</p>
          </div>
          <div v-else-if="!visible.length" class="empty" data-testid="new-order-no-match">
            <div class="label label-dim">Nothing matches “{{ q }}”.</div>
            <button class="btn btn-ghost" @click="q = ''">Clear the search</button>
          </div>
          <div v-else class="catlist">
            <button
              v-for="r in visible"
              :key="r.item_code"
              class="crow"
              :class="{ chosen: inBasket.has(r.item_code) }"
              :data-testid="`new-order-item-${r.item_code}`"
              @click="add(r)"
            >
              <span class="cid">
                <span class="cname ellipsis">{{ r.item_name || r.item_code }}</span>
                <span class="label label-dim">
                  {{ r.item_code }}<span v-if="r.vendor_sku"> · their {{ r.vendor_sku }}</span>
                </span>
                <span class="label label-dim">{{ packNote(r) }}</span>
              </span>
              <span class="cnum">
                <span class="num rate">{{ fmtMoney(r.rate) }}</span>
                <span v-if="r.is_preferred" class="pill pill-accent">Preferred</span>
                <span v-else-if="r.last_purchase_rate" class="label label-dim">last {{ fmtMoney(r.last_purchase_rate) }}</span>
              </span>
            </button>
          </div>
        </section>

        <section class="col bask">
          <div class="between colhead">
            <span class="label">This order</span>
            <button v-if="basket.length" class="btn btn-ghost" data-testid="new-order-clear" @click="basket = []">Clear</button>
          </div>
          <div v-if="!basket.length" class="empty" data-testid="new-order-basket-empty">
            <div class="label label-dim">Tap anything on the left, or scan it.</div>
            <p class="muted small">Quantities start at a whole case; − and + move a case at a time.</p>
          </div>
          <div v-else class="basket">
            <div v-for="l in basket" :key="l.item_code" class="brow" :data-testid="`new-order-line-${l.item_code}`">
              <div class="bid">
                <div class="ellipsis bname">{{ l.item_name }}</div>
                <div class="label label-dim">{{ l.item_code }}<span v-if="l.vendor_sku"> · {{ l.vendor_sku }}</span></div>
                <div v-if="packWarning(l)" class="label warn" :data-testid="`new-order-warn-${l.item_code}`">{{ packWarning(l) }}</div>
              </div>
              <div class="bqty">
                <button class="step" :aria-label="`One case fewer of ${l.item_code}`" :data-testid="`new-order-minus-${l.item_code}`" @click="bumpCase(l, -1)">−</button>
                <input
                  class="input qty"
                  inputmode="numeric"
                  :value="l.qty"
                  :aria-label="`Quantity of ${l.item_code}`"
                  :data-testid="`new-order-qty-${l.item_code}`"
                  @input="setQty(l, ($event.target as HTMLInputElement).value)"
                />
                <button class="step" :aria-label="`One case more of ${l.item_code}`" :data-testid="`new-order-plus-${l.item_code}`" @click="bumpCase(l, 1)">+</button>
              </div>
              <div class="brate">
                <input v-model="l.rate" class="input rate-in" inputmode="decimal" :aria-label="`Unit cost of ${l.item_code}`" :data-testid="`new-order-rate-${l.item_code}`" />
                <span class="label label-dim unit">a unit</span>
              </div>
              <div class="bamt num">{{ fmtMoney(l.qty * num(l.rate)) }}</div>
              <button class="drop label" :data-testid="`new-order-drop-${l.item_code}`" @click="drop(l.item_code)">Remove</button>
            </div>
          </div>
        </section>
      </div>
    </div>

    <template #footer>
      <div v-if="!supplier" class="foot">
        <span class="label label-dim">Buying is Houston's — a store never raises an order.</span>
        <button class="btn" @click="emit('close')">Cancel</button>
      </div>
      <div v-else class="foot" data-testid="new-order-foot">
        <button class="btn btn-ghost" data-testid="new-order-back" @click="backToVendors">Another vendor</button>
        <div class="totals">
          <div class="tot"><span class="label">Lines</span><span class="num v">{{ fmtInt(totals.lines) }}</span></div>
          <div class="tot"><span class="label">Units</span><span class="num v">{{ fmtInt(totals.units) }}</span></div>
          <div class="tot"><span class="label">Value</span><span class="num v accent">{{ fmtMoney(totals.value) }}</span></div>
        </div>
        <button class="btn btn-primary btn-big" :disabled="!totals.lines || busy" data-testid="new-order-create" @click="create">
          {{ busy ? 'Creating…' : 'Create draft order' }}
        </button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.intro {
  margin: 0;
}
.banner {
  padding: 10px 12px;
  border: var(--line-w) solid currentColor;
}
.pre {
  white-space: pre-line;
}

/* ---------- vendor picker ---------- */
.vgrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
  gap: 10px;
}
.vcard {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  min-height: 92px;
  padding: 14px 16px;
  border: var(--line-w) solid var(--line-strong);
  background: var(--surface-2);
  color: var(--text);
  text-align: left;
}
.vcard:hover {
  border-color: var(--accent);
}
.vname {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 15px;
  max-width: 100%;
}

/* ---------- catalogue + basket ---------- */
.scanbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
}
.scanbar .input {
  flex: 1 1 220px;
  min-width: 0;
}
.scanbar .scan {
  flex: 0 1 200px;
}
.cols {
  display: grid;
  grid-template-columns: minmax(0, 0.92fr) minmax(0, 1.08fr);
  gap: 14px;
  align-items: start;
}
.col {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.colhead {
  padding-bottom: 4px;
  border-bottom: var(--line-w) solid var(--line);
}
.catlist,
.basket {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 46vh;
  overflow-y: auto;
  overscroll-behavior-y: contain;
}
/* A height-capped column flex container shrinks its items by default: every row was squashed to
   `min-height` and its three lines of text spilled over the row above and below. */
.catlist > *,
.basket > * {
  flex: 0 0 auto;
}
.crow {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: var(--touch);
  padding: 10px 12px;
  border: var(--line-w) solid var(--line);
  background: transparent;
  color: var(--text);
  text-align: left;
}
.crow:hover {
  border-color: var(--accent);
}
.crow.chosen {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.cid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.cname {
  font-weight: 600;
  font-size: 14px;
  max-width: 100%;
}
.cnum {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 4px;
  flex: 0 0 auto;
}
.rate {
  font-size: 16px;
}
.brow {
  display: grid;
  /* The line's identity gets the full width and the controls sit under it, at every width. Five
     columns on one line collapsed the name to one character per row on a 1120 px sheet, and then
     pushed the amount and Remove out through `.basket`'s own overflow where nobody could reach
     them. What the buyer needs on a basket line is: what it is, then how many, then what it costs. */
  grid-template-columns: auto auto minmax(0, 1fr) auto;
  grid-template-areas:
    'id id id id'
    'qty rate amt drop';
  align-items: center;
  gap: 8px 10px;
  padding: 10px;
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
}
.bid {
  grid-area: id;
}
.bqty {
  grid-area: qty;
}
.brate {
  grid-area: rate;
}
.bamt {
  grid-area: amt;
}
.drop {
  grid-area: drop;
}
.bid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.bname {
  font-weight: 600;
  font-size: 14px;
}
.bid .label {
  overflow-wrap: anywhere;
}
.bqty {
  display: flex;
  align-items: center;
  gap: 4px;
}
.step {
  width: 42px;
  min-height: var(--touch);
  border: var(--line-w) solid var(--line-strong);
  background: transparent;
  color: var(--text);
  font-family: var(--font-display);
  font-size: 18px;
  line-height: 1;
}
.step:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.qty {
  width: 66px;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
}
.brate {
  display: flex;
  align-items: center;
  gap: 6px;
}
.unit {
  white-space: nowrap;
}
.rate-in {
  width: 84px;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
}
.bamt {
  min-width: 84px;
  text-align: right;
  font-size: 15px;
}
.drop {
  padding: 0 8px;
  min-height: var(--touch);
  background: transparent;
  border: 0;
  color: var(--dim);
  white-space: nowrap;
}
.drop:hover {
  color: var(--crit);
}
.empty {
  padding: 26px 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.small {
  margin: 0;
  font-size: 13px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  flex-wrap: wrap;
  justify-content: space-between;
}
.foot .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.totals {
  display: flex;
  gap: 20px;
}
.tot {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tot .v {
  font-size: 22px;
}

@media (max-width: 900px) {
  .cols {
    grid-template-columns: 1fr;
  }
  .catlist,
  .basket {
    max-height: 34vh;
  }
}
@media (max-width: 767px) {
  .brow {
    grid-template-columns: auto minmax(0, 1fr);
    grid-template-areas:
      'id id'
      'qty rate'
      'amt drop';
  }
  .bid {
    grid-area: id;
  }
  .bqty {
    grid-area: qty;
  }
  .brate {
    grid-area: rate;
    justify-content: flex-end;
  }
  .bamt {
    grid-area: amt;
    text-align: left;
  }
  .drop {
    grid-area: drop;
    text-align: right;
  }
  /* Two lines, not three: "another vendor" rides alongside the totals so the basket keeps the
     screen. A column footer here ate two thirds of a 844 px phone. */
  .foot {
    align-items: center;
    gap: 10px;
  }
  .foot .btn-ghost {
    flex: 0 0 auto;
    min-height: 44px;
    padding: 0 12px;
  }
  .totals {
    flex: 1 1 auto;
    justify-content: space-between;
    gap: 12px;
  }
  .foot .btn-primary {
    flex: 1 1 100%;
  }
}
</style>
