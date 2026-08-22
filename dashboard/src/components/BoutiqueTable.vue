<script setup lang="ts">
import StatusPill from './StatusPill.vue'
import { fmtInt, fmtMoney, fmtTime } from '../lib/format'
import type { BoutiqueRow } from '../types'

defineProps<{ rows: BoutiqueRow[]; flash: Record<string, number> }>()
</script>

<template>
  <section class="table">
    <header class="head">
      <span class="label">Boutiques</span>
      <span class="label">{{ rows.length }} · sorted by net</span>
    </header>
    <div class="grid">
      <div class="row hdr">
        <span class="label">#</span>
        <span class="label">Boutique</span>
        <span class="label r">Net</span>
        <span class="label r">Cash</span>
        <span class="label r">Card</span>
        <span class="label r">Inv.</span>
        <span class="label r">Last sale</span>
        <span class="label">Status</span>
      </div>
      <TransitionGroup name="rows">
        <div v-for="(r, i) in rows" :key="r.boutique" class="row" :class="{ flash: !!flash[r.boutique], offline: r.status === 'offline' }">
          <span class="num idx">{{ String(i + 1).padStart(2, '0') }}</span>
          <span class="name">
            <span class="display code">{{ r.boutique }}</span>
            <span class="city">{{ r.name }}</span>
          </span>
          <span class="num r net">{{ fmtMoney(r.net) }}</span>
          <span class="num r">{{ fmtMoney(r.cash) }}</span>
          <span class="num r">{{ fmtMoney(r.card) }}</span>
          <span class="num r">{{ fmtInt(r.invoices) }}</span>
          <span class="num r">{{ fmtTime(r.last_sale) }}</span>
          <span><StatusPill :status="r.status" :queued="r.queued" /></span>
        </div>
      </TransitionGroup>
    </div>
  </section>
</template>

<style scoped>
.table { display: grid; grid-template-rows: auto 1fr; min-height: 0; padding: 20px 32px 0; }
.head { display: flex; justify-content: space-between; margin-bottom: 10px; }
.grid { display: flex; flex-direction: column; min-height: 0; overflow: hidden; }
.row {
  display: grid;
  grid-template-columns: 28px minmax(0, 1.6fr) 1fr 0.8fr 0.8fr 0.5fr 0.7fr 236px;
  align-items: center;
  gap: 14px;
  height: 52px;
  border-bottom: 1px solid var(--line);
  font-size: 16px;
  transition: transform 0.5s ease;
}
.row.hdr { height: 32px; }
.row.flash { animation: rowflash 1.4s ease-out; }
.row.offline .net, .row.offline .name { color: var(--muted); }
.r { text-align: right; }
.idx { color: var(--dim); font-size: 12px; letter-spacing: 0.1em; }
.name { display: flex; align-items: baseline; gap: 14px; min-width: 0; }
.code { font-size: 13px; font-weight: 800; letter-spacing: 0.04em; white-space: nowrap; }
.label { white-space: nowrap; }
.city { color: var(--muted); font-weight: 300; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.net { font-weight: 500; font-size: 17px; }
.rows-move { transition: transform 0.5s ease; }
@media (max-width: 1500px) {
  .row { font-size: 14px; height: 48px; }
  .net { font-size: 15px; }
  .code { font-size: 12px; }
  .name { gap: 10px; }
  .row { grid-template-columns: 28px minmax(0, 1.6fr) 1fr 0.8fr 0.8fr 0.5fr 0.7fr 200px; }
  .row :deep(.pill) { letter-spacing: 0.1em; padding: 0 8px; }
}
</style>
