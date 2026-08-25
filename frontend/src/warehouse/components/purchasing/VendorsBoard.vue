<script lang="ts">
/**
 * v1.0 "Procurement" §A — **Vendors**.
 *
 * Who we buy from, biggest spender first: the account number *they* know us by, the rep to ring,
 * how the order goes out, the lead time and minimum, whether they will drop-ship to a store, and
 * what the last twelve months actually looked like. A vendor is **deactivated, never deleted** —
 * the history is the point.
 *
 * Every performance figure is optional: a vendor with no orders and no receipts in the window
 * comes back with none of them, and renders as an em dash rather than a zero or a `NaN`.
 */
import type { Vendor } from '@/api/purchasing'
import { fmtInt, fmtMoney } from '@/utils/money'

/** A statistic that may not exist. Never prints `NaN`, never invents a zero. */
export function stat(value: number | null | undefined, format: (n: number) => string = fmtInt): string {
  if (value === null || value === undefined) return '—'
  const n = Number(value)
  return Number.isFinite(n) ? format(n) : '—'
}

/** "87.5%" — one decimal, because on-time percentages land on halves. */
export function pct(n: number): string {
  return `${Math.round(n * 10) / 10}%`
}

export function money(n: number): string {
  return fmtMoney(n)
}

/** Under 80% on time is a problem worth seeing from across the desk. */
export function onTimeTone(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'dim'
  const n = Number(value)
  if (n >= 90) return 'good'
  if (n >= 75) return 'warn'
  return 'crit'
}

