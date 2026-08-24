<script setup lang="ts">
/**
 * v1.0 §E — Inbound: what the warehouse is waiting for, and what went wrong when it arrived.
 *
 * Expected vendor orders at HOU-WH, soonest first (so anything overdue is at the top and flagged),
 * with the ETA taken from the order's promised date or the vendor's lead time. Tap an order — or
 * scan a barcode that appears on exactly one of them — to open the receive sheet.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { PurchaseOrderWithItems } from '@/api/purchasing'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import { atNoon, etaOf, etaStatus, matchScan } from '@/warehouse/inbound'
import { installWedgeListener } from '@/scan/wedge'
import { fmtDate, fmtDateTime, todayISO } from '@/utils/device'
import { fmtMoney } from '@/utils/money'
import ReceiveSheet from './ReceiveSheet.vue'

const emit = defineEmits<{ notice: [msg: string] }>()

const store = usePurchasingStore()
const wh = useWarehouseStore()

const openPo = ref<string | null>(null)
const sheet = ref<InstanceType<typeof ReceiveSheet> | null>(null)
const manual = ref('')
const scanNote = ref<{ text: string; ok: boolean } | null>(null)
const today = ref(todayISO())

const warehouse = computed(() => store.inbound?.warehouse || wh.me?.main_warehouse || 'HOU-WH')
const expected = computed(() => store.inbound?.expected ?? [])
const discrepancies = computed(() => store.inbound?.discrepancies ?? [])

/** vendor → lead time, so an order with no promised date still gets an honest ETA */
const leadTimes = computed(() => {
  const map: Record<string, number> = {}
  for (const v of store.vendors) map[v.name] = Number(v.lead_time_days) || 0
  return map
})

interface ExpectedRow {
  order: PurchaseOrderWithItems
  eta: string
  status: ReturnType<typeof etaStatus>
  units: number
  lines: number
}

/** Soonest ETA first — which puts everything overdue at the top, flagged. */
const rows = computed<ExpectedRow[]>(() =>
  expected.value
    .map((order) => {
      const open = (order.items || []).filter((l) => Number(l.pending_qty) > 0)
      const eta = etaOf(order, leadTimes.value, today.value)
      return { order, eta, status: etaStatus(eta, today.value), units: open.reduce((s, l) => s + Number(l.pending_qty || 0), 0), lines: open.length }
    })
    .sort((a, b) => a.eta.localeCompare(b.eta) || a.order.name.localeCompare(b.order.name))
)

const unitsExpected = computed(() => rows.value.reduce((s, r) => s + r.units, 0))
const lateCount = computed(() => rows.value.filter((r) => r.status.late).length)

// ------------------------------------------------------------------ scanning
/**
 * A scan opens the delivery it belongs to, already counting the unit. Two vendors shipping the same
 * item is normal here, so a code on more than one expected order asks rather than guesses.
 */
async function onCode(code: string) {
  if (openPo.value) return // the sheet has its own listener while it is open
  const hits = matchScan(expected.value, code)
  if (!hits.length) {
    scanNote.value = { text: `${code} is not on any expected delivery`, ok: false }
    return
  }
  if (hits.length > 1) {
    scanNote.value = { text: `${code} is on ${hits.length} deliveries (${hits.map((h) => h.order.name).join(', ')}) — open the right one`, ok: false }
    return
  }
  scanNote.value = { text: `${code} → ${hits[0].order.name}`, ok: true }
  openPo.value = hits[0].order.name
  await nextTick()
  sheet.value?.onCode(code)
}
function submitManual() {
  if (!manual.value.trim()) return
  void onCode(manual.value.trim())
  manual.value = ''
}

// ------------------------------------------------------------------ lifecycle
async function load() {
  today.value = todayISO()
  // best effort: lead times only matter for an order with no promised date
  if (!store.vendors.length) await store.loadVendors(undefined, false)
  await store.loadInbound()
}
function onReceived() {
  scanNote.value = null
}

