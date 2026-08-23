<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { v4 as uuidv4 } from 'uuid'
import { useCartStore } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { useSyncStore } from '@/stores/sync'
import { IS_MOCK, type POSInvoice } from '@/api'
import { usePromosStore } from '@/stores/promos'
import { __mockRedeemCoupon } from '@/api/v04'
import type { ReceiptSnapshot } from '@/db'
import type { CardResult, TerminalProgress } from '@/payments/terminal'
import { usePrinterStore } from '@/stores/printer'
import { fmtMoney, round } from '@/utils/money'
import { useLayoutStore } from '@/stores/layout'
import { useSalonPosStore } from '@/stores/salon' // v0.5 K
import { useWebOrdersStore } from '@/stores/webOrders' // v0.4 G
import Keypad from '@/components/Keypad.vue'
import { useAgeStore } from '@/stores/age' // v0.6 N
import { useBrand } from '@/stores/brand' // v0.6 N
import { nextReward } from '@/api/v06' // v0.6 Q

const cart = useCartStore()
const session = useSessionStore()
const catalog = useCatalogStore()
const sync = useSyncStore()
const promos = usePromosStore()
const route = useRoute()
const router = useRouter()
const layout = useLayoutStore()
const age = useAgeStore() // v0.6 N
const brand = useBrand() // v0.6 N

const mode = ref<'cash' | 'card'>((route.query.mode as 'cash' | 'card') || 'cash')

