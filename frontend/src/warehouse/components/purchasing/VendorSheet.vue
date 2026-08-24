<script lang="ts">
/**
 * v1.0 "Procurement" §A + §B — one vendor: their profile, their catalogue (the negotiated costs,
 * case packs and minimums we buy at), their open orders, what they last delivered, and the
 * twelve-month picture.
 *
 * Two rules the UI has to make plain:
 *  - a vendor is **deactivated, never deleted** — the history is why they exist;
 *  - a catalogue **cost writes through to that vendor's buying price list**, so the next purchase
 *    order picks it up. Nothing here is a second price mechanism.
 */
import type { VendorCatalogueRow } from '@/api/purchasing'

export interface CatalogueDraft {
  vendor_sku: string
  cost: number
  case_pack: number
  moq: number
  lead_time_days: number
}

export function draftOf(row: VendorCatalogueRow): CatalogueDraft {
  return {
    vendor_sku: row.vendor_sku || '',
    cost: row.cost,
    case_pack: row.case_pack,
    moq: row.moq,
    lead_time_days: row.lead_time_days
  }
}

/** Has this catalogue row been edited away from what the server holds? */
export function rowDirty(row: VendorCatalogueRow, draft?: CatalogueDraft | null): boolean {
  if (!draft) return false
  const base = draftOf(row)
  return (Object.keys(base) as (keyof CatalogueDraft)[]).some((k) => base[k] !== draft[k])
}

/**
 * A bare `YYYY-MM-DD` used to render a day early west of UTC. `utils/time.ts::parseServer` now
 * reads a date-only string as a site-zone calendar day, so this is a pass-through kept for the
 * screens that already call it.
 */
export function dayStamp(value?: string | null): string {
  return (value || '').trim()
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { usePurchasingStore } from '@/stores/purchasing'
import { ORDER_METHODS, type VendorInput } from '@/api/purchasing'
import { fmtDate } from '@/utils/device'
import { fmtInt, fmtMoney } from '@/utils/money'

const props = defineProps<{ vendor: string }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; changed: [] }>()

const store = usePurchasingStore()

type Tab = 'profile' | 'catalogue' | 'orders' | 'receipts' | 'spend'
const TABS: { key: Tab; label: string }[] = [
  { key: 'profile', label: 'Profile' },
  { key: 'catalogue', label: 'Catalogue' },
  { key: 'orders', label: 'Open orders' },
  { key: 'receipts', label: 'Recent receipts' },
  { key: 'spend', label: 'Spend' }
]

const tab = ref<Tab>('profile')
const form = ref<VendorInput>({})
const rows = ref<Record<string, CatalogueDraft>>({})
const confirming = ref(false)
const localError = ref('')

const detail = computed(() => (store.vendorDetail?.vendor.name === props.vendor ? store.vendorDetail : null))
const v = computed(() => detail.value?.vendor ?? null)
const catalogue = computed(() => detail.value?.catalogue ?? [])
const busy = computed(() => store.busy === props.vendor)
const dirty = computed(() => {
  const cur = v.value
  if (!cur) return false
  return (Object.keys(form.value) as (keyof VendorInput)[]).some((k) => k !== 'name' && form.value[k] !== ((cur as unknown as Record<string, unknown>)[k] ?? form.value[k]))
})

function seed() {
  const cur = v.value
  if (!cur) return
  form.value = {
    name: cur.name,
    supplier_name: cur.supplier_name,
    supplier_group: cur.supplier_group || 'Distributor',
    lead_time_days: cur.lead_time_days,
    min_order_value: cur.min_order_value,
    dropship_capable: cur.dropship_capable,
    order_method: cur.order_method || 'Email',
    portal_url: cur.portal_url ?? '',
    account_number: cur.account_number ?? '',
    rep_name: cur.rep_name ?? '',
    rep_phone: cur.rep_phone ?? '',
    rep_email: cur.rep_email ?? '',
    notes: cur.notes ?? '',
    active: cur.active
  }
  rows.value = Object.fromEntries(catalogue.value.map((r) => [r.item_code, draftOf(r)]))
}

async function load() {
  localError.value = ''
  const out = await store.loadVendor(props.vendor)
  if (out) seed()
}
onMounted(load)
watch(() => props.vendor, load)
watch(detail, (d, prev) => {
  if (d && d !== prev) seed()
})

