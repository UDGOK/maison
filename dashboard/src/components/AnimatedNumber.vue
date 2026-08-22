<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{ value: number; format?: (n: number) => string; duration?: number }>(),
  { format: (n: number) => String(Math.round(n)), duration: 400 },
)

const shown = ref(props.value)
let raf = 0
const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

watch(
  () => props.value,
  (to, from) => {
    cancelAnimationFrame(raf)
    if (reduced || !Number.isFinite(from)) {
      shown.value = to
      return
    }
    const start = performance.now()
    const step = (t: number) => {
      const k = Math.min(1, (t - start) / props.duration)
      const e = 1 - Math.pow(1 - k, 3)
      shown.value = from + (to - from) * e
      if (k < 1) raf = requestAnimationFrame(step)
      else shown.value = to
    }
    raf = requestAnimationFrame(step)
  },
)
onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>

<template>
  <span class="num">{{ format(shown) }}</span>
</template>
