<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
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
    <nav class="rail scroll" :class="{ 'rail-chips': layout.phone }">
      <button class="rail-btn display" :class="{ active: group === null }" @click="group = null">All</button>
      <button v-for="g in catalog.item_groups" :key="g" class="rail-btn display" :class="{ active: group === g }" @click="group = g">
        {{ g }}
      </button>
      <div v-if="!layout.phone" class="rail-foot label label-dim">{{ catalog.items.length }} items</div>
    </nav>

    <section class="center">
      <div class="toolbar">
        <div class="chips scroll-x">
          <button class="chip" :class="{ active: department === null }" @click="department = null">All depts</button>
          <button v-for="d in catalog.departments" :key="d" class="chip" :class="{ active: department === d }" @click="department = department === d ? null : d">
            {{ d }}
          </button>
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
.chips {
  display: flex;
  gap: 6px;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}
.chips::-webkit-scrollbar {
  display: none;
}
.chips > .chip {
  flex: 0 0 auto; /* never shrink: labels were overlapping in the scroll strip */
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
