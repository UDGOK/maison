<script setup lang="ts">
import { computed } from 'vue'
import type { LowStockBlock } from '../types'

/** v0.4 D — open + acknowledged AWANZ Stock Alerts; drill-down opens the desk list. */
const props = defineProps<{ data: LowStockBlock; returns?: { count: number; value: number } }>()
const worst = computed(() => Object.entries(props.data.by_boutique).sort((a, b) => b[1] - a[1]).slice(0, 4))
const listUrl = '/app/awanz-stock-alert?status=%5B%22in%22%2C%5B%22Open%22%2C%22Acknowledged%22%5D%5D'
</script>

<template>
  <section class="tile" :class="{ warn: data.open > 0 }">
    <header class="head">
      <span class="label">Low stock</span>
      <a class="label link" :href="listUrl" target="_blank" rel="noopener">Open in desk →</a>
    </header>
    <div class="body">
      <div class="big">
        <span class="display value num">{{ data.open }}</span>
        <span class="label">alert{{ data.open === 1 ? '' : 's' }} open</span>
        <div class="bb">
          <span v-for="[code, n] in worst" :key="code" class="label chip"><span class="display code">{{ code }}</span> {{ n }}</span>
        </div>
      </div>
      <ol class="list">
        <li v-for="a in data.top.slice(0, 5)" :key="a.name" class="item">
          <span class="display code">{{ a.boutique }}</span>
          <span class="name">{{ a.item_name || a.item_code }}</span>
          <span class="num qty" :class="a.qty <= 0 ? 'crit' : 'warnc'">{{ a.qty }}<span class="dim">/{{ a.reorder_level }}</span></span>
        </li>
        <li v-if="!data.top.length" class="label dim">Nothing below its reorder level.</li>
      </ol>
    </div>
    <footer v-if="returns" class="foot label">
      Returns today · <span class="num">{{ returns.count }}</span> · <span class="num">{{ returns.value.toLocaleString('en-US', { maximumFractionDigits: 0 }) }}</span>
    </footer>
  </section>
</template>

<style scoped>
.tile { display: grid; grid-template-rows: auto 1fr auto; padding: 1.067rem 1.333rem; border-top: 1px solid var(--line); min-height: 0; }
.head { display: flex; justify-content: space-between; margin-bottom: 0.533rem; }
.link { color: var(--accent); text-decoration: none; }
.body { display: grid; grid-template-columns: 8.0rem 1fr; gap: 1.067rem; min-height: 0; }
.big { display: flex; flex-direction: column; gap: 0.267rem; }
.value { font-size: 2.4rem; font-weight: 800; line-height: 1; }
.tile.warn .value { color: var(--warn); }
.bb { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.4rem; }
.chip { border: 1px solid var(--line-strong); padding: 2px 0.4rem; }
.code { font-size: 0.667rem; font-weight: 800; letter-spacing: 0.04em; }
.list { list-style: none; display: flex; flex-direction: column; gap: 0.4rem; overflow: hidden; }
.item { display: grid; grid-template-columns: auto 1fr auto; gap: 0.667rem; align-items: baseline; font-size: 0.867rem; }
.name { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--text); }
.qty { font-weight: 500; }
.warnc { color: var(--warn); }
.crit { color: var(--crit); }
.dim { color: var(--dim); }
.foot { margin-top: 0.667rem; padding-top: 0.533rem; border-top: 1px solid var(--line); }
</style>
