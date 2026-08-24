<script lang="ts">
/**
 * v1.0 "Procurement" §C + §D — **Buying**.
 *
 *   Suggest — the demand engine: what HOU-WH is short of, what the stores asked for that the
 *             warehouse cannot fill, and what is trending up. Quantity and vendor are editable on
 *             every row (the rates are already negotiated — locked decision 2, no RFQ), then
 *             "Create orders" groups the chosen lines into one draft order per vendor.
 *   Orders  — every purchase order with its status, freight, landed total and how much of it has
 *             actually arrived.
 *
 * Buying is centralised in Houston (locked decision 6): stores never raise an order, so the only
 * way a vendor delivers to a store is a drop-ship, chosen here before the order is created.
 */
import type { PurchaseOrderRow, Suggestion } from '@/api/purchasing'
import type { OrderPlan } from '../../buying'

/** The order-status filter, in the order a buyer works them. `all` is every order. */
export const ORDER_STATUSES = ['Draft', 'Open', 'To Receive', 'Completed', 'Closed', 'all'] as const

/** "Create 3 orders across 2 vendors" — the copy on the create button. */
export function planCopy(plan: Pick<OrderPlan, 'orders' | 'vendors'>): string {
  if (!plan.orders) return 'Nothing selected'
  const orders = `${plan.orders} order${plan.orders === 1 ? '' : 's'}`
  const vendors = `${plan.vendors} vendor${plan.vendors === 1 ? '' : 's'}`
  return `Create ${orders} across ${vendors}`
}

/** What the buyer is told after `create_orders` comes back. */
export function createdNotice(orders: string[]): string {
  if (!orders?.length) return 'No orders were created'
  if (orders.length === 1) return `Draft order ${orders[0]} created`
  return `${orders.length} draft orders created — ${orders.join(', ')}`
}

/**
 * Sort key for "low cover first". A row with a cover figure sorts by it; a row without one is
 * either out of stock (the most urgent thing on the list) or simply does not move (the least).
 */
export function coverRank(s: Pick<Suggestion, 'cover_days' | 'on_hand'>): number {
  const cover = Number(s.cover_days) || 0
  if (cover > 0) return cover
  return Number(s.on_hand) > 0 ? Number.POSITIVE_INFINITY : 0
}

export interface SuggestFilters {
  source?: string
  group?: string
  q?: string
}

/** Source chip, item-group chip and the search box, applied to one row. */
export function matchesSuggestion(s: Suggestion, filters: SuggestFilters): boolean {
  const source = filters.source && filters.source !== 'all' ? filters.source : ''
  if (source && !(s.sources?.length ? s.sources : [s.source]).includes(source)) return false
  if (filters.group && filters.group !== 'all' && (s.item_group || '') !== filters.group) return false
  const q = (filters.q || '').trim().toLowerCase()
  if (!q) return true
  return `${s.item_code} ${s.item_name || ''} ${s.barcode || ''} ${s.supplier_name || ''} ${s.supplier || ''}`.toLowerCase().includes(q)
}

/**
 * Units on an order row. The list endpoint serialises `order_dict(with_items=False)`, which
 * carries no line count — the screen prints an em dash rather than a wrong number.
 */
