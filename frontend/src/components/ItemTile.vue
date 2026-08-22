<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Item } from '@/api'
import { fmtMoney } from '@/utils/money'

const props = defineProps<{
  item: Item
  rate: number
  serials: string[]
  stock: number
  currency: string
  override?: boolean
  /** v0.2 — render the photo block above name/price */
  showImage?: boolean
  /** v0.2 — manager: long-press / edit button opens the photo sheet */
  editable?: boolean
}>()
const emit = defineEmits<{ pick: []; edit: [] }>()

const nonStock = computed(() => !props.item.has_serial_no && props.item.is_stock_item === 0)
const available = computed(() => (props.item.has_serial_no ? props.serials.length : nonStock.value ? Infinity : props.stock))
const sub = computed(() => {
  if (nonStock.value) return 'Service'
  if (props.item.has_serial_no) {
    const n = props.serials.length
    return n === 0 ? 'No units' : n === 1 ? (props.showImage ? '1 serial' : `Serial ${props.serials[0]}`) : `${n} serials`
  }
  return props.stock > 0 ? `Qty ${props.stock}` : 'Out of stock'
})
const meta = computed(() => [props.item.maison_metal, props.item.maison_carat ? props.item.maison_carat + ' ct' : ''].filter(Boolean).join(' / '))
const imgFailed = ref(false)
const hasImage = computed(() => props.showImage && !!props.item.image && !imgFailed.value)

// long-press (600 ms) → edit, for managers on touch devices
let timer: number | undefined
let longFired = false
function down() {
  if (!props.editable) return
  longFired = false
  timer = window.setTimeout(() => {
    longFired = true
    emit('edit')
  }, 600)
}
function up() {
  clearTimeout(timer)
}
function click() {
  if (longFired) {
    longFired = false
    return
  }
  emit('pick')
}
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="tile-wrap" :class="{ 'with-image': showImage }">
    <button
      class="tile"
      :class="{ empty: available <= 0, img: showImage }"
      :disabled="available <= 0"
      @click="click"
      @pointerdown="down"
      @pointerup="up"
      @pointercancel="up"
      @pointerleave="up"
      @contextmenu.prevent="editable && emit('edit')"
    >
      <div v-if="showImage" class="photo">
        <img v-if="hasImage" :src="item.image!" :alt="item.item_name" loading="lazy" decoding="async" @error="imgFailed = true" />
        <div v-else class="photo-empty">
          <span class="mono display">{{ item.item_name.slice(0, 1) }}</span>
        </div>
      </div>
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
    <button v-if="editable" class="edit label" title="Edit tile photo" aria-label="Edit tile photo" @click.stop="emit('edit')">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h3l2-2h6l2 2h3v12H4z" /><circle cx="12" cy="13" r="3.5" /></svg>
    </button>
  </div>
</template>

<style scoped>
.tile-wrap {
  position: relative;
  display: flex;
}
.tile {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  text-align: left;
  min-height: 132px;
  padding: 14px 14px 12px;
  background: var(--surface);
  border: var(--line-w) solid var(--line);
  color: var(--text);
  min-width: 0;
  transition:
    border-color var(--t-fast),
    background var(--t-fast);
}
.tile.img {
  padding: 0 0 12px;
}
.tile.img .tile-top,
.tile.img .tile-bottom {
  padding: 0 12px;
}
.tile.img .tile-top {
  margin-top: 10px;
}
.tile:hover {
  border-color: var(--accent-deep);
}
.tile:active {
  background: var(--surface-2);
}
.tile.empty {
  opacity: 0.35;
}
.photo {
  aspect-ratio: 4 / 3;
  width: 100%;
  background: var(--ground);
  border-bottom: var(--line-w) solid var(--line);
  overflow: hidden;
}
.photo img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.photo-empty {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, var(--surface-2), var(--ground));
}
.mono {
  font-size: 34px;
  color: var(--line-strong);
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
.tile.img .name {
  font-size: 13px;
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
  color: var(--accent);
}
.tile.img .price {
  font-size: 14px;
}
.ovr {
  color: var(--warn);
}
@media (max-width: 767px) {
  .tile-bottom {
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    margin-top: 8px;
  }
  .tile.img .name {
    font-size: 12px;
  }
}
.edit {
  position: absolute;
  top: 0;
  right: 0;
  min-width: 36px;
  min-height: 36px;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--dim);
  background: rgba(11, 11, 10, 0.55);
  border-left: var(--line-w) solid var(--line);
  border-bottom: var(--line-w) solid var(--line);
}
.edit svg {
  width: 16px;
  height: 16px;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.5;
}
.edit:hover {
  color: var(--accent);
}
</style>
