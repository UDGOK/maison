<script setup lang="ts">
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCartStore, type CartLine } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { useScanStore } from '@/stores/scan'
import { useLayoutStore } from '@/stores/layout'
import { useSyncStore } from '@/stores/sync'
import { fmtMoney, fmtInt } from '@/utils/money'
import { fmtDate } from '@/utils/device'
import Modal from './Modal.vue'
import Keypad from './Keypad.vue'
import RecognitionTile from './RecognitionTile.vue'
import SalonBar from './SalonBar.vue' // v0.5 K
import PromotionsChip from './PromotionsChip.vue'
import TierProgress from './TierProgress.vue'
import { usePromosStore } from '@/stores/promos'
import { useLoyaltyStore } from '@/stores/loyalty'
import { useRecognitionStore } from '@/stores/recognition'
// --- v0.4 H insights ---
import { watch } from 'vue'
import SuggestionTiles from './SuggestionTiles.vue'
import { useInsightsStore } from '@/stores/insights'
import { affordableTiers, nextReward } from '@/api/v06' // v0.6 Q
import { useBrand } from '@/stores/brand' // v0.6 N
// --- end v0.4 H ---

const cart = useCartStore()
const session = useSessionStore()
const catalog = useCatalogStore()
const scan = useScanStore()
const layout = useLayoutStore()
const sync = useSyncStore()
const recognition = useRecognitionStore()
const promos = usePromosStore()
const loyaltyStore = useLoyaltyStore()
const router = useRouter()

// --- v0.4 H insights: "Suggested for this client" + "Pairs well with" ---
const insights = useInsightsStore()
watch(
  () => cart.customer?.name ?? null,
  (name) => void insights.loadClient(name, session.boutique?.name),
  { immediate: true }
)
watch(
  () => [cart.lines.map((l) => l.item_code).join('|'), cart.customer?.name ?? ''] as const,
  () => insights.scheduleBasket(cart.lines.map((l) => l.item_code), session.boutique?.name, cart.customer?.name ?? null),
  { immediate: true }
)
// --- end v0.4 H ---

const editing = ref<CartLine | null>(null)
const discPct = ref('')
const discAmt = ref('')
const redeemOpen = ref(false)
const redeemPts = ref('')

// ---- client number lookup
const clientNo = ref('')
const padOpen = ref(false)
const looking = ref(false)
const lookupError = ref('')
const pointsValue = computed(() =>
  cart.customer ? (typeof cart.customer.points_value === 'number' ? cart.customer.points_value : cart.customer.loyalty_points * (catalog.loyalty?.conversion_factor || 0)) : 0
)
const redeemOn = computed(() => cart.loyalty_points_redeemed > 0 || cart.reward_tiers.length > 0)
// --- v0.6 Q: fixed reward tiers ($5 / 100, $10 / 200, $15 / 300) replace free-form point redemption when the program defines them ---
const brand = useBrand()
const hasTiers = computed(() => catalog.reward_tiers.length > 0)
const tiersOpen = ref(false)
const affordable = computed(() => affordableTiers(cart.customer?.loyalty_points || 0, catalog.reward_tiers))
const nextTier = computed(() => nextReward(cart.customer?.loyalty_points || 0, catalog.reward_tiers))
const allowStacking = computed(() => catalog.age.reward_allow_stacking)
function openRedeem() {
  if (!cart.customer) return
  if (hasTiers.value) tiersOpen.value = true
  else {
    redeemPts.value = String(cart.loyalty_points_redeemed || cart.maxRedeemable)
    redeemOpen.value = true
  }
}
function pickTier(t: (typeof affordable.value)[number]) {
  if (cart.reward_tiers.some((x) => x.name === t.name)) cart.removeTier(t.name)
  else cart.redeemTier(t, allowStacking.value)
  if (!allowStacking.value) tiersOpen.value = false
}
// --- end v0.6 Q ---

