<script setup lang="ts">
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useCartStore, type CartLine } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { fmtMoney, fmtInt } from '@/utils/money'
import { fmtDate } from '@/utils/device'
import Modal from './Modal.vue'

const cart = useCartStore()
const session = useSessionStore()
const catalog = useCatalogStore()
const router = useRouter()

const editing = ref<CartLine | null>(null)
const discPct = ref('')
const discAmt = ref('')
const redeemOpen = ref(false)
const redeemPts = ref('')

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
</script>

<template>
  <aside class="basket">
    <!-- client card -->
    <button class="client" @click="router.push({ name: 'client' })">
      <template v-if="cart.customer">
        <div class="between">
          <div class="client-name display ellipsis">{{ cart.customer.customer_name }}</div>
          <span class="pill pill-platinum">{{ cart.customer.tier }}</span>
        </div>
        <div class="client-meta">
          <span><span class="label-dim label">Points</span> <span class="num-inline">{{ fmtInt(cart.customer.loyalty_points) }}</span></span>
          <span v-if="cart.customer.last_visit"><span class="label-dim label">Last visit</span> {{ fmtDate(cart.customer.last_visit) }}</span>
        </div>
      </template>
      <template v-else>
        <div class="between">
          <div class="client-name display dim">Walk-in</div>
          <span class="label">Add client</span>
        </div>
      </template>
    </button>

    <!-- lines -->
    <div class="lines scroll">
      <div v-if="!cart.lines.length" class="empty">
        <div class="label label-dim">Basket empty</div>
      </div>
      <div v-for="l in cart.lines" :key="l.id" class="line">
        <button class="line-main" @click="openLine(l)">
          <div class="line-name ellipsis">{{ l.item_name }}</div>
          <div class="line-sub">
            <span v-if="l.serial_no" class="good">{{ l.serial_no }}</span>
            <span v-else>{{ l.qty }} &times; {{ fmtMoney(l.rate, session.currency) }}</span>
            <span v-if="l.discount_amount" class="warn">&minus;{{ fmtMoney(l.discount_amount, session.currency) }}</span>
            <span v-if="!l.taxable" class="dim">No tax</span>
          </div>
        </button>
        <div class="line-right">
          <div class="line-amt num">{{ fmtMoney(l.qty * l.rate - l.discount_amount, session.currency) }}</div>
          <div v-if="!l.serial_no" class="qty">
            <button class="qty-btn" @click="cart.setQty(l.id, l.qty - 1)" aria-label="Less">&minus;</button>
            <span class="qty-n">{{ l.qty }}</span>
            <button class="qty-btn" @click="cart.setQty(l.id, l.qty + 1)" aria-label="More">+</button>
          </div>
          <button v-else class="qty-btn rm" @click="cart.remove(l.id)" aria-label="Remove">&times;</button>
        </div>
      </div>
    </div>

    <!-- totals -->
    <div class="totals">
      <div class="trow"><span class="label">Subtotal</span><span>{{ fmtMoney(cart.totals.gross, session.currency) }}</span></div>
      <div v-if="cart.totals.discount" class="trow"><span class="label">Discount</span><span class="warn">&minus;{{ fmtMoney(cart.totals.discount, session.currency) }}</span></div>
      <div class="trow"><span class="label">Tax {{ catalog.taxRate }}%</span><span>{{ fmtMoney(cart.totals.total_taxes, session.currency) }}</span></div>
      <button class="trow loyalty" :disabled="!cart.customer || !cart.maxRedeemable" @click="redeemPts = String(cart.loyalty_points_redeemed || cart.maxRedeemable); redeemOpen = true">
        <span class="label">Loyalty<span v-if="cart.loyalty_points_redeemed"> &middot; {{ fmtInt(cart.loyalty_points_redeemed) }} pts</span></span>
        <span :class="cart.totals.loyalty_amount ? 'good' : 'dim'">{{ cart.totals.loyalty_amount ? '−' + fmtMoney(cart.totals.loyalty_amount, session.currency) : 'Redeem' }}</span>
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
  display: block;
  width: 100%;
  text-align: left;
  padding: 14px 16px;
  border-bottom: var(--line-w) solid var(--line);
  color: var(--text);
}
.client:hover {
  background: var(--surface-2);
}
.client-name {
  font-size: 15px;
  min-width: 0;
}
.client-meta {
  display: flex;
  gap: 18px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--muted);
}
.client-meta .label {
  margin-right: 4px;
}
.num-inline {
  color: var(--text);
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
</style>
