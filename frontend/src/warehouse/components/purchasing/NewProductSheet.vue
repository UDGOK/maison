<script lang="ts">
/**
 * v1.1 §B — **New product**, created from the warehouse screens.
 *
 * A rep shows the warehouse manager a new disposable and there is no way to add it without going
 * to a laptop. This is that sheet: everything a product needs before it can be bought, in one
 * pass, in the order the manager learns it —
 *
 *   **what it is** (code, name, group, barcode — scannable, UOM) ·
 *   **what we pay** (vendor, *their* SKU, cost, case pack, MOQ, lead time) ·
 *   **when to reorder** (level and quantity at HOU-WH) ·
 *   **what it sells for**.
 *
 * The server writes all of it or none of it (`create_product` runs inside a savepoint), so this
 * sheet never has to reason about a half-built item. What it *does* have to do is put refusals
 * where they belong: a **duplicate barcode** is a real-money hazard — two products on one barcode
 * means the till rings up the wrong one — so that message lands **on the barcode field**, not in a
 * generic banner at the top where it reads as a system error.
 *
 * Saving offers **Order it now**, because that is always what happens next.
 */
import type { NewProductInput } from '@/api/purchasing'

/** The form's own state: every field is a string, because that is what an input holds. */
export interface ProductDraft {
  item_code: string
  item_name: string
  item_group: string
  uom: string
  barcode: string
  supplier: string
  vendor_sku: string
  cost: string
  case_pack: string
  moq: string
  lead_time_days: string
  reorder_level: string
  reorder_qty: string
  selling_rate: string
}

/** The field a message belongs beside; `null` means the banner. */
export type ProductField = 'item_code' | 'item_name' | 'item_group' | 'barcode' | 'supplier' | 'cost' | 'case_pack' | 'selling_rate' | 'reorder_level'

export interface ProductProblem {
  field: ProductField
  message: string
}

export function emptyDraft(): ProductDraft {
  return {
    item_code: '',
    item_name: '',
    item_group: '',
    uom: 'Nos',
    barcode: '',
    supplier: '',
    vendor_sku: '',
    cost: '',
    case_pack: '1',
    moq: '',
    lead_time_days: '',
    reorder_level: '',
    reorder_qty: '',
    selling_rate: ''
  }
}

function n(value: string): number {
  const parsed = Number(String(value ?? '').trim())
  return Number.isFinite(parsed) ? parsed : 0
}

function blank(value: string): boolean {
  return !String(value ?? '').trim()
}

/**
 * What is wrong with the form, field by field, **before** anything is sent. The server refuses all
 * of this too; saying it here is what keeps the manager from typing a whole product and then being
 * told the group was missing.
 *
 * One rule is deliberately stricter than the server's: a product must be **named**. The server
 * falls back to the item code, but a code is not what a customer reads off the till.
 */
export function validateProduct(draft: ProductDraft): ProductProblem[] {
  const problems: ProductProblem[] = []
  if (blank(draft.item_code)) problems.push({ field: 'item_code', message: 'A product needs an item code' })
  else if (/\s/.test(draft.item_code.trim())) problems.push({ field: 'item_code', message: 'An item code has no spaces in it' })
  if (blank(draft.item_name)) problems.push({ field: 'item_name', message: 'A product needs a name — it is what the till shows' })
  if (blank(draft.item_group)) problems.push({ field: 'item_group', message: 'Choose the group this product is filed under' })
  // a scanner never types a space: one in the field means it was keyed, and it will never match
  if (!blank(draft.barcode) && /\s/.test(draft.barcode.trim())) problems.push({ field: 'barcode', message: 'A barcode has no spaces in it — scan it rather than typing it' })
  const terms = [draft.vendor_sku, draft.cost, draft.moq, draft.lead_time_days].some((v) => !blank(v))
  if (blank(draft.supplier) && terms) problems.push({ field: 'supplier', message: 'Choose the vendor these terms belong to' })
  if (n(draft.cost) < 0) problems.push({ field: 'cost', message: 'A vendor cost cannot be negative' })
  if (!blank(draft.case_pack) && n(draft.case_pack) < 1) problems.push({ field: 'case_pack', message: 'A case holds at least one' })
  if (n(draft.selling_rate) < 0) problems.push({ field: 'selling_rate', message: 'A selling price cannot be negative' })
  if (n(draft.reorder_level) < 0 || n(draft.reorder_qty) < 0) problems.push({ field: 'reorder_level', message: 'A reorder level cannot be negative' })
  return problems
}