let uninstall: (() => void) | null = null
onMounted(() => {
  uninstall = installWedgeListener((code) => void onCode(code))
  void load()
})
onBeforeUnmount(() => uninstall?.())
</script>

<template>
  <div class="inbound" data-testid="inbound-board">
    <section class="card block">
      <div class="between">
        <div>
          <div class="section-title">Expected at {{ warehouse }}</div>
          <div class="label label-dim">
            {{ rows.length }} {{ rows.length === 1 ? 'order' : 'orders' }} · {{ unitsExpected }} units outstanding
            <span v-if="lateCount" class="crit"> · {{ lateCount }} overdue</span>
            <span v-if="store.inbound?.as_of"> · as of {{ fmtDateTime(store.inbound.as_of) }}</span>
          </div>
        </div>
        <div class="row">
          <input v-model="manual" class="input scan" placeholder="Scan barcode to open a delivery" data-testid="inbound-scan" @keydown.enter.prevent="submitManual" />
          <button class="btn" data-testid="inbound-find" @click="submitManual">Find</button>
          <button class="btn" :disabled="store.loading" data-testid="inbound-refresh" @click="load">Refresh</button>
        </div>
      </div>

      <div v-if="scanNote" class="pill" :class="scanNote.ok ? 'pill-good' : 'pill-crit'" data-testid="inbound-scan-note">{{ scanNote.text }}</div>
      <div v-if="store.error" class="banner crit" data-testid="inbound-error">{{ store.error }}</div>

      <div v-if="!rows.length && !store.loading" class="empty" data-testid="inbound-empty">
        <div class="section-title">Nothing on its way</div>
        <p class="label label-dim">A purchase order appears here the moment it is submitted, with its ETA and everything on it.</p>
      </div>

      <div v-else class="rows">
        <article
          v-for="row in rows"
          :key="row.order.name"
          class="po"
          :class="{ late: row.status.late }"
          :data-testid="`inbound-po-${row.order.name}`"
          :data-late="row.status.late ? row.status.days : 0"
        >
          <div class="who">
            <div class="display vendor ellipsis">{{ row.order.supplier_name || row.order.supplier }}</div>
            <div class="label label-dim ellipsis">
              {{ row.order.name }} · {{ row.order.status }}
              <span v-if="row.order.dropship_store"> · drop-ship {{ row.order.dropship_store }}</span>
            </div>
          </div>

          <div class="cell">
            <div class="label">ETA</div>
            <div class="num v">{{ fmtDate(atNoon(row.eta)) }}</div>
            <span class="pill" :class="`pill-${row.status.tone}`" :data-testid="`inbound-eta-${row.order.name}`">
              <span v-if="row.status.late" class="flag" aria-hidden="true">⚑</span>{{ row.status.text }}
            </span>
          </div>

          <div class="cell num-cell">
            <div class="label">Units expected</div>
            <div class="num v">{{ row.units }}</div>
            <div class="label label-dim">{{ row.lines }} {{ row.lines === 1 ? 'line' : 'lines' }} of {{ row.order.units }} ordered</div>
          </div>

          <div class="cell num-cell">
            <div class="label">Received</div>
            <div class="num v">{{ Math.round(row.order.per_received) }}%</div>
            <div class="bar" :aria-label="`${Math.round(row.order.per_received)} percent received`">
              <span :style="{ width: `${Math.min(100, Math.max(0, row.order.per_received))}%` }"></span>
            </div>
          </div>

          <div class="cell num-cell">
            <div class="label">Freight</div>
            <div class="num v">{{ fmtMoney(row.order.freight) }}</div>
            <div class="label label-dim">landed {{ fmtMoney(row.order.landed_total) }}</div>
          </div>

          <button class="btn btn-primary receive" :data-testid="`inbound-receive-${row.order.name}`" @click="openPo = row.order.name">Receive</button>
        </article>
      </div>
    </section>

    <section class="card block">
      <div class="between">
        <div>
          <div class="section-title">Open vendor discrepancies</div>
          <div class="label label-dim">Raised by a receipt that came up short, over or damaged — they sit against the vendor, not a store.</div>
        </div>
      </div>
      <div v-if="!discrepancies.length" class="empty small" data-testid="inbound-disc-empty">
        <p class="label label-dim">Nothing outstanding with a vendor.</p>
      </div>
      <div v-else class="scroller">
        <table class="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Type</th>
              <th class="num">Expected</th>
              <th class="num">Received</th>
              <th class="num">Qty</th>
              <th>Order · vendor</th>
              <th>Destination</th>
              <th>Reported</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="d in discrepancies" :key="d.name" :data-testid="`inbound-disc-${d.name}`">
              <td>
                <div class="ellipsis wide">{{ d.item_name || d.item_code }}</div>
                <div class="label label-dim">{{ d.item_code }}</div>
              </td>
              <td><span class="pill" :class="d.type === 'Short' ? 'pill-crit' : 'pill-warn'">{{ d.type }}</span></td>
              <td class="num">{{ d.shipped_qty ?? '—' }}</td>
              <td class="num">{{ d.received_qty ?? '—' }}</td>
              <td class="num" :class="d.type === 'Short' ? 'crit' : 'warn'">
                {{ d.type === 'Short' ? d.short_qty : d.type === 'Damaged' ? d.damaged_qty : d.over_qty }}
              </td>
              <td>
                <div>{{ d.purchase_order || '—' }}</div>
                <div class="label label-dim ellipsis">{{ d.supplier || '—' }}</div>
              </td>
              <td class="muted">{{ d.boutique || warehouse }}</td>
              <td>
                <div class="label label-dim">{{ d.reported_at ? fmtDateTime(d.reported_at) : '—' }}</div>
                <div class="label label-dim ellipsis">{{ d.reported_by }}</div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <ReceiveSheet
      v-if="openPo"
      ref="sheet"
      :po="openPo"
      @close="openPo = null"
      @notice="emit('notice', $event)"
      @received="onReceived"
    />
  </div>
