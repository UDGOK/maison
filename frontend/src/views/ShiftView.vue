<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api, type SalesList } from '@/api'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { fmtMoney } from '@/utils/money'
import { fmtDateTime, todayISO } from '@/utils/device'
import { round } from '@/utils/money'

const session = useSessionStore()
const sync = useSyncStore()

const date = ref(todayISO())
const server = ref<SalesList | null>(null)
const loading = ref(false)
const error = ref('')
const mode = ref<'X' | 'Z'>('X')
const closed = ref(false)
const countedCash = ref('')

/** Local view (works offline) built from the Dexie queue. */
const local = computed(() => {
  const rows = sync.queue.filter((q) => q.invoice.posting_datetime.slice(0, 10) === date.value && q.status !== 'error')
  const gross = round(rows.reduce((s, r) => s + r.receipt.grand_total, 0))
  const tax = round(rows.reduce((s, r) => s + r.receipt.total_taxes, 0))
  const net = round(rows.reduce((s, r) => s + r.receipt.net_total, 0))
  const cash = round(rows.reduce((s, r) => s + r.receipt.payments.filter((p) => p.mode_of_payment === 'Cash').reduce((a, p) => a + p.amount, 0), 0))
  const card = round(rows.reduce((s, r) => s + r.receipt.payments.filter((p) => p.mode_of_payment === 'Card').reduce((a, p) => a + p.amount, 0), 0))
  const pending = rows.filter((r) => r.status !== 'ok').length
  return { rows, gross, tax, net, cash, card, invoices: rows.length, avg: rows.length ? round(gross / rows.length) : 0, pending }
})

const totals = computed(() => {
  if (server.value) return { ...server.value.totals, avg: server.value.totals.avg_ticket, source: 'server' as const }
  const l = local.value
  return { net: l.net, tax: l.tax, gross: l.gross, cash: l.cash, card: l.card, invoices: l.invoices, avg: l.avg, source: 'local' as const }
})

const cashVariance = computed(() => (countedCash.value ? round((parseFloat(countedCash.value) || 0) - totals.value.cash) : null))

async function load() {
  loading.value = true
  error.value = ''
  server.value = null
  try {
    if (!sync.browserOnline || window.__maisonOffline) throw new Error('Offline: showing device totals only')
    server.value = await api.sales.list(session.boutique!.name, date.value)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

function printReport() {
  window.print()
}
</script>

<template>
  <div class="page">
    <div class="page-body">
      <div class="between no-print" style="margin-bottom: 20px">
        <div>
          <div class="page-title">{{ mode }} Report</div>
          <div class="muted" style="margin-top: 4px; font-size: 13px">
            {{ session.boutique?.boutique_name }} &middot; {{ totals.source === 'server' ? 'server totals' : 'device totals' }}
            <span v-if="local.pending" class="warn"> &middot; {{ local.pending }} unsynced</span>
          </div>
        </div>
        <div class="row">
          <input v-model="date" type="date" class="input" style="width: 170px" @change="load" />
          <div class="seg">
            <button class="chip" :class="{ active: mode === 'X' }" @click="mode = 'X'">X</button>
            <button class="chip" :class="{ active: mode === 'Z' }" :disabled="!session.isManager" @click="mode = 'Z'">Z</button>
          </div>
          <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading' : 'Refresh' }}</button>
          <button class="btn" @click="printReport">Print</button>
        </div>
      </div>
      <div v-if="error" class="warn no-print" style="font-size: 13px; margin-bottom: 16px">{{ error }}</div>

      <div class="kpis">
        <div class="kpi"><div class="label">Net sales</div><div class="num v">{{ fmtMoney(totals.net, session.currency) }}</div></div>
        <div class="kpi"><div class="label">Tax</div><div class="num v">{{ fmtMoney(totals.tax, session.currency) }}</div></div>
        <div class="kpi"><div class="label">Gross</div><div class="num v">{{ fmtMoney(totals.gross, session.currency) }}</div></div>
        <div class="kpi"><div class="label">Invoices</div><div class="num v">{{ totals.invoices }}</div></div>
        <div class="kpi"><div class="label">Avg ticket</div><div class="num v">{{ fmtMoney(totals.avg, session.currency) }}</div></div>
      </div>

      <div class="cols">
        <div class="card block">
          <div class="section-title">Tenders</div>
          <div class="between trow"><span class="label">Cash</span><span class="num">{{ fmtMoney(totals.cash, session.currency) }}</span></div>
          <div class="between trow"><span class="label">Card</span><span class="num">{{ fmtMoney(totals.card, session.currency) }}</span></div>
          <div class="hr"></div>
          <div class="between trow"><span class="label">Total</span><span class="num">{{ fmtMoney(totals.cash + totals.card, session.currency) }}</span></div>
        </div>

        <div v-if="mode === 'Z'" class="card block">
          <div class="section-title">Cash drawer close</div>
          <div class="field">
            <label class="label">Counted cash</label>
            <input v-model="countedCash" class="input" inputmode="decimal" placeholder="0.00" :disabled="closed" />
          </div>
          <div v-if="cashVariance !== null" class="between trow">
            <span class="label">Variance</span>
            <span class="num" :class="cashVariance === 0 ? 'good' : Math.abs(cashVariance) > 20 ? 'crit' : 'warn'">{{ fmtMoney(cashVariance, session.currency) }}</span>
          </div>
          <button class="btn btn-primary btn-block" :disabled="closed || !countedCash || local.pending > 0" @click="closed = true">
            {{ closed ? 'Shift closed' : local.pending ? 'Sync queue before closing' : 'Close shift' }}
          </button>
        </div>

        <div class="card block">
          <div class="section-title">Device sales</div>
          <div v-if="!local.rows.length" class="label label-dim" style="padding: 12px 0">No sales on this device for {{ date }}</div>
          <div v-for="r in local.rows" :key="r.offline_uuid" class="between trow small">
            <span class="muted">{{ fmtDateTime(r.invoice.posting_datetime, { year: undefined, month: undefined, day: undefined }) }} &middot; {{ r.invoice_name || r.offline_uuid.slice(0, 8).toUpperCase() }}</span>
            <span class="num">{{ fmtMoney(r.receipt.grand_total, r.receipt.currency) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  gap: 4px;
}
.kpis {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  border: var(--line-w) solid var(--line);
  background: var(--surface);
  margin-bottom: 20px;
}
.kpi {
  padding: 16px 20px;
  border-right: var(--line-w) solid var(--line);
}
.kpi:last-child {
  border-right: 0;
}
.kpi .v {
  font-size: 22px;
  margin-top: 6px;
}
.cols {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(300px, 1fr));
  gap: 16px;
}
.block {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.trow {
  font-size: 15px;
}
.trow.small {
  font-size: 13px;
  padding: 6px 0;
  border-bottom: var(--line-w) solid var(--line);
}
@media print {
  .kpis,
  .card {
    border-color: #000;
    color: #000;
    background: #fff;
  }
}
</style>
