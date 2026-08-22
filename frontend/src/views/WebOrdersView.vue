<script setup lang="ts">
// v0.4 G — "Web orders": click & collect queue of the boutique (Sales Orders placed on the web shop)
// + web enquiries. Pick → Ready → Collect (collection becomes a normal POS sale with the balance).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { useWebOrdersStore } from '@/stores/webOrders'
import { useLayoutStore } from '@/stores/layout'
import { fmtMoney } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'
import type { WebEnquiry, WebOrder, WebOrderStatus } from '@/api/webshop'

const session = useSessionStore()
const sync = useSyncStore()
const store = useWebOrdersStore()
const layout = useLayoutStore()
const router = useRouter()

const tab = ref<'orders' | 'enquiries'>('orders')
const includeDone = ref(false)
const selected = ref<string | null>(null)
const busy = ref(false)
const note = ref('')
const enquiryResponse = ref('')
const selectedEnquiry = ref<string | null>(null)

const boutique = computed(() => session.boutique?.name || '')
const orders = computed(() => {
  const rows = [...store.orders]
  const rank: Record<WebOrderStatus, number> = { Ready: 0, Picking: 1, New: 2, Collected: 3, Cancelled: 4 }
  return rows.sort((a, b) => rank[a.status] - rank[b.status] || a.creation.localeCompare(b.creation))
})
const order = computed<WebOrder | null>(() => orders.value.find((o) => o.name === selected.value) || null)
const enquiry = computed<WebEnquiry | null>(() => store.enquiries.find((e) => e.name === selectedEnquiry.value) || null)

function pill(status: WebOrderStatus) {
  return { New: 'pill-warn', Picking: 'pill-accent', Ready: 'pill-good', Collected: 'pill-accent-fill', Cancelled: 'pill-crit' }[status]
}
function age(iso: string) {
  const m = Math.max(0, Math.round((store.serverNow - new Date(iso.replace(' ', 'T')).getTime()) / 60000))
  if (m < 60) return `${m} min`
  if (m < 48 * 60) return `${Math.round(m / 60)} h`
  return `${Math.round(m / 1440)} d`
}

let timer: number | undefined
async function refresh() {
  if (!boutique.value || !sync.browserOnline) return
  await store.load(boutique.value, includeDone.value)
  if (selected.value && !store.orders.some((o) => o.name === selected.value)) selected.value = null
}
onMounted(() => {
  void refresh()
  timer = window.setInterval(() => void refresh(), 45000)
})
onBeforeUnmount(() => window.clearInterval(timer))

function select(o: WebOrder) {
  selected.value = o.name
  note.value = o.note || ''
}
async function move(status: WebOrderStatus) {
  if (!order.value || busy.value) return
  busy.value = true
  try {
    await store.setStatus(order.value.name, status, note.value !== (order.value.note || '') ? note.value : undefined)
    sync.notify('good', `${order.value.name} · ${status}`, status === 'Ready' ? 'The client has been notified' : '')
  } catch (e) {
    sync.notify('crit', 'Could not update the web order', (e as Error).message)
  } finally {
    busy.value = false
  }
}
async function collect() {
  if (!order.value || busy.value) return
  busy.value = true
  try {
    const missing = await store.loadForCollection(order.value)
    if (missing.length) sync.notify('warn', 'Some lines could not be loaded', missing.join(', '))
    router.push({ name: 'pay', query: { mode: order.value.balance_due > 0 ? 'card' : 'cash' } })
  } catch (e) {
    sync.notify('crit', 'Could not start the collection', (e as Error).message)
  } finally {
    busy.value = false
  }
}
async function updateEnquiry(status: WebEnquiry['status']) {
  if (!enquiry.value || busy.value) return
  busy.value = true
  try {
    await store.updateEnquiry(enquiry.value.name, status, enquiryResponse.value || undefined)
    sync.notify('good', `Enquiry · ${status}`)
  } catch (e) {
    sync.notify('crit', 'Could not update the enquiry', (e as Error).message)
  } finally {
    busy.value = false
  }
}
const stepList: WebOrderStatus[] = ['New', 'Picking', 'Ready', 'Collected']
function stepState(s: WebOrderStatus) {
  if (!order.value) return ''
  const i = stepList.indexOf(order.value.status)
  const j = stepList.indexOf(s)
  if (order.value.status === 'Cancelled') return ''
  return j < i ? 'done' : j === i ? 'active' : ''
}
</script>

