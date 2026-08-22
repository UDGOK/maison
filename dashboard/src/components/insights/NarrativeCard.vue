<script setup lang="ts">
import { computed } from 'vue'
import type { InsightReport } from '../../insights/types'

const props = defineProps<{ report: InsightReport | null; loading?: boolean }>()
const paragraphs = computed(() => (props.report?.narrative || '').split(/\n\n+/).filter(Boolean))
const change = computed(() => props.report?.change_pct ?? null)
</script>

<template>
  <section class="card narrative">
    <header class="head">
      <span class="label">Weekly narrative</span>
      <span v-if="report" class="label meta">
        {{ report.title }} · {{ report.generator === 'Anthropic' ? `Claude · ${report.model}` : 'Template' }}
      </span>
    </header>
    <div v-if="report" class="body">
      <div class="strip">
        <span class="display big num">{{ Math.round(report.net).toLocaleString('en-US') }}</span>
        <span class="strip-meta">
          <span class="label">Net · {{ report.invoices }} tickets</span>
          <span v-if="change !== null" class="delta num" :class="change >= 0 ? 'up' : 'down'">{{ change >= 0 ? '▲' : '▼' }} {{ Math.abs(change).toFixed(0) }}% vs previous week</span>
        </span>
      </div>
      <p v-for="(p, i) in paragraphs" :key="i" class="para" :class="{ lead: i === 0 }">{{ p }}</p>
      <div v-if="report.error" class="label err">{{ report.error }}</div>
    </div>
    <div v-else-if="loading" class="label empty">Composing…</div>
    <div v-else class="label empty">No report yet — the weekly job runs Monday 06:00</div>
  </section>
</template>

<style scoped>
.card { display: flex; flex-direction: column; border: 1px solid var(--line); background: var(--surface); min-width: 0; }
.head { display: flex; justify-content: space-between; align-items: baseline; padding: 16px 22px 12px; border-bottom: 1px solid var(--line); }
.meta { color: var(--muted); letter-spacing: 0.12em; text-transform: none; }
.body { padding: 18px 22px 22px; display: flex; flex-direction: column; gap: 8px; }
.strip { display: flex; align-items: baseline; gap: 20px; margin-bottom: 6px; }
.big { font-size: 44px; font-weight: 800; color: var(--accent); line-height: 1; }
.strip-meta { display: flex; flex-direction: column; gap: 4px; }
.delta { font-size: 13px; letter-spacing: 0.08em; }
.delta.up { color: var(--good); }
.delta.down { color: var(--crit); }
.para { margin: 0; font-size: 15px; font-weight: 300; line-height: 1.55; color: var(--muted); max-width: 78ch; }
.para.lead { color: var(--text); font-weight: 400; font-size: 16px; }
.empty { padding: 28px 22px; color: var(--dim); }
.err { color: var(--dim); text-transform: none; letter-spacing: 0.05em; margin-top: 6px; }
</style>
