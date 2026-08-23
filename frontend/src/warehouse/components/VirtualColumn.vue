<script setup lang="ts" generic="T extends { name: string }">
/**
 * v0.6 P — fixed-row-height virtual list for a wall column (100+ cards stay smooth on a 4K TV).
 * Only the rows inside the viewport (± overscan) are mounted; the spacer keeps the scrollbar honest.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = withDefaults(defineProps<{ items: T[]; itemHeight: number; gap?: number; overscan?: number }>(), { gap: 12, overscan: 3 })
const el = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const height = ref(0)
const rowH = computed(() => props.itemHeight + props.gap)
const start = computed(() => Math.max(0, Math.floor(scrollTop.value / rowH.value) - props.overscan))
const end = computed(() => Math.min(props.items.length, Math.ceil((scrollTop.value + height.value) / rowH.value) + props.overscan))
const visible = computed(() => props.items.slice(start.value, end.value).map((item, i) => ({ item, index: start.value + i })))
const total = computed(() => props.items.length * rowH.value)

let ro: ResizeObserver | null = null
function onScroll() {
  scrollTop.value = el.value?.scrollTop || 0
}
function measure() {
  height.value = el.value?.clientHeight || window.innerHeight
}
onMounted(() => {
  measure()
  if (typeof ResizeObserver !== 'undefined' && el.value) {
    ro = new ResizeObserver(measure)
    ro.observe(el.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())
defineExpose({ start, end })
</script>

<template>
  <div ref="el" class="vcol" :data-rendered="visible.length" :data-total="items.length" @scroll.passive="onScroll">
    <div class="spacer" :style="{ height: total + 'px' }">
      <div v-for="{ item, index } in visible" :key="item.name" class="vrow" :style="{ transform: `translateY(${index * rowH}px)`, height: itemHeight + 'px' }">
        <slot :item="item" :index="index" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.vcol {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  position: relative;
}
.spacer {
  position: relative;
  width: 100%;
}
.vrow {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
}
</style>
