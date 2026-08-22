<script setup lang="ts">
/** 14-day sparkline: gold line, faint baseline, emphasised endpoint (dataviz discipline). */
import { computed } from 'vue'

const props = withDefaults(defineProps<{ values: number[]; width?: number; height?: number; fill?: boolean }>(), { width: 120, height: 28, fill: true })
const pts = computed(() => {
  const v = props.values.length ? props.values : [0]
  const max = Math.max(...v, 0)
  const min = Math.min(...v, 0)
  const span = max - min || 1
  const pad = 2
  const w = props.width - pad * 2
  const h = props.height - pad * 2
  return v.map((y, i) => ({ x: pad + (v.length > 1 ? (i / (v.length - 1)) * w : w / 2), y: pad + h - ((y - min) / span) * h }))
})
const path = computed(() => pts.value.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' '))
const area = computed(() => {
  const p = pts.value
  if (!p.length) return ''
  const base = props.height - 2
  return `${path.value} L${p[p.length - 1]!.x.toFixed(1)},${base} L${p[0]!.x.toFixed(1)},${base} Z`
})
const last = computed(() => pts.value[pts.value.length - 1]!)
const baseline = computed(() => {
  const v = props.values
  const max = Math.max(...v, 0)
  const min = Math.min(...v, 0)
  const span = max - min || 1
  return 2 + (props.height - 4) - ((0 - min) / span) * (props.height - 4)
})
</script>

<template>
  <svg :viewBox="`0 0 ${width} ${height}`" :width="width" :height="height" class="spark" role="img" aria-label="14-day net sales">
    <line :x1="0" :x2="width" :y1="baseline" :y2="baseline" class="base" />
    <path v-if="fill" :d="area" class="area" />
    <path :d="path" class="line" />
    <circle :cx="last.x" :cy="last.y" r="2.2" class="end" />
  </svg>
</template>

<style scoped>
.spark { display: block; overflow: visible; }
.base { stroke: var(--line); stroke-width: 1; }
.area { fill: var(--accent-soft); }
.line { fill: none; stroke: var(--accent-deep); stroke-width: 1.4; stroke-linejoin: round; }
.end { fill: var(--accent); }
</style>
