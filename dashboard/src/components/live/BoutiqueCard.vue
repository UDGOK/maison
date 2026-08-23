<script setup lang="ts">
/**
 * One live card per boutique: rank, code/name, net, vs same weekday last week, tickets, last sale
 * ("Sold · Perpetual 41 · $86,500 · 2 s ago"), status. Pulses gold on a sale.
 */
import { computed } from 'vue'
import StatusPill from '../StatusPill.vue'
import { deriveStatus } from '../../lib/aggregate'
import type { BoutiqueAgg } from '../../lib/aggregate'
import { fmtInt, fmtMoney, storeShortName } from '../../lib/format'
import { useBrand } from '../../stores/brand' // v0.6 R

const props = defineProps<{ row: BoutiqueAgg; index: number; now: number; flashing: boolean; selected: boolean }>()
defineEmits<{ select: [code: string] }>()

const status = computed(() => deriveStatus(props.row.last_seen, props.now, props.row.pending_approvals, props.row.queued))
const ago = computed(() => {
  const ls = props.row.last_sale
  if (!ls) return ''
  const s = Math.max(0, Math.round((props.now - Date.parse(ls.ts)) / 1000))
  if (s < 60) return `${s} s ago`
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  return new Date(ls.ts).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
})
const vs = computed(() => props.row.vs_last_week_pct)
// v0.6 R — drop the brand prefix: "CloudChaserz Montrose" → "Montrose" (the full name is the title)
const brand = useBrand()
const shortName = computed(() => storeShortName(props.row.name, brand.name))
</script>

<template>
  <div class="bcard" :class="{ flash: flashing, selected, offline: status === 'offline' }" :data-boutique="row.boutique" @click="$emit('select', row.boutique)">
    <span class="num idx">{{ String(index + 1).padStart(2, '0') }}</span>
    <span class="name">
      <span class="display code">{{ row.boutique }}</span>
      <span class="city" :title="row.name">{{ shortName }}</span>
    </span>
    <span class="num r net">{{ fmtMoney(row.net) }}</span>
    <span class="num r vs" :class="vs === null ? 'flat' : vs >= 0 ? 'up' : 'down'">{{ vs === null ? '—' : `${vs >= 0 ? '+' : '−'}${Math.abs(vs).toFixed(0)}%` }}</span>
    <span class="num r tickets">{{ fmtInt(row.invoices) }}</span>
    <span class="last" :class="{ ret: row.last_sale?.is_return }">
      <template v-if="row.last_sale">
        <span class="verb">{{ row.last_sale.is_return ? 'Return' : 'Sold' }}</span>
        <span class="dot">·</span>
        <span class="item">{{ row.last_sale.item ?? '—' }}</span>
        <span class="dot">·</span>
        <span class="num amt">{{ fmtMoney(row.last_sale.amount) }}</span>
        <span class="dot">·</span>
        <span class="num ago">{{ ago }}</span>
      </template>
      <span v-else class="verb flat">No sale yet</span>
    </span>
    <span class="st"><StatusPill :status="status" :queued="row.queued" /></span>
  </div>
</template>

<style scoped>
.bcard {
  display: grid;
  /* v0.6 R: the name column carries the only distinguishing text on the row — it gets the width
     the last-sale column was spending on an already-ellipsised item name. */
  grid-template-columns: 2rem minmax(0, 2fr) 1fr 0.6fr 0.5fr minmax(0, 2fr) 11rem;
  align-items: center;
  gap: 1rem;
  height: 100%;
  padding: 0 var(--pad-x);
  border-bottom: 1px solid var(--line);
  font-size: var(--fs-num);
  cursor: pointer;
  transition: background 0.2s;
}
.bcard:hover { background: var(--surface); }
.bcard.selected { background: var(--surface-2); box-shadow: inset 3px 0 0 var(--accent); }
.bcard.flash { animation: cardflash 1.4s ease-out; }
.bcard.offline .net, .bcard.offline .name { color: var(--muted); }
.idx { color: var(--dim); font-size: var(--fs-label); letter-spacing: 0.1em; }
.name { display: flex; align-items: baseline; gap: 0.8rem; min-width: 0; }
.code { font-size: var(--fs-small); font-weight: 800; letter-spacing: 0.04em; white-space: nowrap; }
.city { color: var(--muted); font-weight: 300; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.net { font-family: var(--display); font-weight: 800; font-size: var(--fs-lead); letter-spacing: -0.02em; }
.vs { font-size: var(--fs-small); }
.tickets { color: var(--muted); }
.last { display: flex; align-items: baseline; gap: 0.45rem; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: var(--fs-small); color: var(--muted); }
.last .verb { font-size: var(--fs-label); letter-spacing: 0.2em; text-transform: uppercase; color: var(--accent); }
.last.ret .verb { color: var(--crit); }
.last .item { color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.last .amt { color: var(--text); font-weight: 500; }
.last .ago { color: var(--dim); }
.dot { color: var(--dim); }
.st { justify-self: end; }
@media (max-width: 1600px) {
  .bcard { grid-template-columns: 1.6rem minmax(0, 1.9fr) 0.9fr 0.5fr 0.4fr minmax(0, 1.7fr) 9rem; gap: 0.7rem; }
}
</style>