export function unitsOf(row: PurchaseOrderRow): number | null {
  const units = (row as PurchaseOrderRow & { units?: number }).units
  return typeof units === 'number' ? units : null
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
import { useRoute, useRouter } from 'vue-router'
import BuySuggestRow from './BuySuggestRow.vue'
import OrderSheet from './OrderSheet.vue'
import Modal from '@/components/Modal.vue'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import { fmtDate, fmtDateTime } from '@/utils/device'
import { fmtInt, fmtMoney } from '@/utils/money'

type Sub = 'suggest' | 'orders'

const props = withDefaults(defineProps<{ sub?: Sub; order?: string | null; selfOpen?: boolean }>(), { sub: 'suggest', order: null, selfOpen: true })
const emit = defineEmits<{ (e: 'notice', msg: string): void; (e: 'open-order', name: string): void }>()

const store = usePurchasingStore()
const wh = useWarehouseStore()
// the desk puts the open order in the URL as `?order=`; the board is also usable with no router
// at all (mounted on its own), so both are read defensively.
const route = useRoute() as ReturnType<typeof useRoute> | undefined
const router = useRouter() as ReturnType<typeof useRouter> | undefined
const deepLinked = () => props.order || (typeof route?.query?.order === 'string' ? route.query.order : null)

const tab = ref<Sub>(props.sub)
// suggest
const source = ref('all')
const group = ref('all')
const q = ref('')
const dropTo = ref('')
const dismissing = ref<Suggestion | null>(null)
const dismissReason = ref('')
const created = ref<string[]>([])
// orders
const status = ref<string>('all')
const vendorFilter = ref('')
const storeFilter = ref('')
const from = ref('')
const to = ref('')
const vendorOpts = ref<{ name: string; label: string }[]>([])
const openOrder = ref<string | null>(null)

const stores = computed(() => wh.me?.stores || [])
const rows = computed(() => store.openSuggestions)
const groups = computed(() => [...new Set(rows.value.map((s) => s.item_group || '').filter(Boolean))].sort())
const sources = computed(() => [...new Set(rows.value.flatMap((s) => (s.sources?.length ? s.sources : [s.source])).filter(Boolean))])
const visible = computed(() =>
  rows.value
    .filter((s) => matchesSuggestion(s, { source: source.value, group: group.value, q: q.value }))
    .sort((a, b) => coverRank(a) - coverRank(b) || (b.store_demand || 0) - (a.store_demand || 0) || a.item_code.localeCompare(b.item_code))
)
// a plain key read, so the header tick tracks the basket (see the note in BuySuggestRow)
const allPicked = computed(() => visible.value.length > 0 && visible.value.every((s) => !!store.selection[s.item_code]))
const plan = computed(() => store.plan)
const orders = computed(() => store.orders)

function say(msg: string) {
  if (msg) emit('notice', msg)
}
/** Store actions never throw: they set `notice` on success and `error` on failure. */
function drain() {
  if (store.notice) {
    say(store.notice)
    store.clearNotice()
  }
}

async function loadSuggest(refresh = false) {
  await store.loadSuggestions(refresh)
  if (refresh) drain()
}
async function loadOrders() {
  const out = await store.loadOrders({
    status: status.value,
    supplier: vendorFilter.value || undefined,
    store: storeFilter.value || undefined,
    from: from.value || undefined,
    to: to.value || undefined
  })
  if (out && !vendorFilter.value) {
    const seen = new Map<string, string>()
    for (const o of out.orders) seen.set(o.supplier, o.supplier_name || o.supplier)
    vendorOpts.value = [...seen].map(([name, label]) => ({ name, label })).sort((a, b) => a.label.localeCompare(b.label))
  }
}
function reload() {
  if (tab.value === 'orders') void loadOrders()
  else void loadSuggest()
}

onMounted(() => {
  const deep = deepLinked()
  if (deep) {
    tab.value = 'orders'
    openOrder.value = deep
  }
  reload()
})
watch([() => props.order, () => route?.query?.order], () => {
  const deep = deepLinked()
  if (deep && deep !== openOrder.value) {
    tab.value = 'orders'
    openOrder.value = deep
  }
})
watch(() => props.sub, (s) => (tab.value = s))
watch(tab, reload)
watch([status, vendorFilter, storeFilter, from, to], () => {
  if (tab.value === 'orders') void loadOrders()
})

// ------------------------------------------------------------------ suggest actions
function toggleAll() {
  if (allPicked.value) for (const s of visible.value) store.deselect(s.item_code)
  else for (const s of visible.value) store.select(s.item_code)
}

async function createOrders() {
  const lines = store.selectedLines.map((l) => ({
    item_code: l.item_code,
    qty: l.qty,
    supplier: l.supplier,
    rate: l.rate,
    suggestion: l.suggestion ?? null,
    dropship_store: dropTo.value || null
  }))
  const out = await store.createOrders(lines)
  if (!out) return
  store.clearNotice()
  created.value = out.orders
  dropTo.value = ''
  say(createdNotice(out.orders))
}

async function dismiss() {
  const row = dismissing.value
  if (!row) return
  const out = await store.dismissSuggestion(row.name, dismissReason.value.trim() || undefined)
  if (out) {
    dismissing.value = null
    dismissReason.value = ''
    drain()
  }
}

function openRow(name: string) {
  emit('open-order', name)
  if (props.selfOpen) openOrder.value = name
}
function openCreated(name: string) {
  created.value = []
  openRow(name)
}

const statusTone = (row: { docstatus: number; status: string }) =>
  row.docstatus === 0 ? 'pill-accent' : row.status === 'Completed' ? 'pill-good' : ['Closed', 'Cancelled'].includes(row.status) ? 'pill-crit' : 'pill-accent-fill'

/** An order changed inside the sheet — keep the list underneath honest. */
function onOrderChanged() {
  if (tab.value === 'orders') void loadOrders()
}

/** Closing the sheet drops `?order=` again, so a reload does not reopen it. */
function closeOrderSheet() {
  openOrder.value = null
  if (router && route && route.query.order) {
    const query = { ...route.query }
    delete query.order
    void router.replace({ query })
  }
}
</script>

<template>
  <div class="board" data-testid="buying-board">
    <div class="subnav">
      <button class="chip" :class="{ active: tab === 'suggest' }" data-testid="buy-tab-suggest" @click="tab = 'suggest'">Suggest</button>
      <button class="chip" :class="{ active: tab === 'orders' }" data-testid="buy-tab-orders" @click="tab = 'orders'">Orders</button>
      <div class="spacer"></div>
      <span v-if="tab === 'suggest' && store.asOf" class="label label-dim">List built {{ fmtDateTime(store.asOf) }}</span>
      <button v-if="tab === 'suggest'" class="btn" :disabled="store.loading" data-testid="buy-refresh" @click="loadSuggest(true)">
        {{ store.loading ? 'Working…' : 'Refresh list' }}
      </button>
      <button v-else class="btn" :disabled="store.loading" data-testid="orders-refresh" @click="loadOrders">{{ store.loading ? 'Working…' : 'Refresh' }}</button>
    </div>

    <div v-if="store.error" class="banner crit-banner" data-testid="buying-error">
      <span>{{ store.error }}</span>
      <div class="row">
        <button class="btn btn-ghost" @click="reload">Try again</button>
        <button class="btn btn-ghost" @click="store.clearError()">Dismiss</button>
      </div>
    </div>

    <!-- ============================================================ suggest -->
    <section v-if="tab === 'suggest'" class="panel">
      <div class="filters">
        <div class="seg">
          <button class="chip" :class="{ active: source === 'all' }" @click="source = 'all'">All sources</button>
          <button v-for="s in sources" :key="s" class="chip" :class="{ active: source === s }" :data-testid="`buy-source-${s}`" @click="source = s">{{ s }}</button>
        </div>
        <select v-model="group" class="input sel" aria-label="Item group">
          <option value="all">All groups</option>
          <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
        </select>
        <input v-model="q" class="input search" placeholder="Search item, code or vendor" data-testid="buy-search" />
      </div>

      <div v-if="created.length" class="banner good-banner" data-testid="buy-created">
        <span>{{ createdNotice(created) }}</span>
        <div class="row">
          <button class="btn" data-testid="buy-open-created" @click="openCreated(created[0])">Open {{ created[0] }}</button>
          <button class="btn btn-ghost" @click="created = []">Dismiss</button>
        </div>
      </div>

      <div v-if="rows.length" class="selectall">
        <label class="allbox">
          <input type="checkbox" :checked="allPicked" data-testid="buy-select-all" @change="toggleAll" />
          <span class="label">{{ allPicked ? 'Clear all' : 'Select all' }}<span class="label-dim"> · {{ visible.length }} of {{ rows.length }} shown</span></span>
        </label>
        <button v-if="store.selectedCount" class="btn btn-ghost" @click="store.clearSelection()">Clear {{ store.selectedCount }} selected</button>
      </div>

      <div v-if="store.loading && !rows.length" class="empty"><div class="label label-dim">Building the buying list…</div></div>
      <div v-else-if="!rows.length" class="empty" data-testid="buy-empty">
        <div class="display" style="font-size: 18px">Nothing to buy</div>
        <div class="muted">No item is under its reorder level, no store is waiting on stock the warehouse cannot ship, and nothing is trending up.</div>
        <button class="btn" @click="loadSuggest(true)">Rebuild the list</button>
      </div>
      <div v-else-if="!visible.length" class="empty" data-testid="buy-empty-filtered">
        <div class="display" style="font-size: 18px">No row matches those filters</div>
        <div class="muted">{{ rows.length }} item{{ rows.length === 1 ? '' : 's' }} are on the list — widen the search or clear the source filter.</div>
        <button class="btn" @click="((source = 'all'), (group = 'all'), (q = ''))">Clear filters</button>
      </div>
      <div v-else class="rows">
        <BuySuggestRow v-for="s in visible" :key="s.name" :suggestion="s" :disabled="!store.allowed && !!wh.me" @dismiss="((dismissing = $event), (dismissReason = ''))" />
      </div>

      <div v-if="rows.length" class="footbar" data-testid="buy-footer">
        <div class="totals">
          <div class="tot"><span class="label">Selected</span><span class="num v">{{ fmtInt(store.selectedCount) }}</span></div>
          <div class="tot"><span class="label">Units</span><span class="num v">{{ fmtInt(plan.units) }}</span></div>
          <div class="tot"><span class="label">Value</span><span class="num v accent">{{ fmtMoney(plan.value) }}</span></div>
        </div>
        <div class="ship" :class="{ 'hide-empty': !plan.orders && !dropTo }">
          <select v-model="dropTo" class="input sel" aria-label="Deliver to" data-testid="buy-dropship">
            <option value="">Deliver to Houston warehouse</option>
            <option v-for="s in stores" :key="s" :value="s">Drop-ship direct to {{ s }}</option>
          </select>
          <span v-if="dropTo" class="label warn">The whole order goes to {{ dropTo }}, not Houston.</span>
        </div>
        <button class="btn btn-primary btn-big" :disabled="!plan.orders || store.busy === 'create-orders'" data-testid="buy-create" @click="createOrders">
          {{ store.busy === 'create-orders' ? 'Creating…' : planCopy(plan) }}
        </button>
      </div>
    </section>

    <!-- ============================================================ orders -->
    <section v-else class="panel">
      <div class="filters">
        <div class="seg">
          <button v-for="s in ORDER_STATUSES" :key="s" class="chip" :class="{ active: status === s }" :data-testid="`order-status-${s}`" @click="status = s">
            {{ s === 'all' ? 'All' : s }}
          </button>
        </div>
        <select v-model="vendorFilter" class="input sel" aria-label="Vendor" data-testid="orders-vendor">
          <option value="">All vendors</option>
          <option v-for="v in vendorOpts" :key="v.name" :value="v.name">{{ v.label }}</option>
        </select>
        <select v-model="storeFilter" class="input sel" aria-label="Drop-ship store" data-testid="orders-store">
          <option value="">Any destination</option>
          <option v-for="s in stores" :key="s" :value="s">Drop-ship to {{ s }}</option>
        </select>
        <div class="dates">
          <label class="label" for="ord-from">From</label>
          <input id="ord-from" v-model="from" class="input date" type="date" data-testid="orders-from" />
          <label class="label" for="ord-to">To</label>
          <input id="ord-to" v-model="to" class="input date" type="date" data-testid="orders-to" />
          <button v-if="from || to" class="btn btn-ghost" @click="((from = ''), (to = ''))">Clear dates</button>
        </div>
      </div>

      <div v-if="store.loading && !orders.length" class="empty"><div class="label label-dim">Loading orders…</div></div>
      <div v-else-if="!orders.length" class="empty" data-testid="orders-empty">
        <div class="display" style="font-size: 18px">No purchase orders here</div>
        <div class="muted">Nothing matches this filter. Orders are created from the Suggest tab, one per vendor.</div>
        <button class="btn" @click="tab = 'suggest'">Go to Suggest</button>
      </div>
      <div v-else class="tablewrap">
        <table class="table orders">
          <thead>
            <tr>
              <th>Order</th>
              <th>Vendor</th>
              <th>Ordered</th>
              <th>Expected</th>
              <th>Status</th>
              <th>Destination</th>
              <th class="num">Units</th>
              <th class="num">Net</th>
              <th class="num">Freight</th>
              <th class="num">Landed</th>
              <th>Received</th>
              <th>Sent</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="o in orders" :key="o.name" class="orow" :data-testid="`order-${o.name}`" @click="openRow(o.name)">
              <td><button class="link" :data-testid="`open-order-${o.name}`" @click.stop="openRow(o.name)">{{ o.name }}</button></td>
              <td><div class="ellipsis" style="max-width: 200px">{{ o.supplier_name || o.supplier }}</div><div class="label label-dim">{{ o.supplier }}</div></td>
              <td class="muted">{{ fmtDate(dayStamp(o.transaction_date)) }}</td>
              <td class="muted">{{ fmtDate(dayStamp(o.schedule_date)) }}</td>
              <td><span class="pill" :class="statusTone(o)">{{ o.docstatus === 0 ? 'Draft' : o.status }}</span></td>
              <td>
                <span v-if="o.dropship_store" class="pill pill-warn">{{ o.dropship_store }}</span>
                <span v-else class="muted">{{ o.set_warehouse || 'HOU-WH' }}</span>
              </td>
              <td class="num" :class="{ dim: unitsOf(o) === null }">{{ unitsOf(o) === null ? '—' : fmtInt(unitsOf(o) as number) }}</td>
              <td class="num money">{{ fmtMoney(o.net_total, o.currency || 'USD') }}</td>
              <td class="num money" :class="{ dim: !o.freight }">{{ o.freight ? fmtMoney(o.freight, o.currency || 'USD') : '—' }}</td>
              <td class="num money accent">{{ fmtMoney(o.landed_total, o.currency || 'USD') }}</td>
              <td>
                <div class="bar" role="progressbar" :aria-valuenow="Math.round(o.per_received)" aria-valuemin="0" aria-valuemax="100">
                  <i :style="{ width: Math.min(100, Math.max(0, o.per_received)) + '%' }"></i>
                </div>
                <div class="label label-dim">{{ Math.round(o.per_received) }}%</div>
              </td>
              <td>
                <span v-if="o.sent_on" class="good label">{{ o.sent_method }}</span>
                <span v-else class="label label-dim">Not sent</span>
                <div v-if="o.sent_on" class="label label-dim">{{ fmtDateTime(o.sent_on) }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <Modal v-if="dismissing" :title="`Dismiss ${dismissing.item_code}`" @close="dismissing = null">
      <div class="muted" style="margin-bottom: 12px">
        {{ dismissing.item_name || dismissing.item_code }} leaves the buying list. It comes back on the next run if the demand is still there.
      </div>
      <div class="field">
        <label class="label" for="dismiss-reason">Reason (kept on the suggestion)</label>
        <input id="dismiss-reason" v-model="dismissReason" class="input" placeholder="e.g. discontinued — selling through the 20K instead" data-testid="dismiss-reason" />
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="dismissing = null">Keep it</button>
        <button class="btn btn-crit" :disabled="store.busy === dismissing.name" data-testid="dismiss-confirm" @click="dismiss">Dismiss suggestion</button>
      </template>
    </Modal>

    <OrderSheet
      v-if="openOrder"
      :order="openOrder"
      @close="closeOrderSheet"
      @notice="say"
      @changed="onOrderChanged"
    />
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.subnav {
  display: flex;
  align-items: center;
  gap: 8px;
}
.spacer {
  flex: 1;
}
.panel {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.filters {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.seg {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.sel {
  width: 210px;
}
.search {
  width: 260px;
  flex: 1 1 200px;
  max-width: 360px;
}
.dates {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.date {
  width: 168px;
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
.good-banner {
  border-left: 3px solid var(--good);
  background: rgba(127, 169, 138, 0.1);
  color: var(--good);
}
.selectall {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.allbox {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: var(--touch);
  cursor: pointer;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
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
.footbar {
  position: sticky;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 18px;
  flex-wrap: wrap;
  padding: 14px 16px;
  border: var(--line-w) solid var(--line-strong);
  background: var(--surface-2);
}
.totals {
  display: flex;
  gap: 22px;
}
.tot {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.tot .v {
  font-size: 20px;
}
.ship {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-left: auto;
}
.ship .sel {
  width: 268px;
}
.tablewrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
}
.orders {
  min-width: 1180px;
}
/* an order number, a date or a total that wraps is unreadable — the table scrolls instead */
.orders th,
.orders td {
  white-space: nowrap;
}
.orow {
  cursor: pointer;
}
.orow:hover td {
  background: var(--surface-2);
}
.link {
  color: var(--accent);
  min-height: 0;
  min-width: 0;
  padding: 0;
  font-weight: 500;
}
.money {
  font-family: var(--font-display);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.bar {
  width: 90px;
  height: 4px;
  background: var(--line-strong);
}
.bar > i {
  display: block;
  height: 100%;
  background: var(--accent);
}
@media (max-width: 767px) {
  .sel,
  .search,
  .date,
  .ship .sel {
    width: 100%;
    max-width: none;
  }
  /* the floor manager works this one-handed: the footer stays a footer, not half the screen */
  .footbar {
    gap: 10px;
    padding: 10px 12px;
  }
  .totals {
    gap: 18px;
  }
  .tot .v {
    font-size: 16px;
  }
  .ship {
    margin-left: 0;
    width: 100%;
  }
  .ship.hide-empty {
    display: none;
  }
  .footbar .btn-big {
    width: 100%;
    min-height: 52px;
  }
}
</style>