/** The `create_product` payload — the blank optional halves are dropped rather than sent as 0. */
export function productPayload(draft: ProductDraft): NewProductInput {
  const payload: NewProductInput = {
    item_code: draft.item_code.trim(),
    item_name: draft.item_name.trim() || draft.item_code.trim(),
    item_group: draft.item_group.trim(),
    uom: draft.uom.trim() || 'Nos',
    barcode: draft.barcode.trim() || null
  }
  if (n(draft.selling_rate) > 0) payload.selling_rate = n(draft.selling_rate)
  if (!blank(draft.supplier)) {
    payload.vendor = {
      supplier: draft.supplier.trim(),
      vendor_sku: draft.vendor_sku.trim() || null,
      cost: n(draft.cost),
      case_pack: Math.max(1, Math.trunc(n(draft.case_pack)) || 1),
      moq: Math.max(0, Math.trunc(n(draft.moq))),
      lead_time_days: Math.max(0, Math.trunc(n(draft.lead_time_days)))
    }
  }
  if (n(draft.reorder_level) > 0 || n(draft.reorder_qty) > 0) {
    payload.reorder = { level: n(draft.reorder_level), qty: n(draft.reorder_qty) || n(draft.reorder_level) }
  }
  return payload
}

/**
 * Which field a **server** refusal belongs beside.
 *
 * The duplicate barcode is why this exists. `create_product` names the offending item in its
 * message — "Barcode 8801234500017 is already on item GB-PULSE-15K-BLUE" — and that belongs
 * against the barcode box the manager just scanned into, where it reads as *this scan is wrong*,
 * not as *the system is broken*.
 */
export function fieldForError(message: string): ProductField | null {
  const text = (message || '').toLowerCase()
  if (!text) return null
  if (text.includes('barcode')) return 'barcode'
  if (text.includes('already exists') || text.includes('item code')) return 'item_code'
  if (text.includes('item group')) return 'item_group'
  if (text.includes('unit of measure')) return 'item_code'
  if (text.includes('vendor') && text.includes('does not exist')) return 'supplier'
  if (text.includes('selling price')) return 'selling_rate'
  if (text.includes('vendor cost')) return 'cost'
  if (text.includes('reorder')) return 'reorder_level'
  return null
}

/** "Sells at $24.99 — a $15.65 margin, 63%". Empty until both halves are known. */
export function marginNote(cost: number, sellingRate: number): string {
  const buy = Number(cost) || 0
  const sell = Number(sellingRate) || 0
  if (sell <= 0 || buy <= 0) return ''
  const margin = sell - buy
  const pct = Math.round((margin / sell) * 100)
  if (margin < 0) return `That is ${Math.abs(Math.round(margin * 100) / 100).toFixed(2)} **under** what it costs`
  return `${(Math.round(margin * 100) / 100).toFixed(2)} a unit · ${pct}% margin`
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Modal from '@/components/Modal.vue'
import { purchasingApi, type CreateProductResult, type ItemGroupRow, type Vendor } from '@/api/purchasing'
import { usePurchasingStore } from '@/stores/purchasing'
import { installWedgeListener } from '@/scan/wedge'
import { fmtMoney } from '@/utils/money'

const props = defineProps<{ supplier?: string | null }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; created: [out: CreateProductResult]; order: [supplier: string, itemCode: string] }>()

const store = usePurchasingStore()

const draft = ref<ProductDraft>({ ...emptyDraft(), supplier: props.supplier || '' })
const groups = ref<ItemGroupRow[]>([])
const vendors = ref<Vendor[]>([])
const touched = ref(false)
const saving = ref(false)
const error = ref('')
const errorField = ref<ProductField | null>(null)
const created = ref<CreateProductResult | null>(null)
const lastScan = ref('')
const barcodeBox = ref<HTMLInputElement | null>(null)

const problems = computed(() => validateProduct(draft.value))
const shown = computed(() => (touched.value ? problems.value : []))
const margin = computed(() => marginNote(Number(draft.value.cost) || 0, Number(draft.value.selling_rate) || 0))