async function run<T>(fn: () => Promise<T | null>): Promise<T | null> {
  localError.value = ''
  const out = await fn()
  if (out) {
    if (store.notice) {
      emit('notice', store.notice)
      store.clearNotice()
    }
    emit('changed')
  }
  return out
}

async function save() {
  if (!form.value.supplier_name?.trim()) {
    localError.value = 'A vendor needs a name.'
    return
  }
  await run(() => store.saveVendor({ ...form.value, name: props.vendor, supplier_name: form.value.supplier_name!.trim() }))
}

async function setActive(active: boolean) {
  const out = await run(() => store.setVendorActive(props.vendor, active))
  if (out) confirming.value = false
}

const saveRow = (itemCode: string) =>
  run(() => store.saveItemVendor(itemCode, { supplier: props.vendor, ...rows.value[itemCode] }))

const prefer = (itemCode: string) => run(() => store.setPreferredVendor(itemCode, props.vendor))

/**
 * The catalogue row carries its own `AWANZ Item Vendor` name, so remove by that. A row
 * re-synthesised locally after an edit can be missing it — fall back to the item side then.
 */
async function removeRow(itemCode: string, rowName?: string) {
  let name = rowName
  if (!name) {
    const list = await store.loadItemVendors(itemCode)
    name = list?.vendors.find((r) => r.supplier === props.vendor)?.name
  }
  if (!name) {
    localError.value = `${itemCode} is no longer on this vendor's catalogue.`
    return
  }
  await run(() => store.removeItemVendor(itemCode, name as string))
}
</script>

