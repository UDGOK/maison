<script setup lang="ts">
/**
 * v0.6 O — POS "Receive" screen: inbound warehouse shipments + vendor POs shipped direct to the store;
 * open one → scan (wedge / camera) or tap to count → discrepancies highlighted → Confirm receipt posts
 * the Stock Entry (In Transit → store) or the Purchase Receipt. Short / over / damaged raise a
 * AWANZ Receiving Discrepancy for the warehouse admin. Also: replenishment requests of the store
 * (status, rejection reason) and a manual "Request from warehouse".
 */
import { computed, onMounted, ref } from 'vue'
import { warehouseApi, type Inbound, type PurchaseOrder, type ReceiveResult, type ReplenishmentRequest, type Shipment } from '@/api/warehouse'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { useScanStore } from '@/stores/scan'
import { useCatalogStore } from '@/stores/catalog'
import { useInventoryStore } from '@/stores/inventory'
import { fmtDateTime, fmtDateTimeZoned } from '@/utils/device'
import { plural } from '@/utils/text' // v0.6 R
import CountSheet, { type Counted } from '@/warehouse/components/CountSheet.vue'
import Modal from '@/components/Modal.vue'

const session = useSessionStore()
const sync = useSyncStore()
const scan = useScanStore()
const catalog = useCatalogStore()
const inventory = useInventoryStore()

const inbound = ref<Inbound | null>(null)
const requests = ref<ReplenishmentRequest[]>([])
const loading = ref(false)
const error = ref('')
const busy = ref(false)
const openShipment = ref<Shipment | null>(null)
const openPo = ref<PurchaseOrder | null>(null)
const result = ref<ReceiveResult | null>(null)
const prResult = ref<{ purchase_receipt: string; lines: { item_code: string; qty: number }[] } | null>(null)
const requesting = ref(false)
const reqLines = ref<{ item_code: string; qty: number }[]>([])
const reqSearch = ref('')
const reqReason = ref('')

const boutique = computed(() => session.boutique!.name)
const shipmentLines = computed(() => (openShipment.value?.lines || []).map((l) => ({ key: l.item_code, item_code: l.item_code, item_name: l.item_name, barcode: l.barcode, expected: Math.max(0, (l.shipped_qty || l.qty) - l.received_qty - l.damaged_qty) })))
const poLines = computed(() => (openPo.value?.items || []).filter((i) => i.pending_qty > 0).map((i) => ({ key: i.name, item_code: i.item_code, item_name: i.item_name, barcode: i.barcode, expected: i.pending_qty })))
const reqMatches = computed(() => (reqSearch.value.trim() ? catalog.search(reqSearch.value, null, null).slice(0, 8) : []))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [inb, reqs] = await Promise.all([warehouseApi.store.inbound(boutique.value), warehouseApi.store.requests(boutique.value, 'all', 30)])
    inbound.value = inb
    requests.value = reqs.requests
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(() => {
  void load()
  if (sync.browserOnline) void inventory.refresh()
})

/** Scanner wedge: the POS store owns the global listener — capture raw codes while a sheet is open. */
const capture = (cb: (code: string) => void) => scan.captureRaw(cb)

