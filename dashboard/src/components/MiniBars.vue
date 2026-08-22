<script setup lang="ts">
/** Hourly bars for one boutique (24 net buckets → the trading window), gold fills, current hour emphasised. */
import { computed } from 'vue'
import { fmtCompact, fmtHour } from '../lib/format'

const props = withDefaults(defineProps<{ values: number[]; from?: number; to?: number; currentHour?: number; height?: number }>(), { from: 9, to: 21, currentHour: -1, height: 120 })
const W = 480
const H = computed(() => props.height)
const slice = computed(() => Array.from({ length: props.to - props.from + 1 }, (_, i) => ({ hour: props.from + i, net: props.values[props.from + i] ?? 0 })))
const max = computed(() => Math.max(...slice.value.map((s) => s.net), 1))
const slot = computed(() => W / slice.value.length)
const bars = computed(() =>
  slice.value.map((s, i) => {
    const h = (Math.max(0, s.net) / max.value) * (H.value - 22)
    return { ...s, x: i * slot.value + slot.value * 0.18, w: slot.value * 0.64, y: H.value - 18 - h, h, current: s.hour === props.currentHour }
  }),
)
const peak = computed(() => slice.value.reduce((a, b) => (b.net > a.net ? b : a), slice.value[0]!))
</script>

<template>
  <svg :viewBox="`0 0 ${W} ${H}`" class="mini" preserveAspectRatio="none" role="img" aria-label="Net by hour">
    <line :x1="0" :x2="W" :y1="H - 18" :y2="H - 18" class="axis" />
    <g v-for="b in bars" :key="b.hour">
      <rect :x="b.x" :y="b.y" :width="b.w" :height="Math.max(b.h, b.net > 0 ? 1.5 : 0)" class="bar" :class="{ current: b.current, peak: b.hour === peak.hour && b.net > 0 }" />
      <text v-if="b.hour % 3 === 0" :x="b.x + b.w / 2" :y="H - 5" class="lbl" text-anchor="middle">{{ fmtHour(b.hour).slice(0, 2) }}</text>
      <text v-if="b.hour === peak.hour && b.net > 0" :x="b.x + b.w / 2" :y="b.y - 4" class="val" text-anchor="middle">{{ fmtCompact(b.net) }}</text>
    </g>
  </svg>
</template>

<style scoped>
.mini { width: 100%; height: 100%; display: block; }
.axis { stroke: var(--line); stroke-width: 1; vector-effect: non-scaling-stroke; }
.bar { fill: var(--accent-deep); }
.bar.current { fill: var(--accent); }
.bar.peak { fill: var(--accent); }
.lbl { fill: var(--dim); font-family: var(--body); font-size: 10px; letter-spacing: 0.08em; }
.val { fill: var(--text); font-family: var(--body); font-size: 10px; letter-spacing: 0.04em; }
</style>
