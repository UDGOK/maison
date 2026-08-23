<script setup lang="ts">
/**
 * v0.6 O — scan / tap counting used by the POS Receive screen (warehouse shipments, vendor POs) and the
 * warehouse desk (vendor PO at HOU-WH). Each scan of a line's barcode / item code adds one; tapping +/−
 * or typing a number counts too. Discrepancies (short / over / damaged) are highlighted before confirming.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

export interface CountLine {
  key: string
  item_code: string
  item_name?: string
  barcode?: string | null
  expected: number
}
export interface Counted {
  key: string
  item_code: string
  received: number
  damaged: number
}

const props = withDefaults(defineProps<{ lines: CountLine[]; allowDamaged?: boolean; scanSource?: (cb: (code: string) => void) => () => void; confirmLabel?: string; busy?: boolean }>(), { allowDamaged: false, confirmLabel: 'Confirm receipt' })
const emit = defineEmits<{ confirm: [counts: Counted[], partial: boolean]; scanned: [code: string, matched: boolean] }>()

const received = ref<Record<string, number>>({})
const damaged = ref<Record<string, number>>({})
const manual = ref('')
const lastScan = ref<{ code: string; ok: boolean } | null>(null)
const touched = ref(false)

function match(code: string): CountLine | undefined {
  const c = code.trim().toLowerCase()
  if (!c) return undefined
  return props.lines.find((l) => (l.barcode || '').toLowerCase() === c) || props.lines.find((l) => l.item_code.toLowerCase() === c) || props.lines.find((l) => (l.barcode || '').toLowerCase().endsWith(c) && c.length >= 6)
}
function onCode(code: string) {
  const line = match(code)
  if (line) received.value[line.key] = (received.value[line.key] || 0) + 1
  touched.value = true
  lastScan.value = { code, ok: !!line }
  emit('scanned', code, !!line)
}
function submitManual() {
  if (!manual.value.trim()) return
  onCode(manual.value)
  manual.value = ''
}
function bump(key: string, d: number, kind: 'received' | 'damaged' = 'received') {
  const store = kind === 'received' ? received : damaged
  store.value[key] = Math.max(0, (store.value[key] || 0) + d)
  touched.value = true
}
function fillAll() {
  for (const l of props.lines) received.value[l.key] = l.expected
  touched.value = true
}

const rows = computed(() =>
  props.lines.map((l) => {
    const got = Number(received.value[l.key] || 0)
    const dmg = Number(damaged.value[l.key] || 0)
    const total = got + dmg
    return { ...l, got, dmg, diff: total - l.expected, state: total === l.expected && !dmg ? 'ok' : total < l.expected ? 'short' : total > l.expected ? 'over' : 'damaged' }
  })
)
const summary = computed(() => ({
  short: rows.value.filter((r) => r.state === 'short').length,
  over: rows.value.filter((r) => r.state === 'over').length,
  damaged: rows.value.filter((r) => r.dmg > 0).length,
  counted: rows.value.reduce((s, r) => s + r.got + r.dmg, 0),
  expected: rows.value.reduce((s, r) => s + r.expected, 0)
}))
const clean = computed(() => rows.value.every((r) => r.state === 'ok'))

function confirm(partial = false) {
  emit(
    'confirm',
    rows.value.map((r) => ({ key: r.key, item_code: r.item_code, received: r.got, damaged: r.dmg })),
    partial
  )
}

let uninstall: (() => void) | null = null
onMounted(() => {
  if (props.scanSource) uninstall = props.scanSource(onCode)
})
onBeforeUnmount(() => uninstall?.())
defineExpose({ onCode, fillAll })
</script>

<template>
  <div class="count" data-testid="count-sheet">
    <div class="scanbar">
      <input v-model="manual" class="input" placeholder="Scan barcode or type item code" data-testid="count-input" @keydown.enter.prevent="submitManual" />
      <button class="btn" data-testid="count-add" @click="submitManual">Add</button>
      <button class="btn btn-ghost" data-testid="count-fill-all" @click="fillAll">All as expected</button>
      <span v-if="lastScan" class="pill" :class="lastScan.ok ? 'pill-good' : 'pill-crit'" data-testid="count-last-scan">{{ lastScan.ok ? 'Counted' : 'Not on this delivery' }} · {{ lastScan.code }}</span>
    </div>
    <table class="table">
      <thead>
        <tr>
          <th>Item</th>
          <th class="num">Expected</th>
          <th class="num">Counted</th>
          <th v-if="allowDamaged" class="num">Damaged</th>
          <th class="num">Δ</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.key" :class="r.state" :data-testid="`count-row-${r.item_code}`" :data-state="r.state">
          <td>
            <div class="ellipsis" style="max-width: 320px">{{ r.item_name || r.item_code }}</div>
            <div class="label label-dim">{{ r.item_code }}<span v-if="r.barcode && r.barcode !== r.item_code"> · {{ r.barcode }}</span></div>
          </td>
          <td class="num">{{ r.expected }}</td>
          <td class="num">
            <div class="stepper">
              <button class="step" :aria-label="`minus ${r.item_code}`" @click="bump(r.key, -1)">−</button>
              <input v-model.number="received[r.key]" class="input qty" inputmode="numeric" :placeholder="'0'" :data-testid="`count-qty-${r.item_code}`" @input="touched = true" />
              <button class="step" :aria-label="`plus ${r.item_code}`" :data-testid="`count-plus-${r.item_code}`" @click="bump(r.key, 1)">+</button>
            </div>
          </td>
          <td v-if="allowDamaged" class="num">
            <div class="stepper">
              <button class="step" @click="bump(r.key, -1, 'damaged')">−</button>
              <input v-model.number="damaged[r.key]" class="input qty" inputmode="numeric" placeholder="0" :data-testid="`count-damaged-${r.item_code}`" @input="touched = true" />
              <button class="step" :data-testid="`count-damaged-plus-${r.item_code}`" @click="bump(r.key, 1, 'damaged')">+</button>
            </div>
          </td>
          <td class="num diff" :class="r.state === 'ok' ? 'good' : r.state === 'short' ? 'crit' : 'warn'">{{ r.diff > 0 ? '+' : '' }}{{ r.diff }}<span v-if="r.dmg"> ({{ r.dmg }} dmg)</span></td>
        </tr>
      </tbody>
    </table>
    <div class="foot">
      <div class="label" :class="clean ? 'good' : 'warn'" data-testid="count-summary">
        {{ summary.counted }} / {{ summary.expected }} units<span v-if="summary.short"> · {{ summary.short }} short</span><span v-if="summary.over"> · {{ summary.over }} over</span><span v-if="summary.damaged"> · {{ summary.damaged }} damaged</span>
        <span v-if="clean"> · all good</span>
      </div>
      <div class="row">
        <slot name="actions" :clean="clean" :touched="touched" />
        <button v-if="summary.short && allowDamaged" class="btn" :disabled="busy || !touched" data-testid="count-partial" @click="confirm(true)">Save partial (rest still in transit)</button>
        <button class="btn btn-primary" :disabled="busy || !touched" data-testid="count-confirm" @click="confirm(false)">{{ busy ? 'Posting…' : confirmLabel }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scanbar {
  display: flex;
  gap: 8px;
  align-items: center;
  flex-wrap: wrap;
  margin-bottom: 12px;
}
.scanbar .input {
  flex: 1;
  min-width: 220px;
}
tr.short td {
  background: rgba(196, 115, 106, 0.08);
}
tr.over td,
tr.damaged td {
  background: rgba(211, 165, 91, 0.08);
}
.stepper {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.step {
  width: 40px;
  min-width: 40px;
  min-height: 40px;
  border: var(--line-w) solid var(--line-strong);
  font-size: 18px;
}
.qty {
  width: 64px;
  text-align: center;
  min-height: 40px;
  padding: 0 6px;
}
.diff {
  font-weight: 500;
}
.foot {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  margin-top: 14px;
}
@media (max-width: 767px) {
  .table th:first-child,
  .table td:first-child {
    max-width: 140px;
  }
  .qty {
    width: 48px;
  }
  .step {
    width: 34px;
    min-width: 34px;
  }
  .foot {
    flex-direction: column;
    align-items: stretch;
  }
  .foot .row {
    flex-direction: column;
  }
}
</style>