/** The message for one field: the form's own, or the server's if it landed there. */
function problemFor(field: ProductField): string {
  if (errorField.value === field && error.value) return error.value
  return shown.value.find((p) => p.field === field)?.message || ''
}
function bad(field: ProductField): boolean {
  return !!problemFor(field)
}

async function load() {
  const [g, v] = await Promise.all([purchasingApi.item_groups().catch(() => null), store.loadVendors(undefined, true)])
  if (g) {
    groups.value = g.groups
    // the group the chain files most of its catalogue under is the sensible starting selection
    if (!draft.value.item_group && g.default) draft.value.item_group = g.default
  }
  if (v) vendors.value = v.vendors
  const vendor = vendors.value.find((row) => row.name === draft.value.supplier)
  if (vendor && !draft.value.lead_time_days) draft.value.lead_time_days = String(vendor.lead_time_days || '')
}

function onVendor() {
  const vendor = vendors.value.find((row) => row.name === draft.value.supplier)
  if (vendor && !draft.value.lead_time_days) draft.value.lead_time_days = String(vendor.lead_time_days || '')
}

/** A wedge scanner types into whatever has focus; while this sheet is open it fills the barcode. */
function onCode(code: string) {
  const value = (code || '').trim()
  if (!value || created.value) return
  draft.value.barcode = value
  lastScan.value = value
  if (errorField.value === 'barcode') {
    error.value = ''
    errorField.value = null
  }
}

let uninstall: (() => void) | null = null
onMounted(() => {
  uninstall = installWedgeListener(onCode)
  void load()
})
onBeforeUnmount(() => uninstall?.())

async function save() {
  touched.value = true
  error.value = ''
  errorField.value = null
  if (problems.value.length) return
  saving.value = true
  try {
    const out = await purchasingApi.create_product(productPayload(draft.value))
    created.value = out
    emit('created', out)
    emit('notice', `${out.item_code} created${out.catalogue_row ? ` · ${out.catalogue_row.vendor_sku || 'no SKU'} at ${fmtMoney(out.catalogue_row.cost)}` : ''}`)
  } catch (e) {
    const message = (e as Error)?.message || 'The product was not created'
    error.value = message
    errorField.value = fieldForError(message)
  } finally {
    saving.value = false
  }
}

function again() {
  const supplier = draft.value.supplier
  const group = draft.value.item_group
  draft.value = { ...emptyDraft(), supplier, item_group: group }
  created.value = null
  touched.value = false
  error.value = ''
  errorField.value = null
  lastScan.value = ''
}

function orderIt() {
  const out = created.value
  if (!out) return
  emit('order', out.item.preferred || draft.value.supplier, out.item_code)
}

defineExpose({ onCode })
</script>

