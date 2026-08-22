<script setup lang="ts" generic="T">
/**
 * v0.5 L — fixed-row-height virtualised list: renders only the rows inside the scroll viewport
 * (+ overscan). 100 boutiques → ~15 DOM rows. Row height is rem-based so it follows the type scale.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { virtualRange } from '../lib/virtual'

const props = withDefaults(defineProps<{ items: T[]; rowHeight: number; keyOf: (item: T) => string; overscan?: number }>(), { overscan: 4 })

const el = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewport = ref(600)
let ro: ResizeObserver | null = null

function onScroll() {
  scrollTop.value = el.value?.scrollTop ?? 0
}
onMounted(() => {
  viewport.value = el.value?.clientHeight ?? 600
  if (typeof ResizeObserver !== 'undefined' && el.value) {
    ro = new ResizeObserver(() => (viewport.value = el.value?.clientHeight ?? 600))
    ro.observe(el.value)
  }
})
onBeforeUnmount(() => ro?.disconnect())

const range = computed(() => virtualRange(props.items.length, props.rowHeight, scrollTop.value, viewport.value, props.overscan))
const slice = computed(() => props.items.slice(range.value.start, range.value.end).map((item, i) => ({ item, index: range.value.start + i })))
defineExpose({ range })
</script>

<template>
  <div ref="el" class="vlist" @scroll.passive="onScroll">
    <div class="spacer" :style="{ height: `${range.totalHeight}px` }">
      <div class="window" :style="{ transform: `translateY(${range.offsetTop}px)` }">
        <div v-for="{ item, index } in slice" :key="keyOf(item)" class="vrow" :style="{ height: `${rowHeight}px` }">
          <slot :item="item" :index="index" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.vlist { overflow-y: auto; overflow-x: hidden; min-height: 0; height: 100%; position: relative; }
.spacer { position: relative; width: 100%; }
.window { position: absolute; left: 0; right: 0; top: 0; will-change: transform; }
.vrow { overflow: hidden; }
</style>