function padKey(k: string) {
  lookupError.value = ''
  if (k === 'clear') clientNo.value = ''
  else if (k === 'back') clientNo.value = clientNo.value.slice(0, -1)
  else if (clientNo.value.length < 12) clientNo.value += k
}
async function lookup() {
  const code = clientNo.value.trim()
  if (!code) return
  looking.value = true
  lookupError.value = ''
  try {
    // Digits-only input is a client number unless prefixed: MC + 6 digits is the printed form.
    const candidates = /^\d{6}$/.test(code) ? [`MC${code}`, code] : [code]
    let c = null
    for (const cand of candidates) {
      c = await scan.lookupCustomer(cand)
      if (c) break
    }
    if (c) {
      cart.setCustomer(c)
      clientNo.value = ''
      padOpen.value = false
    } else lookupError.value = 'No client with that number'
  } finally {
    looking.value = false
  }
}
async function scanClient() {
  const c = await scan.scanClient()
  if (c) cart.setCustomer(c)
}
function toggleRedeem() {
  if (!cart.customer) return
  // v0.6 Q: with fixed tiers the switch opens the tier picker (or clears the picked tier)
  if (hasTiers.value) {
    if (cart.reward_tiers.length) cart.redeemTier(null)
    else tiersOpen.value = true
    return
  }
  if (!cart.maxRedeemable) return
  cart.redeem(redeemOn.value ? 0 : cart.maxRedeemable)
}

function openLine(l: CartLine) {
  editing.value = l
  discAmt.value = l.discount_amount ? String(l.discount_amount) : ''
  discPct.value = ''
}
function applyDiscount() {
  if (!editing.value) return
  if (discPct.value) cart.setDiscountPercent(editing.value.id, parseFloat(discPct.value) || 0)
  else cart.setDiscount(editing.value.id, parseFloat(discAmt.value) || 0)
  editing.value = null
}
function applyRedeem() {
  cart.redeem(parseInt(redeemPts.value) || 0)
  redeemOpen.value = false
}
function pay(mode: 'cash' | 'card') {
  if (!cart.lines.length) return
  router.push({ name: 'pay', query: { mode } })
}
function charge() {
  if (!cart.lines.length) return
  layout.openSheet()
}
</script>

