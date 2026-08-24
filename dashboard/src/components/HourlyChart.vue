<script setup lang="ts">
import { computed } from 'vue'
import { fmtCompact, fmtHour, fmtMoney } from '../lib/format'
import { hourWindow, peakHour, visibleHours } from '../lib/hourly'
import type { HourBucket } from '../types'

/**
 * v0.8 QA D-1 — `from` / `to` are overrides, not defaults: left unset the window follows the
 * data (see `lib/hourly.ts`). The hard-coded 09:00–21:00 hid 86 % of a real trading day and
 * named the wrong peak hour.
 */
const props = defineProps<{ hours: HourBucket[]; currentHour: number; from?: number; to?: number }>()

const W = 1000
const H = 300
const PAD = { l: 56, r: 12, t: 18, b: 30 }

const range = computed(() => hourWindow(props.hours, props.currentHour, props.from, props.to))
const visible = computed(() => visibleHours(props.hours, range.value))

function niceMax(v: number): number {
  if (v <= 0) return 1000
  const p = Math.pow(10, Math.floor(Math.log10(v)))
  const m = v / p
  const n = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10
  return n * p
}

const maxNet = computed(() => niceMax(Math.max(...visible.value.map((h) => h.net), 0) * 1.08))
const plotW = W - PAD.l - PAD.r
const plotH = H - PAD.t - PAD.b
const slot = computed(() => plotW / visible.value.length)
const barW = computed(() => slot.value * 0.62)

const bars = computed(() =>
  visible.value.map((h, i) => {
    const bh = (h.net / maxNet.value) * plotH
    return {
      ...h,
      x: PAD.l + i * slot.value + (slot.value - barW.value) / 2,
      y: PAD.t + plotH - bh,
      h: bh,
      cx: PAD.l + i * slot.value + slot.value / 2,
      current: h.hour === props.currentHour,
      future: h.hour > props.currentHour,
    }
  }),
)

const ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((k) => ({ v: maxNet.value * k, y: PAD.t + plotH - k * plotH })))

/** over every bucket, not the drawn slice — the label can never disagree with the bars */
const peak = computed(() => peakHour(props.hours))
</script>

<template>
  <section class="chart">
    <header class="head">
      <span class="label">Net sales by hour</span>
      <span class="meta">
        <span class="label">Peak</span>
        <span class="num peak" data-testid="hourly-peak">{{ peak ? `${fmtHour(peak.hour)} · ${fmtMoney(peak.net)}` : '—' }}</span>
      </span>
    </header>
    <div class="plot">
    <svg :viewBox="`0 0 ${W} ${H}`" preserveAspectRatio="none" class="svg" role="img" aria-label="Net sales by hour">
      <g v-for="t in ticks" :key="t.v">
        <line :x1="PAD.l" :x2="W - PAD.r" :y1="t.y" :y2="t.y" class="grid" />
      </g>
      <g v-for="b in bars" :key="b.hour">
        <rect v-if="b.current" :x="b.x - (slot - barW) / 2" :y="PAD.t" :width="slot" :height="plotH" class="hl" />
        <rect :x="b.x" :y="b.y" :width="barW" :height="Math.max(b.h, b.net > 0 ? 1.5 : 0)" class="bar" :class="{ current: b.current, future: b.future }" />
      </g>
      <line :x1="PAD.l" :x2="W - PAD.r" :y1="PAD.t + plotH" :y2="PAD.t + plotH" class="axis" />
    </svg>
    <div class="ylabels" aria-hidden="true">
      <span v-for="t in ticks" :key="t.v" class="num" :style="{ top: `${(t.y / H) * 100}%` }">{{ fmtCompact(t.v) }}</span>
    </div>
    <div class="xlabels" aria-hidden="true">
      <span v-for="b in bars" :key="b.hour" class="num" :class="{ current: b.current }" :style="{ left: `${(b.cx / W) * 100}%` }">{{ fmtHour(b.hour) }}</span>
    </div>
    </div>
  </section>
</template>

<style scoped>
.chart {
  display: grid;
  grid-template-rows: auto 1fr;
  padding: 1.333rem var(--pad-x) 1.867rem;
  border-bottom: 1px solid var(--line);
  min-height: 0;
}
.head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 10px; }
.meta { display: inline-flex; gap: 12px; align-items: baseline; }
.peak { color: var(--muted); font-size: var(--fs-small); }
.plot { position: relative; min-height: 0; }
.svg { width: 100%; height: 100%; display: block; min-height: 0; }
.grid { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.axis { stroke: var(--dim); stroke-width: 1; vector-effect: non-scaling-stroke; }
.bar { fill: var(--accent-deep); transition: y 0.4s ease, height 0.4s ease; }
.bar.future { fill: var(--line); }
.bar.current { fill: var(--accent); }
.hl { fill: var(--accent-soft); }
.ylabels { position: absolute; left: 0; top: 0; bottom: 0; width: 3.2rem; pointer-events: none; }
.ylabels span {
  position: absolute;
  right: 0;
  transform: translateY(-50%);
  font-size: var(--fs-label);
  color: var(--dim);
  letter-spacing: 0.06em;
}
.xlabels { position: absolute; left: 0; right: 0; bottom: -20px; height: 16px; pointer-events: none; }
.xlabels span {
  position: absolute;
  transform: translateX(-50%);
  font-size: var(--fs-label);
  color: var(--dim);
  letter-spacing: 0.08em;
}
.xlabels span.current { color: var(--text); }
</style>
