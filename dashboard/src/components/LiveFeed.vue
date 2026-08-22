<script setup lang="ts">
import { fmtMoney, fmtTime } from '../lib/format'
import type { SaleEvent } from '../types'

defineProps<{ feed: SaleEvent[] }>()
</script>

<template>
  <aside class="feed">
    <header class="head">
      <span class="label">Live feed</span>
      <span class="label">Last {{ feed.length }}</span>
    </header>
    <TransitionGroup name="feed" tag="ol" class="list">
      <li v-for="s in feed" :key="s.invoice" class="item">
        <div class="line1">
          <span class="num time">{{ fmtTime(s.posting_datetime) }}</span>
          <span class="display code">{{ s.boutique }}</span>
          <span class="tier" :class="(s.tier ?? '').toLowerCase()">{{ s.tier ?? s.customer_name ?? 'Guest' }}</span>
          <span class="display num amt">{{ fmtMoney(s.net) }}</span>
        </div>
        <div class="line2">
          <span class="items">{{ s.items.join(' · ') }}</span>
          <span class="pay num">{{ s.card >= s.net ? 'Card' : s.cash >= s.net ? 'Cash' : 'Split' }}</span>
        </div>
      </li>
    </TransitionGroup>
    <p v-if="!feed.length" class="empty label">Waiting for first sale…</p>
  </aside>
</template>

<style scoped>
.feed { display: grid; grid-template-rows: auto 1fr; min-height: 0; padding: 20px 32px; border-left: 1px solid var(--line); }
.head { display: flex; justify-content: space-between; margin-bottom: 10px; }
.list { list-style: none; display: flex; flex-direction: column; min-height: 0; overflow: hidden; position: relative;
  mask-image: linear-gradient(to bottom, #000 88%, transparent 100%); -webkit-mask-image: linear-gradient(to bottom, #000 88%, transparent 100%); }
.item { padding: 9px 0 10px; border-bottom: 1px solid var(--line); }
.line1 { display: grid; grid-template-columns: auto auto 1fr auto; align-items: baseline; gap: 14px; }
.time { color: var(--dim); font-size: 13px; letter-spacing: 0.04em; }
.code { font-size: 12px; font-weight: 800; letter-spacing: 0.04em; }
.tier { font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; color: var(--dim); }
.tier.gold, .tier.platinum { color: var(--warn); }
.tier.noir { color: var(--text); }
.amt { font-size: 18px; font-weight: 800; letter-spacing: -0.02em; }
.line2 { display: flex; justify-content: space-between; gap: 12px; margin-top: 3px; color: var(--muted); font-weight: 300; font-size: 14px; }
.items { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pay { color: var(--dim); font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; flex-shrink: 0; }
.empty { padding-top: 24px; }
.feed-enter-active { animation: feedin 0.35s ease-out; }
.feed-move { transition: transform 0.35s ease; }
.feed-leave-active { position: absolute; opacity: 0; }
</style>