<template>
  <aside class="basket" :class="{ phone: layout.phone, expanded: layout.sheetExpanded }">
    <!-- phone: collapsed summary bar -->
    <button v-if="layout.phone && !layout.sheetExpanded" class="summary-bar" :disabled="!cart.lines.length && !cart.customer && !recognition.boutiqueEnabled" @click="layout.openSheet()">
      <span class="sum-left">
        <span class="label">{{ cart.count }} item{{ cart.count === 1 ? '' : 's' }}</span>
        <span v-if="cart.customer" class="sum-client ellipsis">{{ cart.customer.customer_name }}</span>
        <span v-else class="sum-client dim">Walk-in<span v-if="recognition.boutiqueEnabled" class="sum-rec"> · <span class="accent">Recognition</span></span></span>
      </span>
      <span class="sum-total num">{{ fmtMoney(cart.totals.grand_total, session.currency) }}</span>
      <span class="sum-cta display" :class="{ off: !cart.lines.length }" @click.stop="charge">Charge</span>
    </button>

    <template v-if="layout.sheetExpanded">
      <div v-if="layout.phone" class="sheet-head">
        <span class="section-title">Basket · {{ cart.count }}</span>
        <button class="label close-sheet" @click="layout.closeSheet()">Close</button>
      </div>

      <!-- client card -->
      <div class="client">
        <RecognitionTile v-if="recognition.boutiqueEnabled" :compact="layout.phone" />
        <template v-if="cart.customer">
          <div class="between">
            <button class="client-name display ellipsis" @click="router.push({ name: 'client' })">{{ cart.customer.customer_name }}</button>
            <span class="pills">
              <span v-if="recognition.recognised?.customer === cart.customer.name" class="pill pill-accent-fill" title="Recognised by camera">Face</span>
              <span class="pill pill-accent">{{ cart.customer.tier }}</span>
            </span>
          </div>
          <div class="client-no">
            <span class="label">Client №</span>
            <span class="num accent">{{ cart.customer.client_number || '—' }}</span>
          </div>
          <div class="client-meta">
            <span><span class="label-dim label">Points</span> <span class="num-inline">{{ fmtInt(cart.customer.loyalty_points) }}</span> <span class="dim">({{ fmtMoney(pointsValue, session.currency) }})</span></span>
            <span v-if="cart.customer.last_visit"><span class="label-dim label">Last visit</span> {{ fmtDate(cart.customer.last_visit) }}</span>
          </div>
          <TierProgress v-if="loyaltyStore.forCustomer(cart.customer.name)" :loyalty="loyaltyStore.forCustomer(cart.customer.name)" :currency="session.currency" compact class="client-tier" />
          <div class="client-actions">
            <!-- v0.6 Q: "Redeem" with fixed tiers when the program defines them -->
            <button v-if="hasTiers" class="redeem" :class="{ on: redeemOn }" :disabled="!affordable.length && !cart.reward_tiers.length" data-testid="redeem-btn" @click="toggleRedeem">
              <span class="switch" :class="{ on: redeemOn }"></span>
              <span class="redeem-txt">
                Redeem
                <span class="dim small" data-testid="redeem-sub">{{ cart.reward_tiers.length ? cart.reward_tiers.map((t) => t.title).join(' + ') : affordable.length ? affordable.length + ' reward' + (affordable.length > 1 ? 's' : '') + ' available' : nextTier ? fmtInt(nextTier.points_needed) + ' pts to ' + nextTier.title : 'nothing to redeem' }}</span>
              </span>
            </button>
            <button v-else class="redeem" :class="{ on: redeemOn }" :disabled="!cart.maxRedeemable" @click="toggleRedeem">
              <span class="switch" :class="{ on: redeemOn }"></span>
              <span class="redeem-txt">
                Redeem points
                <span class="dim small">{{ redeemOn ? fmtInt(cart.loyalty_points_redeemed) + ' pts · −' + fmtMoney(cart.totals.loyalty_amount, session.currency) : cart.maxRedeemable ? 'up to ' + fmtInt(cart.maxRedeemable) : 'nothing to redeem' }}</span>
              </span>
            </button>
            <button class="label detach" @click="cart.setCustomer(null)">Detach</button>
          </div>
          <!-- v0.4 H: next best offer for the attached client -->
          <SuggestionTiles
            v-if="sync.online && (insights.visibleClientItems.length || insights.clientLoading)"
            class="client-suggest"
            title="Suggested for this client"
            :items="insights.visibleClientItems"
            :loading="insights.clientLoading"
            :compact="layout.phone"
            testid="suggested-for-client"
          />
          <SalonBar />
          <!-- ^ v0.5 K -->
        </template>
        <template v-else>
          <div class="between">
            <button class="client-name display dim" @click="router.push({ name: 'client' })">Walk-in</button>
            <button class="label link client-search" @click="router.push({ name: 'client' })">Search</button>
          </div>
          <div class="cn-row">
            <label class="label" for="client-no">Client №</label>
            <div class="cn-input">
              <span class="cn-prefix num">MC</span>
              <input
                id="client-no"
                v-model="clientNo"
                class="input num cn-field"
                inputmode="numeric"
                autocomplete="off"
                placeholder="000000"
                maxlength="12"
                @focus="padOpen = true"
                @keydown.enter.prevent="lookup"
              />
              <button v-if="catalog.settings.scan_enabled" class="cn-btn" title="Scan client card" aria-label="Scan client card" @click="scanClient">
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" /><rect x="8" y="8" width="8" height="8" /></svg>
              </button>
              <button class="cn-btn go" :disabled="!clientNo.trim() || looking" @click="lookup">{{ looking ? '…' : 'Find' }}</button>
            </div>
            <div v-if="lookupError" class="crit small">{{ lookupError }}</div>
            <div v-else-if="!sync.online" class="dim small">Offline — cached clients only</div>
          </div>
          <Keypad v-if="padOpen" class="cn-pad" @key="padKey" />
          <button v-if="padOpen" class="label link hide-pad" @click="padOpen = false">Hide keypad</button>
          <SalonBar />
          <!-- ^ v0.5 K -->
        </template>
      </div>

      <!-- v0.4 I — promotions & coupons -->
      <div v-if="promos.enabled" class="promo-row"><PromotionsChip /></div>

      <!-- lines -->
      <div class="lines scroll">
        <div v-if="!cart.lines.length" class="empty">
          <div class="label label-dim">Basket empty</div>
        </div>
        <div v-for="l in cart.lines" :key="l.id" class="line">
          <button class="line-main" @click="openLine(l)">
            <div class="line-name ellipsis">{{ l.item_name }}</div>
            <div class="line-sub">
              <span v-if="l.serial_no" class="good serial">{{ l.serial_no }}</span>
              <span v-else>{{ l.qty }} &times; {{ fmtMoney(l.rate, session.currency) }}</span>
              <span v-if="l.discount_amount" class="warn">&minus;{{ fmtMoney(l.discount_amount, session.currency) }}</span>
              <span v-if="cart.extras[l.id]" class="good" :title="'Promotion / coupon'">&#10022; &minus;{{ fmtMoney(cart.extras[l.id], session.currency) }}</span>
              <span v-if="!l.taxable" class="dim">No tax</span>
            </div>
          </button>
          <div class="line-right">
            <div class="line-amt num">{{ fmtMoney(l.qty * l.rate - l.discount_amount - (cart.extras[l.id] || 0), session.currency) }}</div>
            <div v-if="!l.serial_no" class="qty">
              <button class="qty-btn" @click="cart.setQty(l.id, l.qty - 1)" aria-label="Less">&minus;</button>
              <span class="qty-n">{{ l.qty }}</span>
              <button class="qty-btn" @click="cart.setQty(l.id, l.qty + 1)" aria-label="More">+</button>
            </div>
            <button v-else class="qty-btn rm" @click="cart.remove(l.id)" aria-label="Remove">&times;</button>
          </div>
        </div>
      </div>

      <!-- v0.4 H: pairs well with the basket -->
      <SuggestionTiles
        v-if="cart.lines.length && sync.online && insights.visibleBasketItems.length"
        title="Pairs well with"
        :items="insights.visibleBasketItems"
        :loading="insights.basketLoading"
        :compact="layout.phone"
        testid="pairs-well-with"
      />

      <!-- totals -->
      <div class="totals">
        <div class="trow"><span class="label">Subtotal</span><span>{{ fmtMoney(cart.totals.gross, session.currency) }}</span></div>
        <div v-if="cart.totals.discount - promos.promoTotal - promos.couponTotal > 0.004" class="trow"><span class="label">Discount</span><span class="warn">&minus;{{ fmtMoney(cart.totals.discount - promos.promoTotal - promos.couponTotal, session.currency) }}</span></div>
        <div v-if="promos.promoTotal" class="trow" data-testid="promo-total"><span class="label">Promotions</span><span class="good">&minus;{{ fmtMoney(promos.promoTotal, session.currency) }}</span></div>
        <div v-if="promos.coupon && promos.couponTotal" class="trow" data-testid="coupon-total"><span class="label">Coupon {{ promos.coupon.code }}</span><span class="good">&minus;{{ fmtMoney(promos.couponTotal, session.currency) }}</span></div>
        <div class="trow"><span class="label">Tax {{ catalog.taxRate }}%</span><span>{{ fmtMoney(cart.totals.total_taxes, session.currency) }}</span></div>
        <button class="trow loyalty" :disabled="!cart.customer || (!cart.maxRedeemable && !hasTiers)" data-testid="loyalty-row" @click="openRedeem">
          <span class="label">{{ hasTiers ? 'Reward' : 'Loyalty' }}<span v-if="cart.reward_tiers.length"> &middot; {{ fmtInt(cart.rewardPoints) }} pts</span><span v-else-if="cart.loyalty_points_redeemed"> &middot; {{ fmtInt(cart.loyalty_points_redeemed) }} pts</span></span>
          <span :class="cart.totals.loyalty_amount ? 'good' : 'dim'">{{ cart.totals.loyalty_amount ? '−' + fmtMoney(cart.totals.loyalty_amount, session.currency) : 'Adjust' }}</span>
        </button>
        <div class="hr"></div>
        <div class="total">
          <span class="label">Total</span>
          <span class="total-amt num">{{ fmtMoney(cart.totals.grand_total, session.currency) }}</span>
        </div>
      </div>

      <div class="pay">
        <button class="btn btn-primary btn-big" :disabled="!cart.lines.length" @click="pay('cash')">Cash</button>
        <button class="btn btn-primary btn-big" :disabled="!cart.lines.length" @click="pay('card')">Card</button>
      </div>
      <button v-if="cart.lines.length" class="clear label" @click="cart.clear()">Clear basket</button>
    </template>

    <Modal v-if="editing" :title="editing.item_name" width="440px" @close="editing = null">
      <div class="stack">
        <div class="muted">
          {{ editing.qty }} &times; {{ fmtMoney(editing.rate, session.currency) }}
          <span v-if="editing.serial_no"> &middot; Serial {{ editing.serial_no }}</span>
          <span v-if="editing.certificate_no"> &middot; {{ editing.certificate_no }}</span>
        </div>
        <div class="row">
          <div class="field" style="flex: 1">
            <label class="label">Discount %</label>
            <input v-model="discPct" class="input" inputmode="decimal" placeholder="0" @input="discAmt = ''" />
          </div>
          <div class="field" style="flex: 1">
            <label class="label">Discount amount</label>
            <input v-model="discAmt" class="input" inputmode="decimal" placeholder="0.00" @input="discPct = ''" />
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn btn-crit" @click="cart.remove(editing!.id); editing = null">Remove line</button>
        <button class="btn btn-primary" @click="applyDiscount">Apply</button>
      </template>
    </Modal>

    <!-- v0.6 Q: tier picker — only the tiers the client can afford, one per transaction unless stacking is enabled -->
    <Modal v-if="tiersOpen" :title="'Redeem · ' + brand.programName" width="460px" @close="tiersOpen = false">
      <div class="stack" data-testid="redeem-sheet">
        <div class="muted">{{ cart.customer?.customer_name }} has <b>{{ fmtInt(cart.customer?.loyalty_points || 0) }} points</b>.<template v-if="!allowStacking"> One reward per transaction.</template></div>
        <div v-if="!affordable.length" class="muted" data-testid="redeem-none">No reward yet<template v-if="nextTier"> — {{ fmtInt(nextTier.points_needed) }} more points to {{ nextTier.title }}</template>.</div>
        <div class="tiers">
          <button v-for="t in affordable" :key="t.name" class="tier" :class="{ on: cart.reward_tiers.some((x) => x.name === t.name) }" :data-testid="'tier-' + t.points" @click="pickTier(t)">
            <span class="tier-amt num">{{ fmtMoney(t.amount, session.currency) }} off</span>
            <span class="label">{{ t.points }} points</span>
          </button>
        </div>
        <div v-if="nextTier && affordable.length" class="muted small">Next: {{ nextTier.title }} ({{ fmtInt(nextTier.points_needed) }} to go)</div>
      </div>
      <template #footer>
        <button class="btn" data-testid="redeem-clear" @click="cart.redeemTier(null); tiersOpen = false">None</button>
        <button class="btn btn-primary" data-testid="redeem-done" @click="tiersOpen = false">Done</button>
      </template>
    </Modal>
    <Modal v-if="redeemOpen" title="Redeem points" width="420px" @close="redeemOpen = false">
      <div class="stack">
        <div class="muted">
          {{ cart.customer?.customer_name }} has {{ fmtInt(cart.customer?.loyalty_points || 0) }} points. Up to
          {{ fmtInt(cart.maxRedeemable) }} can be applied to this sale ({{ fmtMoney(cart.maxRedeemable * (catalog.loyalty?.conversion_factor || 0), session.currency) }}).
        </div>
        <div class="field">
          <label class="label">Points to redeem</label>
          <input v-model="redeemPts" class="input" inputmode="numeric" />
        </div>
      </div>
      <template #footer>
        <button class="btn" @click="cart.redeem(0); redeemOpen = false">None</button>
        <button class="btn btn-primary" @click="applyRedeem">Apply</button>
      </template>
    </Modal>
  </aside>