<template>
  <div class="page">
    <div class="page-body wo" :class="{ phone: layout.phone }" data-testid="web-orders">
      <div class="wo-list">
        <div class="between wo-head">
          <div>
            <div class="page-title">Web orders</div>
            <div class="muted" style="margin-top: 4px; font-size: 13px">
              {{ store.counts.New }} new &middot; {{ store.counts.Picking }} picking &middot; {{ store.counts.Ready }} ready
              <span v-if="store.loadedAt"> &middot; updated {{ fmtDateTime(new Date(store.loadedAt), { year: undefined, month: undefined, day: undefined }) }}</span>
            </div>
          </div>
          <div class="row">
            <label class="label toggle"><input v-model="includeDone" type="checkbox" @change="refresh()" /> Collected</label>
            <button class="btn" :disabled="store.loading || !sync.browserOnline" @click="refresh()">{{ store.loading ? 'Loading' : 'Refresh' }}</button>
          </div>
        </div>

        <div class="tabs">
          <button class="tab display" :class="{ active: tab === 'orders' }" @click="tab = 'orders'">Orders <span class="count">{{ store.open.length }}</span></button>
          <button class="tab display" :class="{ active: tab === 'enquiries' }" @click="tab = 'enquiries'">Enquiries <span class="count">{{ store.enquiries.length }}</span></button>
        </div>

        <div v-if="store.error" class="crit" style="padding: 16px 0; font-size: 13px">{{ store.error }}</div>

        <div v-if="tab === 'orders'" class="rows scroll">
          <div v-if="!orders.length && !store.loading" class="label label-dim empty">No open web orders for {{ session.boutique?.boutique_name }}</div>
          <button v-for="o in orders" :key="o.name" class="wo-row" :class="{ selected: o.name === selected }" data-testid="web-order-row" :data-name="o.name" @click="select(o)">
            <div class="wo-row-main">
              <div class="between">
                <span class="wo-name">{{ o.customer_name }}</span>
                <span class="pill" :class="pill(o.status)"><span class="dot"></span>{{ o.status }}</span>
              </div>
              <div class="muted wo-sub">
                {{ o.name }} &middot; {{ o.items.reduce((n, l) => n + l.qty, 0) }} piece{{ o.items.reduce((n, l) => n + l.qty, 0) === 1 ? '' : 's' }} &middot; {{ age(o.creation) }} ago
                <span v-if="o.web_mode === 'Reserve-with-deposit'" class="accent"> &middot; Reserve · deposit {{ fmtMoney(o.deposit_amount, o.currency) }}</span>
                <span v-else-if="o.prepaid_amount > 0 && o.prepaid_amount >= o.rounded_total - 0.005" class="good"> &middot; Paid online</span>
                <span v-else-if="o.prepaid_amount > 0" class="accent"> &middot; {{ fmtMoney(o.prepaid_amount, o.currency) }} paid online</span>
                <span v-else class="warn"> &middot; Pay at collection</span>
              </div>
            </div>
            <div class="num wo-amt">{{ fmtMoney(o.grand_total, o.currency) }}</div>
          </button>
        </div>

        <div v-else class="rows scroll">
          <div v-if="!store.enquiries.length && !store.loading" class="label label-dim empty">No open enquiries</div>
          <button v-for="e in store.enquiries" :key="e.name" class="wo-row" :class="{ selected: e.name === selectedEnquiry }" data-testid="web-enquiry-row" @click="selectedEnquiry = e.name; enquiryResponse = e.response || ''">
            <div class="wo-row-main">
              <div class="between">
                <span class="wo-name">{{ e.customer_name }}</span>
                <span class="pill" :class="e.status === 'New' ? 'pill-warn' : e.status === 'Contacted' ? 'pill-accent' : 'pill-good'"><span class="dot"></span>{{ e.status }}</span>
              </div>
              <div class="muted wo-sub">{{ e.item_name }} &middot; {{ age(e.enquiry_date) }} ago</div>
            </div>
          </button>
        </div>
      </div>

      <!-- detail -->
      <aside v-if="tab === 'orders'" class="wo-detail" :class="{ open: !!order }">
        <div v-if="!order" class="label label-dim empty">Select an order</div>
        <template v-else>
          <div class="wo-detail-body scroll" data-testid="web-order-detail">
            <button v-if="layout.phone" class="btn btn-ghost back" @click="selected = null">Back</button>
            <div class="label label-dim">{{ order.name }} &middot; {{ fmtDateTime(order.creation) }}</div>
            <div class="wo-title display">{{ order.customer_name }}</div>
            <div class="muted" style="font-size: 13px">
              <span v-if="order.contact_mobile">{{ order.contact_mobile }} &middot; </span><span v-if="order.contact_email">{{ order.contact_email }}</span>
              <span v-if="order.customer_doc?.client_number" class="accent"> &middot; {{ order.customer_doc.client_number }}</span>
            </div>

            <div class="steps">
              <div v-for="s in stepList" :key="s" class="step" :class="stepState(s)"><span class="step-dot"></span><span class="label">{{ s }}</span></div>
            </div>
            <div v-if="order.status === 'Cancelled'" class="pill pill-crit" style="margin-top: 8px"><span class="dot"></span>Cancelled</div>

            <div class="section-title" style="margin-top: 22px">Pieces to prepare</div>
            <div class="lines">
              <div v-for="l in order.items" :key="l.row" class="line">
                <div class="thumb"><img v-if="l.image" :src="l.image" alt="" /></div>
                <div class="line-main">
                  <div class="line-name">{{ l.item_name }}</div>
                  <div class="muted line-sub">{{ l.item_code }} &middot; {{ l.qty }} &times; {{ fmtMoney(l.rate, order.currency) }}</div>
                  <div class="line-sub" :class="l.available_here >= l.qty ? 'good' : 'warn'">
                    {{ l.available_here >= l.qty ? `${l.available_here} in boutique` : l.available_here > 0 ? `Only ${l.available_here} here — transfer ${l.qty - l.available_here}` : 'Not in boutique — transfer needed' }}
                    <span v-if="l.serials_here.length" class="dim"> &middot; {{ l.serials_here.slice(0, 3).join(', ') }}{{ l.serials_here.length > 3 ? '…' : '' }}</span>
                  </div>
                </div>
                <div class="num line-amt">{{ fmtMoney(l.amount, order.currency) }}</div>
              </div>
            </div>

            <div class="totals">
              <div class="between"><span class="muted">Subtotal</span><span class="num">{{ fmtMoney(order.net_total, order.currency) }}</span></div>
              <div class="between"><span class="muted">Tax</span><span class="num">{{ fmtMoney(order.total_taxes, order.currency) }}</span></div>
              <div class="between"><span class="muted">Total</span><span class="num">{{ fmtMoney(order.grand_total, order.currency) }}</span></div>
              <div class="between"><span class="muted">Paid online</span><span class="num good">-{{ fmtMoney(order.prepaid_amount, order.currency) }}</span></div>
              <div class="between balance"><span class="label">Balance at collection</span><span class="num accent display">{{ fmtMoney(order.balance_due, order.currency) }}</span></div>
            </div>

            <div class="field" style="margin-top: 18px">
              <label class="label">Pick note</label>
              <textarea v-model="note" class="input" rows="2" placeholder="Gift wrapping, resizing, special request…"></textarea>
            </div>
            <div v-if="order.sales_invoice" class="muted" style="font-size: 13px; margin-top: 12px">Collected on {{ order.sales_invoice }}<span v-if="order.collected_at"> &middot; {{ fmtDateTime(order.collected_at) }}</span></div>
          </div>

          <div class="actions">
            <button v-if="order.status === 'New'" class="btn btn-primary btn-big" style="flex: 1" :disabled="busy" data-testid="web-order-pick" @click="move('Picking')">Start picking</button>
            <button v-if="order.status === 'Picking'" class="btn btn-primary btn-big" style="flex: 1" :disabled="busy" data-testid="web-order-ready" @click="move('Ready')">Mark ready</button>
            <button v-if="order.status === 'Ready'" class="btn btn-primary btn-big" style="flex: 1" :disabled="busy || !sync.online" data-testid="web-order-collect" @click="collect">
              {{ order.balance_due > 0 ? 'Collect · take ' + fmtMoney(order.balance_due, order.currency) : 'Collect · paid online' }}
            </button>
            <button v-if="order.status === 'Ready'" class="btn btn-big" :disabled="busy" @click="move('Picking')">Back to picking</button>
            <button v-if="['New', 'Picking', 'Ready'].includes(order.status) && session.isManager" class="btn btn-big btn-crit" :disabled="busy" @click="move('Cancelled')">Cancel</button>
          </div>
        </template>
      </aside>

      <aside v-else class="wo-detail" :class="{ open: !!enquiry }">
        <div v-if="!enquiry" class="label label-dim empty">Select an enquiry</div>
        <template v-else>
          <div class="wo-detail-body scroll">
            <button v-if="layout.phone" class="btn btn-ghost back" @click="selectedEnquiry = null">Back</button>
            <div class="label label-dim">{{ enquiry.name }} &middot; {{ fmtDateTime(enquiry.enquiry_date) }}</div>
            <div class="wo-title display">{{ enquiry.customer_name }}</div>
            <div class="muted" style="font-size: 13px"><span v-if="enquiry.phone">{{ enquiry.phone }} &middot; </span>{{ enquiry.email }}</div>
            <div class="section-title" style="margin-top: 22px">Piece</div>
            <div class="line" style="border: 0; padding: 8px 0">
              <div class="line-main"><div class="line-name">{{ enquiry.item_name }}</div><div class="muted line-sub">{{ enquiry.item_code }}<span v-if="enquiry.serial_no"> &middot; {{ enquiry.serial_no }}</span></div></div>
            </div>
            <div class="section-title" style="margin-top: 14px">Message</div>
            <div class="message">{{ enquiry.message || '—' }}</div>
            <div class="field" style="margin-top: 18px">
              <label class="label">Boutique response</label>
              <textarea v-model="enquiryResponse" class="input" rows="3" placeholder="Called the client, viewing booked Saturday 11:00…"></textarea>
            </div>
          </div>
          <div class="actions">
            <button v-if="enquiry.status === 'New'" class="btn btn-primary btn-big" style="flex: 1" :disabled="busy" @click="updateEnquiry('Contacted')">Mark contacted</button>
            <button v-if="enquiry.status !== 'Closed'" class="btn btn-big" :disabled="busy" @click="updateEnquiry('Closed')">Close</button>
          </div>
        </template>
      </aside>
    </div>
  </div>
