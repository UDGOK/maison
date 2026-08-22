<script setup lang="ts">
/**
 * v0.5 K — on-screen ring sizer. Renders a circle whose inner diameter is the true size of a US ring
 * size, calibrated for the iPad's 132 CSS-px-per-inch panel (5.2 px/mm); the client lays a ring on the
 * glass and adjusts until the inner edge touches the band.
 */
import { computed } from 'vue'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [v: string] }>()

/** US size → inner diameter (mm), half sizes included. */
const US_SIZES: [string, number][] = [
  ['3', 14.1], ['3.5', 14.5], ['4', 14.9], ['4.5', 15.3], ['5', 15.7], ['5.5', 16.1], ['6', 16.5], ['6.5', 16.9], ['7', 17.3], ['7.5', 17.7],
  ['8', 18.1], ['8.5', 18.5], ['9', 18.9], ['9.5', 19.4], ['10', 19.8], ['10.5', 20.2], ['11', 20.6], ['11.5', 21.0], ['12', 21.4], ['12.5', 21.8], ['13', 22.2]
]
const PX_PER_MM = 132 / 25.4
const idx = computed(() => Math.max(0, US_SIZES.findIndex(([s]) => s === props.modelValue)))
const size = computed(() => US_SIZES[idx.value] || US_SIZES[7])
const px = computed(() => size.value[1] * PX_PER_MM)
function step(d: number) {
  const i = Math.min(US_SIZES.length - 1, Math.max(0, idx.value + d))
  emit('update:modelValue', US_SIZES[i][0])
}
</script>

<template>
  <div class="sizer" data-testid="ring-sizer">
    <div class="plate">
      <div class="circle" :style="{ width: px + 'px', height: px + 'px' }"></div>
      <div class="tick h"></div>
      <div class="tick v"></div>
    </div>
    <div class="controls">
      <button class="s-key aux" type="button" aria-label="Smaller" @click="step(-1)">−</button>
      <div class="readout">
        <div class="s-num lg" data-testid="ring-size">{{ size[0] }}</div>
        <div class="s-eyebrow s-dim">US · {{ size[1].toFixed(1) }} mm</div>
      </div>
      <button class="s-key aux" type="button" aria-label="Larger" @click="step(1)">+</button>
    </div>
  </div>
</template>

<style scoped>
.sizer {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 18px;
}
.plate {
  position: relative;
  width: clamp(180px, 26vmin, 260px);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  border: 1px solid var(--s-line-soft);
  background: radial-gradient(circle at 50% 40%, rgba(201, 169, 110, 0.12), rgba(0, 0, 0, 0) 70%);
}
.circle {
  border-radius: 50%;
  border: 1.5px solid var(--s-gold-2);
  box-shadow:
    0 0 0 6px rgba(201, 169, 110, 0.08),
    inset 0 0 18px rgba(201, 169, 110, 0.25);
  transition:
    width 300ms var(--s-ease),
    height 300ms var(--s-ease);
}
.tick {
  position: absolute;
  background: var(--s-line);
}
.tick.h {
  width: 100%;
  height: 1px;
  opacity: 0.5;
}
.tick.v {
  height: 100%;
  width: 1px;
  opacity: 0.5;
}
.controls {
  display: flex;
  align-items: center;
  gap: 26px;
}
.controls .s-key {
  width: clamp(64px, 8vmin, 84px);
  font-size: clamp(22px, 3vmin, 34px);
  font-family: var(--font-display);
}
.readout {
  min-width: 150px;
  display: flex;
  flex-direction: column;
  align-items: center;
}
</style>
