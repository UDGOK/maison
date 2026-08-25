<script setup lang="ts">
/**
 * v1.0 §F — Stock: what the **Houston warehouse** is holding, valued at moving average.
 *
 * The successor to the v0.6 `warehouse_stock` tab: same rows, plus the valuation rate, the stock
 * value, how many days of cover it buys and what is already on order — so the buyer can see why an
 * item is on the Buying list without leaving the desk.
 *
 * v1.1 §D — and the way **out**: every row opens the distribution sheet, because "Houston is
 * holding 288 of these" is the moment you decide where they should be instead.
 */
import { computed, onMounted, ref } from 'vue'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import { filterStock, fmtCover, stockGroups, stockTotals } from '@/warehouse/inbound'
import { fmtInt, fmtMoney } from '@/utils/money'
import SendToStoresSheet from './SendToStoresSheet.vue'

const emit = defineEmits<{ notice: [msg: string] }>()

const store = usePurchasingStore()
const wh = useWarehouseStore()

const q = ref('')
const group = ref('')
const lowOnly = ref(false)
/** v1.1 — the item whose distribution sheet is open. */
const sending = ref<{ item_code: string; item_name?: string | null } | null>(null)

const warehouse = computed(() => store.stockSummary?.warehouse || wh.me?.main_warehouse || 'HOU-WH')
const groups = computed(() => stockGroups(store.stock))
const rows = computed(() => filterStock(store.stock, { group: group.value, lowOnly: lowOnly.value }))
const totals = computed(() => stockTotals(rows.value))
const filtered = computed(() => rows.value.length !== store.stock.length)

async function load() {
  const out = await store.loadStock(q.value.trim() || undefined)
  // a group that no longer exists in the result would silently hide every row
  if (out && group.value && !stockGroups(out.rows).includes(group.value)) group.value = ''
}
function clearSearch() {
  if (!q.value) return
  q.value = ''
  void load()
}
function reset() {
  group.value = ''
  lowOnly.value = false
  q.value = ''
  void load()
  emit('notice', 'Stock filters cleared')
}

function sendToStores(row: { item_code: string; item_name?: string }) {
  sending.value = { item_code: row.item_code, item_name: row.item_name ?? null }
}
/** Sending moves units into `committed`, so what Houston has available has changed underneath. */
function onSent() {
  void load()
}

onMounted(() => void load())
</script>