/** Biggest twelve-month spend first; a vendor with no spend sorts by name, not to the top. */
export function sortVendors(vendors: Vendor[]): Vendor[] {
  return [...(vendors || [])].sort((a, b) => (b.spend ?? 0) - (a.spend ?? 0) || (a.supplier_name || a.name).localeCompare(b.supplier_name || b.name))
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import VendorSheet, { dayStamp } from './VendorSheet.vue'
import NewOrderSheet from './NewOrderSheet.vue'
import { usePurchasingStore } from '@/stores/purchasing'
import { ORDER_METHODS, type VendorInput } from '@/api/purchasing'
import { fmtDate } from '@/utils/device'

const emit = defineEmits<{ (e: 'notice', msg: string): void; (e: 'open-order', name: string): void }>()

const store = usePurchasingStore()

const q = ref('')
const activeOnly = ref(true)
const open = ref<string | null>(null)
const adding = ref(false)
/** v1.1 §D — "Order from this vendor": the New order sheet, vendor pre-chosen. */
const ordering = ref<string | null>(null)
const draft = ref<VendorInput>({ supplier_name: '', supplier_group: 'Distributor', order_method: 'Email', lead_time_days: 0, active: true })
const formError = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

const vendors = computed(() => sortVendors(store.vendors))
const since = ref('')

function say(msg: string) {
  if (msg) emit('notice', msg)
}
/** The vendor sheet asked for an order. Close it first — a sheet on a sheet is a trap on a phone. */
function orderFrom(supplier: string) {
  open.value = null
  ordering.value = supplier
}
/** The draft exists; the desk takes it to Buying → Orders and opens it. */
function onOrderCreated(name: string) {
  ordering.value = null
  emit('open-order', name)
}
function drain() {
  if (store.notice) {
    say(store.notice)
    store.clearNotice()
  }
}

async function load() {
  const out = await store.loadVendors(q.value.trim() || undefined, activeOnly.value)
  if (out) since.value = out.since
}
onMounted(load)
watch(activeOnly, load)
watch(q, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void load(), 300)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

function startAdd() {
  draft.value = { supplier_name: '', supplier_group: 'Distributor', order_method: 'Email', lead_time_days: 0, active: true }
  formError.value = ''
  adding.value = true
}

async function addVendor() {
  if (!draft.value.supplier_name?.trim()) {
    formError.value = 'A vendor needs a name.'
    return
  }
  const out = await store.saveVendor({ ...draft.value, supplier_name: draft.value.supplier_name.trim() })
  if (!out) return
  drain()
  adding.value = false
  await load()
  open.value = out.vendor.name
}
</script>

<template>
  <div class="board" data-testid="vendors-board">
    <div class="bar">
      <input v-model="q" class="input search" placeholder="Search vendor, account number or rep" data-testid="vendor-search" />
      <div class="seg">
        <button class="chip" :class="{ active: activeOnly }" data-testid="vendor-active" @click="activeOnly = true">Active</button>
        <button class="chip" :class="{ active: !activeOnly }" data-testid="vendor-all" @click="activeOnly = false">All</button>
      </div>
      <div class="spacer"></div>
      <span v-if="since" class="label label-dim">Performance since {{ fmtDate(dayStamp(since)) }}</span>
      <button class="btn btn-primary" data-testid="vendor-add" @click="startAdd">Add vendor</button>
    </div>

    <div v-if="store.error" class="banner crit-banner" data-testid="vendors-error">
      <span>{{ store.error }}</span>
      <div class="row">
        <button class="btn btn-ghost" @click="load">Try again</button>
        <button class="btn btn-ghost" @click="store.clearError()">Dismiss</button>
      </div>
    </div>

    <div v-if="store.loading && !vendors.length" class="empty"><div class="label label-dim">Loading vendors…</div></div>
    <div v-else-if="!vendors.length" class="empty" data-testid="vendors-empty">
      <div class="display" style="font-size: 18px">{{ q ? 'No vendor matches that' : 'No vendors yet' }}</div>
      <div class="muted">
        {{ q ? 'Try the account number they know us by, or the rep’s name.' : 'Add the distributors and brands Houston buys from — each one gets its own negotiated price list.' }}
      </div>
      <button class="btn" @click="q ? (q = '') : startAdd()">{{ q ? 'Clear search' : 'Add the first vendor' }}</button>
    </div>

    <div v-else class="tablewrap">
      <table class="table vendors">
        <thead>
          <tr>
            <th>Vendor</th>
            <th>Our account no.</th>
            <th>Rep</th>
            <th>Order by</th>
            <th class="num">Lead time</th>
            <th class="num">Min order</th>
            <th>Drop-ship</th>
            <th class="num">Spend 12 m</th>
            <th class="num">Orders</th>
            <th class="num">On time</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="v in vendors" :key="v.name" class="vrow" :class="{ off: !v.active }" :data-testid="`vendor-${v.name}`" @click="open = v.name">
            <td>
              <div class="row" style="gap: 8px">
                <button class="link" :data-testid="`open-vendor-${v.name}`" @click.stop="open = v.name">{{ v.supplier_name || v.name }}</button>
                <span v-if="!v.active" class="pill pill-crit">Inactive</span>
              </div>
              <div class="label label-dim">{{ v.name }}<span v-if="v.supplier_group"> · {{ v.supplier_group }}</span></div>
            </td>
            <td>{{ v.account_number || '—' }}</td>
            <td>
              <div class="ellipsis" style="max-width: 180px">{{ v.rep_name || '—' }}</div>
              <div class="label label-dim ellipsis" style="max-width: 180px">{{ v.rep_phone || v.rep_email || '' }}</div>
            </td>
            <td><span class="pill">{{ v.order_method || 'Email' }}</span></td>
            <td class="num">{{ v.lead_time_days ? `${v.lead_time_days} d` : '—' }}</td>
            <td class="num money">{{ v.min_order_value ? fmtMoney(v.min_order_value) : '—' }}</td>
            <td><span v-if="v.dropship_capable" class="pill pill-good">Yes</span><span v-else class="muted">No</span></td>
            <td class="num money accent" :data-testid="`vendor-spend-${v.name}`">{{ stat(v.spend, money) }}</td>
            <td class="num">{{ stat(v.orders) }}</td>
            <td class="num" :class="onTimeTone(v.on_time_pct)" :data-testid="`vendor-ontime-${v.name}`">{{ stat(v.on_time_pct, pct) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="adding" title="Add vendor" width="640px" @close="adding = false">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="vendor-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field span">
          <label class="label" for="nv-name">Vendor name</label>
          <input id="nv-name" v-model="draft.supplier_name" class="input" placeholder="e.g. Gulf Coast Distributing" data-testid="new-vendor-name" />
        </div>
        <div class="field">
          <label class="label" for="nv-group">Type</label>
          <select id="nv-group" v-model="draft.supplier_group" class="input">
            <option value="Distributor">Distributor</option>
            <option value="Brand Direct">Brand direct</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="nv-method">Order by</label>
          <select id="nv-method" v-model="draft.order_method" class="input">
            <option v-for="m in ORDER_METHODS" :key="m" :value="m">{{ m }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="nv-lead">Lead time (days)</label>
          <input id="nv-lead" v-model.number="draft.lead_time_days" class="input" inputmode="numeric" />
        </div>
        <div class="field">
          <label class="label" for="nv-acct">Our account number with them</label>
          <input id="nv-acct" v-model="draft.account_number" class="input" placeholder="the number they know us by" />
        </div>
      </div>
      <p class="muted note">A buying price list is created for this vendor on save — negotiated costs live there, and every purchase order picks them up.</p>
      <template #footer>
        <button class="btn btn-ghost" @click="adding = false">Cancel</button>
        <button class="btn btn-primary" :disabled="store.busy === 'new-vendor'" data-testid="new-vendor-save" @click="addVendor">
          {{ store.busy === 'new-vendor' ? 'Saving…' : 'Add vendor' }}
        </button>
      </template>
    </Modal>

    <VendorSheet v-if="open" :vendor="open" @close="open = null" @notice="say" @changed="load" @order="orderFrom" />

    <NewOrderSheet v-if="ordering" :supplier="ordering" @close="ordering = null" @notice="say" @created="onOrderCreated" />
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.search {
  width: 320px;
  flex: 1 1 220px;
  max-width: 420px;
}
.seg {
  display: flex;
  gap: 4px;
}
.spacer {
  flex: 1;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 14px;
}
.crit-banner {
  border-left: 3px solid var(--crit);
  background: rgba(196, 115, 106, 0.1);
  color: var(--crit);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 56px 16px;
  text-align: center;
  border: var(--line-w) dashed var(--line-strong);
  background: var(--surface);
}
.empty .muted {
  max-width: 56ch;
}
.tablewrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
}
.vendors {
  min-width: 1080px;
}
.vrow {
  cursor: pointer;
}
.vrow:hover td {
  background: var(--surface-2);
}
.vrow.off td {
  color: var(--dim);
}
.link {
  color: var(--accent);
  min-height: 0;
  min-width: 0;
  padding: 0;
  font-weight: 500;
  text-align: left;
}
.money {
  font-family: var(--font-display);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.span {
  grid-column: 1 / -1;
}
.note {
  margin-top: 14px;
  font-size: 13px;
  max-width: 62ch;
}
@media (max-width: 767px) {
  .search {
    width: 100%;
    max-width: none;
  }
  .form {
    grid-template-columns: 1fr;
  }
}
</style>
