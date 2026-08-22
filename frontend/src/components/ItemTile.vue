<script setup lang="ts">
import { computed } from 'vue'
import type { Item } from '@/api'
import { fmtMoney } from '@/utils/money'

const props = defineProps<{ item: Item; rate: number; serials: string[]; stock: number; currency: string; override?: boolean }>()
const emit = defineEmits<{ pick: [] }>()

const nonStock = computed(() => !props.item.has_serial_no && props.item.is_stock_item === 0)
const available = computed(() => (props.item.has_serial_no ? props.serials.length : nonStock.value ? Infinity : props.stock))
const sub = computed(() => {
  if (nonStock.value) return 'Service'
  if (props.item.has_serial_no) {
    const n = props.serials.length
    return n === 0 ? 'No units' : n === 1 ? `Serial ${props.serials[0]}` : `${n} serials`
  }
  return props.stock > 0 ? `Qty ${props.stock}` : 'Out of stock'
})
const meta = computed(() => [props.item.maison_metal, props.item.maison_carat ? props.item.maison_carat + ' ct' : ''].filter(Boolean).join(' / '))
</script>

<template>
  <button class="tile" :class="{ empty: available <= 0 }" :disabled="available <= 0" @click="emit('pick')">
    <div class="tile-top">
      <div class="name display">{{ item.item_name }}</div>
      <div class="meta ellipsis">{{ meta || item.item_group }}</div>
    </div>
    <div class="tile-bottom">
      <div class="sub" :class="{ serial: item.has_serial_no, low: !item.has_serial_no && stock <= 2 && stock > 0 }">{{ sub }}</div>
      <div class="price num">
        {{ fmtMoney(rate, currency) }}
        <span v-if="override" class="ovr" title="Boutique price">*</span>
      </div>
    </div>
  </button>
</template>

<style scoped>
.tile {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  text-align: left;
  min-height: 132px;
  padding: 14px 14px 12px;
  background: var(--surface);
  border: var(--line-w) solid var(--line);
  color: var(--text);
  transition:
    border-color var(--t-fast),
    background var(--t-fast);
}
.tile:hover {
  border-color: var(--muted);
}
.tile:active {
  background: var(--surface-2);
}
.tile.empty {
  opacity: 0.35;
}
.tile-top {
  min-width: 0;
}
.name {
  font-size: 15px;
  line-height: 1.15;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  word-break: break-word;
}
.meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--dim);
}
.tile-bottom {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 8px;
  margin-top: 12px;
}
.sub {
  font-size: 11px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub.serial {
  color: var(--good);
}
.sub.low {
  color: var(--warn);
}
.price {
  font-size: 15px;
  white-space: nowrap;
  flex-shrink: 0;
}
.ovr {
  color: var(--warn);
}
</style>