</template>

<style scoped>
.wo {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 420px;
  gap: 0;
  padding: 0;
  height: 100%;
  min-height: 0;
}
.wo-list {
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 24px 24px 0;
  border-right: var(--line-w) solid var(--line);
}
.wo-head {
  margin-bottom: 18px;
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin-right: 8px;
  cursor: pointer;
}
.toggle input {
  accent-color: var(--accent);
  width: 16px;
  height: 16px;
}
.tabs {
  display: flex;
  border-bottom: var(--line-w) solid var(--line);
}
.tab {
  padding: 12px 18px 10px;
  color: var(--muted);
  font-size: 13px;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
}
.tab.active {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.tab .count {
  font-family: var(--font-body);
  font-size: 11px;
  margin-left: 8px;
  padding: 1px 6px;
  border: 1px solid currentColor;
}
.rows {
  flex: 1;
  min-height: 0;
  padding-bottom: 24px;
}
.empty {
  padding: 40px 0;
  text-align: center;
}
.wo-row {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  min-height: 72px;
  padding: 14px 16px;
  text-align: left;
  border-bottom: var(--line-w) solid var(--line);
  border-left: 3px solid transparent;
  color: var(--text);
}
.wo-row:hover {
  background: var(--surface);
}
.wo-row.selected {
  background: var(--surface);
  border-left-color: var(--accent);
}
.wo-row-main {
  flex: 1;
  min-width: 0;
}
.wo-name {
  font-weight: 500;
  font-size: 15px;
}
.wo-sub {
  font-size: 12px;
  margin-top: 4px;
}
.wo-amt {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 15px;
  color: var(--accent);
  white-space: nowrap;
}
.wo-detail {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--surface);
}
.wo-detail-body {
  flex: 1;
  min-height: 0;
  padding: 24px;
}
.wo-title {
  font-size: 22px;
  margin: 6px 0 4px;
}
.steps {
  display: flex;
  margin-top: 18px;
}
.step {
  flex: 1;
  position: relative;
  padding-top: 14px;
  color: var(--dim);
}
.step::before {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 4px;
  height: 1px;
  background: var(--line-strong);
}
.step-dot {
  position: absolute;
  left: 0;
  top: 0;
  width: 9px;
  height: 9px;
  background: var(--line-strong);
}
.step.done,
.step.done .label {
  color: var(--muted);
}
.step.done::before,
.step.done .step-dot {
  background: var(--accent);
}
.step.active .label {
  color: var(--accent);
}
.step.active .step-dot {
  background: var(--accent);
  box-shadow: 0 0 0 4px var(--accent-soft);
}
.lines {
  border-top: var(--line-w) solid var(--line-strong);
}
.line {
  display: flex;
  gap: 14px;
  align-items: center;
  padding: 12px 0;
  border-bottom: var(--line-w) solid var(--line);
}
.thumb {
  width: 56px;
  height: 56px;
  flex: 0 0 auto;
  background: var(--surface-2);
  border: var(--line-w) solid var(--line);
  overflow: hidden;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.line-main {
  flex: 1;
  min-width: 0;
}
.line-name {
  font-weight: 500;
  font-size: 14px;
}
.line-sub {
  font-size: 12px;
  margin-top: 2px;
}
.line-amt {
  font-size: 14px;
  white-space: nowrap;
}
.totals {
  margin-top: 14px;
  display: grid;
  gap: 8px;
  font-size: 14px;
}
.totals .balance {
  margin-top: 6px;
  padding-top: 12px;
  border-top: var(--line-w) solid var(--line-strong);
}
.totals .balance .num {
  font-size: 22px;
}
.message {
  font-size: 14px;
  line-height: 1.6;
  color: var(--muted);
  white-space: pre-wrap;
}
.input {
  width: 100%;
  padding: 10px 12px;
  background: var(--surface-2);
  border: var(--line-w) solid var(--line-strong);
  color: var(--text);
  font-family: var(--font-body);
  font-size: 14px;
  resize: vertical;
}
.input:focus {
  outline: none;
  border-color: var(--accent);
}
.actions {
  display: flex;
  gap: 12px;
  padding: 16px 24px calc(16px + var(--safe-bottom));
  border-top: var(--line-w) solid var(--line);
}
.back {
  margin-bottom: 12px;
}

/* ---------- phone ---------- */
.wo.phone {
  grid-template-columns: 1fr;
}
.wo.phone .wo-list {
  border-right: 0;
  padding: 16px 16px 0;
}
.wo.phone .wo-detail {
  display: none;
}
.wo.phone .wo-detail.open {
  display: flex;
  position: fixed;
  inset: calc(var(--topbar-h) + var(--safe-top)) 0 0 0;
  z-index: 30;
}
</style>
