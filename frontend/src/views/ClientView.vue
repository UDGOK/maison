<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { api, type Customer, type CustomerHistoryRow } from '@/api'
import { db } from '@/db'
import { useCartStore } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { useScanStore } from '@/stores/scan'
import { useCatalogStore } from '@/stores/catalog'
import { useLayoutStore } from '@/stores/layout'
import { fmtMoney, fmtInt } from '@/utils/money'
import { fmtDate } from '@/utils/device'
import Keypad from '@/components/Keypad.vue'

const cart = useCartStore()
const session = useSessionStore()
const sync = useSyncStore()
const scan = useScanStore()
const catalog = useCatalogStore()
const layout = useLayoutStore()
const router = useRouter()

// ---- client number (v0.2)
const clientNo = ref('')
const padOpen = ref(false)
const looking = ref(false)
const lookupError = ref('')
const padKey = (k: string) => {
  lookupError.value = ''
  if (k === 'clear') clientNo.value = ''
  else if (k === 'back') clientNo.value = clientNo.value.slice(0, -1)
  else if (clientNo.value.length < 12) clientNo.value += k
}
async function lookupNumber() {
  const code = clientNo.value.trim()
  if (!code) return
  looking.value = true
  lookupError.value = ''
  try {
    const candidates = /^\d{6}$/.test(code) ? [`MC${code}`, code] : [code]
    let c: Customer | null = null
    for (const cand of candidates) {
      c = await scan.lookupCustomer(cand)
      if (c) break
    }
    if (c) {
      clientNo.value = ''
      padOpen.value = false
      await select(c)
    } else lookupError.value = 'No client with that number'
  } finally {
    looking.value = false
  }
}
async function scanClient() {
  const c = await scan.scanClient()
  if (c) await select(c)
}
const pointsValue = (c: Customer) => (typeof c.points_value === 'number' ? c.points_value : c.loyalty_points * (catalog.loyalty?.conversion_factor || 0))

const q = ref('')
const results = ref<Customer[]>([])
const selected = ref<Customer | null>(cart.customer)
const history = ref<CustomerHistoryRow[]>([])
const loadingHistory = ref(false)
const creating = ref(false)
const form = ref({ customer_name: '', mobile_no: '', email_id: '' })
const saving = ref(false)
const error = ref('')
const source = ref<'server' | 'local'>('server')

let timer: number | undefined

async function search() {
  error.value = ''
  try {
    if (window.__maisonOffline) throw new Error('offline')
    results.value = await api.customers.search(q.value, 30)
    source.value = 'server'
    await db.customers.bulkPut(JSON.parse(JSON.stringify(results.value)))
  } catch {
    source.value = 'local'
    const s = q.value.trim().toLowerCase()
    const all = await db.customers.toArray()
    const digits = s.replace(/\D/g, '')
    results.value = all
      .filter(
        (c) =>
          !s ||
          c.customer_name.toLowerCase().includes(s) ||
          (c.client_number || '').toLowerCase().includes(s) ||
          (digits.length >= 4 && (c.mobile_no || '').replace(/\D/g, '').includes(digits)) ||
          (c.email_id || '').toLowerCase().includes(s)
      )
      .slice(0, 30)
  }
}

watch(q, () => {
  clearTimeout(timer)
  timer = window.setTimeout(search, 200)
})

onMounted(() => {
  void search()
  if (selected.value) void loadHistory(selected.value)
})

async function select(c: Customer) {
  selected.value = c
  await loadHistory(c)
}

async function loadHistory(c: Customer) {
  loadingHistory.value = true
  try {
    history.value = await api.customers.history(c.name, 20)
  } catch {
    history.value = []
  } finally {
    loadingHistory.value = false
  }
}

function attach() {
  cart.setCustomer(selected.value)
  router.push({ name: 'sell' })
}
function detach() {
  cart.setCustomer(null)
  selected.value = null
  history.value = []
}

