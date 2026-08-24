<script setup lang="ts">
/**
 * v0.6 P — the 55" Warehouse Wall (`/warehouse-wall`, 1920×1080 / 4K landscape): five kanban columns,
 * big type, live age timers, ⚑ priority, sound/flash on a newly approved shipment, realtime + 10 s polling,
 * auto-print of packing list / label through a hidden iframe (`window.__awanzLastWallPrint`).
 * Tap a card → Pick / Packed / Buy label / Print / Ship.
 *
 * v1.0 §F — a sixth column, **Inbound**: the vendor deliveries the floor is waiting for, soonest
 * first, anything past its ETA flagged. Read-only (receiving happens on the desk, where the counts
 * and costs are), and refreshed on the same tick as the rest of the board, throttled so the extra
 * read never costs the wall a frame.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { WALL_COLUMNS, type WallColumn } from '@/api/warehouse'
import { useWarehouseStore } from '@/stores/warehouse'
import { usePurchasingStore } from '@/stores/purchasing'
import { inboundCards, inboundTier, sortCards, totalUnits, type WallCard } from '../wall'
import WallCardView from '../components/WallCard.vue'
import VirtualColumn from '../components/VirtualColumn.vue'
import ShipmentSheet from '../components/ShipmentSheet.vue'
import ApproveSheet from '../components/ApproveSheet.vue'
import { clockHM, setSiteTimeZone, zoneLabel } from '@/utils/time' // v0.6 R
import { fmtDate, todayISO } from '@/utils/device'
import { atNoon, etaStatus } from '../inbound'

/** The wall polls every 10 s; the inbound read rides that tick at most this often. */
const INBOUND_TTL_MS = 30_000

const wh = useWarehouseStore()
const pur = usePurchasingStore()
const now = ref(Date.now())
const openShipment = ref<string | null>(null)
const openRequest = ref<string | null>(null)
const toast = ref('')
const today = ref(todayISO())
let tick: number | null = null
let inboundAt = 0

const columns = computed(() =>
  WALL_COLUMNS.map((c) => {
    const cards = sortCards((wh.wall?.columns[c.key] || []) as WallCard[])
    return { ...c, cards, units: totalUnits(cards) }
  })
)

/** vendor → lead time, so an order with no promised date still shows an honest ETA */
const leadTimes = computed(() => {
  const map: Record<string, number> = {}
  for (const v of pur.vendors) map[v.name] = Number(v.lead_time_days) || 0
  return map
})
const inbound = computed(() =>
  inboundCards(pur.inbound?.expected || [], { leadTimes: leadTimes.value, today: today.value, warehouse: wh.me?.main_warehouse || undefined })
)
const inboundUnits = computed(() => totalUnits(inbound.value))

/** "Aug 27" — the ETA in the site zone, without the year the board does not need. */
function shortEta(eta: string): string {
  return fmtDate(atNoon(eta)).replace(/,\s*\d{4}$/, '')
}

async function refreshInbound(force = false) {
  if (!wh.allowed) return
  const at = Date.now()
  if (!force && at - inboundAt < INBOUND_TTL_MS) return
  inboundAt = at
  today.value = todayISO()
  await pur.loadInbound()
}
// v0.6 R — the board hangs in the warehouse: it shows the *site* clock, not the browser's.
const clock = computed(() => clockHM(new Date(now.value)))
const zone = computed(() => zoneLabel(new Date(now.value)))
const cardHeight = computed(() => (window.innerHeight >= 1600 ? 200 : 164))

function open(card: WallCard) {
  if (card.kind === 'request') openRequest.value = card.name
  else openShipment.value = card.name
}
async function act(card: WallCard, action: 'approve' | 'pick' | 'packed' | 'buy' | 'ship' | 'none') {
  try {
    if (action === 'approve') openRequest.value = card.name
    else if (action === 'pick') {
      await wh.mark(card.name, 'Picking')
      openShipment.value = card.name
    } else if (action === 'packed') await wh.mark(card.name, 'Packed')
    else if (action === 'buy') openShipment.value = card.name
    else if (action === 'ship') {
      await wh.mark(card.name, 'Shipped')
      say(`${card.name} shipped to ${card.boutique}`)
    }
  } catch (e) {
    say((e as Error).message)
  }
}
function say(msg: string) {
  toast.value = msg
  setTimeout(() => {
    if (toast.value === msg) toast.value = ''
  }, 5000)
}
function onApproved(shipment?: string) {
  if (shipment) {
    say(`Shipment ${shipment} created — packing list printing`)
    void wh.printPackingList(shipment)
  }
}