<template>
  <div class="stock" data-testid="stock-board">
    <section class="card block">
      <div class="head">
        <div class="head-id">
          <div class="section-title">Stock on hand · {{ warehouse }}</div>
          <div class="label label-dim">The Houston warehouse — not a store's shelf. Valued at moving average, the cost the last receipt moved it to.</div>
        </div>
        <div class="row controls">
          <input
            v-model="q"
            class="input search"
            placeholder="Search item, code or barcode"
            data-testid="stock-search"
            @keydown.enter.prevent="load"
            @keydown.esc="clearSearch"
          />
          <select v-model="group" class="input select" data-testid="stock-group" aria-label="Item group">
            <option value="">All groups</option>
            <option v-for="g in groups" :key="g" :value="g">{{ g }}</option>
          </select>
          <button class="chip" :class="{ active: lowOnly }" data-testid="stock-low-only" @click="lowOnly = !lowOnly">Low only</button>
          <button class="btn" :disabled="store.loading" data-testid="stock-search-go" @click="load">Search</button>
        </div>
      </div>

      <div class="kpis" data-testid="stock-summary">
        <div class="kpi">
          <div class="label">Stock value</div>
          <div class="num v accent">{{ fmtMoney(totals.value) }}</div>
          <div class="label label-dim">at moving average</div>
        </div>
        <div class="kpi">
          <div class="label">Items</div>
          <div class="num v">{{ fmtInt(totals.items) }}</div>
          <div class="label label-dim">{{ fmtInt(totals.units) }} units on hand</div>
        </div>
        <div class="kpi">
          <div class="label">Low stock</div>
          <div class="num v" :class="{ warn: totals.low }">{{ fmtInt(totals.low) }}</div>
          <div class="label label-dim">at or under reorder level</div>
        </div>
        <div class="kpi">
          <div class="label">On order</div>
          <div class="num v">{{ fmtInt(totals.on_order) }}</div>
          <div class="label label-dim">units on submitted orders</div>
        </div>
      </div>

      <div v-if="store.error" class="banner crit" data-testid="stock-error">{{ store.error }}</div>

      <div v-if="filtered || q" class="between filters">
        <div class="label label-dim">
          Showing {{ rows.length }} of {{ store.stock.length }} loaded rows<span v-if="q"> · matching “{{ q }}”</span><span v-if="group"> · {{ group }}</span
          ><span v-if="lowOnly"> · low stock only</span>
        </div>
        <button class="btn btn-ghost" data-testid="stock-reset" @click="reset">Clear filters</button>
      </div>

      <div v-if="!rows.length && !store.loading" class="empty" data-testid="stock-empty">
        <div class="section-title">{{ store.stock.length ? 'Nothing matches those filters' : 'No stock at the warehouse' }}</div>
        <p class="label label-dim">
          {{ store.stock.length ? 'Widen the search or clear the group filter.' : 'Receive a vendor delivery on Inbound and it will show up here, valued.' }}
        </p>
      </div>

      <div v-else class="scroller">
        <table class="table">
          <thead>
            <tr>
              <th>Item</th>
              <th>Group</th>
              <th class="num">On hand</th>
              <th class="num">Value at MA</th>
              <th class="num">Stock value</th>
              <th class="num">Cover</th>
              <th class="num">On order</th>
              <th class="num">Reorder</th>
              <th class="send-col"><span class="vh">Send to stores</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="r.item_code" :class="{ low: r.low }" :data-testid="`stock-${r.item_code}`" :data-low="r.low ? '1' : '0'">
              <td>
                <div class="ellipsis wide">{{ r.item_name || r.item_code }}</div>
                <div class="label label-dim">{{ r.item_code }}<span v-if="r.barcode && r.barcode !== r.item_code"> · {{ r.barcode }}</span></div>
              </td>
              <td class="muted">{{ r.item_group || '—' }}</td>
              <td class="num" :class="{ crit: r.actual_qty <= 0, warn: r.low && r.actual_qty > 0 }">{{ fmtInt(r.actual_qty) }}</td>
              <td class="num">{{ fmtMoney(r.valuation_rate) }}</td>
              <td class="num">{{ fmtMoney(r.stock_value) }}</td>
              <td class="num" :data-testid="`stock-cover-${r.item_code}`">
                <span :class="{ crit: r.cover_days != null && r.cover_days < 7 }">{{ fmtCover(r.cover_days) }}</span>
                <div v-if="!r.velocity" class="label label-dim">no movement</div>
              </td>
              <td class="num" :class="r.on_order ? 'accent' : 'muted'">{{ r.on_order ? fmtInt(r.on_order) : '—' }}</td>
              <td class="num muted">{{ r.reorder_level ? fmtInt(r.reorder_level) : '—' }}</td>
              <td class="send-col">
                <button
                  class="btn btn-send"
                  :disabled="r.actual_qty <= 0 || (!store.allowed && !!wh.me)"
                  :title="r.actual_qty <= 0 ? 'Nothing at Houston to send' : `Send ${r.item_code} out to the stores`"
                  :data-testid="`stock-send-${r.item_code}`"
                  @click="sendToStores(r)"
                >
                  Send to stores
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <SendToStoresSheet
      v-if="sending"
      :item-code="sending.item_code"
      :item-name="sending.item_name"
      @close="sending = null"
      @notice="emit('notice', $event)"
      @sent="onSent"
    />
  </div>
</template>

<style scoped>
.stock {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.block {
  padding: 16px 20px;
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
.filters {
  flex-wrap: wrap;
}
.empty {
  padding: 32px 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.scroller {
  overflow-x: auto;
  overscroll-behavior-x: contain;
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
.send-col {
  width: 1%;
  white-space: nowrap;
}
.btn-send {
  padding: 0 14px;
  min-height: var(--touch);
  font-size: 11px;
  letter-spacing: 0.14em;
}
/* the header is for a screen reader; the buttons already say what they do */
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
@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .kpi:nth-child(2) {
    border-right: 0;
  }
}
@media (max-width: 767px) {
  .block {
    padding: 14px;
  }
  .head,
  .between {
    flex-direction: column;
    align-items: stretch;
  }
  /* a column flex container reads `flex-basis` as a height — 320px of empty space */
  .head-id {
    flex: 0 0 auto;
    max-width: none;
  }
  .controls {
    justify-content: stretch;
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
  .btn-send {
    padding: 0 10px;
  }
}
</style>
