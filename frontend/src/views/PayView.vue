<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { v4 as uuidv4 } from 'uuid'
import { useCartStore } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { useSyncStore } from '@/stores/sync'
import type { POSInvoice } from '@/api'
import type { ReceiptSnapshot } from '@/db'
import { createTerminal, type CardResult, type TerminalProgress } from '@/payments/terminal'
import { fmtMoney, round } from '@/utils/money'
import Keypad from '@/components/Keypad.vue'

const cart = useCartStore()
const session = useSessionStore()
const catalog = useCatalogStore()
const sync = useSyncStore()
const route = useRoute()
const router = useRouter()

const mode = ref<'cash' | 'card'>((route.query.mode as 'cash' | 'card') || 'cash')
const total = computed(() => cart.totals.grand_total)

// ---- cash
const tenderedStr = ref('')
const tendered = computed(() => (tenderedStr.value ? parseFloat(tenderedStr.value) || 0 : total.value))
const change = computed(() => round(Math.max(0, tendered.value - total.value)))
const cashOk = computed(() => tendered.value + 0.001 >= total.value)
const quick = computed(() => {
  const t = total.value
  const steps = [Math.ceil(t / 50) * 50, Math.ceil(t / 100) * 100, Math.ceil(t / 500) * 500, Math.ceil(t / 1000) * 1000]
  return [...new Set([round(t), ...steps])].slice(0, 4)
})
function key(k: string) {
  if (k === 'clear') tenderedStr.value = ''
  else if (k === 'back') tenderedStr.value = tenderedStr.value.slice(0, -1)
  else if (k === '.' && tenderedStr.value.includes('.')) return
  else if (tenderedStr.value.length < 10) tenderedStr.value += k
}

// ---- card
const terminal = createTerminal({ publishableKey: import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY, locationId: session.boutique?.stripe_location_id })
const progress = ref<TerminalProgress>({ step: 'idle', message: '' })
const cardError = ref('')
const offline_uuid = ref(uuidv4())
const busy = ref(false)

const stepOrder = ['discovering', 'connecting', 'collecting', 'processing', 'done'] as const
const stepLabels: Record<(typeof stepOrder)[number], string> = {
  discovering: 'Discover',
  connecting: 'Connect',
  collecting: 'Collect',
  processing: 'Process',
  done: 'Approved'
}
function stepState(s: (typeof stepOrder)[number]) {
  const cur = progress.value.step
  const norm = cur === 'connected' ? 'connecting' : cur === 'capturing' ? 'processing' : cur
  const ci = stepOrder.indexOf(norm as any)
  const si = stepOrder.indexOf(s)
  if (cur === 'error') return si <= ci ? 'done' : ''
  if (si < ci || cur === 'done') return 'done'
  if (si === ci) return 'active'
  return ''
}

async function chargeCard() {
  if (busy.value) return
  cardError.value = ''
  busy.value = true
  try {
    const result = await terminal.charge({
      boutique: session.boutique!.name,
      amount: Math.round(total.value * 100),
      currency: session.currency,
      offline_uuid: offline_uuid.value,
      customer: cart.customer?.name,
      onProgress: (p) => (progress.value = p)
    })
    await finalize('Card', result)
  } catch (e) {
    progress.value = { step: 'error', message: (e as Error).message }
    cardError.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
function cancelCard() {
  void terminal.cancel()
  router.push({ name: 'sell' })
}

async function payCash() {
  if (!cashOk.value || busy.value) return
  busy.value = true
  try {
    await finalize('Cash')
  } finally {
    busy.value = false
  }
}

async function finalize(modeOfPayment: 'Cash' | 'Card', card?: CardResult) {
  const now = new Date()
  const invoice: POSInvoice = {
    offline_uuid: offline_uuid.value,
    boutique: session.boutique!.name,
    associate: session.associate!.name,
    device_id: session.device_id,
    customer: cart.customer?.name,
    posting_datetime: now.toISOString(),
    items: cart.lines.map((l) => ({
      item_code: l.item_code,
      qty: l.qty,
      rate: l.rate,
      serial_no: l.serial_no,
      discount_amount: l.discount_amount || undefined
    })),
    payments: [{ mode_of_payment: modeOfPayment, amount: total.value, stripe_payment_intent: card?.payment_intent }],
    loyalty_points_redeemed: cart.loyalty_points_redeemed || undefined,
    notes: cart.notes || undefined
  }
  const t = cart.totals
  const receipt: ReceiptSnapshot = {
    boutique: session.boutique!.name,
    boutique_name: session.boutique!.boutique_name,
    address_line: session.boutique!.address_line,
    city: session.boutique!.city,
    phone: session.boutique!.phone,
    associate_name: session.associate!.full_name,
    customer_name: cart.customer?.customer_name,
    customer_tier: cart.customer?.tier,
    lines: cart.lines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      rate: l.rate,
      amount: round(l.qty * l.rate - l.discount_amount),
      serial_no: l.serial_no,
      certificate_no: l.certificate_no,
      discount_amount: l.discount_amount || undefined
    })),
    net_total: t.net_total,
    discount: t.discount,
    total_taxes: t.total_taxes,
    tax_rate: catalog.taxRate,
    loyalty_amount: t.loyalty_amount,
    loyalty_points_redeemed: cart.loyalty_points_redeemed,
    grand_total: t.grand_total,
    payments: [
      modeOfPayment === 'Cash'
        ? { mode_of_payment: 'Cash', amount: total.value, tendered: round(tendered.value), change: change.value }
        : { mode_of_payment: 'Card', amount: total.value, card_brand: card?.card_brand, last4: card?.last4, approval: card?.approval }
    ],
    points_earned: cart.pointsEarned,
    points_balance: cart.customer ? cart.customer.loyalty_points - cart.loyalty_points_redeemed + cart.pointsEarned : undefined,
    currency: session.currency
  }
  await sync.enqueue(invoice, receipt)
  for (const l of cart.lines) catalog.consume(l.item_code, l.qty, l.serial_no)
  const uuid = offline_uuid.value
  cart.clear()
  router.replace({ name: 'receipt', params: { uuid } })
}