async function confirmShipment(counts: Counted[], partial: boolean) {
  if (!openShipment.value) return
  busy.value = true
  error.value = ''
  try {
    const out = await warehouseApi.store.receive_shipment({
      shipment: openShipment.value.name,
      lines: counts.map((c) => ({ item_code: c.item_code, received_qty: c.received, damaged_qty: c.damaged })),
      final: partial ? 0 : 1,
      device_id: session.device_id
    })
    result.value = out
    openShipment.value = null
    sync.notify(out.discrepancies.length ? 'warn' : 'good', partial ? `Partial receipt saved for ${out.name}` : `${out.name} received`, out.discrepancies.length ? `${out.discrepancies.length} discrepancy(ies) raised` : out.stock_entry_receive || undefined)
    await load()
    void inventory.refresh()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function confirmPo(counts: Counted[]) {
  if (!openPo.value) return
  busy.value = true
  error.value = ''
  try {
    const out = await warehouseApi.store.receive_po({ po: openPo.value.name, boutique: boutique.value, lines: counts.filter((c) => c.received > 0).map((c) => ({ name: c.key, item_code: c.item_code, qty: c.received })) })
    prResult.value = out
    openPo.value = null
    sync.notify('good', `Purchase Receipt ${out.purchase_receipt}`, `${out.lines.length} line(s) into ${session.boutique?.warehouse}`)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
function addReqLine(item_code: string) {
  if (!reqLines.value.some((l) => l.item_code === item_code)) reqLines.value.push({ item_code, qty: 6 })
  reqSearch.value = ''
}
async function sendRequest() {
  if (!reqLines.value.length) return
  busy.value = true
  try {
    const out = await warehouseApi.store.replenish({ boutique: boutique.value, lines: reqLines.value.filter((l) => l.qty > 0), reason: reqReason.value || undefined })
    sync.notify('good', `Request ${out.name} sent to the warehouse`, out.material_request || undefined)
    requesting.value = false
    reqLines.value = []
    reqReason.value = ''
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-body receive-body">
      <div class="between" style="margin-bottom: 18px; flex-wrap: wrap; gap: 10px">
        <div>
          <div class="page-title">Receive</div>
          <div class="muted" style="margin-top: 4px; font-size: 13px">
            <!-- the store code, not the raw ERPNext warehouse: "OK-SAP - CCZ" leaks the company abbreviation into user-facing copy -->
            <!-- v0.6 R: the stamp says what it is and which clock it is on (the store's) -->
            {{ session.boutique?.boutique_name }} · {{ session.boutique?.name }}<span v-if="inbound"> · data as of {{ fmtDateTimeZoned(inbound.as_of) }}</span>
          </div>
        </div>
        <div class="row">
          <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading' : 'Refresh' }}</button>
          <button class="btn btn-primary" data-testid="request-from-warehouse" @click="requesting = true">Request from warehouse</button>
        </div>
      </div>
      <div v-if="error" class="crit" style="font-size: 13px; margin-bottom: 12px" data-testid="receive-error">{{ error }}</div>

      <div v-if="result" class="card block result" data-testid="receive-result">
        <div class="between">
          <div class="section-title">{{ result.name }} · {{ result.final ? 'received' : 'partial receipt saved' }}</div>
          <button class="btn btn-ghost" @click="result = null">Dismiss</button>
        </div>
        <div class="muted" style="font-size: 14px">
          Stock Entry <span class="good" data-testid="receive-stock-entry">{{ result.stock_entry_receive || '—' }}</span><span v-if="result.stock_entry_damaged"> · damaged {{ result.stock_entry_damaged }}</span>
          <span v-if="result.discrepancies.length" class="warn"> · {{ result.discrepancies.length }} discrepancy(ies): {{ result.discrepancies.join(', ') }}</span>
        </div>
      </div>
      <div v-if="prResult" class="card block result">
        <div class="between">
          <div class="section-title">Purchase Receipt {{ prResult.purchase_receipt }}</div>
          <button class="btn btn-ghost" @click="prResult = null">Dismiss</button>
        </div>
        <div class="muted" style="font-size: 14px">{{ prResult.lines.map((l) => `${l.item_code} × ${l.qty}`).join(' · ') }}</div>
      </div>

      <div class="cols">
        <div class="card block" data-testid="inbound-shipments">
          <div class="between">
            <div class="section-title">From the warehouse</div>
            <span class="pill" :class="inbound?.shipments.length ? 'pill-accent' : ''">{{ inbound?.shipments.length || 0 }} in transit</span>
          </div>
          <div v-if="!inbound?.shipments.length" class="empty label label-dim">Nothing on its way right now.</div>
          <button v-for="s in inbound?.shipments || []" :key="s.name" class="ship" :data-testid="`inbound-${s.name}`" @click="openShipment = s">
            <div class="between">
              <span style="font-weight: 500">{{ s.name }}<span v-if="s.priority && s.priority !== 'Normal'" class="accent"> ⚑</span></span>
              <span class="num">{{ s.units }} <span class="label label-dim">units</span></span>
            </div>
            <div class="label label-dim" style="margin-top: 4px">
              {{ s.carrier || 'carrier tbd' }} {{ s.service || '' }}<span v-if="s.tracking_no"> · {{ s.tracking_no }}</span> · shipped {{ s.shipped_at ? fmtDateTime(s.shipped_at) : '' }}<span v-if="s.units_received"> · {{ s.units_received }} already received</span>
            </div>
          </button>
          <template v-if="inbound?.preparing.length">
            <div class="label label-dim" style="margin-top: 10px">Being prepared at the warehouse</div>
            <div v-for="p in inbound.preparing" :key="p.name" class="between trow small">
              <span>{{ p.name }}</span><span class="pill pill-accent">{{ p.status }}</span>
            </div>
          </template>
        </div>

        <div class="card block" data-testid="vendor-pos">
          <div class="between">
            <div class="section-title">Vendor deliveries (POs)</div>
            <span class="pill">{{ inbound?.purchase_orders.length || 0 }} open</span>
          </div>
          <div v-if="!inbound?.purchase_orders.length" class="empty label label-dim">No purchase orders addressed to this store.</div>
          <button v-for="po in inbound?.purchase_orders || []" :key="po.name" class="ship" :data-testid="`po-${po.name}`" @click="openPo = po">
            <div class="between"><span style="font-weight: 500">{{ po.name }}</span><span class="num">{{ Math.round(po.per_received) }}%</span></div>
            <div class="label label-dim" style="margin-top: 4px">{{ po.supplier_name || po.supplier }} · expected {{ po.schedule_date }} · {{ po.items.length }} lines</div>
          </button>
        </div>

        <div class="card block" data-testid="store-requests">
          <div class="between">
            <div class="section-title">My requests</div>
            <span class="pill" :class="inbound?.open_requests ? 'pill-warn' : ''">{{ inbound?.open_requests || 0 }} pending</span>
          </div>
          <div v-if="!requests.length" class="empty label label-dim">No replenishment requests yet — use the low-stock list on Shift or "Request from warehouse".</div>
          <div v-for="r in requests" :key="r.name" class="trow small" :data-testid="`req-${r.name}`">
            <div class="between">
              <span>{{ r.name }} <span class="muted">· {{ plural(r.items, 'item') }} · {{ r.units }} u</span></span>
              <span class="pill" :class="r.status === 'Pending Approval' ? 'pill-warn' : r.status === 'Rejected' ? 'pill-crit' : 'pill-good'">{{ r.status }}</span>
            </div>
            <div class="label label-dim" style="margin-top: 2px">
              {{ r.requested_at ? fmtDateTime(r.requested_at) : '' }}<span v-if="r.shipment"> · {{ r.shipment }}</span><span v-if="r.rejection_reason" class="crit"> · {{ r.rejection_reason }}</span>
            </div>
          </div>
          <template v-if="inbound?.recent.length">
            <div class="label label-dim" style="margin-top: 10px">Recently received</div>
            <div v-for="s in inbound.recent" :key="s.name" class="between trow small">
              <span>{{ s.name }}</span><span class="muted">{{ s.received_at ? fmtDateTime(s.received_at) : '' }}</span>
            </div>
          </template>
        </div>
      </div>
    </div>

    <Modal v-if="openShipment" :title="`Receive ${openShipment.name}`" width="900px" @close="openShipment = null">
      <div class="between" style="margin-bottom: 12px; flex-wrap: wrap; gap: 8px">
        <div class="muted">{{ openShipment.carrier }} {{ openShipment.service }}<span v-if="openShipment.tracking_no"> · {{ openShipment.tracking_no }}</span> · {{ openShipment.packages || 1 }} parcel(s) · scan each unit or tap +</div>
        <button v-if="catalog.settings.scan_enabled" class="btn" @click="scan.openSheet('raw')">Camera scan</button>
      </div>
      <CountSheet :lines="shipmentLines" allow-damaged :scan-source="capture" :busy="busy" @confirm="confirmShipment" />
    </Modal>
    <Modal v-if="openPo" :title="`Receive ${openPo.name}`" width="900px" @close="openPo = null">
      <div class="muted" style="margin-bottom: 12px">{{ openPo.supplier_name || openPo.supplier }} → {{ session.boutique?.warehouse }} · Purchase Receipt against the PO</div>
      <CountSheet :lines="poLines" :scan-source="capture" :busy="busy" confirm-label="Post Purchase Receipt" @confirm="confirmPo" />
    </Modal>
    <Modal v-if="requesting" title="Request from warehouse" width="640px" @close="requesting = false">
      <div class="field">
        <label class="label">Add item</label>
        <input v-model="reqSearch" class="input" placeholder="Search the catalogue" data-testid="req-search" />
        <div v-if="reqMatches.length" class="matches">
          <button v-for="it in reqMatches" :key="it.item_code" class="match" @click="addReqLine(it.item_code)">
            <span class="ellipsis">{{ it.item_name }}</span><span class="label label-dim">{{ it.item_code }}</span>
          </button>
        </div>
      </div>
      <div v-if="!reqLines.length" class="label label-dim" style="padding: 8px 0">No lines yet.</div>
      <div v-for="(l, i) in reqLines" :key="l.item_code" class="between trow">
        <span><span style="font-weight: 500">{{ catalog.byCode[l.item_code]?.item_name || l.item_code }}</span> <span class="label label-dim">{{ l.item_code }}</span></span>
        <span class="row">
          <input v-model.number="l.qty" class="input qty" inputmode="numeric" />
          <button class="btn btn-ghost" @click="reqLines.splice(i, 1)">Remove</button>
        </span>
      </div>
      <div class="field" style="margin-top: 12px"><label class="label">Reason (optional)</label><input v-model="reqReason" class="input" /></div>
      <template #footer>
        <button class="btn btn-primary" :disabled="busy || !reqLines.length" data-testid="req-send" @click="sendRequest">Send request</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
/**
 * v0.6 R — the three cards used to be 140 px tall at the top of a 1024 px screen with ~740 px of
 * dark nothing under them, which reads as a half-built page. The columns now fill the screen (the
 * same board shape as the warehouse wall) and each empty state sits in the middle of its column,
 * so a store with nothing inbound looks *finished and empty* rather than unfinished.
 */
.receive-body {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
  flex: 1;
  min-height: 320px;
  align-items: stretch;
}
.block {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: auto;
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: 24px 8px;
  max-width: 34ch;
  margin: 0 auto;
  line-height: 1.6;
}
.result {
  margin-bottom: 16px;
  border-color: var(--accent);
}
.ship {
  width: 100%;
  text-align: left;
  padding: 12px 14px;
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
  min-height: 56px;
}
.ship:hover {
  border-color: var(--accent);
}
.trow {
  padding: 8px 0;
  border-bottom: var(--line-w) solid var(--line);
  font-size: 14px;
}
.trow.small {
  font-size: 13px;
}
.qty {
  width: 76px;
  text-align: right;
  min-height: 40px;
}
.matches {
  border: var(--line-w) solid var(--line);
  margin-top: 6px;
}
.match {
  width: 100%;
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  text-align: left;
  min-height: 44px;
  border-bottom: var(--line-w) solid var(--line);
}
</style>
