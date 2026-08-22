<script setup lang="ts">
/**
 * v0.5 K — basket mirror: the newest piece large (image or generated visual), name, serial,
 * certificate line, price; the running total with tax; points to be earned; "Ask about this piece".
 */
import { computed, ref } from 'vue'
import { useSalonStore } from '../store'
import { fmtInt, fmtMoney } from '@/utils/money'
import PieceVisual from '../components/PieceVisual.vue'

const salon = useSalonStore()
const lines = computed(() => salon.remote.lines || [])
/** keep the list short on the client's screen: the last four pieces + a count */
const shownLines = computed(() => lines.value.slice(-4))
const hiddenCount = computed(() => Math.max(0, lines.value.length - shownLines.value.length))
const focus = computed(() => lines.value.find((l) => l.id === salon.remote.focus_line) || lines.value[lines.value.length - 1] || null)
const totals = computed(() => salon.remote.totals)
const asking = ref(false)
const question = ref('')
const sent = computed(() => salon.askedAt > 0 && Date.now() - salon.askedAt < 60_000)

async function send() {
  if (!question.value.trim()) return
  if (await salon.ask(question.value.trim(), focus.value?.item_code)) {
    question.value = ''
    asking.value = false
  }
}
</script>

<template>
  <div class="salon-screen wide" data-testid="salon-basket">
    <div v-if="!focus" class="empty">
      <div class="s-eyebrow">{{ salon.client ? `For ${salon.client.first_name}` : 'Your selection' }}</div>
      <div class="s-title soft">Your associate is preparing your pieces</div>
    </div>
    <div v-else class="s-cols">
      <div class="hero">
        <Transition name="piece" mode="out-in">
          <div :key="focus.id || focus.item_code" class="hero-in">
            <PieceVisual :image="focus.image" :name="focus.item_name" :code="focus.item_code" :metal="focus.metal" :stones="focus.stones" size="xl" />
          </div>
        </Transition>
        <div class="focus-name" data-testid="basket-focus-name">{{ focus.item_name }}</div>
        <div class="focus-meta s-small s-muted">
          <span v-if="focus.metal">{{ focus.metal }}</span>
          <span v-if="focus.stones"> · {{ focus.stones }}</span>
          <span v-if="focus.serial_no"> · № {{ focus.serial_no }}</span>
        </div>
        <div v-if="focus.certificate_no" class="s-small s-dim">Certificate {{ focus.certificate_no }}</div>
        <div class="s-num lg" data-testid="basket-focus-price">{{ fmtMoney(focus.rate * focus.qty, salon.currency) }}</div>
        <div class="ask">
          <button v-if="!asking && !sent" class="s-btn ghost" type="button" data-testid="basket-ask" @click="asking = true">Ask about this piece</button>
          <div v-else-if="sent" class="s-small s-gold" data-testid="basket-asked">Your question has been passed to your associate.</div>
          <form v-else class="ask-form" @submit.prevent="send">
            <input v-model="question" class="s-input" type="text" autocomplete="off" placeholder="What would you like to know?" data-testid="basket-question" />
            <div class="s-btn-row">
              <button class="s-btn ghost" type="button" @click="asking = false">Cancel</button>
              <button class="s-btn primary" type="submit" :disabled="!question.trim() || salon.busy" data-testid="basket-send">Send</button>
            </div>
          </form>
        </div>
      </div>
      <div class="s-col-right side">
        <div class="s-eyebrow">{{ salon.client ? `For ${salon.client.first_name}` : 'Your selection' }}</div>
        <ul class="lines" data-testid="basket-lines">
          <li v-if="hiddenCount" class="more s-dim"><span class="ln">+ {{ hiddenCount }} more piece{{ hiddenCount > 1 ? 's' : '' }}</span></li>
          <li v-for="l in shownLines" :key="l.id || l.item_code + (l.serial_no || '')" :class="{ focus: l === focus }">
            <span class="ln">{{ l.item_name }}<span v-if="l.qty > 1" class="s-dim"> × {{ l.qty }}</span></span>
            <span class="s-num md">{{ fmtMoney(l.amount, salon.currency) }}</span>
          </li>
        </ul>
        <div v-if="totals" class="totals">
          <div class="row s-muted"><span>Subtotal</span><span class="s-num md">{{ fmtMoney(totals.net_total, salon.currency) }}</span></div>
          <div v-if="totals.discount" class="row s-muted"><span>With our compliments</span><span class="s-num md">− {{ fmtMoney(totals.discount, salon.currency) }}</span></div>
          <div class="row s-muted"><span>Tax</span><span class="s-num md">{{ fmtMoney(totals.total_taxes, salon.currency) }}</span></div>
          <div v-if="totals.loyalty_amount" class="row s-muted"><span>Points redeemed</span><span class="s-num md">− {{ fmtMoney(totals.loyalty_amount, salon.currency) }}</span></div>
          <div class="row total"><span class="s-eyebrow">Total</span><span class="s-num lg" data-testid="basket-total">{{ fmtMoney(totals.grand_total, salon.currency) }}</span></div>
          <div v-if="salon.remote.points_earned" class="s-small s-gold" data-testid="basket-points">+ {{ fmtInt(salon.remote.points_earned as number) }} points with this visit</div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.salon-screen {
  max-height: 100%;
  overflow: hidden;
  gap: calc(var(--s-unit) * 0.9);
}
.hero :deep(.piece.xl) {
  width: min(56vw, 25vh * 1.3333, 480px);
}
.lines li.more {
  padding: 8px 0;
  font-size: clamp(13px, 1.5vmin, 17px);
}
@media (orientation: landscape) {
  .hero :deep(.piece.xl) {
    width: min(44vw, 50vh * 1.3333, 600px);
  }
}
.empty {
  display: flex;
  flex-direction: column;
  gap: 16px;
  align-items: center;
}
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  position: relative;
}
.hero-in {
  display: grid;
  place-items: center;
}
.focus-name {
  font-family: var(--font-display);
  font-weight: 300;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-size: clamp(16px, 2.2vmin, 26px);
  margin-top: 6px;
}
.ask {
  margin-top: 10px;
  min-height: 60px;
  width: 100%;
  display: flex;
  justify-content: center;
}
.ask-form {
  width: 100%;
  max-width: 560px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.s-gold {
  color: var(--s-gold-2);
}
.side {
  display: flex;
  flex-direction: column;
  gap: 16px;
  width: 100%;
  max-width: 560px;
  margin: 0 auto;
}
.lines {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--s-line-soft);
}
.lines li {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
  padding: 9px 0;
  border-bottom: 1px solid var(--s-line-soft);
  color: var(--s-muted);
  transition: color 600ms var(--s-ease);
}
.lines li.focus {
  color: var(--s-ink);
}
.ln {
  text-align: left;
}
.totals {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.row {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 16px;
}
.row.total {
  margin-top: 10px;
  padding-top: 14px;
  border-top: 1px solid var(--s-line);
}
</style>
