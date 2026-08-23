<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useCatalogStore } from '@/stores/catalog'
import { useCartStore } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import { useScanStore } from '@/stores/scan'
import { useLayoutStore } from '@/stores/layout'
import type { Item } from '@/api'
import ItemTile from '@/components/ItemTile.vue'
import BasketPanel from '@/components/BasketPanel.vue'
import Modal from '@/components/Modal.vue'
import ImageSheet from '@/components/ImageSheet.vue'

const catalog = useCatalogStore()
const cart = useCartStore()
const session = useSessionStore()
const scan = useScanStore()
const layout = useLayoutStore()
const route = useRoute()

const group = ref<string | null>(null)
const department = ref<string | null>(null)
const q = ref('')
const serialPick = ref<Item | null>(null)
const editItem = ref<Item | null>(null)

const items = computed(() => catalog.search(q.value, group.value, department.value))
const overrideCodes = computed(() => new Set(catalog.pricing_rules.map((r) => r.item_code)))
const canEdit = computed(() => session.isManager)

onMounted(() => {
  const rq = route.query.q
  if (typeof rq === 'string' && rq) q.value = rq
  layout.syncSheet(cart.lines.length)
})
watch(
  () => route.query.q,
  (v) => {
    if (typeof v === 'string' && v) q.value = v
  }
)
watch(
  () => cart.lines.length,
  (n) => layout.syncSheet(n)
)

/**
 * v0.6 R — department chips: a horizontal scroller with no affordance clipped "Kratom" to "KR" at
 * 1366 px, which reads as a broken label rather than as more content. A fade on whichever side has
 * hidden chips (plus arrow buttons) makes the strip legibly scrollable, and no label is ever cut
 * without a visible cue.
 */
const chipsEl = ref<HTMLElement | null>(null)
const railEl = ref<HTMLElement | null>(null)
const chipsOverflowStart = ref(false)
const chipsOverflowEnd = ref(false)
const railOverflowStart = ref(false)
const railOverflowEnd = ref(false)
function edges(el: HTMLElement | null): [boolean, boolean] {
  if (!el) return [false, false]
  const max = el.scrollWidth - el.clientWidth
  return [el.scrollLeft > 2, max > 2 && el.scrollLeft < max - 2]
}
function measureChips() {
  ;[chipsOverflowStart.value, chipsOverflowEnd.value] = edges(chipsEl.value)
}
function measureRail() {
  ;[railOverflowStart.value, railOverflowEnd.value] = edges(railEl.value)
}
function measureAll() {
  measureChips()
  measureRail()
}
function scrollChips(dir: 1 | -1) {
  const el = chipsEl.value
  if (!el) return
  el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.7), behavior: 'smooth' })
}
let scrollerObserver: ResizeObserver | null = null
onMounted(async () => {
  await nextTick()
  measureAll()
  if (typeof ResizeObserver !== 'undefined') {
    scrollerObserver = new ResizeObserver(measureAll)
    if (chipsEl.value) scrollerObserver.observe(chipsEl.value)
    if (railEl.value) scrollerObserver.observe(railEl.value)
  }
})
onBeforeUnmount(() => scrollerObserver?.disconnect())
watch(
  () => [catalog.departments.length, catalog.item_groups.length, layout.phone],
  async () => {
    await nextTick()
    measureAll()
  }
)

function availableSerials(code: string) {
  return (catalog.serials[code] || []).filter((s) => !cart.usedSerials.has(s))
}

function pick(item: Item) {
  if (!item.has_serial_no) {
    cart.add(item)
    return
  }
  const free = availableSerials(item.item_code)
  if (free.length === 1) cart.add(item, free[0])
  else if (free.length > 1) serialPick.value = item
}

function pickSerial(sn: string) {
  if (serialPick.value) cart.add(serialPick.value, sn)
  serialPick.value = null
}

function toggleImages() {
  void catalog.setImagesOverride(!catalog.showImages)
}
</script>