watch(
  () => wh.wall?.server_time,
  () => void refreshInbound()
)

onMounted(async () => {
  await wh.loadMe()
  setSiteTimeZone(wh.me?.time_zone) // v0.6 R — the site zone rides on `shipping.me`
  if (wh.allowed) {
    wh.start(true)
    // lead times are read once: they only matter for an order with no promised date
    void pur.loadVendors(undefined, false)
    void refreshInbound(true)
  }
  tick = window.setInterval(() => (now.value = Date.now()), 1000)
})
onBeforeUnmount(() => {
  wh.stop()
  if (tick) window.clearInterval(tick)
})
</script>

<template>
  <div class="wall" data-testid="warehouse-wall">
    <header class="wall-head">
      <div class="wordmark display-900">{{ wh.brand.wordmark_text }}</div>
      <div class="sub label">Warehouse Wall · {{ wh.me?.main_warehouse || 'HOU-WH' }}</div>
      <div class="spacer"></div>
      <div v-if="wh.wall" class="stats">
        <span class="num">{{ wh.wall.in_transit }} <span class="label label-dim">in transit</span></span>
        <span class="num">{{ wh.wall.received_today }} <span class="label label-dim">received today</span></span>
        <span class="num" :class="{ warn: wh.wall.open_discrepancies }">{{ wh.wall.open_discrepancies }} <span class="label label-dim">discrepancies</span></span>
      </div>
      <!-- v0.6 R: a colour emoji bell was the only non-monochrome mark on the board — drawn in the
           gold line system instead, with the "off" state struck through. -->
      <button class="toggle" :class="{ on: wh.sound }" :title="wh.sound ? 'Sound & flash on' : 'Sound & flash off'" :aria-pressed="wh.sound" aria-label="Sound and flash" data-testid="sound-toggle" @click="wh.setSound(!wh.sound)">
        <svg class="bell" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3.5a5.5 5.5 0 0 0-5.5 5.5v4L5 16.5h14L17.5 13V9A5.5 5.5 0 0 0 12 3.5Z" />
          <path d="M10 19a2 2 0 0 0 4 0" />
          <path v-if="!wh.sound" class="slash" d="M4 4l16 16" />
        </svg>
      </button>
      <span class="pill" :class="wh.connected ? 'pill-accent' : 'pill-warn'" data-testid="wall-connection">
        <span class="dot"></span>{{ wh.connected ? 'Live' : 'Polling' }}
      </span>
      <!-- v0.6 R: the wall runs on the *site* clock, labelled, like every other screen -->
      <div class="clock num" data-testid="wall-clock">{{ clock }}<span class="zone label label-dim">{{ zone }}</span></div>
    </header>

    <div v-if="wh.meError || (wh.me && !wh.allowed)" class="gate" data-testid="wall-gate">
      <div class="display">Warehouse admin role required</div>
      <div class="muted">{{ wh.meError || `${wh.me?.user} is not an AWANZ Warehouse Admin` }}</div>
      <a class="btn" href="/login?redirect-to=/warehouse-wall">Sign in</a>
    </div>

    <div v-else class="board">
      <section v-for="c in columns" :key="c.key" class="col" :data-testid="`col-${c.key}`" :data-count="c.cards.length">
        <div class="col-head">
          <div class="col-title display">{{ c.label }}</div>
          <div class="col-count num">{{ c.cards.length }}<span class="label label-dim"> · {{ c.units }} u</span></div>
        </div>
        <div v-if="!c.cards.length" class="empty label label-dim">Nothing here</div>
        <VirtualColumn v-else :items="c.cards" :item-height="cardHeight" :gap="12">
          <template #default="{ item }">
            <WallCardView :card="item" :column="c.key as WallColumn" :fetched-at="wh.fetchedAt" :now="now" :warn="wh.wall?.warn_seconds || 14400" :crit="wh.wall?.crit_seconds || 86400" :flash="wh.flash === item.name" :busy="wh.busy === item.name" @open="open" @action="act" />
          </template>
        </VirtualColumn>
      </section>

      <!-- v1.0 §F — what is arriving. Read-only: receiving happens on the desk. -->
      <section class="col" data-testid="col-inbound" :data-count="inbound.length">
        <div class="col-head">
          <div class="col-title display">Inbound</div>
          <div class="col-count num">{{ inbound.length }}<span class="label label-dim"> · {{ inboundUnits }} u</span></div>
        </div>
        <div v-if="!inbound.length" class="empty label label-dim">Nothing on its way</div>
        <VirtualColumn v-else :items="inbound" :item-height="cardHeight" :gap="12">
          <template #default="{ item }">
            <div class="icard" :class="inboundTier(item)" :data-testid="`wall-inbound-${item.name}`" :data-tier="inboundTier(item)">
              <div class="top">
                <!-- the vendor leads, because `Supplier.name` is a code on some sites and the
                     company's own name on others — the name is what the floor says out loud -->
                <div class="code display" :title="item.supplier_name || item.supplier">
                  {{ item.supplier_name || item.supplier }}<span v-if="item.overdue_days" class="flag" title="past its ETA">⚑</span>
                </div>
                <div class="age num" :class="inboundTier(item)" :title="fmtDate(atNoon(item.eta))" :data-testid="`eta-${item.name}`">{{ etaStatus(item.eta, today).text }}</div>
              </div>
              <div class="store ellipsis">{{ item.name }}<span v-if="item.per_received"> · {{ Math.round(item.per_received) }}% in</span></div>
              <div class="meta">
                <span class="num">{{ item.items }} <span class="label label-dim">{{ item.items === 1 ? 'line' : 'lines' }}</span></span>
                <span class="num">{{ item.units }} <span class="label label-dim">{{ item.units === 1 ? 'unit' : 'units' }}</span></span>
                <span class="eta">{{ shortEta(item.eta) }}</span>
              </div>
              <div class="bottom">
                <span class="label label-dim ellipsis">{{ item.supplier }}</span>
                <span class="label label-dim ellipsis dest">{{ item.dropship_store ? `→ ${item.dropship_store}` : item.boutique }}</span>
              </div>
            </div>
          </template>
        </VirtualColumn>
      </section>
    </div>

    <div v-if="toast" class="toast" data-testid="wall-toast">{{ toast }}</div>
    <div v-if="wh.error" class="toast crit">{{ wh.error }}</div>

    <ShipmentSheet v-if="openShipment" :name="openShipment" large @close="openShipment = null" @changed="wh.refresh(true)" />
    <ApproveSheet v-if="openRequest" :name="openRequest" large @close="openRequest = null" @changed="onApproved" />
  </div>
