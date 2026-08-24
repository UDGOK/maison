<script setup lang="ts">
/**
 * Selected boutique: its own item-level feed (socket events first, server fill behind) + hourly bars.
 */
import { computed, onMounted, ref, watch } from 'vue'
import MiniBars from '../MiniBars.vue'
import { fetchBoutiqueFeed } from '../../api'
import type { BoutiqueAgg } from '../../lib/aggregate'
import { fmtInt, fmtMoney, fmtTime } from '../../lib/format'
import type { FeedSale, SaleEvent } from '../../types'

const props = defineProps<{ row: BoutiqueAgg; now: number }>()
defineEmits<{ close: []; open: [code: string] }>()

const server = ref<FeedSale[]>([])
const loading = ref(false)
async function load() {
  loading.value = true
  try {
    server.value = (await fetchBoutiqueFeed(props.row.boutique, 30)).sales
  } catch {
    server.value = []
  } finally {
    loading.value = false
  }
}
onMounted(load)
watch(() => props.row.boutique, load)

interface Line { key: string; time: string; items: string; amount: number; ret: boolean; who?: string }
const lines = computed<Line[]>(() => {
  const seen = new Set<string>()
  const out: Line[] = []
  for (const s of props.row.feed as SaleEvent[]) {
    if (seen.has(s.invoice)) continue
    seen.add(s.invoice)
    out.push({ key: s.invoice, time: s.posting_datetime, items: s.items.join(' · ') || s.top_item || '—', amount: s.net, ret: !!s.is_return, who: s.tier })
  }
  for (const s of server.value) {
    if (seen.has(s.invoice)) continue
    seen.add(s.invoice)
    out.push({ key: s.invoice, time: s.posting_datetime, items: s.items.map((i) => `${i.item_name}${i.serial_no ? ' · ' + i.serial_no : ''}`).join(' · ') || '—', amount: s.amount, ret: !!s.is_return })
  }
  return out.slice(0, 40)
})
const currentHour = computed(() => new Date(props.now).getHours())
</script>

<template>
  <aside class="drill" :data-boutique="row.boutique">
    <header class="head">
      <div class="title">
        <span class="display code">{{ row.boutique }}</span>
        <span class="city">{{ row.name }}</span>
      </div>
      <div class="actions">
        <button class="btn ghost" @click="$emit('open', row.boutique)">Open</button>
        <button class="btn" @click="$emit('close')">Close</button>
      </div>
    </header>
    <div class="stats">
      <div><span class="label">Net</span><span class="display num v">{{ fmtMoney(row.net) }}</span></div>
      <div><span class="label">Tickets</span><span class="display num v">{{ fmtInt(row.invoices) }}</span></div>
      <div><span class="label">Avg sale</span><span class="display num v">{{ fmtMoney(row.avg_ticket) }}</span></div>
      <div><span class="label">Returns</span><span class="display num v" :class="{ down: row.returns > 0 }">{{ fmtInt(row.returns) }}</span></div>
    </div>
    <div class="bars"><MiniBars :values="row.by_hour" :current-hour="currentHour" :height="110" /></div>
    <div class="feedhead"><span class="label">Item-level feed</span><span class="label">{{ loading ? 'loading…' : `${lines.length} sales` }}</span></div>
    <ol class="lines">
      <li v-for="l in lines" :key="l.key" class="line" :class="{ ret: l.ret }">
        <span class="num t">{{ fmtTime(l.time) }}</span>
        <span class="items">{{ l.items }}</span>
        <span class="display num amt">{{ fmtMoney(l.amount) }}</span>
      </li>
      <li v-if="!lines.length && !loading" class="label empty">No sales yet today</li>
    </ol>
  </aside>
</template>

<style scoped>
.drill { display: grid; grid-template-rows: auto auto auto auto 1fr; min-height: 0; border-left: 1px solid var(--line); background: var(--surface); }
.head { display: flex; justify-content: space-between; align-items: center; padding: 0.9rem var(--pad-x); border-bottom: 1px solid var(--line); }
.title { display: flex; align-items: baseline; gap: 0.8rem; }
.code { font-size: var(--fs-lead); font-weight: 900; }
.city { color: var(--muted); font-weight: 300; }
.actions { display: flex; gap: 0.4rem; }
.stats { display: grid; grid-template-columns: repeat(4, 1fr); border-bottom: 1px solid var(--line); }
.stats > div { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.8rem var(--pad-x); border-right: 1px solid var(--line); }
.stats > div:last-child { border-right: 0; }
.v { font-size: var(--fs-lead); font-weight: 800; }
.bars { height: 8rem; padding: 0.8rem var(--pad-x) 0; border-bottom: 1px solid var(--line); }
.feedhead { display: flex; justify-content: space-between; padding: 0.8rem var(--pad-x) 0.4rem; }
.lines { list-style: none; overflow-y: auto; min-height: 0; padding: 0 var(--pad-x) 1rem; }
.line { display: grid; grid-template-columns: auto 1fr auto; gap: 0.8rem; align-items: baseline; padding: 0.5rem 0; border-bottom: 1px solid var(--line); font-size: var(--fs-small); }
.t { color: var(--dim); }
.items { color: var(--muted); font-weight: 300; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.amt { font-weight: 800; font-size: var(--fs-num); }
.line.ret .amt { color: var(--crit); }
.empty { padding-top: 1rem; }
</style>