onBeforeUnmount(() => {
  if (busy.value) void terminal.cancel()
})

if (!cart.lines.length) router.replace({ name: 'sell' })
</script>

<template>
  <div class="pay">
    <div class="pay-left">
      <div class="tabs">
        <button class="tab display" :class="{ active: mode === 'cash' }" :disabled="busy" @click="mode = 'cash'">Cash</button>
        <button class="tab display" :class="{ active: mode === 'card' }" :disabled="busy" @click="mode = 'card'">Card</button>
      </div>

      <div class="amount">
        <div class="label">Amount due</div>
        <div class="due num">{{ fmtMoney(total, session.currency) }}</div>
        <div class="muted sub">{{ cart.count }} item{{ cart.count === 1 ? '' : 's' }}<span v-if="cart.customer"> &middot; {{ cart.customer.customer_name }}</span></div>
      </div>

      <!-- CASH -->
      <div v-if="mode === 'cash'" class="cash">
        <div class="cash-grid">
          <div class="cash-left">
            <div class="field">
              <label class="label">Tendered</label>
              <div class="tendered num" :class="{ placeholder: !tenderedStr }">{{ tenderedStr ? tenderedStr : fmtMoney(total, session.currency) }}</div>
            </div>
            <div class="quick">
              <button v-for="qv in quick" :key="qv" class="chip" @click="tenderedStr = String(qv)">{{ fmtMoney(qv, session.currency) }}</button>
            </div>
            <div class="change between">
              <span class="label">Change</span>
              <span class="num change-amt" :class="{ crit: !cashOk }">{{ cashOk ? fmtMoney(change, session.currency) : 'Short ' + fmtMoney(total - tendered, session.currency) }}</span>
            </div>
          </div>
          <Keypad decimal @key="key" />
        </div>
        <div class="actions">
          <button class="btn btn-big" :disabled="busy" @click="router.push({ name: 'sell' })">Back</button>
          <button class="btn btn-primary btn-big" style="flex: 1" :disabled="!cashOk || busy" @click="payCash">Complete cash sale</button>
        </div>
      </div>

      <!-- CARD -->
      <div v-else class="card-flow">
        <div class="reader card">
          <div class="between">
            <div class="section-title">{{ terminal.kind === 'simulated' ? 'Simulated reader' : 'Stripe Terminal' }}</div>
            <span v-if="progress.reader" class="muted" style="font-size: 12px">{{ progress.reader }}</span>
          </div>
          <div class="steps">
            <div v-for="s in stepOrder" :key="s" class="step" :class="stepState(s)">
              <span class="step-dot"></span>
              <span class="label">{{ stepLabels[s] }}</span>
            </div>
          </div>
          <div class="status" :class="{ crit: progress.step === 'error', good: progress.step === 'done' }">
            {{ progress.step === 'idle' ? 'Ready to charge' : progress.message }}
          </div>
        </div>
        <div v-if="!sync.online && terminal.kind === 'stripe'" class="warn" style="font-size: 13px">Offline: card payments need a connection to the reader and Stripe.</div>
        <div class="actions">
          <button class="btn btn-big" @click="cancelCard">{{ busy ? 'Cancel' : 'Back' }}</button>
          <button class="btn btn-primary btn-big" style="flex: 1" :disabled="busy" @click="chargeCard">
            {{ busy ? progress.message : progress.step === 'error' ? 'Retry card' : 'Charge ' + fmtMoney(total, session.currency) }}
          </button>
        </div>
      </div>
    </div>

    <aside class="summary">
      <div class="section-title" style="padding: 16px 20px; border-bottom: 1px solid var(--line)">Summary</div>
      <div class="sum-lines scroll">
        <div v-for="l in cart.lines" :key="l.id" class="sline">
          <div class="between">
            <span class="ellipsis">{{ l.item_name }}</span>
            <span class="num">{{ fmtMoney(l.qty * l.rate - l.discount_amount, session.currency) }}</span>
          </div>
          <div class="muted sline-sub">{{ l.serial_no ? 'Serial ' + l.serial_no : l.qty + ' × ' + fmtMoney(l.rate, session.currency) }}</div>
        </div>
      </div>
      <div class="sum-totals">
        <div class="between"><span class="label">Subtotal</span><span>{{ fmtMoney(cart.totals.gross, session.currency) }}</span></div>
        <div v-if="cart.totals.discount" class="between"><span class="label">Discount</span><span class="warn">−{{ fmtMoney(cart.totals.discount, session.currency) }}</span></div>
        <div class="between"><span class="label">Tax {{ catalog.taxRate }}%</span><span>{{ fmtMoney(cart.totals.total_taxes, session.currency) }}</span></div>
        <div v-if="cart.totals.loyalty_amount" class="between"><span class="label">Loyalty</span><span class="good">−{{ fmtMoney(cart.totals.loyalty_amount, session.currency) }}</span></div>
        <div class="hr"></div>
        <div class="between"><span class="label">Total</span><span class="num" style="font-size: 22px">{{ fmtMoney(total, session.currency) }}</span></div>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.pay {
  flex: 1;
  min-height: 0;
  display: flex;
}
.pay-left {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  padding: 0 40px 28px;
  overflow: auto;
}
.tabs {
  display: flex;
  border-bottom: var(--line-w) solid var(--line);
  margin: 0 -40px;
  padding: 0 40px;
}
.tab {
  padding: 0 28px;
  min-height: 56px;
  font-size: 13px;
  color: var(--muted);
  border-bottom: 2px solid transparent;
}
.tab.active {
  color: var(--text);
  border-bottom-color: var(--platinum);
}
.amount {
  padding: 28px 0 20px;
}
.due {
  font-size: 48px;
  margin-top: 6px;
  line-height: 1;
}
.sub {
  margin-top: 10px;
  font-size: 13px;
}
.cash-grid {
  display: grid;
  grid-template-columns: 1fr 300px;
  gap: 28px;
  align-items: start;
}
.cash-left {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.tendered {
  font-size: 34px;
  min-height: 48px;
  display: flex;
  align-items: center;
  padding: 0 14px;
  border: var(--line-w) solid var(--line-strong);
  background: var(--surface);
}
.tendered.placeholder {
  color: var(--dim);
}
.quick {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.change-amt {
  font-size: 24px;
}
.actions {
  display: flex;
  gap: 12px;
  margin-top: 28px;
}
.card-flow {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
.reader {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 22px;
}
.steps {
  display: flex;
  gap: 0;
}
.step {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  position: relative;
}
.step::before {
  content: '';
  position: absolute;
  top: 5px;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--line-strong);
}
.step-dot {
  position: relative;
  width: 11px;
  height: 11px;
  background: var(--ground);
  border: 1px solid var(--line-strong);
}
.step.done .step-dot {
  background: var(--platinum);
  border-color: var(--platinum);
}
.step.done::before {
  background: var(--platinum);
}
.step.active .step-dot {
  border-color: var(--platinum);
  animation: pulse 1s infinite alternate;
}
.step.done .label,
.step.active .label {
  color: var(--text);
}
@keyframes pulse {
  to {
    background: var(--platinum);
  }
}
.status {
  font-size: 18px;
  min-height: 24px;
}
.summary {
  width: 360px;
  flex: 0 0 360px;
  border-left: var(--line-w) solid var(--line);
  background: var(--surface);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.sum-lines {
  flex: 1;
  min-height: 0;
  padding: 8px 20px;
}
.sline {
  padding: 10px 0;
  border-bottom: var(--line-w) solid var(--line);
  font-size: 14px;
}
.sline-sub {
  font-size: 12px;
  margin-top: 2px;
}
.sum-totals {
  padding: 14px 20px 20px;
  border-top: var(--line-w) solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 8px;
  font-size: 14px;
}
</style>