<template>
  <div class="sell" :class="{ phone: layout.phone }">
    <!-- v0.6 R: on the phone the group rail is the same kind of horizontal scroller as the department
         chips — it gets the same fade so a half-visible group reads as "scroll", not as a cut label -->
    <nav ref="railEl" class="rail scroll" :class="{ 'rail-chips': layout.phone, 'fade-start': layout.phone && railOverflowStart, 'fade-end': layout.phone && railOverflowEnd }" @scroll="measureRail">
      <button class="rail-btn display" :class="{ active: group === null }" @click="group = null">All</button>
      <button v-for="g in catalog.item_groups" :key="g" class="rail-btn display" :class="{ active: group === g }" @click="group = g">
        {{ g }}
      </button>
      <div v-if="!layout.phone" class="rail-foot label label-dim">{{ catalog.items.length }} items</div>
    </nav>

    <section class="center">
      <div class="toolbar">
        <!-- v0.6 R: fade + arrows so a clipped chip reads as "scroll for more", never as a cut label -->
        <div class="chips-wrap" :class="{ 'fade-start': chipsOverflowStart, 'fade-end': chipsOverflowEnd }">
          <button v-if="chipsOverflowStart" class="chip-nav start label" aria-label="Scroll departments left" @click="scrollChips(-1)">&lsaquo;</button>
          <div ref="chipsEl" class="chips scroll-x" @scroll="measureChips">
            <button class="chip" :class="{ active: department === null }" @click="department = null">All depts</button>
            <button v-for="d in catalog.departments" :key="d" class="chip" :class="{ active: department === d }" @click="department = department === d ? null : d">
              {{ d }}
            </button>
          </div>
          <button v-if="chipsOverflowEnd" class="chip-nav end label" aria-label="Scroll departments right" @click="scrollChips(1)">&rsaquo;</button>
        </div>
        <div class="tools">
          <div class="search">
            <input v-model="q" class="input" type="search" placeholder="Search name, code or serial" autocomplete="off" />
            <button v-if="q" class="clear-q label" @click="q = ''">Clear</button>
          </div>
          <button class="icon-btn" :class="{ on: catalog.showImages }" :title="catalog.showImages ? 'Hide product photos' : 'Show product photos'" aria-label="Toggle product photos" @click="toggleImages">
            <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" /><path d="M3 16l5-5 4 4 3-3 6 5" /><circle cx="16" cy="9" r="1.5" /></svg>
          </button>
          <button v-if="catalog.settings.scan_enabled" class="icon-btn scan-btn" title="Scan barcode / QR" aria-label="Scan barcode or QR" @click="scan.openSheet('any')">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" />
              <path d="M7 8v8M10 8v8M13 8v8M17 8v8" />
            </svg>
          </button>
        </div>
      </div>
      <div class="grid-wrap scroll">
        <div v-if="!items.length" class="none label label-dim">No items match</div>
        <div class="grid" :class="{ 'grid-img': catalog.showImages }">
          <ItemTile
            v-for="it in items"
            :key="it.item_code"
            :item="it"
            :rate="catalog.rateFor(it.item_code)"
            :serials="availableSerials(it.item_code)"
            :stock="catalog.stock[it.item_code] ?? 0"
            :currency="session.currency"
            :override="overrideCodes.has(it.item_code)"
            :show-image="catalog.showImages"
            :editable="canEdit"
            @pick="pick(it)"
            @edit="editItem = it"
          />
        </div>
        <div v-if="layout.phone" class="sheet-spacer"></div>
      </div>
    </section>

    <BasketPanel />

    <Modal v-if="serialPick" :title="serialPick.item_name" width="520px" @close="serialPick = null">
      <div class="label" style="margin-bottom: 12px">Select serial number</div>
      <div class="serials">
        <button v-for="sn in availableSerials(serialPick.item_code)" :key="sn" class="serial-btn" @click="pickSerial(sn)">
          <span class="num-sn">{{ sn }}</span>
          <span v-if="serialPick.maison_certificate_no" class="dim">{{ serialPick.maison_certificate_no }}</span>
        </button>
      </div>
    </Modal>

    <ImageSheet v-if="editItem" :item="editItem" @close="editItem = null" />
  </div>
</template>

