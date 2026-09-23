<script setup lang="ts">
/**
 * v1.5 — Stock → **a store's shelf**: what one store holds, item by item, what it sells there,
 * what sold in the last week and month, and the way to **correct** a quantity from the desk.
 *
 * Counting belongs at the store (the till's Count screen — the person with the shelf in front of
 * them); this is for corrections, and every one posts a Stock Reconciliation with a reason so the
 * ledger says who changed what and why. No cost is shown here — the same rows the store manager
 * sees on their till.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { storeStockApi, filterStoreStock, sortStoreStock, storeStockGroups, storeStockTotals, type StockFilter, type StoreStock, type StoreStockRow } from '@/api/storeStock'
import { fmtCover } from '@/warehouse/inbound'
import { fmtInt, fmtMoney } from '@/utils/money'
import Modal from '@/components/Modal.vue'
import PriceBoardSheet from '../pricing/PriceBoardSheet.vue'

const props = defineProps<{ boutique: string; boutiqueName?: string | null }>()
const emit = defineEmits<{ notice: [msg: string] }>()

const data = ref<StoreStock | null>(null)
const loading = ref(false)
const error = ref('')
const q = ref('')
const group = ref('')
const filter = ref<StockFilter>('all')
const adjusting = ref<StoreStockRow | null>(null)
const newQty = ref<number | null>(null)
const reason = ref('')
const formError = ref('')
const busy = ref(false)
const pricing = ref<{ item_code: string; item_name?: string | null } | null>(null)

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
    data.value = await storeStockApi.stock(props.boutique)
    if (group.value && !groups.value.includes(group.value)) group.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.boutique, () => void load())

function startAdjust(r: StoreStockRow) {
  adjusting.value = r
  newQty.value = r.on_hand
  reason.value = ''
  formError.value = ''
}
async function confirmAdjust() {
  if (!adjusting.value) return
  const qty = Number(newQty.value)
  if (!Number.isFinite(qty) || qty < 0) return void (formError.value = 'Enter the quantity actually on the shelf — zero or more.')
  if (!reason.value.trim()) return void (formError.value = 'Say why — it goes on the stock ledger under your name.')
  busy.value = true
  formError.value = ''
  try {
    const out = await storeStockApi.adjust(props.boutique, adjusting.value.item_code, qty, reason.value.trim())
    emit('notice', out.changed ? `${out.item_name || out.item_code} at ${props.boutiqueName || props.boutique}: ${fmtInt(out.before)} → ${fmtInt(out.after)} (${out.stock_reconciliation})` : `${out.item_code} already shows ${fmtInt(out.before)} — nothing changed`)
    adjusting.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="panel" data-testid="store-stock-panel">
    <div class="head">
      <div class="head-id">
        <div class="section-title">On the shelf · {{ data?.boutique_name || boutiqueName || boutique }}</div>
        <div class="label label-dim">What the store holds and sells it for — the same rows the manager sees on their till. Correct a quantity here only when the store cannot count it; every correction is logged with its reason.</div>
      </div>
      <div class="row controls">
        <input v-model="q" class="input search" placeholder="Search item, code or barcode" data-testid="store-stock-search" />
        <select v-model="group" class="input select" aria-label="Item group">
          <option value="">All groups</option>
          <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
        </select>
        <div class="seg">
          <button v-for="f in FILTERS" :key="f.key" class="chip" :class="{ active: filter === f.key }" :data-testid="`store-stock-filter-${f.key}`" @click="filter = f.key">{{ f.label }}</button>
        </div>
        <button class="btn" :disabled="loading" @click="load">Refresh</button>
      </div>
    </div>

    <div class="kpis">
      <div class="kpi"><div class="label">Items</div><div class="num v">{{ fmtInt(totals.items) }}</div><div class="label label-dim">{{ fmtInt(totals.units) }} units on the shelf</div></div>
      <div class="kpi"><div class="label">Retail on the shelf</div><div class="num v accent">{{ fmtMoney(totals.retail) }}</div><div class="label label-dim">at this store's prices</div></div>
      <div class="kpi"><div class="label">Low</div><div class="num v" :class="{ warn: totals.low }">{{ fmtInt(totals.low) }}</div><div class="label label-dim">at or under reorder level</div></div>
      <div class="kpi"><div class="label">Out and selling</div><div class="num v" :class="{ crit: totals.out }">{{ fmtInt(totals.out) }}</div><div class="label label-dim">sold in 28 days, none left</div></div>
    </div>

    <div v-if="error" class="banner crit" data-testid="store-stock-error">{{ error }}</div>

    <div v-if="!rows.length && !loading" class="empty">
      <div class="section-title">{{ data?.items.length ? 'Nothing matches those filters' : 'Nothing on the shelf yet' }}</div>
    </div>
    <div v-else class="scroller">
      <table class="table">
        <thead>
          <tr>
            <th>Item</th>
            <th>Group</th>
            <th class="num">On hand</th>
            <th class="num">Coming</th>
            <th class="num">Sold 7d</th>
            <th class="num">Sold 28d</th>
            <th class="num">Cover</th>
            <th class="num">Shelf price</th>
            <th class="num">Reorder</th>
            <th class="acts"><span class="vh">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.item_code" :class="{ low: r.low }" :data-testid="`store-stock-${r.item_code}`">
            <td>
              <div class="ellipsis wide">{{ r.item_name || r.item_code }}</div>
              <div class="label label-dim">{{ r.item_code }}<span v-if="r.size"> · {{ r.size }}</span><span v-if="r.barcode && r.barcode !== r.item_code"> · {{ r.barcode }}</span></div>
            </td>
            <td class="muted">{{ r.item_group || '—' }}</td>
            <td class="num" :class="{ crit: r.out && r.sold_28 > 0, warn: r.low && !r.out }">{{ fmtInt(r.on_hand) }}</td>
            <td class="num" :class="r.in_transit ? 'accent' : 'muted'">{{ r.in_transit ? fmtInt(r.in_transit) : '—' }}</td>
            <td class="num">{{ r.sold_7 ? fmtInt(r.sold_7) : '—' }}</td>
            <td class="num">{{ r.sold_28 ? fmtInt(r.sold_28) : '—' }}</td>
            <td class="num"><span :class="{ crit: r.cover_days != null && r.cover_days < 7 }">{{ fmtCover(r.cover_days) }}</span></td>
            <td class="num">
              <div>{{ fmtMoney(r.rate) }}</div>
              <div class="label label-dim">{{ r.rate_source === 'Store override' ? 'this store' : 'chain' }}</div>
            </td>
            <td class="num muted">{{ r.reorder_level ? fmtInt(r.reorder_level) : '—' }}</td>
            <td class="acts">
              <div class="rowacts">
                <button class="btn btn-act" :data-testid="`store-stock-prices-${r.item_code}`" @click="pricing = { item_code: r.item_code, item_name: r.item_name }">Prices</button>
                <button class="btn btn-act" :data-testid="`store-stock-adjust-${r.item_code}`" @click="startAdjust(r)">Adjust</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="adjusting" :title="`Correct ${adjusting.item_name} at ${data?.boutique_name || boutique}`" width="520px" @close="adjusting = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="adjust-error">{{ formError }}</div>
      <p class="muted" style="margin-top: 0">The store shows <b>{{ fmtInt(adjusting.on_hand) }}</b>. Enter what is actually on the shelf. A Stock Reconciliation is posted in your name with the reason on it.</p>
      <div class="form">
        <div class="field">
          <label class="label" for="adj-qty">Actual quantity</label>
          <input id="adj-qty" v-model.number="newQty" class="input" type="number" min="0" step="1" inputmode="numeric" data-testid="adjust-qty" />
        </div>
        <div class="field span">
          <label class="label" for="adj-reason">Reason (on the ledger)</label>
          <input id="adj-reason" v-model="reason" class="input" placeholder="Broken in store · miscount at receiving · tester opened" data-testid="adjust-reason" />
        </div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="adjusting = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy" data-testid="adjust-confirm" @click="confirmAdjust">{{ busy ? 'Posting…' : 'Post correction' }}</button>
      </template>
    </Modal>

    <PriceBoardSheet v-if="pricing" :item-code="pricing.item_code" :item-name="pricing.item_name" @close="pricing = null" @notice="emit('notice', $event)" />
  </div>
</template>

<style scoped>
.panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.head-id {
  flex: 1 1 320px;
  min-width: 0;
  max-width: 62ch;
}
.controls {
  flex: 0 0 auto;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.search {
  width: 230px;
}
.select {
  width: 150px;
}
.seg {
  display: flex;
  gap: 4px;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
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
.banner {
  padding: 10px 12px;
  border: var(--line-w) solid currentColor;
}
.empty {
  padding: 32px 0;
  text-align: center;
}
.scroller {
  overflow-x: auto;
  max-height: 62vh;
  overflow-y: auto;
}
.scroller .table thead th {
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
}
.wide {
  max-width: 320px;
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
  .head {
    flex-direction: column;
    align-items: stretch;
  }
  .head-id {
    flex: 0 0 auto;
    max-width: none;
  }
  .search,
  .select {
    flex: 1;
    width: auto;
    min-width: 130px;
  }
  .scroller {
    max-height: none;
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