async function create() {
  error.value = ''
  if (!form.value.customer_name.trim()) {
    error.value = 'Name is required'
    return
  }
  saving.value = true
  try {
    const res = (await api.customers.upsert({ ...form.value })) as { name: string; client_number?: string }
    const c: Customer = { name: res.name, ...form.value, loyalty_points: 0, tier: 'Member', client_number: res.client_number }
    await db.customers.put(c)
    creating.value = false
    form.value = { customer_name: '', mobile_no: '', email_id: '' }
    selected.value = c
    history.value = []
    cart.setCustomer(c)
    router.push({ name: 'sell' })
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="client-view" :class="{ phone: layout.phone }">
    <section class="list">
      <div class="toolbar">
        <input v-model="q" class="input" type="search" placeholder="Search name, client №, mobile, email" :autofocus="!layout.phone" />
        <button class="btn" @click="creating = !creating">{{ creating ? 'Cancel' : 'New client' }}</button>
      </div>
      <div v-if="catalog.settings.loyalty_lookup_enabled" class="cn card">
        <div class="cn-head">
          <span class="label">Client №</span>
          <span v-if="lookupError" class="crit small">{{ lookupError }}</span>
        </div>
        <div class="cn-input">
          <span class="cn-prefix num">MC</span>
          <input v-model="clientNo" class="input num cn-field" inputmode="numeric" placeholder="000000" maxlength="12" autocomplete="off" @focus="padOpen = true" @keydown.enter.prevent="lookupNumber" />
          <button v-if="catalog.settings.scan_enabled" class="cn-btn" title="Scan client card" aria-label="Scan client card" @click="scanClient">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" /><rect x="8" y="8" width="8" height="8" /></svg>
          </button>
          <button class="cn-btn go" :disabled="!clientNo.trim() || looking" @click="lookupNumber">{{ looking ? '…' : 'Find' }}</button>
        </div>
        <Keypad v-if="padOpen" class="cn-pad" @key="padKey" />
        <button v-if="padOpen" class="label link hide-pad" @click="padOpen = false">Hide keypad</button>
      </div>
      <div v-if="creating" class="create card">
        <div class="section-title">New client</div>
        <div class="field"><label class="label">Name</label><input v-model="form.customer_name" class="input" /></div>
        <div class="row">
          <div class="field" style="flex: 1"><label class="label">Mobile</label><input v-model="form.mobile_no" class="input" inputmode="tel" /></div>
          <div class="field" style="flex: 1"><label class="label">Email</label><input v-model="form.email_id" class="input" inputmode="email" /></div>
        </div>
        <div class="between">
          <span class="crit" style="font-size: 13px">{{ error }}</span>
          <button class="btn btn-primary" :disabled="saving || !sync.online" @click="create">{{ sync.online ? 'Create and attach' : 'Online required' }}</button>
        </div>
      </div>
      <div class="source label label-dim">{{ results.length }} clients &middot; {{ source === 'server' ? 'live' : 'cached' }}</div>
      <div class="rows scroll">
        <button v-for="c in results" :key="c.name" class="crow" :class="{ active: selected?.name === c.name }" @click="select(c)">
          <div class="crow-main">
            <div class="crow-name">{{ c.customer_name }}</div>
            <div class="crow-sub muted"><span v-if="c.client_number" class="accent">{{ c.client_number }}</span><span v-if="c.client_number && c.mobile_no"> &middot; </span>{{ c.mobile_no }} <span v-if="c.email_id && !layout.phone">&middot; {{ c.email_id }}</span></div>
          </div>
          <div class="crow-right">
            <span class="pill" :class="{ 'pill-accent': c.tier === 'Platinum' || c.tier === 'Gold' }">{{ c.tier }}</span>
            <span class="num pts">{{ fmtInt(c.loyalty_points) }}</span>
          </div>
        </button>
      </div>
    </section>

    <aside v-if="!layout.phone || selected" class="detail">
      <template v-if="selected">
        <div class="detail-head">
          <div class="dname display">{{ selected.customer_name }}</div>
          <div class="row" style="margin-top: 10px">
            <span class="pill pill-accent">{{ selected.tier }}</span>
            <span class="num accent" style="font-size: 15px">{{ selected.client_number || selected.name }}</span>
          </div>
        </div>
        <div class="stats">
          <div class="stat">
            <div class="label">Points</div>
            <div class="num big">{{ fmtInt(selected.loyalty_points) }}</div>
            <div class="dim small">{{ fmtMoney(pointsValue(selected), session.currency) }}</div>
          </div>
          <div class="stat"><div class="label">Last visit</div><div class="val">{{ selected.last_visit ? fmtDate(selected.last_visit) : '—' }}</div></div>
          <div class="stat"><div class="label">Boutique</div><div class="val">{{ selected.last_boutique || '—' }}</div></div>
        </div>
        <div class="contact muted">
          <div>{{ selected.mobile_no || 'No mobile' }}</div>
          <div>{{ selected.email_id || 'No email' }}</div>
        </div>
        <div class="section-title hist-title">History</div>
        <div class="hist scroll">
          <div v-if="loadingHistory" class="label label-dim">Loading</div>
          <div v-else-if="!history.length" class="label label-dim">No purchases on record</div>
          <div v-for="h in history" :key="h.invoice" class="hrow">
            <div class="between">
              <span class="hinv">{{ h.invoice }}</span>
              <span class="num">{{ fmtMoney(h.grand_total, session.currency) }}</span>
            </div>
            <div class="muted hsub">{{ fmtDate(h.date) }} &middot; {{ h.boutique }} &middot; {{ h.items.join(', ') }}</div>
          </div>
        </div>
        <div class="actions">
          <button v-if="cart.customer?.name === selected.name" class="btn" @click="detach">Detach</button>
          <button v-if="layout.phone" class="btn" @click="selected = null">Back</button>
          <button class="btn btn-primary btn-big" style="flex: 1" @click="attach">Attach to sale</button>
        </div>
      </template>
      <div v-else-if="!layout.phone" class="empty label label-dim">Select a client</div>
    </aside>
  </div>
</template>

<style scoped>
.client-view {
  flex: 1;
  min-height: 0;
  display: flex;
  position: relative;
}
.list {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.toolbar {
  display: flex;
  gap: 12px;
  padding: 16px;
  border-bottom: var(--line-w) solid var(--line);
}
.toolbar .input {
  flex: 1;
}
.create {
  margin: 16px 16px 0;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.source {
  padding: 12px 16px 6px;
}
.rows {
  flex: 1;
  min-height: 0;
  padding: 0 16px 16px;
}
.crow {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 12px 14px;
  border-bottom: var(--line-w) solid var(--line);
  color: var(--text);
  text-align: left;
}
.crow:hover {
  background: var(--surface);
}
.crow.active {
  background: var(--surface);
  box-shadow: inset 3px 0 0 var(--platinum);
}
.crow-main {
  min-width: 0;
}
.crow-name {
  font-size: 15px;
  font-weight: 500;
}
.crow-sub {
  font-size: 13px;
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.crow-right {
  display: flex;
  align-items: center;
  gap: 16px;
}
.pts {
  font-size: 14px;
  min-width: 60px;
  text-align: right;
}
.detail {
  width: 420px;
  flex: 0 0 420px;
  border-left: var(--line-w) solid var(--line);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.detail-head {
  padding: 20px 20px 16px;
  border-bottom: var(--line-w) solid var(--line);
}
.dname {
  font-size: 20px;
}
.stats {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr;
  border-bottom: var(--line-w) solid var(--line);
}
.stat {
  padding: 14px 20px;
  border-right: var(--line-w) solid var(--line);
}
.stat:last-child {
  border-right: 0;
}
.stat .big {
  font-size: 22px;
  margin-top: 4px;
}
.stat .val {
  margin-top: 6px;
  font-size: 14px;
}
.contact {
  padding: 14px 20px;
  font-size: 13px;
  border-bottom: var(--line-w) solid var(--line);
}
.hist-title {
  padding: 16px 20px 8px;
}
.hist {
  flex: 1;
  min-height: 0;
  padding: 0 20px;
}
.hrow {
  padding: 10px 0;
  border-bottom: var(--line-w) solid var(--line);
}
.hinv {
  font-size: 13px;
}
.hsub {
  font-size: 12px;
  margin-top: 3px;
}
.actions {
  display: flex;
  gap: 10px;
  padding: 16px 20px;
  border-top: var(--line-w) solid var(--line);
}
.empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}
.small {
  font-size: 12px;
}
.cn {
  margin: 16px 16px 0;
  padding: 12px 14px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.cn-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.cn-input {
  display: flex;
  align-items: stretch;
  border: var(--line-w) solid var(--line-strong);
  background: var(--ground);
}
.cn-input:focus-within {
  border-color: var(--accent);
}
.cn-prefix {
  display: flex;
  align-items: center;
  padding-left: 12px;
  font-size: 18px;
  color: var(--dim);
}
.cn-field {
  flex: 1;
  min-width: 0;
  border: 0;
  background: transparent;
  font-size: 20px;
  letter-spacing: 0.08em;
  padding: 0 8px;
}
.cn-btn {
  min-width: 48px;
  padding: 0 14px;
  border-left: var(--line-w) solid var(--line);
  color: var(--muted);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  display: flex;
  align-items: center;
  justify-content: center;
}
.cn-btn svg {
  width: 20px;
  height: 20px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.cn-btn.go {
  color: var(--ink-on-accent);
  background: var(--accent);
}
.cn-btn.go:disabled {
  background: transparent;
  color: var(--dim);
}
.cn-pad {
  max-width: 360px;
}
.cn-pad :deep(.key) {
  height: 52px;
}
.link {
  min-width: 0;
  min-height: 32px;
  padding: 0 4px;
  color: var(--accent);
}
.hide-pad {
  align-self: flex-end;
}

/* ---------- phone ---------- */
.client-view.phone {
  flex-direction: column;
}
.phone .list {
  flex: 1;
}
.phone .toolbar {
  padding: 12px;
  gap: 8px;
}
.phone .toolbar .btn {
  padding: 0 14px;
}
.phone .cn {
  margin: 12px 12px 0;
}
.phone .cn-pad {
  max-width: none;
}
.phone .rows {
  padding: 0 12px 12px;
}
.phone .crow {
  padding: 12px 10px;
}
.phone .detail {
  position: absolute;
  inset: 0;
  width: auto;
  flex: none;
  border-left: 0;
  z-index: 15;
}
.phone .actions {
  padding-bottom: calc(16px + var(--safe-bottom));
}
</style>