<style scoped>
.sell {
  flex: 1;
  min-height: 0;
  display: flex;
}
.rail {
  width: var(--rail-w);
  flex: 0 0 var(--rail-w);
  display: flex;
  flex-direction: column;
  border-right: var(--line-w) solid var(--line);
  background: var(--ground);
}
.rail-btn {
  text-align: left;
  padding: 0 18px;
  min-height: 56px;
  font-size: 13px;
  color: var(--muted);
  border-bottom: var(--line-w) solid var(--line);
  border-left: 3px solid transparent;
  line-height: 1.1;
}
.rail-btn:hover {
  color: var(--text);
}
.rail-btn.active {
  color: var(--accent);
  border-left-color: var(--accent);
  background: var(--surface);
}
.rail-foot {
  margin-top: auto;
  padding: 16px 18px;
}
.center {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 16px;
  border-bottom: var(--line-w) solid var(--line);
}
.chips-wrap {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}
.chips {
  display: flex;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
  scroll-snap-type: x proximity;
  scroll-padding-inline: 28px;
}
.chips::-webkit-scrollbar {
  display: none;
}
.chips > .chip {
  flex: 0 0 auto; /* never shrink: labels were overlapping in the scroll strip */
  scroll-snap-align: start;
}
/* the fade is a mask so the chips underneath keep their own colours */
.chips-wrap.fade-end .chips {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 44px), transparent 100%);
}
.chips-wrap.fade-start .chips {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 44px);
  mask-image: linear-gradient(to right, transparent 0, #000 44px);
}
.chips-wrap.fade-start.fade-end .chips {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 44px, #000 calc(100% - 44px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 44px, #000 calc(100% - 44px), transparent 100%);
}
.rail-chips.fade-end {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 40px), transparent 100%);
}
.rail-chips.fade-start {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 40px);
  mask-image: linear-gradient(to right, transparent 0, #000 40px);
}
.rail-chips.fade-start.fade-end {
  -webkit-mask-image: linear-gradient(to right, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%);
  mask-image: linear-gradient(to right, transparent 0, #000 40px, #000 calc(100% - 40px), transparent 100%);
}
.chip-nav {
  position: absolute;
  top: 0;
  bottom: 0;
  z-index: 2;
  width: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  line-height: 1;
  color: var(--accent);
  background: linear-gradient(to right, var(--ground) 55%, transparent);
}
.chip-nav.start {
  left: 0;
}
.chip-nav.end {
  right: 0;
  background: linear-gradient(to left, var(--ground) 55%, transparent);
}
.tools {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
.search {
  position: relative;
  width: 280px;
  flex: 0 0 280px;
}
.search .input {
  padding-right: 70px;
}
.clear-q {
  position: absolute;
  right: 0;
  top: 0;
  height: 100%;
  padding: 0 12px;
  min-width: 0;
}
.icon-btn.on {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.grid-wrap {
  flex: 1;
  min-height: 0;
  padding: 16px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(196px, 1fr));
  gap: 10px;
}
.grid-img {
  grid-template-columns: repeat(auto-fill, minmax(176px, 1fr));
}
.none {
  padding: 40px;
  text-align: center;
}
.serials {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.serial-btn {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
  padding: 12px 14px;
  border: var(--line-w) solid var(--line);
  background: var(--ground);
  color: var(--text);
  text-align: left;
}
.serial-btn:hover {
  border-color: var(--accent);
}
.num-sn {
  font-size: 14px;
}
.serial-btn .dim {
  font-size: 12px;
}

/* ---------- phone (portrait, ≤ 767 px) ---------- */
.sell.phone {
  flex-direction: column;
  position: relative;
}
.rail-chips {
  width: auto;
  flex: 0 0 auto;
  flex-direction: row;
  overflow-x: auto;
  overflow-y: hidden;
  border-right: 0;
  border-bottom: var(--line-w) solid var(--line);
  scrollbar-width: none;
  padding: 0 8px;
}
.rail-chips::-webkit-scrollbar {
  display: none;
}
.rail-chips .rail-btn {
  flex: 0 0 auto;
  min-height: 48px;
  padding: 0 12px;
  font-size: 12px;
  border-bottom: 2px solid transparent;
  border-left: 0;
  white-space: nowrap;
}
.rail-chips .rail-btn.active {
  background: transparent;
  border-bottom-color: var(--accent);
}
.phone .toolbar {
  flex-direction: column;
  align-items: stretch;
  gap: 10px;
  padding: 10px 12px;
}
.phone .tools {
  width: 100%;
}
.phone .search {
  flex: 1;
  width: auto;
}
.phone .grid-wrap {
  padding: 12px;
}
.phone .grid {
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
}
.phone .serials {
  grid-template-columns: 1fr;
}
.sheet-spacer {
  height: calc(72px + var(--safe-bottom));
}
</style>
