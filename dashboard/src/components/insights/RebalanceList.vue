<script setup lang="ts">
import { ref } from 'vue'
import { fmtCompact, fmtInt } from '../../lib/format'
import { createTransfer, dismissSuggestion } from '../../insights/api'
import type { RebalanceMove } from '../../insights/types'
import { useBrand } from '../../stores/brand' // v0.6 D1

const brand = useBrand()

defineProps<{ moves: RebalanceMove[]; days: number }>()
const emit = defineEmits<{ changed: [] }>()
const busy = ref<string | null>(null)
const done = ref<Record<string, string>>({})
const error = ref<string | null>(null)

async function transfer(m: RebalanceMove) {
  if (!m.name) return
  busy.value = m.name
  error.value = null
  try {
    const r = await createTransfer(m.name)
    done.value = { ...done.value, [m.name]: r.stock_entry }
    emit('changed')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function dismiss(m: RebalanceMove) {
  if (!m.name) return
  busy.value = m.name
  try {
    await dismissSuggestion(m.name)
    emit('changed')
  } finally {
    busy.value = null
  }
}
function cover(d: number | null): string {
  return d === null ? 'no sales' : `${Math.round(d)} d cover`
}
</script>

<template>
  <section class="card">
    <header class="head">
      <span class="label">Rebalance suggestions</span>
      <span class="label meta">{{ moves.length }} open · velocity over {{ days }} days</span>
    </header>
    <div class="list">
      <div v-for="m in moves" :key="m.name ?? m.item_code + m.from_boutique" class="row" :class="{ busy: busy === m.name }">
        <span class="item">
          <span class="nm ellipsis">{{ m.item_name }}</span>
          <span class="label code">{{ m.item_code }} · {{ fmtInt(m.qty) }} unit{{ m.qty === 1 ? '' : 's' }} · {{ fmtCompact(m.value) }} at retail</span>
        </span>
        <span class="move">
          <span class="store">
            <span class="display b">{{ m.from_boutique }}</span>
            <span class="label s">{{ fmtInt(m.from_on_hand) }} on hand · {{ m.from_velocity.toFixed(2) }}/wk<br />{{ cover(m.from_days_on_hand) }}</span>
          </span>
          <span class="arrow display">→ {{ fmtInt(m.qty) }} →</span>
          <span class="store">
            <span class="display b">{{ m.to_boutique }}</span>
            <span class="label s">{{ fmtInt(m.to_on_hand) }} on hand · {{ m.to_velocity.toFixed(2) }}/wk<br />{{ cover(m.to_days_on_hand) }}</span>
          </span>
        </span>
        <span class="acts">
          <template v-if="m.name && done[m.name]">
            <span class="label ok">{{ done[m.name] }}</span>
          </template>
          <template v-else>
            <button class="act" :disabled="busy === m.name || m.can_transfer === false" :title="m.can_transfer === false ? `Managers of the ${brand.storesLower} involved (or Head Office) only` : 'Submit a Material Transfer'" @click="transfer(m)">
              {{ busy === m.name ? '…' : 'Create transfer' }}
            </button>
            <button class="act ghost" :disabled="busy === m.name || m.can_transfer === false" title="Dismiss" @click="dismiss(m)">×</button>
          </template>
        </span>
      </div>
      <div v-if="!moves.length" class="label empty">Stock is where it sells — nothing to move</div>
      <div v-if="error" class="label err">{{ error }}</div>
    </div>
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--line); background: var(--surface); min-width: 0; display: flex; flex-direction: column; }
.head { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 22px 12px; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); letter-spacing: 0.12em; text-transform: none; }
.list { display: flex; flex-direction: column; padding: 6px 22px 16px; }
.row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.5fr) auto; gap: 16px; align-items: center; padding: 12px 0; border-bottom: 1px solid var(--line); }
.row.busy { opacity: 0.5; }
.item { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.nm { font-size: 15px; }
.code { text-transform: none; letter-spacing: 0.08em; color: var(--dim); font-size: 11px; }
.move { display: grid; grid-template-columns: 1fr auto 1fr; gap: 12px; align-items: center; min-width: 0; }
.store { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.b { font-size: 13px; font-weight: 800; letter-spacing: 0.04em; }
.s { text-transform: none; letter-spacing: 0.06em; color: var(--dim); font-size: 11px; line-height: 1.4; }
.arrow { color: var(--accent); font-size: 13px; letter-spacing: 0.08em; white-space: nowrap; }
.acts { display: flex; gap: 6px; align-items: center; }
.act { height: 34px; padding: 0 14px; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-on-accent); background: var(--accent); border: 1px solid var(--accent); cursor: pointer; white-space: nowrap; }
.act.ghost { color: var(--dim); background: transparent; border-color: var(--line); font-size: 16px; letter-spacing: 0; width: 34px; padding: 0; }
.act:disabled { opacity: 0.45; cursor: default; }
.ok { color: var(--good); text-transform: none; letter-spacing: 0.08em; }
.empty { padding: 20px 0; color: var(--dim); }
.err { color: var(--crit); text-transform: none; letter-spacing: 0.05em; padding-top: 10px; }
</style>