</template>

<style scoped>
.wall {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ground);
  color: var(--text);
}
.wall-head {
  display: flex;
  align-items: center;
  gap: 22px;
  padding: 0 28px;
  height: 76px;
  border-bottom: var(--line-w) solid var(--line);
}
.wordmark {
  font-family: var(--font-display);
  font-weight: 900;
  font-size: 26px;
  letter-spacing: 0.28em;
  color: var(--accent);
}
.sub {
  color: var(--muted);
}
.spacer {
  flex: 1;
}
.stats {
  display: flex;
  gap: 26px;
  font-size: 22px;
}
.toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 52px;
  min-height: 52px;
  border: var(--line-w) solid var(--line);
  color: var(--muted);
  opacity: 0.75;
}
.toggle.on {
  opacity: 1;
  border-color: var(--accent);
  color: var(--accent);
}
.bell {
  width: 24px;
  height: 24px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.bell .slash {
  stroke-width: 1.6;
}
.clock {
  display: inline-flex;
  align-items: baseline;
  gap: 10px;
  font-size: 28px;
  font-weight: 500;
}
.clock .zone {
  font-size: 12px;
  letter-spacing: 0.22em;
}
.pill .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  display: inline-block;
  margin-right: 8px;
}
.board {
  flex: 1;
  min-height: 0;
  display: grid;
  /* v1.0 §F — five workflow columns plus a slimmer Inbound, so the original five keep their room */
  grid-template-columns: repeat(5, minmax(0, 1fr)) minmax(0, 0.8fr);
  gap: 16px;
  padding: 18px 24px 24px;
}
.col {
  display: flex;
  flex-direction: column;
  min-height: 0;
  border: var(--line-w) solid var(--line);
  background: rgba(20, 19, 17, 0.5);
}
.col-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  padding: 14px 16px;
  border-bottom: var(--line-w) solid var(--line-strong);
}
.col-title {
  font-size: 14px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.14em;
  min-width: 0;
}
.col-count {
  font-size: 22px;
  font-weight: 500;
  color: var(--accent);
  flex: 0 0 auto;
  white-space: nowrap;
}
.empty {
  padding: 28px 16px;
  text-align: center;
}
.col :deep(.vcol) {
  padding: 12px;
}

