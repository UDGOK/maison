<script setup lang="ts">
/**
 * v0.6 P — Warehouse Admin desk (`/warehouse`). Same bundle as the POS; role-gated through
 * `shipping.me` (and on every endpoint server-side).
 *
 * v1.0 §F — the flat v0.6 tab strip becomes five sections:
 *
 *   **Outbound** · Inbound · Buying · Vendors · Stock
 *
 * Outbound is the v0.6 desk unchanged, with Requests / Shipments / Discrepancies re-parented as its
 * sub-tabs. The retired "Vendor POs" tab is split in two: receiving is Inbound, ordering is Buying.
 *
 * `/warehouse/:tab?` keeps answering to every key it ever answered to — there are bookmarks and e2e
 * specs pointing at them. `resolveTab` owns that mapping (`warehouse/inbound.ts`), and Outbound
 * writes its *sub-tab* key to the URL so `/warehouse/shipments` still means what it meant in v0.6.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { warehouseApi, type Discrepancy, type ReplenishmentRequest, type Shipment } from '@/api/warehouse'
import { useWarehouseStore } from '@/stores/warehouse'
import { usePurchasingStore } from '@/stores/purchasing'
import { fmtDateTime } from '@/utils/device'
import { setSiteTimeZone } from '@/utils/time' // v0.6 R
import { fmtMoney } from '@/utils/money'
import { ageTier, fmtAge, liveAge, sortCards, type WallCard } from '../wall'
import { OUTBOUND_TABS, SECTIONS, resolveTab, tabKeyFor, type OutboundTab, type Section } from '../inbound'
import ApproveSheet from '../components/ApproveSheet.vue'
import ShipmentSheet from '../components/ShipmentSheet.vue'
import InboundBoard from '../components/purchasing/InboundBoard.vue'
import BuyingBoard from '../components/purchasing/BuyingBoard.vue'
import VendorsBoard from '../components/purchasing/VendorsBoard.vue'
import StockBoard from '../components/purchasing/StockBoard.vue'
import Modal from '@/components/Modal.vue'

/** How long a section badge may go stale before the wall's tick refreshes it. */
const COUNTS_TTL_MS = 60_000

const wh = useWarehouseStore()
const pur = usePurchasingStore()
const route = useRoute()
const router = useRouter()

const entry = resolveTab(route.params.tab as string | undefined)
const section = ref<Section>(entry.section)
const outTab = ref<OutboundTab>(entry.outbound)
const now = ref(Date.now())
let tick: number | null = null
let countsAt = 0

const requests = ref<ReplenishmentRequest[]>([])
const reqFilter = ref<'open' | 'all' | 'Approved' | 'Rejected'>('open')
const shipments = ref<Shipment[]>([])
const shFilter = ref<'open' | 'Shipped' | 'Received' | 'all'>('open')
const discrepancies = ref<Discrepancy[]>([])
const dFilter = ref<'Open' | 'Resolved' | 'all'>('Open')
const openRequest = ref<string | null>(null)
const openShipment = ref<string | null>(null)
const resolving = ref<Discrepancy | null>(null)
const resolution = ref<'Write off' | 'Returned to warehouse' | 'Re-ship' | 'Accepted'>('Accepted')
const resolveNotes = ref('')
const loading = ref(false)
const busy = ref(false)
const error = ref('')
const notice = ref('')

const store = computed(() => route.query.store as string | undefined)

/** The live count on each section, so the manager sees where the work is without clicking. */
const badges = computed<Partial<Record<Section, { count: number; tone: 'accent' | 'crit' }>>>(() => ({
  outbound: wh.wall?.counts.pending_approval ? { count: wh.wall.counts.pending_approval, tone: 'accent' } : undefined,
  inbound: pur.inbound?.expected.length ? { count: pur.inbound.expected.length, tone: 'accent' } : undefined,
  buying: pur.openSuggestions.length ? { count: pur.openSuggestions.length, tone: 'accent' } : undefined,
  stock: pur.lowStockCount ? { count: pur.lowStockCount, tone: 'crit' } : undefined
}))

