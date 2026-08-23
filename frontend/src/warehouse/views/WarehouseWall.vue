<script setup lang="ts">
/**
 * v0.6 P — the 55" Warehouse Wall (`/warehouse-wall`, 1920×1080 / 4K landscape): five kanban columns,
 * big type, live age timers, ⚑ priority, sound/flash on a newly approved shipment, realtime + 10 s polling,
 * auto-print of packing list / label through a hidden iframe (`window.__maisonLastWallPrint`).
 * Tap a card → Pick / Packed / Buy label / Print / Ship.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { WALL_COLUMNS, type WallColumn } from '@/api/warehouse'
import { useWarehouseStore } from '@/stores/warehouse'
import { sortCards, totalUnits, type WallCard } from '../wall'
import WallCardView from '../components/WallCard.vue'
import VirtualColumn from '../components/VirtualColumn.vue'
import ShipmentSheet from '../components/ShipmentSheet.vue'
import ApproveSheet from '../components/ApproveSheet.vue'

const wh = useWarehouseStore()
const now = ref(Date.now())
const openShipment = ref<string | null>(null)
const openRequest = ref<string | null>(null)
const toast = ref('')
let tick: number | null = null

const columns = computed(() =>
  WALL_COLUMNS.map((c) => {
    const cards = sortCards((wh.wall?.columns[c.key] || []) as WallCard[])
    return { ...c, cards, units: totalUnits(cards) }
  })
)
const clock = computed(() => new Date(now.value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))
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

onMounted(async () => {
  await wh.loadMe()
  if (wh.allowed) wh.start(true)
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
      <button class="toggle" :class="{ on: wh.sound }" :title="wh.sound ? 'Sound & flash on' : 'Sound & flash off'" data-testid="sound-toggle" @click="wh.setSound(!wh.sound)">
        {{ wh.sound ? '🔔' : '🔕' }}
      </button>
      <span class="pill" :class="wh.connected ? 'pill-accent' : 'pill-warn'" data-testid="wall-connection">
        <span class="dot"></span>{{ wh.connected ? 'Live' : 'Polling' }}
      </span>
      <div class="clock num">{{ clock }}</div>
    </header>

    <div v-if="wh.meError || (wh.me && !wh.allowed)" class="gate" data-testid="wall-gate">
      <div class="display">Warehouse admin role required</div>
      <div class="muted">{{ wh.meError || `${wh.me?.user} is not a Maison Warehouse Admin` }}</div>
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
  font-size: 22px;
  min-width: 52px;
  min-height: 52px;
  border: var(--line-w) solid var(--line);
  opacity: 0.55;
}
.toggle.on {
  opacity: 1;
  border-color: var(--accent);
}
.clock {
  font-size: 28px;
  font-weight: 500;
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
  grid-template-columns: repeat(5, 1fr);
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
  font-size: 15px;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.18em;
}
.col-count {
  font-size: 24px;
  font-weight: 500;
  color: var(--accent);
}
.empty {
  padding: 28px 16px;
  text-align: center;
}
.col :deep(.vcol) {
  padding: 12px;
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
}
</style>
