<script setup lang="ts">
/**
 * v1.5 — **Stock** (the till, managers): what this store holds, item by item — on hand, what is
 * on its way from Houston, what sold this week and this month, the shelf price here and where it
 * comes from — and the three things a manager does about a row:
 *
 *   **Request** more from the warehouse (`inventory.replenish` — the same request Receive shows),
 *   **Count** the shelf (the Count screen — a count is done with the shelf in front of you),
 *   **Propose a price** for this store (`purchasing.request_price_change` — head office or the
 *   warehouse desk approves, unless the chain has switched approval off, in which case it takes
 *   effect at once; the request is recorded either way).
 *
 * No cost appears here. What Houston paid is not shop-floor information.
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { storeStockApi, filterStoreStock, sortStoreStock, storeStockGroups, storeStockTotals, type StockFilter, type StoreStock, type StoreStockRow } from '@/api/storeStock'
import { warehouseApi } from '@/api/warehouse'
import { purchasingApi } from '@/api/purchasing'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { fmtCover } from '@/warehouse/inbound'
import { fmtDateTime } from '@/utils/device'
import { fmtInt, fmtMoney } from '@/utils/money'
import Modal from '@/components/Modal.vue'

const session = useSessionStore()
const sync = useSyncStore()
const router = useRouter()

const data = ref<StoreStock | null>(null)
const loading = ref(false)
const error = ref('')
const notice = ref('')
const q = ref('')
const group = ref('')
const filter = ref<StockFilter>('all')

const requesting = ref<StoreStockRow | null>(null)
const reqQty = ref<number | null>(null)
const reqReason = ref('')
const proposing = ref<StoreStockRow | null>(null)
const newRate = ref<number | null>(null)
const priceReason = ref('')
const formError = ref('')
const busy = ref(false)

const boutique = computed(() => session.boutique!.name)
const rows = computed(() => sortStoreStock(filterStoreStock(data.value?.items || [], { q: q.value, group: group.value, filter: filter.value })))
const groups = computed(() => storeStockGroups(data.value?.items || []))
const totals = computed(() => storeStockTotals(rows.value))
const FILTERS: { key: StockFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'low', label: 'Low' },
  { key: 'out', label: 'Out' },
  { key: 'moving', label: 'Selling' },
  { key: 'idle', label: 'Not moving' }
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await storeStockApi.stock(boutique.value)
    if (group.value && !groups.value.includes(group.value)) group.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())

function say(msg: string) {
  notice.value = msg
  setTimeout(() => {
    if (notice.value === msg) notice.value = ''
  }, 6000)
}

/** A sensible default ask: back up to two weeks of cover at the 28-day pace, at least the reorder level, at least 1. */
function suggestedQty(r: StoreStockRow): number {
  const twoWeeks = Math.ceil((r.sold_28 / 28) * 14)
  return Math.max(1, twoWeeks - r.on_hand - r.in_transit, r.reorder_level - r.on_hand - r.in_transit)
}
function startRequest(r: StoreStockRow) {
  requesting.value = r
  reqQty.value = suggestedQty(r)
  reqReason.value = ''
  formError.value = ''
}
async function confirmRequest() {
  if (!requesting.value) return
  const qty = Number(reqQty.value)
  if (!(qty > 0)) return void (formError.value = 'How many? One or more.')
  busy.value = true
  formError.value = ''
  try {
    const out = await warehouseApi.store.replenish({ boutique: boutique.value, item: requesting.value.item_code, qty, reason: reqReason.value.trim() || undefined })
    say(`Requested ${fmtInt(qty)} × ${requesting.value.item_name} from the warehouse (${out.name}) — track it on Receive`)
    requesting.value = null
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function startPropose(r: StoreStockRow) {
  proposing.value = r
  newRate.value = r.rate
  priceReason.value = ''
  formError.value = ''
}
async function confirmPropose() {
  if (!proposing.value) return
  const rate = Number(newRate.value)
  if (!(rate > 0)) return void (formError.value = 'Enter the price this store should sell it for.')
  if (Math.abs(rate - proposing.value.rate) < 0.005) return void (formError.value = 'That is the price already.')
  if (!priceReason.value.trim()) return void (formError.value = 'Say why — the person who approves it reads this.')
  busy.value = true
  formError.value = ''
  try {
    const out = await purchasingApi.request_price_change(proposing.value.item_code, boutique.value, rate, priceReason.value.trim())
    say(out.auto_approved ? `${proposing.value.item_name} now sells for ${fmtMoney(rate)} at this store (${out.name})` : `Proposed ${fmtMoney(rate)} for ${proposing.value.item_name} — the warehouse desk has it (${out.name}); the shelf price changes when they approve`)
    proposing.value = null
    if (out.auto_approved) await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
function goCount() {
  void router.push({ name: 'count' })
}
</script>

<template>
  <div class="page" data-testid="stock-view">
    <div class="page-body">
      <div class="between head">
        <div>
          <div class="page-title">Stock</div>
          <div class="muted" style="margin-top: 4px; font-size: 13px">
            {{ data?.boutique_name || session.boutique?.boutique_name }}<span v-if="data"> · as of {{ fmtDateTime(data.as_of) }}</span>
          </div>
        </div>
        <div class="row">
          <button class="btn" :disabled="loading" data-testid="stock-reload" @click="load">{{ loading ? 'Loading' : 'Reload' }}</button>
          <button class="btn btn-primary" data-testid="stock-count" @click="goCount">Count the shelf</button>
        </div>
      </div>

      <div v-if="!session.isManager" class="gate" data-testid="stock-gate">
        <div class="section-title">Managers only</div>
        <div class="muted">Stock levels, prices and warehouse requests are the manager's screen. Ask your manager.</div>
      </div>

      <template v-else>
        <div v-if="notice" class="notice" data-testid="stock-notice">{{ notice }}</div>
        <div v-if="error" class="crit" style="font-size: 13px; margin-bottom: 12px" data-testid="stock-error">{{ error }}</div>
        <div v-if="!sync.online" class="muted" style="font-size: 13px; margin-bottom: 12px">Offline — showing the last figures loaded. Requests and price proposals need the connection back.</div>

        <div class="kpis">
          <div class="kpi"><div class="label">Items</div><div class="num v">{{ fmtInt(totals.items) }}</div><div class="label label-dim">{{ fmtInt(totals.units) }} units</div></div>
          <div class="kpi"><div class="label">Retail on the shelf</div><div class="num v accent">{{ fmtMoney(totals.retail) }}</div><div class="label label-dim">at this store's prices</div></div>
          <div class="kpi"><div class="label">Low</div><div class="num v" :class="{ warn: totals.low }">{{ fmtInt(totals.low) }}</div><div class="label label-dim">at or under reorder level</div></div>
          <div class="kpi"><div class="label">Out and selling</div><div class="num v" :class="{ crit: totals.out }">{{ fmtInt(totals.out) }}</div><div class="label label-dim">sold in 28 days, none left</div></div>
        </div>

        <div class="controls">
          <input v-model="q" class="input search" placeholder="Search item, code or barcode" data-testid="stock-search" />
          <select v-model="group" class="input select" aria-label="Item group">
            <option value="">All groups</option>
            <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
          </select>
          <div class="seg">
            <button v-for="f in FILTERS" :key="f.key" class="chip" :class="{ active: filter === f.key }" :data-testid="`stock-filter-${f.key}`" @click="filter = f.key">{{ f.label }}</button>
          </div>
        </div>

        <div v-if="!rows.length && !loading" class="empty">
          <div class="section-title">{{ data?.items.length ? 'Nothing matches those filters' : 'Nothing on the shelf yet' }}</div>
          <div class="muted">{{ data?.items.length ? 'Widen the search or clear the filter.' : 'Stock arrives through Receive when the warehouse ships it.' }}</div>
        </div>
        <div v-else class="scroller">
          <table class="table">
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">On hand</th>
                <th class="num">Coming</th>
                <th class="num">Sold 7d</th>
                <th class="num">Sold 28d</th>
                <th class="num">Cover</th>
                <th class="num">Price here</th>
                <th class="acts"><span class="vh">Actions</span></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.item_code" :class="{ low: r.low }" :data-testid="`stock-${r.item_code}`">
                <td>
                  <div class="ellipsis wide">{{ r.item_name || r.item_code }}</div>
                  <div class="label label-dim">{{ r.item_group || '' }}<span v-if="r.size"> · {{ r.size }}</span><span v-if="r.barcode && r.barcode !== r.item_code"> · {{ r.barcode }}</span></div>
                </td>
                <td class="num" :class="{ crit: r.out && r.sold_28 > 0, warn: r.low && !r.out }">
                  {{ fmtInt(r.on_hand) }}
                  <div v-if="r.reorder_level" class="label label-dim">reorder at {{ fmtInt(r.reorder_level) }}</div>
                </td>
                <td class="num" :class="r.in_transit ? 'accent' : 'muted'">{{ r.in_transit ? fmtInt(r.in_transit) : '—' }}</td>
                <td class="num">{{ r.sold_7 ? fmtInt(r.sold_7) : '—' }}</td>
                <td class="num">{{ r.sold_28 ? fmtInt(r.sold_28) : '—' }}</td>
                <td class="num"><span :class="{ crit: r.cover_days != null && r.cover_days < 7 }">{{ fmtCover(r.cover_days) }}</span></td>
                <td class="num">
                  <div>{{ fmtMoney(r.rate) }}</div>
                  <div class="label label-dim">{{ r.rate_source === 'Store override' ? 'this store' : 'chain price' }}</div>
                </td>
                <td class="acts">
                  <div class="rowacts">
                    <button class="btn btn-act" :disabled="!sync.online" :data-testid="`stock-request-${r.item_code}`" @click="startRequest(r)">Request</button>
                    <button class="btn btn-act" :disabled="!sync.online" :data-testid="`stock-propose-${r.item_code}`" @click="startPropose(r)">Propose price</button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </div>

    <Modal v-if="requesting" :title="`Request ${requesting.item_name} from the warehouse`" width="480px" @close="requesting = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="request-error">{{ formError }}</div>
      <p class="muted" style="margin-top: 0">On hand {{ fmtInt(requesting.on_hand) }}<span v-if="requesting.in_transit"> · {{ fmtInt(requesting.in_transit) }} already on the way</span> · sold {{ fmtInt(requesting.sold_28) }} in 28 days.</p>
      <div class="form">
        <div class="field">
          <label class="label" for="rq-qty">Quantity</label>
          <input id="rq-qty" v-model.number="reqQty" class="input" type="number" min="1" step="1" inputmode="numeric" data-testid="request-qty" />
        </div>
        <div class="field span">
          <label class="label" for="rq-why">Note for the warehouse (optional)</label>
          <input id="rq-why" v-model="reqReason" class="input" placeholder="Weekend rush · display refill" />
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="requesting = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy" data-testid="request-confirm" @click="confirmRequest">{{ busy ? 'Sending…' : 'Send request' }}</button>
      </template>
    </Modal>

    <Modal v-if="proposing" :title="`Propose a price for ${proposing.item_name}`" width="480px" @close="proposing = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="propose-error">{{ formError }}</div>
      <p class="muted" style="margin-top: 0">Sells here for <b>{{ fmtMoney(proposing.rate) }}</b> ({{ proposing.rate_source === 'Store override' ? 'this store’s price' : 'the chain price' }}). The new price applies to this store only, once approved.</p>
      <div class="form">
        <div class="field">
          <label class="label" for="pp-rate">New price</label>
          <input id="pp-rate" v-model.number="newRate" class="input" type="number" min="0.01" step="0.01" inputmode="decimal" data-testid="propose-rate" />
        </div>
        <div class="field span">
          <label class="label" for="pp-why">Why (the approver reads this)</label>
          <input id="pp-why" v-model="priceReason" class="input" placeholder="Competitor across the road · slow seller · box damaged" data-testid="propose-reason" />
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="proposing = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy" data-testid="propose-confirm" @click="confirmPropose">{{ busy ? 'Sending…' : 'Propose' }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.head {
  margin-bottom: 18px;
  flex-wrap: wrap;
  gap: 12px;
}
.gate {
  padding: 40px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.notice {
  padding: 10px 14px;
  margin-bottom: 12px;
  border: var(--line-w) solid var(--accent);
  background: var(--accent-soft);
}
.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
  margin-bottom: 14px;
}
.kpi {
  padding: 12px 16px;
  border-right: var(--line-w) solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.kpi:last-child {
  border-right: 0;
}
.kpi .v {
  font-size: 22px;
}
.controls {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.search {
  width: 260px;
}
.select {
  width: 170px;
}
.seg {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.empty {
  padding: 32px 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.scroller {
  overflow-x: auto;
}
.wide {
  max-width: 340px;
}
.acts {
  width: 1%;
  white-space: nowrap;
  position: relative;
}
.rowacts {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.btn-act {
  padding: 0 14px;
  min-height: var(--touch);
  font-size: 11px;
  letter-spacing: 0.14em;
}
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
tr.low td {
  background: rgba(211, 165, 91, 0.06);
}
.form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
}
.form .span {
  grid-column: 1 / -1;
}
@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .kpi:nth-child(2) {
    border-right: 0;
  }
}
@media (max-width: 767px) {
  .search,
  .select {
    flex: 1;
    width: auto;
    min-width: 130px;
  }
  .wide {
    max-width: 180px;
  }
  .rowacts {
    flex-direction: column;
    align-items: stretch;
  }
  .form {
    grid-template-columns: 1fr;
  }
}
</style>