// --- v0.4 G: collecting a web order — the amount paid online is an advance; only the balance is due ---
const webOrders = useWebOrdersStore()
const prepaid = computed(() => (webOrders.active ? Math.min(webOrders.prepaid, cart.totals.grand_total) : 0))
const total = computed(() => round(Math.max(0, cart.totals.grand_total - prepaid.value)))
const fullyPrepaid = computed(() => !!webOrders.active && total.value <= 0.005)
async function completeCollection() {
  if (!fullyPrepaid.value || busy.value) return
  busy.value = true
  try {
    await finalize('Cash')
  } finally {
    busy.value = false
  }
}
// --- end v0.4 G ---

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
// v0.4 A — the driver is bound to the reader picked in Settings (shared with the printer store)
const terminal = usePrinterStore().terminal()
const progress = ref<TerminalProgress>({ step: 'idle', message: '' })
const cardError = ref('')
const offline_uuid = ref(uuidv4())
// --- v0.5 K: mirror the payment step to the client display ---
const salon = useSalonPosStore()
watch(
  [mode, () => progress.value.step, total],
  () => {
    if (salon.pay?.step === 'approved') return
    salon.setPay({ mode: mode.value, amount: total.value, step: mode.value === 'card' && ['collecting', 'processing'].includes(String(progress.value.step)) ? 'processing' : 'present' })
  },
  { immediate: true, flush: 'post' }
)
onBeforeUnmount(() => salon.setPay(null))
// --- end v0.5 K ---
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
      // v0.4 I — manual + promotion discount; the coupon share is sent separately for server verification
      discount_amount: round(l.discount_amount + (promos.promoResult.perLine[l.id] || 0)) || undefined,
      coupon_discount: promos.couponResult.perLine[l.id] || undefined
    })),
    // v0.4 G — nothing to tender when the web order was fully paid online
    payments: total.value > 0.005 ? [{ mode_of_payment: modeOfPayment, amount: total.value, stripe_payment_intent: card?.payment_intent }] : [],
    sales_order: webOrders.active?.name,
    loyalty_points_redeemed: cart.loyalty_points_redeemed || undefined,
    notes: cart.notes || undefined,
    coupon_code: promos.coupon?.code || undefined,
    promotions: promos.applied.length ? promos.applied.map((a) => ({ name: a.name, title: a.title, discount: a.discount })) : undefined,
    // --- v0.6 N/Q — age check outcome (only when restricted lines were sold) + fixed reward tier(s) ---
    age_check: age.payload,
    reward_tier: cart.reward_tiers.length === 1 ? cart.reward_tiers[0].name : undefined,
    reward_tiers: cart.reward_tiers.length > 1 ? cart.reward_tiers.map((t) => t.name) : undefined
    // --- end v0.6 N/Q ---
  }
  // v0.6 Q: the tier costs its points; the balance after this sale feeds "next reward"
  const pointsAfter = cart.customer ? cart.customer.loyalty_points - cart.loyalty_points_redeemed - cart.rewardPoints + cart.pointsEarned : undefined
  const t = cart.totals
  const receipt: ReceiptSnapshot = {
    boutique: session.boutique!.name,
    boutique_name: session.boutique!.boutique_name,
    address_line: session.boutique!.address_line,
    city: session.boutique!.city,
    phone: session.boutique!.phone,
    associate_name: session.associate!.full_name,
    customer_name: cart.customer?.customer_name,
    customer_tier: cart.customer?.tier || undefined,
    customer_client_number: cart.customer?.client_number,
    receipt_qr_base_url: catalog.receiptQrBase,
    lines: cart.lines.map((l) => ({
      item_code: l.item_code,
      item_name: l.item_name,
      qty: l.qty,
      rate: l.rate,
      amount: round(l.qty * l.rate - l.discount_amount - (cart.extras[l.id] || 0)),
      serial_no: l.serial_no,
      certificate_no: l.certificate_no,
      discount_amount: round(l.discount_amount + (cart.extras[l.id] || 0)) || undefined
    })),
    net_total: t.net_total,
    discount: t.discount,
    total_taxes: t.total_taxes,
    tax_rate: catalog.taxRate,
    loyalty_amount: t.loyalty_amount,
    loyalty_points_redeemed: cart.reward_tiers.length ? cart.rewardPoints : cart.loyalty_points_redeemed,
    grand_total: t.grand_total,
    payments:
      total.value > 0.005
        ? [
            modeOfPayment === 'Cash'
              ? { mode_of_payment: 'Cash', amount: total.value, tendered: round(tendered.value), change: change.value }
              : { mode_of_payment: 'Card', amount: total.value, card_brand: card?.card_brand, last4: card?.last4, approval: card?.approval }
          ]
        : [],
    web_order: webOrders.active?.name, // v0.4 G
    prepaid: prepaid.value || undefined, // v0.4 G
    points_earned: cart.pointsEarned,
    promo_discount: promos.promoTotal || undefined,
    coupon_code: promos.coupon?.code,
    coupon_discount: promos.couponTotal || undefined,
    points_balance: pointsAfter,
    currency: session.currency,
    // --- v0.6 N/Q ---
    brand: { wordmark: brand.wordmark, brand_name: brand.name, sub_mark: brand.subMark, thanks: brand.thanks, program_name: brand.programName },
    reward_tier: cart.reward_tiers.length ? { title: cart.reward_tiers.map((x) => x.title).join(' + '), points: cart.rewardPoints, amount: t.loyalty_amount } : undefined,
    age_verified: age.isVerified || undefined,
    next_reward: cart.customer && catalog.reward_tiers.length ? nextReward(pointsAfter || 0, catalog.reward_tiers) : undefined
    // --- end v0.6 N/Q ---
  }
  if (IS_MOCK && promos.coupon) __mockRedeemCoupon(promos.coupon.code)
  // --- v0.5 K: "Approved" with a gold pulse on the client display before the thank-you ---
  if (salon.paired) {
    salon.setPay({ mode: modeOfPayment === 'Card' ? 'card' : 'cash', amount: total.value, step: 'approved', card_brand: card?.card_brand, last4: card?.last4 })
    salon.setReceipt({ ...({ customer: cart.customer?.name } as object), points_earned: cart.pointsEarned, points_balance: receipt.points_balance, tier: cart.customer?.tier || null, grand_total: t.grand_total, currency: session.currency, next_reward: receipt.next_reward || null, program_name: receipt.brand?.program_name })
    await new Promise((r) => setTimeout(r, 1400))
  }
  // --- end v0.5 K ---
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
  <div class="pay" :class="{ phone: layout.phone }">
    <div class="pay-left">
      <div class="tabs">
        <button class="tab display" :class="{ active: mode === 'cash' }" :disabled="busy" @click="mode = 'cash'">Cash</button>
        <button class="tab display" :class="{ active: mode === 'card' }" :disabled="busy" @click="mode = 'card'">Card</button>
      </div>

      <div class="amount">
        <div class="label">Amount due</div>
        <div class="due num" data-testid="pay-total">{{ fmtMoney(total, session.currency) }}</div>
        <!-- v0.4 G: web order collection -->
        <div v-if="webOrders.active" class="accent sub" style="font-size: 13px">Web order {{ webOrders.active.name }} &middot; paid online {{ fmtMoney(prepaid, session.currency) }} of {{ fmtMoney(cart.totals.grand_total, session.currency) }}</div>
        <div class="muted sub">{{ cart.count }} item{{ cart.count === 1 ? '' : 's' }}<span v-if="cart.customer"> &middot; {{ cart.customer.customer_name }}<span v-if="cart.customer.client_number" class="accent"> &middot; {{ cart.customer.client_number }}</span></span></div>
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
          <button v-if="fullyPrepaid" class="btn btn-primary btn-big" style="flex: 1" :disabled="busy" data-testid="collect-complete" @click="completeCollection">Complete collection · paid online</button>
          <button v-else class="btn btn-primary btn-big" style="flex: 1" :disabled="!cashOk || busy" @click="payCash">Complete cash sale</button>
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
.due {
  color: var(--accent);
}

/* ---------- phone ---------- */
.pay.phone {
  flex-direction: column;
  overflow: auto;
}
.phone .pay-left {
  flex: none;
  overflow: visible;
  padding: 0 16px 20px;
}
.phone .tabs {
  margin: 0 -16px;
  padding: 0 16px;
}
.phone .tab {
  flex: 1;
  padding: 0;
}
.phone .amount {
  padding: 20px 0 16px;
}
.phone .due {
  font-size: 36px;
}
.phone .cash-grid {
  grid-template-columns: 1fr;
  gap: 16px;
}
.phone .tendered {
  font-size: 28px;
}
.phone .actions {
  margin-top: 20px;
  flex-wrap: wrap;
}
.phone .actions .btn {
  min-height: 56px;
}
.phone .summary {
  width: auto;
  flex: none;
  border-left: 0;
  border-top: var(--line-w) solid var(--line);
  padding-bottom: var(--safe-bottom);
}
.phone .sum-lines {
  max-height: 200px;
}
</style>
