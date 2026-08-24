<script setup lang="ts">
/**
 * v0.6 P — Warehouse Admin desk (`/warehouse`): requests (approve / edit / reject), shipments,
 * discrepancies, stock on hand at the main warehouse (+ low stock), inbound vendor POs with scan receive.
 * Same bundle as the POS; role-gated through `shipping.me` (and on every endpoint server-side).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { warehouseApi, type Discrepancy, type PurchaseOrder, type ReplenishmentRequest, type Shipment, type WarehouseStockRow } from '@/api/warehouse'
import { useWarehouseStore } from '@/stores/warehouse'
import { installWedgeListener } from '@/scan/wedge'
import { fmtDateTime } from '@/utils/device'
import { setSiteTimeZone } from '@/utils/time' // v0.6 R
import { fmtMoney } from '@/utils/money'
import { ageTier, fmtAge, liveAge, sortCards, type WallCard } from '../wall'
import ApproveSheet from '../components/ApproveSheet.vue'
import ShipmentSheet from '../components/ShipmentSheet.vue'
import CountSheet, { type Counted } from '../components/CountSheet.vue'
import Modal from '@/components/Modal.vue'

type Tab = 'requests' | 'shipments' | 'discrepancies' | 'stock' | 'vendor'
const TABS: { key: Tab; label: string }[] = [
  { key: 'requests', label: 'Requests' },
  { key: 'shipments', label: 'Shipments' },
  { key: 'discrepancies', label: 'Discrepancies' },
  { key: 'stock', label: 'Stock' },
  { key: 'vendor', label: 'Vendor POs' }
]

const wh = useWarehouseStore()
const route = useRoute()
const router = useRouter()
const tab = ref<Tab>((route.params.tab as Tab) || 'requests')
const now = ref(Date.now())
let tick: number | null = null

const requests = ref<ReplenishmentRequest[]>([])
const reqFilter = ref<'open' | 'all' | 'Approved' | 'Rejected'>('open')
const shipments = ref<Shipment[]>([])
const shFilter = ref<'open' | 'Shipped' | 'Received' | 'all'>('open')
const discrepancies = ref<Discrepancy[]>([])
const dFilter = ref<'Open' | 'Resolved' | 'all'>('Open')
const stock = ref<{ warehouse: string; rows: WarehouseStockRow[]; total: number; low: number } | null>(null)
const stockQ = ref('')
const lowOnly = ref(false)
const pos = ref<PurchaseOrder[]>([])
const openRequest = ref<string | null>(null)
const openShipment = ref<string | null>(null)
const openPo = ref<PurchaseOrder | null>(null)
const resolving = ref<Discrepancy | null>(null)
const resolution = ref<'Write off' | 'Returned to warehouse' | 'Re-ship' | 'Accepted'>('Accepted')
const resolveNotes = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')

const filteredStock = computed(() => (stock.value?.rows || []).filter((r) => !lowOnly.value || r.low))
const store = computed(() => route.query.store as string | undefined)

async function load() {
  if (!wh.allowed) return
  loading.value = true
  error.value = ''
  try {
    if (tab.value === 'requests') requests.value = (await warehouseApi.admin.requests(reqFilter.value, store.value)).requests
    else if (tab.value === 'shipments') shipments.value = (await warehouseApi.admin.shipments(shFilter.value, store.value)).shipments
    else if (tab.value === 'discrepancies') discrepancies.value = (await warehouseApi.admin.discrepancies(dFilter.value, store.value)).discrepancies
    else if (tab.value === 'stock') stock.value = await warehouseApi.admin.warehouse_stock(stockQ.value)
    else if (tab.value === 'vendor') pos.value = (await warehouseApi.admin.vendor_pos()).purchase_orders
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
function go(t: Tab) {
  tab.value = t
  void router.replace({ name: 'warehouse', params: { tab: t }, query: route.query })
}
watch([tab, reqFilter, shFilter, dFilter, lowOnly], () => void load())
watch(
  () => wh.wall?.server_time,
  () => void load()
)
function say(msg: string) {
  notice.value = msg
  setTimeout(() => {
    if (notice.value === msg) notice.value = ''
  }, 6000)
}
function onApproved(shipment?: string) {
  if (shipment) say(`Shipment ${shipment} created — it is on the wall`)
  void load()
}
async function resolve() {
  if (!resolving.value) return
  busy.value = true
  try {
    const out = await warehouseApi.admin.resolve_discrepancy(resolving.value.name, resolution.value, resolveNotes.value || undefined)
    say(out.reship_request ? `Resolved · re-ship request ${out.reship_request}` : `Resolved ${out.name}`)
    resolving.value = null
    resolveNotes.value = ''
    await load()
    void wh.refresh(true)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function receivePo(counts: Counted[]) {
  if (!openPo.value) return
  busy.value = true
  try {
    const out = await warehouseApi.admin.receive_vendor_po(
      openPo.value.name,
      counts.filter((c) => c.received > 0).map((c) => ({ name: c.key, item_code: c.item_code, qty: c.received }))
    )
    say(`Purchase Receipt ${out.purchase_receipt} posted (${out.lines.length} lines)`)
    openPo.value = null
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
const wedge = (cb: (code: string) => void) => installWedgeListener(cb)
const cardFor = (s: Shipment) => ({ ...s, kind: 'shipment' }) as WallCard

onMounted(async () => {
  await wh.loadMe()
  setSiteTimeZone(wh.me?.time_zone) // v0.6 R — desk timestamps on the site clock
  if (wh.allowed) {
    wh.start(false)
    await load()
  }
  tick = window.setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  wh.stop()
  if (tick) window.clearInterval(tick)
})
</script>

<template>
  <div class="desk" data-testid="warehouse-desk">
    <header class="head">
      <div class="wordmark display-900">{{ wh.brand.wordmark_text }}</div>
      <div class="vline"></div>
      <div>
        <div class="title">Warehouse</div>
        <div class="label label-dim">{{ wh.me?.main_warehouse || 'HOU-WH' }}</div>
      </div>
      <nav class="nav">
        <button v-for="t in TABS" :key="t.key" class="nav-btn" :class="{ active: tab === t.key }" :data-testid="`tab-${t.key}`" @click="go(t.key)">
          {{ t.label }}
          <span v-if="t.key === 'requests' && wh.wall?.counts.pending_approval" class="badge">{{ wh.wall.counts.pending_approval }}</span>
          <span v-if="t.key === 'discrepancies' && wh.wall?.open_discrepancies" class="badge crit">{{ wh.wall.open_discrepancies }}</span>
        </button>
      </nav>
      <div class="spacer"></div>
      <a class="btn" href="/warehouse-wall" target="_blank" rel="noopener">Open wall</a>
      <div class="user">
        <div class="ellipsis">{{ wh.me?.full_name || wh.me?.user }}</div>
        <div class="label label-dim">{{ wh.me?.warehouse_admin ? 'Warehouse admin' : 'Head office' }}</div>
      </div>
      <span class="pill" :class="wh.connected ? 'pill-accent' : 'pill-warn'">{{ wh.connected ? 'Live' : 'Polling' }}</span>
      <a class="lock label" href="/?cmd=web_logout">Sign out</a>
    </header>

    <div v-if="wh.meError || (wh.me && !wh.allowed)" class="gate" data-testid="desk-gate">
      <div class="display" style="font-size: 22px">Warehouse admin role required</div>
      <div class="muted">{{ wh.meError || `${wh.me?.user} is not an AWANZ Warehouse Admin` }}</div>
      <a class="btn" href="/login?redirect-to=/warehouse">Sign in as another user</a>
    </div>

    <div v-else class="body">
      <div v-if="wh.wall" class="kpis">
        <div class="kpi"><div class="label">Pending approval</div><div class="num v">{{ wh.wall.counts.pending_approval }}</div></div>
        <div class="kpi"><div class="label">To pick / pack</div><div class="num v">{{ wh.wall.counts.to_pick + wh.wall.counts.packing }}</div></div>
        <div class="kpi"><div class="label">Ready to ship</div><div class="num v">{{ wh.wall.counts.ready }}</div></div>
        <div class="kpi"><div class="label">In transit</div><div class="num v">{{ wh.wall.in_transit }}</div></div>
        <div class="kpi"><div class="label">Discrepancies</div><div class="num v" :class="{ warn: wh.wall.open_discrepancies }">{{ wh.wall.open_discrepancies }}</div></div>
      </div>
      <div v-if="error" class="crit" style="margin-bottom: 12px" data-testid="desk-error">{{ error }}</div>
      <div v-if="notice" class="good" style="margin-bottom: 12px" data-testid="desk-notice">{{ notice }}</div>

      <!-- requests -->
      <section v-if="tab === 'requests'" class="card block">
        <div class="between">
          <div class="section-title">Replenishment requests<span v-if="store" class="muted"> · {{ store }}</span></div>
          <div class="row">
            <div class="seg">
              <button v-for="f in ['open', 'Approved', 'Rejected', 'all']" :key="f" class="chip" :class="{ active: reqFilter === f }" @click="reqFilter = f as typeof reqFilter">{{ f === 'open' ? 'Pending' : f }}</button>
            </div>
            <button class="btn" :disabled="loading" @click="load">Refresh</button>
          </div>
        </div>
        <div v-if="!requests.length" class="label label-dim" style="padding: 12px 0">No requests.</div>
        <table v-else class="table">
          <thead>
            <tr><th>Request</th><th>Store</th><th class="num">Items</th><th class="num">Units</th><th>Priority</th><th>Waiting</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <!-- v0.8 QA W-D2: the age comes from the server (`age_seconds`) and ticks locally, exactly
                 like the Shipments tab and the wall. Parsing the zone-less `requested_at` string in the
                 browser's zone made every fresh request amber (and the two screens disagree). -->
            <tr v-for="r in sortCards(requests.map((x) => ({ ...x, age_seconds: liveAge(x, wh.fetchedAt, now) })))" :key="r.name" :data-testid="`req-${r.name}`">
              <td><div>{{ r.name }}</div><div class="label label-dim">{{ r.requested_at ? fmtDateTime(r.requested_at) : '' }}</div></td>
              <td><div class="display" style="font-size: 14px">{{ r.boutique }}</div><div class="label label-dim ellipsis" style="max-width: 180px">{{ r.boutique_name }}</div></td>
              <td class="num">{{ r.items }}</td>
              <td class="num">{{ r.units }}<span v-if="r.status === 'Approved' && r.units_approved !== r.units" class="muted"> → {{ r.units_approved }}</span></td>
              <td><span v-if="r.priority !== 'Normal'" class="pill pill-warn">⚑ {{ r.priority }}</span><span v-else class="muted">Normal</span></td>
              <td class="num" :class="ageTier(r.age_seconds || 0, wh.wall?.warn_seconds, wh.wall?.crit_seconds)">{{ r.status === 'Pending Approval' ? fmtAge(r.age_seconds || 0) : '—' }}</td>
              <td><span class="pill" :class="r.status === 'Pending Approval' ? 'pill-accent' : r.status === 'Rejected' ? 'pill-crit' : 'pill-good'">{{ r.status }}</span></td>
              <td class="num">
                <button v-if="r.status === 'Pending Approval'" class="btn btn-primary" :data-testid="`review-${r.name}`" @click="openRequest = r.name">Review</button>
                <button v-else-if="r.shipment" class="btn" @click="openShipment = r.shipment">{{ r.shipment }}</button>
                <button v-else class="btn btn-ghost" @click="openRequest = r.name">View</button>
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- shipments -->
      <section v-if="tab === 'shipments'" class="card block">
        <div class="between">
          <div class="section-title">Shipments</div>
          <div class="row">
            <div class="seg">
              <button v-for="f in ['open', 'Shipped', 'Received', 'all']" :key="f" class="chip" :class="{ active: shFilter === f }" @click="shFilter = f as typeof shFilter">{{ f === 'open' ? 'Open' : f }}</button>
            </div>
            <button class="btn" :disabled="loading" @click="load">Refresh</button>
          </div>
        </div>
        <div v-if="!shipments.length" class="label label-dim" style="padding: 12px 0">No shipments.</div>
        <table v-else class="table">
          <thead>
            <tr><th>Shipment</th><th>Store</th><th class="num">Units</th><th>Carrier</th><th>Tracking</th><th>Age</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="s in shipments" :key="s.name" :data-testid="`sh-${s.name}`">
              <td><div>{{ s.name }}</div><div class="label label-dim">{{ s.created_at ? fmtDateTime(s.created_at) : '' }}</div></td>
              <td><div class="display" style="font-size: 14px">{{ s.boutique }}<span v-if="s.priority && s.priority !== 'Normal'" class="accent"> ⚑</span></div><div class="label label-dim ellipsis" style="max-width: 180px">{{ s.boutique_name }}</div></td>
              <td class="num">{{ s.units }}<span v-if="s.units_picked && s.units_picked !== s.units" class="muted"> · {{ s.units_picked }} picked</span></td>
              <td><span v-if="s.carrier">{{ s.carrier }} {{ s.service }}<div class="label label-dim">{{ fmtMoney(s.rate_amount || 0) }} · {{ s.rate_days }} d</div></span><span v-else class="muted">—</span></td>
              <td><span v-if="s.tracking_no">{{ s.tracking_no }}<div class="label label-dim">{{ s.tracking_status }}</div></span><span v-else class="muted">—</span></td>
              <td class="num" :class="ageTier(liveAge(cardFor(s), wh.fetchedAt, now), wh.wall?.warn_seconds, wh.wall?.crit_seconds)">{{ ['Received', 'Cancelled'].includes(s.status) ? '—' : fmtAge(liveAge(cardFor(s), wh.fetchedAt, now)) }}</td>
              <td><span class="pill" :class="s.status === 'Received' ? 'pill-good' : s.status === 'Cancelled' ? 'pill-crit' : s.status === 'Shipped' ? 'pill-accent-fill' : 'pill-accent'">{{ s.status }}</span></td>
              <td class="num"><button class="btn" :data-testid="`open-${s.name}`" @click="openShipment = s.name">Open</button></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- discrepancies -->
      <section v-if="tab === 'discrepancies'" class="card block">
        <div class="between">
          <div class="section-title">Receiving discrepancies</div>
          <div class="row">
            <div class="seg">
              <button v-for="f in ['Open', 'Resolved', 'all']" :key="f" class="chip" :class="{ active: dFilter === f }" @click="dFilter = f as typeof dFilter">{{ f }}</button>
            </div>
            <button class="btn" :disabled="loading" @click="load">Refresh</button>
          </div>
        </div>
        <div v-if="!discrepancies.length" class="label label-dim" style="padding: 12px 0">No discrepancies.</div>
        <table v-else class="table">
          <thead>
            <tr><th>Discrepancy</th><th>Shipment · Store</th><th>Item</th><th>Type</th><th class="num">Shipped</th><th class="num">Received</th><th class="num">Qty</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="d in discrepancies" :key="d.name" :data-testid="`disc-${d.name}`">
              <td><div>{{ d.name }}</div><div class="label label-dim">{{ d.reported_at ? fmtDateTime(d.reported_at) : '' }} · {{ d.reported_by }}</div></td>
              <td><button class="link" @click="openShipment = d.shipment">{{ d.shipment }}</button><div class="label label-dim">{{ d.boutique }}</div></td>
              <td><div class="ellipsis" style="max-width: 220px">{{ d.item_name || d.item_code }}</div><div class="label label-dim">{{ d.item_code }}</div></td>
              <td><span class="pill" :class="d.type === 'Short' ? 'pill-crit' : 'pill-warn'">{{ d.type }}</span></td>
              <td class="num">{{ d.shipped_qty }}</td>
              <td class="num">{{ d.received_qty }}<span v-if="d.damaged_qty" class="muted"> +{{ d.damaged_qty }} dmg</span></td>
              <td class="num" :class="d.type === 'Short' ? 'crit' : 'warn'">{{ d.type === 'Short' ? d.short_qty : d.type === 'Damaged' ? d.damaged_qty : d.over_qty }}</td>
              <td><span class="pill" :class="d.status === 'Open' ? 'pill-warn' : 'pill-good'">{{ d.status }}</span><div v-if="d.resolution" class="label label-dim">{{ d.resolution }}</div></td>
              <td class="num"><button v-if="d.status === 'Open'" class="btn" :data-testid="`resolve-${d.name}`" @click="resolving = d">Resolve</button></td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- stock -->
      <section v-if="tab === 'stock'" class="card block">
        <div class="between">
          <div class="section-title">Stock on hand · {{ stock?.warehouse || wh.me?.main_warehouse }}<span v-if="stock" class="muted"> · {{ stock.total }} items · <span :class="{ warn: stock.low }">{{ stock.low }} low</span></span></div>
          <div class="row">
            <input v-model="stockQ" class="input" placeholder="Search item / barcode" style="width: 240px" data-testid="stock-search" @keydown.enter="load" />
            <button class="chip" :class="{ active: lowOnly }" @click="lowOnly = !lowOnly">Low stock only</button>
            <button class="btn" :disabled="loading" @click="load">Search</button>
          </div>
        </div>
        <div v-if="!filteredStock.length" class="label label-dim" style="padding: 12px 0">No stock rows.</div>
        <table v-else class="table">
          <thead>
            <tr><th>Item</th><th>Group</th><th class="num">On hand</th><th class="num">Reserved</th><th class="num">Projected</th><th class="num">Reorder</th></tr>
          </thead>
          <tbody>
            <tr v-for="r in filteredStock" :key="r.item_code" :class="{ low: r.low }" :data-testid="`stock-${r.item_code}`">
              <td><div class="ellipsis" style="max-width: 360px">{{ r.item_name || r.item_code }}</div><div class="label label-dim">{{ r.item_code }}<span v-if="r.barcode && r.barcode !== r.item_code"> · {{ r.barcode }}</span></div></td>
              <td class="muted">{{ r.item_group }}</td>
              <td class="num" :class="{ crit: r.actual_qty <= 0, warn: r.low && r.actual_qty > 0 }">{{ r.actual_qty }}</td>
              <td class="num muted">{{ r.reserved_qty }}</td>
              <td class="num muted">{{ r.projected_qty }}</td>
              <td class="num muted">{{ r.reorder_level || '—' }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <!-- vendor POs -->
      <section v-if="tab === 'vendor'" class="card block">
        <div class="between">
          <div class="section-title">Inbound vendor purchase orders · {{ wh.me?.main_warehouse }}</div>
          <button class="btn" :disabled="loading" @click="load">Refresh</button>
        </div>
        <div v-if="!pos.length" class="label label-dim" style="padding: 12px 0">No open purchase orders addressed to the warehouse.</div>
        <div v-for="po in pos" :key="po.name" class="po" :data-testid="`po-${po.name}`">
          <div class="between">
            <div>
              <div style="font-weight: 500">{{ po.name }} <span class="muted">· {{ po.supplier_name || po.supplier }}</span></div>
              <div class="label label-dim">expected {{ po.schedule_date }} · {{ po.items.length }} lines · {{ Math.round(po.per_received) }}% received</div>
            </div>
            <button class="btn btn-primary" @click="openPo = po">Receive</button>
          </div>
        </div>
      </section>
    </div>

    <ApproveSheet v-if="openRequest" :name="openRequest" @close="openRequest = null" @changed="onApproved" />
    <ShipmentSheet v-if="openShipment" :name="openShipment" @close="openShipment = null" @changed="load" />
    <Modal v-if="resolving" :title="`Resolve ${resolving.name}`" @close="resolving = null">
      <div class="muted" style="margin-bottom: 12px">{{ resolving.type }} · {{ resolving.item_code }} · {{ resolving.shipment }} → {{ resolving.boutique }}</div>
      <div class="stack">
        <label v-for="opt in ['Accepted', 'Re-ship', 'Returned to warehouse', 'Write off']" :key="opt" class="opt" :class="{ active: resolution === opt }">
          <input v-model="resolution" type="radio" :value="opt" />
          <span>{{ opt }}</span>
          <span class="label label-dim">{{ opt === 'Accepted' ? 'close only' : opt === 'Re-ship' ? 'urgent request for the missing units' : opt === 'Write off' ? 'issue from in-transit' : 'in-transit → warehouse' }}</span>
        </label>
      </div>
      <div class="field" style="margin-top: 12px"><label class="label">Notes</label><input v-model="resolveNotes" class="input" /></div>
      <template #footer>
        <button class="btn btn-primary" :disabled="busy" data-testid="resolve-confirm" @click="resolve">Resolve</button>
      </template>
    </Modal>
    <Modal v-if="openPo" :title="`Receive ${openPo.name}`" width="880px" @close="openPo = null">
      <div class="muted" style="margin-bottom: 12px">{{ openPo.supplier_name || openPo.supplier }} → {{ wh.me?.main_warehouse }} · scan each unit or tap +</div>
      <CountSheet :lines="openPo.items.filter((i) => i.pending_qty > 0).map((i) => ({ key: i.name, item_code: i.item_code, item_name: i.item_name, barcode: i.barcode, expected: i.pending_qty }))" :scan-source="wedge" :busy="busy" confirm-label="Post Purchase Receipt" @confirm="receivePo" />
    </Modal>
  </div>
</template>

<style scoped>
.desk {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.head {
  height: 64px;
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 0 24px;
  border-bottom: var(--line-w) solid var(--line);
  flex: 0 0 auto;
}
.wordmark {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: 17px;
  letter-spacing: 0.28em;
  color: var(--accent);
}
.vline {
  width: 1px;
  height: 32px;
  background: var(--line-strong);
}
.title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}
.nav {
  display: flex;
  gap: 2px;
  margin-left: 12px;
}
.nav-btn {
  padding: 0 14px;
  min-height: 40px;
  font-size: 13px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  position: relative;
}
.nav-btn.active {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.badge {
  margin-left: 6px;
  padding: 1px 7px;
  font-size: 11px;
  background: var(--accent);
  color: var(--ink-on-accent);
  border-radius: 10px;
}
.badge.crit {
  background: var(--crit);
  color: #fff;
}
.spacer {
  flex: 1;
}
.user {
  text-align: right;
  max-width: 220px;
  font-size: 14px;
}
.lock {
  padding: 0 8px;
  color: var(--muted);
}
.body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 22px 28px;
}
.gate {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border: var(--line-w) solid var(--line);
  background: var(--surface);
  margin-bottom: 18px;
}
.kpi {
  padding: 14px 18px;
  border-right: var(--line-w) solid var(--line);
}
.kpi:last-child {
  border-right: 0;
}
.kpi .v {
  font-size: 24px;
  margin-top: 4px;
}
.block {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.seg {
  display: flex;
  gap: 4px;
}
.link {
  color: var(--accent);
  min-height: 0;
  min-width: 0;
  padding: 0;
}
tr.low td {
  background: rgba(211, 165, 91, 0.06);
}
.po {
  padding: 12px 0;
  border-bottom: var(--line-w) solid var(--line);
}
.opt {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 10px 12px;
  border: var(--line-w) solid var(--line);
  cursor: pointer;
}
.opt.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.stack {
  gap: 6px;
}
@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(3, 1fr);
  }
  .user {
    display: none;
  }
}
</style>