</template>

<style scoped>
/* v0.6 Q — reward tier picker */
.tiers {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
  gap: 10px;
}
.tier {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 12px;
  border: var(--line-w) solid var(--line);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
}
.tier.on {
  border-color: var(--accent);
  background: rgba(201, 162, 77, 0.12);
}
.tier-amt {
  font-size: 20px;
  color: var(--accent);
}
.promo-row {
  padding: 0 16px 10px;
}
.client-tier {
  margin: 8px 0 2px;
}
/* v0.4 H — suggestion tiles must never squeeze the basket lines out of view */
.client-suggest {
  padding: 6px 0 0;
  border-bottom: 0;
  background: transparent;
}
.basket:not(.phone) .lines {
  min-height: 96px;
}
.basket {
  width: var(--panel-w);
  flex: 0 0 var(--panel-w);
  display: flex;
  flex-direction: column;
  min-height: 0;
  border-left: var(--line-w) solid var(--line);
  background: var(--surface);
}
.client {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: var(--line-w) solid var(--line);
  color: var(--text);
}
.pills {
  display: flex;
  gap: 6px;
  flex: 0 0 auto;
}
.client-name {
  font-size: 15px;
  min-width: 0;
  text-align: left;
  padding: 0;
  min-height: 0;
  color: var(--text);
}
.client-no {
  display: flex;
  align-items: baseline;
  gap: 10px;
  font-size: 15px;
}
.client-meta {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  font-size: 13px;
  color: var(--muted);
}
.client-meta .label {
  margin-right: 4px;
}
.num-inline {
  color: var(--text);
}
.client-actions {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.redeem {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 0;
  color: var(--text);
  font-size: 13px;
  text-align: left;
}
.redeem-txt {
  display: flex;
  flex-direction: column;
  line-height: 1.2;
}
.small {
  font-size: 12px;
}
.detach {
  padding: 0 4px;
  min-width: 0;
  color: var(--dim);
}
.detach:hover {
  color: var(--crit);
}
.link {
  padding: 0 4px;
  min-width: 0;
  min-height: 32px;
  color: var(--accent);
}
.cn-row {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  padding: 0 0 0 12px;
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
.cn-field::placeholder {
  letter-spacing: 0.08em;
}
.cn-btn {
  min-width: 48px;
  padding: 0 12px;
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
.cn-btn:hover {
  color: var(--accent);
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
  margin-top: 2px;
}
.cn-pad :deep(.key) {
  height: 52px;
}
.hide-pad {
  align-self: flex-end;
}
.lines {
  flex: 1;
  min-height: 0;
}
.empty {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 80px;
}
.line {
  display: flex;
  align-items: stretch;
  border-bottom: var(--line-w) solid var(--line);
}
.line-main {
  flex: 1;
  min-width: 0;
  text-align: left;
  padding: 10px 0 10px 16px;
  color: var(--text);
}
.line-name {
  font-size: 14px;
  font-weight: 500;
}
.line-sub {
  display: flex;
  gap: 10px;
  margin-top: 3px;
  font-size: 12px;
  color: var(--muted);
}
.line-right {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  justify-content: space-between;
  padding: 10px 12px 6px 8px;
}
.line-amt {
  font-size: 14px;
  white-space: nowrap;
}
.qty {
  display: flex;
  align-items: center;
  margin-right: -8px;
}
.qty-btn {
  min-width: 36px;
  min-height: 36px;
  width: 36px;
  height: 36px;
  color: var(--muted);
  font-size: 18px;
}
.qty-btn:hover {
  color: var(--text);
}
.qty-n {
  min-width: 20px;
  text-align: center;
  font-size: 13px;
}
.totals {
  padding: 12px 16px 10px;
  border-top: var(--line-w) solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.trow {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 14px;
}
.trow.loyalty {
  width: 100%;
  min-height: 32px;
  padding: 0;
  color: var(--text);
  text-align: left;
}
.trow.loyalty:disabled {
  opacity: 0.5;
}
.totals .hr {
  margin: 4px 0;
}
.total {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.total-amt {
  font-size: 26px;
  color: var(--accent);
}
.pay {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 0 16px 12px;
}
.clear {
  margin: 0 16px 12px;
  color: var(--dim);
}
.clear:hover {
  color: var(--crit);
}

/* ---------- phone: bottom sheet ---------- */
.basket.phone {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  width: auto;
  flex: none;
  border-left: 0;
  border-top: var(--line-w) solid var(--line-strong);
  z-index: 20;
  padding-bottom: var(--safe-bottom);
  box-shadow: 0 -12px 32px rgba(0, 0, 0, 0.45);
}
.basket.phone.expanded {
  top: 0;
  border-top: 0;
}
.summary-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-height: 72px;
  padding: 0 0 0 16px;
  color: var(--text);
  text-align: left;
}
.summary-bar:disabled {
  opacity: 1;
}
.sum-left {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.sum-client {
  font-size: 14px;
}
.sum-rec {
  font-size: 12px;
}
.sum-total {
  font-size: 20px;
  color: var(--accent);
  white-space: nowrap;
}
.sum-cta {
  display: flex;
  align-items: center;
  justify-content: center;
  align-self: stretch;
  min-width: 104px;
  padding: 0 18px;
  background: var(--accent);
  color: var(--ink-on-accent);
  font-size: 13px;
  letter-spacing: 0.12em;
}
.sum-cta.off {
  background: var(--surface-2);
  color: var(--dim);
}
.sheet-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 16px;
  min-height: 52px;
  border-bottom: var(--line-w) solid var(--line);
}
.close-sheet {
  padding: 0 12px;
  color: var(--accent);
}
.phone .pay {
  padding-bottom: 12px;
}
.phone .lines {
  min-height: 96px;
}
/* phone: every control in the sheet is a finger target (SPEC_v0.2 §4: ≥48 px) */
.phone .client-name,
.phone .link,
.phone .detach,
.phone .hide-pad,
.phone .trow.loyalty,
.phone .close-sheet {
  min-height: 48px;
}
.phone .qty-btn {
  width: 48px;
  height: 48px;
  min-width: 48px;
  min-height: 48px;
}
.phone .line {
  min-height: 56px;
}
</style>