<template>
  <Modal :title="v?.supplier_name || vendor" width="1120px" @close="emit('close')">
    <div v-if="store.error || localError" class="banner crit-banner" data-testid="vendor-error">
      <span>{{ localError || store.error }}</span>
      <button class="btn btn-ghost" @click="((localError = ''), store.clearError())">Dismiss</button>
    </div>

    <div v-if="!detail && store.loading" class="empty"><div class="label label-dim">Loading vendor…</div></div>
    <div v-else-if="!detail || !v" class="empty" data-testid="vendor-missing">
      <div class="display" style="font-size: 18px">Vendor not available</div>
      <div class="muted">{{ vendor }} could not be opened.</div>
      <button class="btn" @click="load">Try again</button>
    </div>

    <div v-else class="sheet" data-testid="vendor-sheet">
      <header class="vhead">
        <div>
          <div class="display vname">{{ v.supplier_name }}</div>
          <div class="label label-dim">
            {{ v.name }}<span v-if="v.supplier_group"> · {{ v.supplier_group }}</span><span v-if="v.account_number"> · our account {{ v.account_number }}</span>
          </div>
        </div>
        <div class="row">
          <span class="pill">{{ v.order_method || 'Email' }}</span>
          <span v-if="v.dropship_capable" class="pill pill-good">Drop-ship</span>
          <span class="pill" :class="v.active ? 'pill-accent' : 'pill-crit'" data-testid="vendor-state">{{ v.active ? 'Active' : 'Inactive' }}</span>
        </div>
      </header>

      <nav class="tabs">
        <button v-for="t in TABS" :key="t.key" class="chip" :class="{ active: tab === t.key }" :data-testid="`vendor-tab-${t.key}`" @click="tab = t.key">
          {{ t.label }}
          <span v-if="t.key === 'catalogue' && catalogue.length" class="count">{{ catalogue.length }}</span>
          <span v-if="t.key === 'orders' && detail.open_orders.length" class="count">{{ detail.open_orders.length }}</span>
        </button>
      </nav>

      <!-- profile -->
      <section v-if="tab === 'profile'" class="panel form" data-testid="vendor-profile">
        <div class="field span"><label class="label" for="vf-name">Vendor name</label><input id="vf-name" v-model="form.supplier_name" class="input" data-testid="vf-name" /></div>
        <div class="field">
          <label class="label" for="vf-group">Type</label>
          <select id="vf-group" v-model="form.supplier_group" class="input"><option value="Distributor">Distributor</option><option value="Brand Direct">Brand direct</option></select>
        </div>
        <div class="field">
          <label class="label" for="vf-method">Order by</label>
          <select id="vf-method" v-model="form.order_method" class="input" data-testid="vf-order-method"><option v-for="m in ORDER_METHODS" :key="m" :value="m">{{ m }}</option></select>
        </div>
        <div class="field"><label class="label" for="vf-lead">Lead time (days)</label><input id="vf-lead" v-model.number="form.lead_time_days" class="input" inputmode="numeric" data-testid="vf-lead" /></div>
        <div class="field"><label class="label" for="vf-moq">Minimum order value</label><input id="vf-moq" v-model.number="form.min_order_value" class="input" inputmode="decimal" /></div>
        <div class="field"><label class="label" for="vf-acct">Our account number with them</label><input id="vf-acct" v-model="form.account_number" class="input" placeholder="the number they know us by" /></div>
        <div class="field"><label class="label" for="vf-portal">Portal address</label><input id="vf-portal" v-model="form.portal_url" class="input" placeholder="https://" /></div>
        <div class="field"><label class="label" for="vf-rep">Rep</label><input id="vf-rep" v-model="form.rep_name" class="input" /></div>
        <div class="field"><label class="label" for="vf-phone">Rep phone</label><input id="vf-phone" v-model="form.rep_phone" class="input" inputmode="tel" /></div>
        <div class="field span"><label class="label" for="vf-email">Rep e-mail (where a purchase order is sent)</label><input id="vf-email" v-model="form.rep_email" class="input" inputmode="email" data-testid="vf-email" /></div>
        <label class="check span"><input v-model="form.dropship_capable" type="checkbox" data-testid="vf-dropship" /><span>Will drop-ship direct to a store</span></label>
        <div class="field span"><label class="label" for="vf-notes">Notes</label><textarea id="vf-notes" v-model="form.notes" class="input area" rows="3"></textarea></div>

        <div class="deact span">
          <div>
            <div class="section-title">{{ v.active ? 'Deactivate this vendor' : 'Reactivate this vendor' }}</div>
            <p class="muted">
              Vendors are never deleted. Deactivating keeps every order, receipt and negotiated price they have ever had — they simply stop appearing
              on the buying list.
            </p>
          </div>
          <template v-if="!confirming">
            <button v-if="v.active" class="btn btn-crit" :disabled="busy" data-testid="vendor-deactivate" @click="confirming = true">Deactivate…</button>
            <button v-else class="btn" :disabled="busy" data-testid="vendor-reactivate" @click="setActive(true)">Reactivate</button>
          </template>
          <div v-else class="row">
            <button class="btn btn-ghost" :disabled="busy" @click="confirming = false">Keep active</button>
            <button class="btn btn-crit" :disabled="busy" data-testid="vendor-deactivate-confirm" @click="setActive(false)">Yes, deactivate</button>
          </div>
        </div>
      </section>

      <!-- catalogue -->
      <section v-else-if="tab === 'catalogue'" class="panel" data-testid="vendor-catalogue">
        <p class="note">
          A cost saved here writes through to <b>{{ v.price_list }}</b
          >, this vendor's own buying price list, so the next purchase order picks it up. One vendor per item can be preferred — the star moves it.
        </p>
        <div v-if="!catalogue.length" class="empty">
          <div class="display" style="font-size: 18px">No items on this vendor yet</div>
          <div class="muted">Add them from the item's own vendor list — an item can sit on two vendors at different costs, which is what moving average is for.</div>
        </div>
        <div v-else class="tablewrap">
          <table class="table cat">
            <thead>
              <tr>
                <th>Item</th>
                <th>Their SKU</th>
                <th class="num">Cost</th>
                <th class="num">Case pack</th>
                <th class="num">MOQ</th>
                <th class="num">Lead</th>
                <th>Last bought</th>
                <th class="num">Preferred</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <!-- guarded: a row is only editable once its draft exists -->
              <template v-for="r in catalogue" :key="r.item_code">
              <tr v-if="rows[r.item_code]" :data-testid="`cat-${r.item_code}`">
                <td>
                  <div class="ellipsis" style="max-width: 184px">{{ r.item_name || r.item_code }}</div>
                  <div class="label label-dim">{{ r.item_code }}<span v-if="r.item_group"> · {{ r.item_group }}</span></div>
                </td>
                <td><input v-model="rows[r.item_code].vendor_sku" class="input cell wide" :aria-label="`Vendor SKU for ${r.item_code}`" /></td>
                <td class="num"><input v-model.number="rows[r.item_code].cost" class="input cell" inputmode="decimal" :aria-label="`Cost for ${r.item_code}`" :data-testid="`cat-cost-${r.item_code}`" /></td>
                <td class="num"><input v-model.number="rows[r.item_code].case_pack" class="input cell narrow" inputmode="numeric" :aria-label="`Case pack for ${r.item_code}`" /></td>
                <td class="num"><input v-model.number="rows[r.item_code].moq" class="input cell narrow" inputmode="numeric" :aria-label="`MOQ for ${r.item_code}`" /></td>
                <td class="num"><input v-model.number="rows[r.item_code].lead_time_days" class="input cell narrow" inputmode="numeric" :aria-label="`Lead time for ${r.item_code}`" /></td>
                <td>
                  <div class="muted">{{ r.last_purchase_date ? fmtDate(dayStamp(r.last_purchase_date)) : '—' }}</div>
                  <div class="label label-dim">{{ r.last_purchase_rate ? fmtMoney(r.last_purchase_rate) : '' }}</div>
                </td>
                <td class="num">
                  <button
                    class="star"
                    :class="{ on: r.is_preferred }"
                    :disabled="r.is_preferred || store.busy === r.item_code"
                    :title="r.is_preferred ? `${v.supplier_name} is the preferred vendor for this item` : `Make ${v.supplier_name} the preferred vendor for this item`"
                    :aria-pressed="r.is_preferred"
                    :data-testid="`cat-star-${r.item_code}`"
                    @click="prefer(r.item_code)"
                  >
                    ★
                  </button>
                </td>
                <td class="num rowacts">
                  <button v-if="rowDirty(r, rows[r.item_code])" class="btn compact" :disabled="store.busy === r.item_code" :data-testid="`cat-save-${r.item_code}`" @click="saveRow(r.item_code)">Save</button>
                  <button class="btn btn-ghost compact" :disabled="store.busy === r.item_code" :data-testid="`cat-remove-${r.item_code}`" @click="removeRow(r.item_code, r.name)">Remove</button>
                </td>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <!-- open orders -->
      <section v-else-if="tab === 'orders'" class="panel" data-testid="vendor-orders">
        <div v-if="!detail.open_orders.length" class="empty">
          <div class="display" style="font-size: 18px">No open orders</div>
          <div class="muted">Nothing is on its way from {{ v.supplier_name }} right now.</div>
        </div>
        <div v-else class="tablewrap">
          <table class="table">
            <thead>
              <tr><th>Order</th><th>Ordered</th><th>Expected</th><th>Status</th><th>Destination</th><th class="num">Net</th><th class="num">Landed</th><th class="num">Received</th></tr>
            </thead>
            <tbody>
              <tr v-for="o in detail.open_orders" :key="o.name">
                <td>{{ o.name }}</td>
                <td class="muted">{{ fmtDate(dayStamp(o.transaction_date)) }}</td>
                <td class="muted">{{ fmtDate(dayStamp(o.schedule_date)) }}</td>
                <td><span class="pill" :class="o.docstatus === 0 ? 'pill-accent' : 'pill-accent-fill'">{{ o.docstatus === 0 ? 'Draft' : o.status }}</span></td>
                <td><span v-if="o.dropship_store" class="pill pill-warn">{{ o.dropship_store }}</span><span v-else class="muted">{{ o.set_warehouse || 'HOU-WH' }}</span></td>
                <td class="num money">{{ fmtMoney(o.net_total, o.currency || 'USD') }}</td>
                <td class="num money accent">{{ fmtMoney(o.landed_total, o.currency || 'USD') }}</td>
                <td class="num">{{ Math.round(o.per_received) }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- receipts -->
      <section v-else-if="tab === 'receipts'" class="panel" data-testid="vendor-receipts">
        <div v-if="!detail.receipts.length" class="empty">
          <div class="display" style="font-size: 18px">Nothing received yet</div>
          <div class="muted">Receipts appear here as the warehouse books them in.</div>
        </div>
        <div v-else class="tablewrap">
          <table class="table">
            <thead>
              <tr><th>Receipt</th><th>Date</th><th>Warehouse</th><th class="num">Units</th><th class="num">Net</th><th class="num">Total</th></tr>
            </thead>
            <tbody>
              <tr v-for="r in detail.receipts" :key="r.name">
                <td>{{ r.name }}</td>
                <td class="muted">{{ fmtDate(dayStamp(r.posting_date)) }}</td>
                <td class="muted">{{ r.warehouse || '—' }}</td>
                <td class="num">{{ fmtInt(r.units) }}</td>
                <td class="num money">{{ fmtMoney(r.net_total) }}</td>
                <td class="num money accent">{{ fmtMoney(r.grand_total) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- spend -->
      <section v-else class="panel" data-testid="vendor-spend">
        <div class="label label-dim">Twelve months to today · since {{ detail.spend.since }}</div>
        <div class="stats">
          <div class="kpi"><span class="label">Spend received</span><span class="num v accent">{{ detail.spend.spend == null ? '—' : fmtMoney(detail.spend.spend) }}</span></div>
          <div class="kpi"><span class="label">Ordered</span><span class="num v">{{ detail.spend.ordered_value == null ? '—' : fmtMoney(detail.spend.ordered_value) }}</span></div>
          <div class="kpi"><span class="label">Freight</span><span class="num v">{{ detail.spend.freight == null ? '—' : fmtMoney(detail.spend.freight) }}</span></div>
          <div class="kpi"><span class="label">Orders</span><span class="num v">{{ detail.spend.orders == null ? '—' : fmtInt(detail.spend.orders) }}</span></div>
          <div class="kpi"><span class="label">Receipts</span><span class="num v">{{ detail.spend.receipts == null ? '—' : fmtInt(detail.spend.receipts) }}</span></div>
          <div class="kpi"><span class="label">Units</span><span class="num v">{{ detail.spend.units == null ? '—' : fmtInt(detail.spend.units) }}</span></div>
          <div class="kpi"><span class="label">Average lead time</span><span class="num v">{{ detail.spend.avg_lead_time_days == null ? '—' : `${detail.spend.avg_lead_time_days} d` }}</span></div>
          <div class="kpi"><span class="label">On time</span><span class="num v">{{ detail.spend.on_time_pct == null ? '—' : `${detail.spend.on_time_pct}%` }}</span></div>
        </div>
        <p class="muted note">
          Measured over {{ detail.spend.deliveries == null ? 'no' : detail.spend.deliveries }} deliveries. A vendor we have not bought from in the
          window has no figures at all — that is an em dash, not a zero.
        </p>
      </section>
    </div>

    <template #footer>
      <div v-if="detail" class="foot">
        <span v-if="tab === 'profile' && dirty" class="label warn">Unsaved changes</span>
        <span v-else></span>
        <div class="row">
          <button class="btn btn-ghost" @click="emit('close')">Close</button>
          <button v-if="tab === 'profile'" class="btn btn-primary" :disabled="busy || !dirty" data-testid="vendor-save" @click="save">{{ busy ? 'Saving…' : 'Save vendor' }}</button>
        </div>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 14px;
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
  gap: 10px;
  padding: 44px 16px;
  text-align: center;
}
.empty .muted {
  max-width: 56ch;
}
.vhead {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.vname {
  font-size: 22px;
}
.tabs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.count {
  margin-left: 8px;
  opacity: 0.7;
}
.panel {
  border-top: var(--line-w) solid var(--line);
  padding-top: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.span {
  grid-column: 1 / -1;
}
.check {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: var(--touch);
  cursor: pointer;
}
.area {
  min-height: 84px;
  padding: 12px 14px;
  line-height: 1.4;
  resize: vertical;
}
.deact {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
  padding: 14px;
  border: var(--line-w) solid var(--line-strong);
  background: var(--ground);
}
.deact p {
  margin-top: 6px;
  font-size: 13px;
  max-width: 62ch;
}
.note {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  max-width: 78ch;
}
.tablewrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.cat {
  min-width: 900px;
}
.cat td,
.cat th {
  white-space: nowrap;
}
.cell {
  width: 88px;
  min-height: 44px;
  text-align: right;
}
.cell.narrow {
  width: 68px;
}
.cell.wide {
  width: 120px;
  text-align: left;
}
.compact {
  min-height: 40px;
  padding: 0 12px;
  letter-spacing: 0.1em;
}
.star {
  min-width: 44px;
  min-height: 44px;
  font-size: 20px;
  color: var(--line-strong);
}
.star:hover:not(:disabled) {
  color: var(--accent);
}
.star.on {
  color: var(--accent);
  opacity: 1;
}
.star.on:disabled {
  opacity: 1;
  cursor: default;
}
.rowacts {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.money {
  font-family: var(--font-display);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 1px;
  background: var(--line);
  border: var(--line-w) solid var(--line);
}
.kpi {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px;
  background: var(--surface);
}
.kpi .v {
  font-size: 20px;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
}
@media (max-width: 767px) {
  .form,
  .stats {
    grid-template-columns: 1fr;
  }
  .stats {
    grid-template-columns: 1fr 1fr;
  }
}
</style>