<template>
  <Modal :title="created ? `${created.item_code} created` : 'New product'" width="960px" @close="emit('close')">
    <!-- ============================================================ confirmation -->
    <div v-if="created" class="sheet" data-testid="product-created">
      <div class="done">
        <div class="display done-h">{{ created.item.item_name }}</div>
        <div class="label label-dim">{{ created.item_code }}<span v-if="created.item.barcode"> · {{ created.item.barcode }}</span> · {{ created.item.item_group }}</div>
      </div>
      <ul class="wrote">
        <li>Stock item at <strong>{{ created.item.warehouse }}</strong>, valued at {{ created.item.valuation_method || 'Moving Average' }}.</li>
        <li v-if="created.catalogue_row">
          <strong>{{ created.catalogue_row.item_code }}</strong> is <strong>{{ created.catalogue_row.vendor_sku || 'unlisted' }}</strong> to
          {{ created.item.preferred }} at {{ fmtMoney(created.catalogue_row.cost) }} a unit, {{ created.catalogue_row.case_pack }} to a case — written to
          their buying price list, and marked preferred.
        </li>
        <li v-else>No vendor yet — add one from the item's catalogue before it can be bought.</li>
        <li v-if="created.item.selling_rate">Sells at {{ fmtMoney(created.item.selling_rate) }} on {{ created.item.price_list }}.</li>
        <li v-else>No selling price yet — set one before a store rings it up.</li>
        <li v-if="created.item.reorder">
          Reorders at {{ created.item.reorder.level }}, {{ created.item.reorder.qty }} at a time, at {{ created.item.reorder.warehouse }}.
        </li>
        <li v-else>No reorder level — it will not appear on the buying list on its own.</li>
      </ul>
      <p class="muted next">Nothing is on the shelf yet. Ordering it is what happens next.</p>
    </div>

    <!-- ============================================================ the form -->
    <div v-else class="sheet" data-testid="product-sheet">
      <div v-if="error && !errorField" class="banner crit pre" data-testid="product-error">{{ error }}</div>

      <section class="group">
        <div class="section-title">What it is</div>
        <div class="grid">
          <div class="field">
            <label class="label" for="np-code">Item code</label>
            <input id="np-code" v-model="draft.item_code" class="input" :class="{ bad: bad('item_code') }" placeholder="e.g. GB-PULSE-15K-CHERRY" data-testid="product-code" />
            <span v-if="problemFor('item_code')" class="label crit err" data-testid="product-code-error">{{ problemFor('item_code') }}</span>
          </div>
          <div class="field wide">
            <label class="label" for="np-name">Name (what the till shows)</label>
            <input id="np-name" v-model="draft.item_name" class="input" :class="{ bad: bad('item_name') }" placeholder="e.g. Geek Bar Pulse 15K — Cherry Ice" data-testid="product-name" />
            <span v-if="problemFor('item_name')" class="label crit err">{{ problemFor('item_name') }}</span>
          </div>
          <div class="field">
            <label class="label" for="np-group">Group</label>
            <select id="np-group" v-model="draft.item_group" class="input" :class="{ bad: bad('item_group') }" data-testid="product-group">
              <option value="">Choose a group</option>
              <option v-for="g in groups" :key="g.name" :value="g.name">{{ g.label }}<span v-if="g.items"> ({{ g.items }})</span></option>
            </select>
            <span v-if="problemFor('item_group')" class="label crit err">{{ problemFor('item_group') }}</span>
          </div>
          <div class="field wide">
            <label class="label" for="np-barcode">Barcode</label>
            <div class="row scanrow">
              <input
                id="np-barcode"
                ref="barcodeBox"
                v-model="draft.barcode"
                class="input"
                :class="{ bad: bad('barcode') }"
                placeholder="Scan the box, or type it"
                data-testid="product-barcode"
              />
              <button class="btn" data-testid="product-scan" @click="barcodeBox?.focus()">Scan</button>
            </div>
            <span v-if="problemFor('barcode')" class="label crit err" data-testid="product-barcode-error">{{ problemFor('barcode') }}</span>
            <span v-else-if="lastScan" class="label good err">Scanned {{ lastScan }}</span>
            <span v-else class="label label-dim err">Scan with no box selected and it lands here.</span>
          </div>
          <div class="field">
            <label class="label" for="np-uom">Sold as</label>
            <input id="np-uom" v-model="draft.uom" class="input" placeholder="Nos" data-testid="product-uom" />
          </div>
        </div>
      </section>

      <section class="group">
        <div class="section-title">What we pay</div>
        <div class="grid">
          <div class="field wide">
            <label class="label" for="np-vendor">Vendor</label>
            <select id="np-vendor" v-model="draft.supplier" class="input" :class="{ bad: bad('supplier') }" data-testid="product-vendor" @change="onVendor">
              <option value="">No vendor yet</option>
              <option v-for="v in vendors" :key="v.name" :value="v.name">{{ v.supplier_name }}</option>
            </select>
            <span v-if="problemFor('supplier')" class="label crit err">{{ problemFor('supplier') }}</span>
            <span v-else class="label label-dim err">Its first vendor becomes the preferred one.</span>
          </div>
          <div class="field">
            <label class="label" for="np-sku">Their SKU</label>
            <input id="np-sku" v-model="draft.vendor_sku" class="input" placeholder="what they call it" data-testid="product-sku" />
          </div>
          <div class="field">
            <label class="label" for="np-cost">Unit cost</label>
            <input id="np-cost" v-model="draft.cost" class="input num-in" :class="{ bad: bad('cost') }" inputmode="decimal" placeholder="0.00" data-testid="product-cost" />
            <span v-if="problemFor('cost')" class="label crit err">{{ problemFor('cost') }}</span>
          </div>
          <div class="field">
            <label class="label" for="np-case">Case pack</label>
            <input id="np-case" v-model="draft.case_pack" class="input num-in" :class="{ bad: bad('case_pack') }" inputmode="numeric" data-testid="product-case-pack" />
            <span v-if="problemFor('case_pack')" class="label crit err">{{ problemFor('case_pack') }}</span>
          </div>
          <div class="field">
            <label class="label" for="np-moq">MOQ</label>
            <input id="np-moq" v-model="draft.moq" class="input num-in" inputmode="numeric" placeholder="0" data-testid="product-moq" />
          </div>
          <div class="field">
            <label class="label" for="np-lead">Lead time (days)</label>
            <input id="np-lead" v-model="draft.lead_time_days" class="input num-in" inputmode="numeric" placeholder="0" data-testid="product-lead" />
          </div>
        </div>
      </section>

      <section class="group">
        <div class="section-title">When to reorder, and what it sells for</div>
        <div class="grid">
          <div class="field">
            <label class="label" for="np-level">Reorder at (HOU-WH)</label>
            <input id="np-level" v-model="draft.reorder_level" class="input num-in" :class="{ bad: bad('reorder_level') }" inputmode="numeric" placeholder="0" data-testid="product-reorder-level" />
            <span v-if="problemFor('reorder_level')" class="label crit err">{{ problemFor('reorder_level') }}</span>
          </div>
          <div class="field">
            <label class="label" for="np-rqty">Reorder quantity</label>
            <input id="np-rqty" v-model="draft.reorder_qty" class="input num-in" inputmode="numeric" placeholder="same as the level" data-testid="product-reorder-qty" />
          </div>
          <div class="field">
            <label class="label" for="np-sell">Sells at</label>
            <input id="np-sell" v-model="draft.selling_rate" class="input num-in" :class="{ bad: bad('selling_rate') }" inputmode="decimal" placeholder="0.00" data-testid="product-selling-rate" />
            <span v-if="problemFor('selling_rate')" class="label crit err">{{ problemFor('selling_rate') }}</span>
            <span v-else-if="margin" class="label err" :class="margin.includes('under') ? 'crit' : 'label-dim'" data-testid="product-margin">{{ margin.replace(/\*\*/g, '') }}</span>
          </div>
          <div class="field wide note-cell">
            <span class="label label-dim story">
              A reorder level is what puts it on tomorrow's buying list on its own. Leave it empty and it only appears when a store asks for it.
            </span>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <div v-if="created" class="foot" data-testid="product-created-foot">
        <button class="btn btn-ghost" data-testid="product-again" @click="again">Add another</button>
        <div class="row">
          <button class="btn" data-testid="product-done" @click="emit('close')">Done</button>
          <button v-if="created.item.preferred" class="btn btn-primary btn-big" data-testid="product-order-now" @click="orderIt">Order it now</button>
        </div>
      </div>
      <div v-else class="foot">
        <span v-if="touched && problems.length" class="label crit" data-testid="product-problem-count">
          {{ problems.length }} thing{{ problems.length === 1 ? '' : 's' }} to fix
        </span>
        <span v-else class="label label-dim">Everything is written together, or nothing is.</span>
        <div class="row">
          <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary btn-big" :disabled="saving" data-testid="product-save" @click="save">{{ saving ? 'Creating…' : 'Create product' }}</button>
        </div>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.group {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 12px;
}
.field.wide {
  grid-column: span 2;
}
.err {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
  min-height: 14px;
}
.input.bad {
  border-color: var(--crit);
}
.num-in {
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
}
.scanrow {
  gap: 8px;
}
.scanrow .input {
  flex: 1;
  min-width: 0;
}
.banner {
  padding: 10px 12px;
  border: var(--line-w) solid currentColor;
}
.pre {
  white-space: pre-line;
}
.note-cell {
  justify-content: flex-end;
}
.story {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
  line-height: 1.5;
}
.done {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px 16px;
  border: var(--line-w) solid var(--good);
}
.done-h {
  font-size: 20px;
  color: var(--good);
}
.wrote {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: var(--muted);
  font-size: 14px;
  line-height: 1.5;
}
.wrote strong {
  color: var(--text);
}
.next {
  margin: 0;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  flex-wrap: wrap;
}
.foot .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
@media (max-width: 767px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .field.wide {
    grid-column: span 1;
  }
  .foot {
    flex-direction: column;
    align-items: stretch;
  }
  .foot .row {
    flex-direction: column;
  }
  .foot .btn {
    width: 100%;
  }
}
</style>
