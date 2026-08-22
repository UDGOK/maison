<script setup lang="ts">
import { ref } from 'vue'
import { fmtCompact } from '../../lib/format'
import { markSignal } from '../../insights/api'
import type { ClientSignal } from '../../insights/types'

const props = defineProps<{ signals: ClientSignal[]; week: string; byType: Record<string, number> }>()
const emit = defineEmits<{ done: [name: string] }>()
const busy = ref<string | null>(null)

const TONE: Record<string, string> = {
  'VIP lapsing': 'crit',
  'Overdue visit': 'warn',
  'Spend drop': 'warn',
  Birthday: 'gold',
  Anniversary: 'gold',
  'Due this week': 'good',
  'New client follow-up': 'good',
}

async function mark(s: ClientSignal, status: 'Contacted' | 'Dismissed') {
  busy.value = s.name
  try {
    await markSignal(s.name, status)
    emit('done', s.name)
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <section class="card">
    <header class="head">
      <span class="label">Clients to contact this week</span>
      <span class="label meta">{{ week }} · {{ props.signals.length }} open</span>
    </header>
    <div class="chips">
      <span v-for="(n, t) in byType" :key="t" class="chip" :class="TONE[t]"><b class="num">{{ n }}</b> {{ t }}</span>
    </div>
    <div class="list">
      <div v-for="s in signals" :key="s.name" class="row" :class="{ busy: busy === s.name }">
        <span class="prio num" :class="TONE[s.signal_type]">{{ Math.round(s.priority) }}</span>
        <span class="who">
          <span class="nm">{{ s.customer_name }} <span class="label inline">{{ s.boutique || '—' }}</span></span>
          <span class="why">{{ s.reason }}</span>
          <span class="label facts">
            {{ s.visits }} visit{{ s.visits === 1 ? '' : 's' }} · {{ fmtCompact(s.lifetime_spend) }} lifetime
            <template v-if="s.preferred_department"> · {{ s.preferred_department }}</template>
            <template v-if="s.preferred_metal"> · {{ s.preferred_metal }}</template>
            <template v-if="s.recommended_item_name"> · <span class="accent">Offer: {{ s.recommended_item_name }}</span></template>
          </span>
        </span>
        <span class="kind" :class="TONE[s.signal_type]">{{ s.signal_type }}</span>
        <span class="acts">
          <button class="act" :disabled="busy === s.name" title="Mark contacted" @click="mark(s, 'Contacted')">Done</button>
          <button class="act ghost" :disabled="busy === s.name" title="Dismiss" @click="mark(s, 'Dismissed')">×</button>
        </span>
      </div>
      <div v-if="!signals.length" class="label empty">No one is flagged — the weekly job runs Monday 05:00</div>
    </div>
  </section>
</template>

<style scoped>
.card { border: 1px solid var(--line); background: var(--surface); min-width: 0; display: flex; flex-direction: column; }
.head { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 22px 12px; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); letter-spacing: 0.12em; text-transform: none; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; padding: 12px 22px 4px; }
.chip { font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--muted); border: 1px solid var(--line); padding: 4px 10px; }
.chip b { color: var(--text); font-weight: 500; margin-right: 4px; }
.chip.crit { border-color: rgba(196, 115, 106, 0.5); }
.chip.gold { border-color: var(--accent-deep); }
.list { display: flex; flex-direction: column; padding: 8px 22px 16px; max-height: 760px; overflow-y: auto; }
.row { display: grid; grid-template-columns: 44px minmax(0, 1fr) 120px auto; gap: 14px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); }
.row.busy { opacity: 0.5; }
.prio { font-family: var(--display); font-weight: 800; font-size: 18px; color: var(--muted); }
.prio.crit { color: var(--crit); }
.prio.warn { color: var(--warn); }
.prio.gold { color: var(--accent); }
.prio.good { color: var(--good); }
.who { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
.nm { font-size: 15px; }
.inline { margin-left: 8px; color: var(--dim); }
.why { font-size: 13px; color: var(--muted); font-weight: 300; }
.facts { text-transform: none; letter-spacing: 0.06em; color: var(--dim); font-size: 11px; }
.accent { color: var(--accent); }
.kind { font-size: 11px; letter-spacing: 0.14em; text-transform: uppercase; color: var(--muted); }
.kind.crit { color: var(--crit); }
.kind.warn { color: var(--warn); }
.kind.gold { color: var(--accent); }
.kind.good { color: var(--good); }
.acts { display: flex; gap: 6px; }
.act { height: 32px; padding: 0 12px; font-size: 11px; letter-spacing: 0.18em; text-transform: uppercase; color: var(--ink-on-accent); background: var(--accent); border: 1px solid var(--accent); cursor: pointer; }
.act.ghost { color: var(--dim); background: transparent; border-color: var(--line); font-size: 16px; letter-spacing: 0; width: 32px; padding: 0; }
.act:disabled { opacity: 0.5; cursor: default; }
.empty { padding: 20px 0; color: var(--dim); }
</style>