// ---------------------------------------------------------------- Outbound (v0.6, unchanged)
async function load() {
  if (!wh.allowed || section.value !== 'outbound') return
  loading.value = true
  error.value = ''
  try {
    if (outTab.value === 'requests') requests.value = (await warehouseApi.admin.requests(reqFilter.value, store.value)).requests
    else if (outTab.value === 'shipments') shipments.value = (await warehouseApi.admin.shipments(shFilter.value, store.value)).shipments
    else if (outTab.value === 'discrepancies') discrepancies.value = (await warehouseApi.admin.discrepancies(dFilter.value, store.value)).discrepancies
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}

/**
 * The section badges. Cheap on purpose: one read per section that has a count, throttled to
 * {@link COUNTS_TTL_MS}, skipping whatever the open section is already loading for itself.
 */
async function loadCounts(force = false) {
  if (!wh.allowed) return
  const at = Date.now()
  if (!force && at - countsAt < COUNTS_TTL_MS) return
  countsAt = at
  const jobs: Promise<unknown>[] = []
  if (section.value !== 'inbound') jobs.push(pur.loadInbound())
  if (section.value !== 'buying') jobs.push(pur.loadSuggestions())
  if (section.value !== 'stock') jobs.push(pur.loadStock())
  await Promise.all(jobs)
}

// ---------------------------------------------------------------- navigation
function goSection(s: Section) {
  section.value = s
  const query = { ...route.query }
  // `?order=` belongs to Buying only — leaving the section drops it so it cannot reopen later
  if (s !== 'buying') delete query.order
  void router.replace({ name: 'warehouse', params: { tab: tabKeyFor(s, outTab.value) }, query })
}
function goOutbound(t: OutboundTab) {
  outTab.value = t
  section.value = 'outbound'
  void router.replace({ name: 'warehouse', params: { tab: t }, query: route.query })
}
/** BuyingBoard hands an order back; the desk selects Buying and puts it in the URL as `?order=`. */
function onOpenOrder(name: string) {
  section.value = 'buying'
  void router.replace({ name: 'warehouse', params: { tab: 'buying' }, query: { ...route.query, order: name } })
}

watch(
  () => route.params.tab,
  (raw) => {
    const next = resolveTab(raw as string | undefined)
    if (next.redirect && next.redirect !== raw) {
      void router.replace({ name: 'warehouse', params: { tab: next.redirect }, query: route.query })
      return
    }
    section.value = next.section
    if (next.section === 'outbound') outTab.value = next.outbound
  }
)
watch([outTab, reqFilter, shFilter, dFilter], () => void load())
watch(section, (s) => {
  if (s === 'outbound') void load()
})
watch(
  () => wh.wall?.server_time,
  () => {
    void load()
    void loadCounts()
  }
)

function say(msg: string) {
  notice.value = msg
  setTimeout(() => {
    if (notice.value === msg) notice.value = ''
  }, 6000)
  // a write is the only thing that really moves a badge — refresh them off the back of it
  void loadCounts(true)
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
const cardFor = (s: Shipment) => ({ ...s, kind: 'shipment' }) as WallCard

onMounted(async () => {
  await wh.loadMe()
  setSiteTimeZone(wh.me?.time_zone) // v0.6 R — desk timestamps on the site clock
  if (entry.redirect) void router.replace({ name: 'warehouse', params: { tab: entry.redirect }, query: route.query })
  if (wh.allowed) {
    wh.start(false)
    await load()
    void loadCounts(true)
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
      <nav class="nav" aria-label="Warehouse sections">
        <button
          v-for="s in SECTIONS"
          :key="s.key"
          class="nav-btn"
          :class="{ active: section === s.key }"
          :data-testid="`tab-${s.key}`"
          :aria-current="section === s.key ? 'page' : undefined"
          @click="goSection(s.key)"
        >
          {{ s.label }}
          <span v-if="badges[s.key]" class="badge" :class="badges[s.key]!.tone === 'crit' ? 'crit' : ''">{{ badges[s.key]!.count }}</span>
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
      <div v-if="notice" class="notice banner" data-testid="desk-notice">{{ notice }}</div>

      <!-- ============================================================ Outbound (v0.6, re-parented) -->
      <template v-if="section === 'outbound'">
        <div v-if="wh.wall" class="kpis">
          <div class="kpi"><div class="label">Pending approval</div><div class="num v">{{ wh.wall.counts.pending_approval }}</div></div>
          <div class="kpi"><div class="label">To pick / pack</div><div class="num v">{{ wh.wall.counts.to_pick + wh.wall.counts.packing }}</div></div>
          <div class="kpi"><div class="label">Ready to ship</div><div class="num v">{{ wh.wall.counts.ready }}</div></div>
          <div class="kpi"><div class="label">In transit</div><div class="num v">{{ wh.wall.in_transit }}</div></div>
          <div class="kpi"><div class="label">Discrepancies</div><div class="num v" :class="{ warn: wh.wall.open_discrepancies }">{{ wh.wall.open_discrepancies }}</div></div>
        </div>
        <div v-if="error" class="crit banner" data-testid="desk-error">{{ error }}</div>

        <nav class="subnav" aria-label="Outbound boards">
          <button
            v-for="t in OUTBOUND_TABS"
            :key="t.key"
            class="sub-btn"
            :class="{ active: outTab === t.key }"
            :data-testid="`tab-${t.key}`"
            :aria-current="outTab === t.key ? 'page' : undefined"
            @click="goOutbound(t.key)"
          >
            {{ t.label }}
            <span v-if="t.key === 'requests' && wh.wall?.counts.pending_approval" class="badge">{{ wh.wall.counts.pending_approval }}</span>
            <span v-if="t.key === 'discrepancies' && wh.wall?.open_discrepancies" class="badge crit">{{ wh.wall.open_discrepancies }}</span>
          </button>
        </nav>

        <!-- requests -->
        <section v-if="outTab === 'requests'" class="card block">
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
        <section v-if="outTab === 'shipments'" class="card block">
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
        <section v-if="outTab === 'discrepancies'" class="card block">
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
      </template>

      <!-- ============================================================ v1.0 sections -->
      <InboundBoard v-else-if="section === 'inbound'" @notice="say" />
      <BuyingBoard v-else-if="section === 'buying'" @notice="say" @open-order="onOpenOrder" />
      <VendorsBoard v-else-if="section === 'vendors'" @notice="say" @open-order="onOpenOrder" />
      <StockBoard v-else-if="section === 'stock'" @notice="say" />
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
.subnav {
  display: flex;
  gap: 2px;
  margin-bottom: 14px;
  border-bottom: var(--line-w) solid var(--line);
}
.sub-btn {
  padding: 0 16px;
  min-height: var(--touch);
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: var(--muted);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.sub-btn.active {
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
.banner {
  margin-bottom: 12px;
}
/* a notice states what happened — it is not always a success, so it is not green */
.notice {
  padding: 10px 14px;
  border: var(--line-w) solid var(--accent);
  background: var(--accent-soft);
  color: var(--text);
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
@media (max-width: 767px) {
  .head {
    height: auto;
    flex-wrap: wrap;
    gap: 10px;
    padding: 10px 14px;
  }
  .nav {
    order: 10;
    width: 100%;
    margin-left: 0;
    overflow-x: auto;
  }
  .nav-btn {
    flex: 0 0 auto;
    padding: 0 12px;
  }
  .subnav {
    overflow-x: auto;
  }
  .sub-btn {
    flex: 0 0 auto;
  }
  .body {
    padding: 14px 14px calc(14px + var(--safe-bottom));
  }
}
</style>
