<script setup lang="ts">
import { computed, ref } from 'vue'
import { useCatalogStore } from '@/stores/catalog'
import { useCartStore } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import type { Item } from '@/api'
import ItemTile from '@/components/ItemTile.vue'
import BasketPanel from '@/components/BasketPanel.vue'
import Modal from '@/components/Modal.vue'

const catalog = useCatalogStore()
const cart = useCartStore()
const session = useSessionStore()

const group = ref<string | null>(null)
const department = ref<string | null>(null)
const q = ref('')
const serialPick = ref<Item | null>(null)

const items = computed(() => catalog.search(q.value, group.value, department.value))
const overrideCodes = computed(() => new Set(catalog.pricing_rules.map((r) => r.item_code)))

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
</script>

<template>
  <div class="sell">
    <nav class="rail scroll">
      <button class="rail-btn display" :class="{ active: group === null }" @click="group = null">All</button>
      <button v-for="g in catalog.item_groups" :key="g" class="rail-btn display" :class="{ active: group === g }" @click="group = g">
        {{ g }}
      </button>
      <div class="rail-foot label label-dim">{{ catalog.items.length }} items</div>
    </nav>

    <section class="center">
      <div class="toolbar">
        <div class="chips scroll-x">
          <button class="chip" :class="{ active: department === null }" @click="department = null">All depts</button>
          <button v-for="d in catalog.departments" :key="d" class="chip" :class="{ active: department === d }" @click="department = department === d ? null : d">
            {{ d }}
          </button>
        </div>
        <div class="search">
          <input v-model="q" class="input" type="search" placeholder="Search name, code or serial" autocomplete="off" />
          <button v-if="q" class="clear-q label" @click="q = ''">Clear</button>
        </div>
      </div>
      <div class="grid-wrap scroll">
        <div v-if="!items.length" class="none label label-dim">No items match</div>
        <div class="grid">
          <ItemTile
            v-for="it in items"
            :key="it.item_code"
            :item="it"
            :rate="catalog.rateFor(it.item_code)"
            :serials="availableSerials(it.item_code)"
            :stock="catalog.stock[it.item_code] ?? 0"
            :currency="session.currency"
            :override="overrideCodes.has(it.item_code)"
            @pick="pick(it)"
          />
        </div>
      </div>
    </section>

    <BasketPanel />

    <Modal v-if="serialPick" :title="serialPick.item_name" width="520px" @close="serialPick = null">
      <div class="label" style="margin-bottom: 12px">Select serial number</div>
      <div class="serials">
        <button v-for="sn in availableSerials(serialPick.item_code)" :key="sn" class="serial-btn" @click="pickSerial(sn)">
          <span class="num">{{ sn }}</span>
          <span v-if="serialPick.maison_certificate_no" class="dim">{{ serialPick.maison_certificate_no }}</span>
        </button>
      </div>
    </Modal>
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
  color: var(--text);
  border-left-color: var(--platinum);
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
.search {
  position: relative;
  width: 300px;
  flex: 0 0 300px;
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
  border-color: var(--muted);
}
.serial-btn .num {
  font-size: 14px;
}
.serial-btn .dim {
  font-size: 12px;
}
</style>
