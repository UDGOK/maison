<script setup lang="ts">
/**
 * v0.4 H — compact next-best-offer tiles ("Suggested for this client" / "Pairs well with").
 * Tapping a tile adds the item to the basket (serialized pieces: the single free serial is used,
 * otherwise the Sell grid is filtered to that item so the associate picks the serial).
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { Recommendation } from '@/api'
import { useCartStore } from '@/stores/cart'
import { useCatalogStore } from '@/stores/catalog'
import { useSessionStore } from '@/stores/session'
import { fmtMoney } from '@/utils/money'

const props = defineProps<{
  title: string
  items: Recommendation[]
  loading?: boolean
  /** phone sheet: single row of narrower tiles */
  compact?: boolean
  testid?: string
}>()

const cart = useCartStore()
const catalog = useCatalogStore()
const session = useSessionStore()
const router = useRouter()

const rows = computed(() => props.items.slice(0, 3))

function freeSerials(code: string) {
  return (catalog.serials[code] || []).filter((s) => !cart.usedSerials.has(s))
}
function rateFor(r: Recommendation) {
  const live = catalog.rateFor(r.item_code)
  return live || r.rate
}
function available(r: Recommendation) {
  const it = catalog.byCode[r.item_code]
  if (!it) return false
  if (it.has_serial_no) return freeSerials(r.item_code).length > 0
  if (it.is_stock_item === 0) return true
  return (catalog.stock[r.item_code] ?? 0) > 0
}
function add(r: Recommendation) {
  const it = catalog.byCode[r.item_code]
  if (!it) return
  if (it.has_serial_no) {
    const free = freeSerials(r.item_code)
    if (free.length === 1) cart.add(it, free[0])
    else router.push({ name: 'sell', query: { q: r.item_code } })
    return
  }
  cart.add(it)
}
</script>

<template>
  <section v-if="rows.length || loading" class="suggest" :class="{ compact }" :data-testid="testid">
    <div class="suggest-head">
      <span class="label">{{ title }}</span>
      <span v-if="loading" class="label label-dim">…</span>
    </div>
    <div class="tiles">
      <div v-for="r in rows" :key="r.item_code" class="stile" :class="{ off: !available(r) }" :data-item="r.item_code">
        <button class="stile-main" :disabled="!available(r)" :title="r.reason" @click="add(r)">
          <div class="stile-top">
            <span class="stile-name display ellipsis">{{ r.item_name }}</span>
            <span class="stile-price num">{{ fmtMoney(rateFor(r), session.currency) }}</span>
          </div>
          <div class="stile-why ellipsis">{{ available(r) ? r.reason : 'Not in stock here' }}</div>
        </button>
      </div>
    </div>
  </section>
</template>

<style scoped>
/* three narrow tiles in a row: keeps the basket lines and the Cash / Card buttons on screen at 1366×1024 */
.suggest {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 16px 10px;
  border-bottom: var(--line-w) solid var(--line);
  background: var(--surface);
}
.suggest-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 6px;
}
.tiles > * {
  min-width: 0;
}
.stile {
  position: relative;
  display: flex;
  min-width: 0;
  border: var(--line-w) solid var(--line);
  background: var(--ground);
}
.stile:hover {
  border-color: var(--accent);
}
.stile.off {
  opacity: 0.55;
}
.stile-main {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 7px 8px 6px;
  text-align: left;
  color: var(--text);
  min-height: 48px;
}
.stile-top {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.stile-name {
  font-size: 10px;
  letter-spacing: 0.02em;
  min-width: 0;
  line-height: 1.2;
}
.stile-price {
  color: var(--accent);
  font-size: 12px;
}
.stile-why {
  font-size: 10px;
  color: var(--dim);
}
.stile-x {
  display: none;
}
</style>