/* v1.0 §F — the Inbound card. Same anatomy as `WallCard.vue` (whose styles are scoped to it):
   big code, name, meta row, footer — tiered on how overdue the delivery is rather than on age. */
.icard {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  background: var(--surface);
  border: var(--line-w) solid var(--line);
  border-left: 5px solid var(--line-strong);
  user-select: none;
}
.icard.warn {
  border-left-color: var(--warn);
}
.icard.crit {
  border-left-color: var(--crit);
  background: rgba(196, 115, 106, 0.08);
}
.icard .top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 8px;
}
.icard .code {
  font-size: 16px;
  font-weight: 900;
  letter-spacing: 0;
  line-height: 1.12;
  min-width: 0;
  /* a vendor name is longer than a store code: two lines, then clip */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.icard .flag {
  color: var(--crit);
  margin-left: 8px;
  font-size: 20px;
}
.icard .age {
  font-size: 15px;
  font-weight: 500;
  color: var(--muted);
  white-space: nowrap;
}
.icard .age.warn {
  color: var(--warn);
}
.icard .age.crit {
  color: var(--crit);
}
.icard .store {
  font-size: 16px;
  color: var(--muted);
  flex: 0 0 auto;
  line-height: 1.4;
  padding-bottom: 1px;
}
.icard .meta {
  display: flex;
  gap: 14px;
  align-items: baseline;
  font-size: 18px;
  min-width: 0;
}
.icard .eta {
  font-size: 15px;
  color: var(--accent);
  white-space: nowrap;
}
.icard .bottom {
  margin-top: auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.icard .dest {
  flex: 0 0 auto;
  max-width: 45%;
}
.gate {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  font-size: 22px;
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 28px;
  transform: translateX(-50%);
  padding: 14px 22px;
  background: var(--surface-2);
  border: var(--line-w) solid var(--accent);
  font-size: 18px;
  z-index: 60;
}
.toast.crit {
  border-color: var(--crit);
}
@media (min-width: 3000px) {
  .wall-head {
    height: 120px;
    font-size: 1.6em;
  }
  .wordmark {
    font-size: 40px;
  }
  .col-title {
    font-size: 24px;
  }
  .col-count {
    font-size: 38px;
  }
  .board {
    gap: 28px;
    padding: 28px 40px 40px;
  }
  .col :deep(.wcard) {
    font-size: 1.5em;
  }
  .col :deep(.wcard .code) {
    font-size: 40px;
  }
  .col :deep(.wcard .age) {
    font-size: 34px;
  }
  .col :deep(.wcard .meta) {
    font-size: 30px;
  }
  .col :deep(.icard) {
    font-size: 1.5em;
  }
  .col :deep(.icard .code) {
    font-size: 30px;
  }
  .col :deep(.icard .age) {
    font-size: 24px;
  }
  .col :deep(.icard .meta) {
    font-size: 26px;
  }
}
</style>
