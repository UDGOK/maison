<script setup lang="ts">
/** Compact chain-wide ticker: the latest 10 sales, newest first, one line each. */
import { fmtMoney, fmtTime } from '../../lib/format'
import type { SaleEvent } from '../../types'

defineProps<{ items: SaleEvent[] }>()
</script>

<template>
  <div class="ticker" data-testid="ticker">
    <span class="label head">Latest · chain</span>
    <TransitionGroup name="tk" tag="ol" class="list">
      <li v-for="s in items" :key="s.invoice + (s.net < 0 ? 'r' : '')" class="tk" :class="{ ret: s.is_return || s.net < 0 }" :data-invoice="s.invoice">
        <span class="num t">{{ fmtTime(s.posting_datetime) }}</span>
        <span class="display code">{{ s.boutique }}</span>
        <span class="item">{{ s.top_item ?? s.items[0] ?? '—' }}</span>
        <span class="tier" :class="(s.tier ?? '').toLowerCase().replace(/\s+/g, '-')">{{ s.tier ?? '' }}</span>
        <span class="display num amt">{{ fmtMoney(s.net) }}</span>
      </li>
    </TransitionGroup>
    <span v-if="!items.length" class="label empty">Waiting for the first sale…</span>
  </div>
</template>

<style scoped>
.ticker { display: grid; grid-template-columns: auto 1fr; align-items: center; gap: 1.2rem; height: 2.8rem; padding: 0 var(--pad-x); border-bottom: 1px solid var(--line); background: var(--surface); overflow: hidden; }
.head { white-space: nowrap; }
.list { list-style: none; display: flex; gap: 0; overflow: hidden; position: relative; min-width: 0;
  mask-image: linear-gradient(to right, #000 92%, transparent 100%); -webkit-mask-image: linear-gradient(to right, #000 92%, transparent 100%); }
.tk { display: inline-flex; align-items: baseline; gap: 0.6rem; padding: 0 1.2rem; border-left: 1px solid var(--line); white-space: nowrap; font-size: var(--fs-small); }
.tk:first-child { border-left: 0; padding-left: 0; }
.t { color: var(--dim); letter-spacing: 0.04em; }
.code { font-size: var(--fs-label); font-weight: 800; letter-spacing: 0.04em; }
.item { color: var(--muted); font-weight: 300; max-width: 16rem; overflow: hidden; text-overflow: ellipsis; }
.tier { font-size: var(--fs-label); letter-spacing: 0.18em; text-transform: uppercase; color: var(--dim); }
.tier.patron, .tier.connoisseur, .tier.collector { color: var(--accent); }
.amt { font-size: var(--fs-num); font-weight: 800; letter-spacing: -0.02em; }
.tk.ret .amt { color: var(--crit); }
.empty { color: var(--dim); }
.tk-enter-active { animation: feedin 0.35s ease-out; }
.tk-move { transition: transform 0.35s ease; }
.tk-leave-active { position: absolute; opacity: 0; }
</style>