</template>

<style scoped>
.inbound {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.block {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.scan {
  width: 260px;
}
.banner {
  padding: 10px 12px;
  border: var(--line-w) solid currentColor;
}
.empty {
  padding: 32px 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.empty.small {
  padding: 16px 0;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.po {
  display: grid;
  grid-template-columns: minmax(180px, 1.4fr) repeat(4, minmax(120px, 1fr)) auto;
  gap: 12px 20px;
  align-items: center;
  padding: 14px 16px;
  border: var(--line-w) solid var(--line);
  border-left: 4px solid var(--line-strong);
  background: var(--surface-2);
}
.po.late {
  border-left-color: var(--crit);
  background: rgba(196, 115, 106, 0.06);
}
.who {
  min-width: 0;
}
.vendor {
  font-size: 15px;
}
.cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  align-items: flex-start;
  min-width: 0;
}
.num-cell {
  align-items: flex-end;
  text-align: right;
}
.cell .v {
  font-size: 18px;
}
.flag {
  margin-right: 6px;
}
.bar {
  width: 100%;
  height: 6px;
  background: var(--line);
}
.bar span {
  display: block;
  height: 100%;
  background: var(--accent);
}
.receive {
  min-height: var(--touch);
  padding: 0 22px;
}
.scroller {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.wide {
  max-width: 240px;
}
@media (max-width: 1100px) {
  .po {
    grid-template-columns: repeat(2, minmax(140px, 1fr));
  }
  .who {
    grid-column: 1 / -1;
  }
  .receive {
    grid-column: 1 / -1;
    width: 100%;
  }
}
@media (max-width: 767px) {
  .block {
    padding: 14px;
  }
  .between {
    flex-direction: column;
    align-items: stretch;
  }
  .between .row {
    flex-wrap: wrap;
  }
  .scan {
    width: auto;
    flex: 1;
    min-width: 160px;
  }
  .po {
    grid-template-columns: 1fr 1fr;
  }
  .num-cell {
    align-items: flex-start;
    text-align: left;
  }
}
</style>
