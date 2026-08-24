<script lang="ts">
/**
 * v1.0 "Procurement" §C — one row of the buying list.
 *
 * Touch-first: the whole card is the hit target for select, the stepper moves a **whole case** per
 * tap, and the vendor alternatives are on the card rather than behind a menu — the rates are
 * already negotiated (locked decision 2, no RFQ), so choosing a vendor is a comparison, not a
 * quote request.
 *
 * The maths is `warehouse/buying.ts`; nothing is recomputed here. `displayLine` mirrors the
 * store's `selectedLines` getter exactly, so what the row shows is what will be ordered.
 */
import { lineFor, pickVendor, roundToCasePack, type BuyLine } from '../../buying'
import type { Suggestion } from '@/api/purchasing'
import type { SelectionOverride } from '@/stores/purchasing'
import { fmtMoney } from '@/utils/money'

/**
 * The buying line this row stands for — the buyer's vendor and quantity overrides applied on top
 * of the suggestion. Mirrors `stores/purchasing.ts::selectedLines` for one row.
 */
export function displayLine(suggestion: Suggestion, override?: SelectionOverride | null): BuyLine {
  const supplier = override?.supplier || suggestion.supplier || ''
  const line = supplier && supplier !== suggestion.supplier ? pickVendor(suggestion, supplier) : lineFor(suggestion)
  if (override?.qty != null) return { ...line, qty: Math.max(0, Number(override.qty) || 0) }
  return line
}

/** Unit-cost difference against the preferred vendor, at four decimals (costs carry fractions). */
export function costDelta(cost: number, preferredCost: number): number {
  const d = (Number(cost) || 0) - (Number(preferredCost) || 0)
  return Math.round((d + Number.EPSILON) * 10000) / 10000
}

/** "+$0.35 / unit" · "−$0.07 / unit" · "same cost" — what the buyer compares at a glance. */
export function deltaLabel(delta: number, currency = 'USD'): string {
  if (!delta) return 'same cost'
  return `${delta > 0 ? '+' : '−'}${fmtMoney(Math.abs(delta), currency)} / unit`
}

/** "12 per case · MOQ 24" — the rounding rule the quantity above it obeys. */
export function packNote(casePack: number, moq: number): string {
  const pack = Math.max(1, Math.trunc(Number(casePack) || 0))
  const min = Math.max(0, Math.trunc(Number(moq) || 0))
  const parts = [pack > 1 ? `${pack} per case` : 'single units']
  if (min > 0) parts.push(`MOQ ${min}`)
  return parts.join(' · ')
}

/** Cover-day tone: under a week is critical, under a fortnight is a warning. */
export function coverTone(coverDays: number, onHand: number): string {
  if (onHand <= 0) return 'crit'
  const d = Number(coverDays) || 0
  if (d <= 0) return 'muted'
  if (d < 7) return 'crit'
  if (d < 14) return 'warn'
  return 'muted'
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import SourceBadge from './SourceBadge.vue'
import { usePurchasingStore } from '@/stores/purchasing'
import { fmtInt } from '@/utils/money'

const props = defineProps<{ suggestion: Suggestion; disabled?: boolean }>()
const emit = defineEmits<{ dismiss: [Suggestion] }>()

const store = usePurchasingStore()

const code = computed(() => props.suggestion.item_code)
const override = computed<SelectionOverride | null>(() => store.selection[code.value] ?? null)
// read the key, do not ask `store.isSelected()`: it answers with `Object.prototype.hasOwnProperty
// .call(...)`, which is not a tracked read on a reactive proxy, so a computed built on it never
// re-evaluates and the tick never appears.
const picked = computed(() => !!override.value)
const line = computed(() => displayLine(props.suggestion, override.value))

/** Preferred first, then cheapest — the order a buyer reads them in. */
const vendors = computed(() =>
  [...(props.suggestion.vendors || [])].sort((a, b) => Number(b.is_preferred) - Number(a.is_preferred) || a.cost - b.cost)
)
const preferredCost = computed(() => vendors.value.find((v) => v.is_preferred)?.cost ?? props.suggestion.cost ?? 0)
const chosen = computed(() => line.value.supplier)
const lineValue = computed(() => line.value.qty * line.value.rate)
const busy = computed(() => store.busy === props.suggestion.name)

/** Local while the buyer types; the store only hears the re-rounded figure on blur. */
const draft = ref<number | string>(line.value.qty)
watch(
  () => line.value.qty,
  (q) => {
    draft.value = q
  }
)

/** One line of plain English whenever the screen changed the buyer's number for them. */
const note = ref('')
function say(msg: string) {
  note.value = msg
}

function toggle() {
  if (props.disabled) return
  store.toggle(code.value)
}

/** Re-round to the chosen vendor's case pack / MOQ, and say so when the figure moved. */
function commitQty() {
  if (props.disabled) return
  const typed = Math.max(0, Number(draft.value) || 0)
  const snapped = roundToCasePack(typed, line.value.case_pack, line.value.moq)
  draft.value = snapped
  store.setQty(code.value, snapped)
  if (snapped !== typed) {
    say(
      snapped === 0
        ? 'Nothing ordered on this line.'
        : `Rounded ${fmtInt(typed)} up to ${fmtInt(snapped)} — ${packNote(line.value.case_pack, line.value.moq)}.`
    )
  } else note.value = ''
}

function step(cases: number) {
  if (props.disabled) return
  const pack = Math.max(1, line.value.case_pack)
  const next = roundToCasePack(Math.max(0, line.value.qty + cases * pack), pack, line.value.moq)
  draft.value = next
  store.setQty(code.value, next)
  note.value = ''
}

/**
 * Swap vendor. The store deliberately drops a quantity typed against the previous vendor's case
 * pack — that is correct, so the row says it out loud instead of hiding it.
 */
function chooseVendor(supplier: string) {
  if (props.disabled || supplier === chosen.value) return
  const typed = override.value?.qty
  store.setSupplier(code.value, supplier)
  const after = displayLine(props.suggestion, store.selection[code.value] ?? null)
  const name = vendors.value.find((v) => v.supplier === supplier)?.supplier_name || supplier
  say(
    typed != null && typed !== after.qty
      ? `Your ${fmtInt(typed)} was entered against the previous case pack — ${fmtInt(after.qty)} is ${name}'s (${packNote(after.case_pack, after.moq)}).`
      : `${fmtInt(after.qty)} at ${name}'s ${packNote(after.case_pack, after.moq)}.`
  )
}
</script>

<template>
  <article class="srow" :class="{ picked, busy }" :data-testid="`sug-${code}`">
    <label class="pick" :aria-label="`Select ${suggestion.item_name || code}`">
      <input type="checkbox" :checked="picked" :disabled="disabled" @change="toggle" />
    </label>

    <div class="main">
      <header class="head">
        <div class="thumb" aria-hidden="true">
          <img v-if="suggestion.image" :src="suggestion.image" alt="" loading="lazy" decoding="async" />
          <span v-else class="ph">{{ (suggestion.item_name || code).slice(0, 2).toUpperCase() }}</span>
        </div>
        <div class="idn">
          <div class="iname ellipsis">{{ suggestion.item_name || code }}</div>
          <div class="label label-dim ellipsis">{{ code }}<span v-if="suggestion.item_group"> · {{ suggestion.item_group }}</span></div>
        </div>
        <SourceBadge :source="suggestion.source" :sources="suggestion.sources" />
      </header>

      <div class="stats">
        <div class="stat"><span class="label">On hand</span><span class="num v" :class="{ crit: suggestion.on_hand <= 0 }">{{ fmtInt(suggestion.on_hand) }}</span></div>
        <div class="stat"><span class="label">On order</span><span class="num v" :class="{ dim: !suggestion.on_order }">{{ fmtInt(suggestion.on_order) }}</span></div>
        <div class="stat"><span class="label">Store demand</span><span class="num v" :class="{ dim: !suggestion.store_demand }">{{ fmtInt(suggestion.store_demand) }}</span></div>
        <div class="stat"><span class="label">Reorder at</span><span class="num v dim">{{ suggestion.reorder_level ? fmtInt(suggestion.reorder_level) : '—' }}</span></div>
        <div class="stat">
          <span class="label">Cover</span>
          <span class="num v" :class="coverTone(suggestion.cover_days, suggestion.on_hand)">{{ suggestion.cover_days ? `${suggestion.cover_days} d` : '—' }}</span>
        </div>
      </div>

      <div class="qtyrow">
        <button class="step" :disabled="disabled || line.qty <= 0" aria-label="One case less" @click="step(-1)">−</button>
        <input
          v-model="draft"
          class="input qty num"
          inputmode="numeric"
          :disabled="disabled"
          :aria-label="`Quantity for ${code}`"
          :data-testid="`sug-qty-${code}`"
          @blur="commitQty"
          @keydown.enter="commitQty"
        />
        <button class="step" :disabled="disabled" aria-label="One case more" @click="step(1)">+</button>
        <div class="packs">
          <div class="label label-dim">{{ packNote(line.case_pack, line.moq) }}</div>
          <div class="label label-dim">{{ line.lead_time_days ? `${line.lead_time_days} day lead` : 'no lead time on file' }}</div>
        </div>
        <div class="lineval">
          <div class="label label-dim">Line value</div>
          <div class="num money">{{ fmtMoney(lineValue) }}</div>
        </div>
      </div>

      <!--
        Always mounted, never `v-if`. Committing the quantity on blur used to unmount this line,
        which pulled the vendor grid 46 px up between mousedown and mouseup — so the buyer's very
        next tap on an alternative vendor dispatched no click at all and was silently swallowed.
        Type-a-quantity-then-choose-a-vendor is the normal order of work on this row.
      -->
      <p class="note" :class="{ empty: !note }" :data-testid="`sug-note-${code}`">{{ note }}</p>

      <div class="vendors" role="group" aria-label="Vendor">
        <button
          v-for="v in vendors"
          :key="v.supplier"
          class="vendor"
          :class="{ on: v.supplier === chosen }"
          :disabled="disabled"
          :data-testid="`sug-vendor-${code}-${v.supplier}`"
          @click="chooseVendor(v.supplier)"
        >
          <span class="vtop">
            <span class="vname ellipsis">{{ v.supplier_name || v.supplier }}</span>
            <span v-if="v.is_preferred" class="vpref label">Preferred</span>
          </span>
          <span class="vmeta label label-dim ellipsis">
            {{ v.vendor_sku || 'no vendor SKU' }} · {{ v.lead_time_days ? `${v.lead_time_days} d` : 'lead n/a' }} · {{ packNote(v.case_pack, v.moq) }}
          </span>
          <span class="vcost num">{{ fmtMoney(v.cost) }}</span>
          <span
            v-if="!v.is_preferred"
            class="vdelta label"
            :class="costDelta(v.cost, preferredCost) > 0 ? 'warn' : costDelta(v.cost, preferredCost) < 0 ? 'good' : 'label-dim'"
            :data-testid="`sug-delta-${code}-${v.supplier}`"
          >
            {{ deltaLabel(costDelta(v.cost, preferredCost)) }}
          </span>
          <span v-else class="vdelta label label-dim">the baseline</span>
        </button>
      </div>

      <footer class="foot">
        <span class="label label-dim">{{ suggestion.name }}</span>
        <button class="btn btn-ghost" :disabled="disabled || busy" :data-testid="`sug-dismiss-${code}`" @click="emit('dismiss', suggestion)">
          {{ busy ? 'Dismissing…' : 'Dismiss' }}
        </button>
      </footer>
    </div>
  </article>
</template>

<style scoped>
.srow {
  display: flex;
  gap: 12px;
  padding: 14px 16px 14px 10px;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
  border-left: 3px solid transparent;
}
.srow.picked {
  border-left-color: var(--accent);
  background: var(--surface-2);
}
.srow.busy {
  opacity: 0.55;
}
.pick {
  display: flex;
  align-items: flex-start;
  justify-content: center;
  min-width: 44px;
  padding-top: 10px;
  cursor: pointer;
}
.main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.thumb {
  flex: 0 0 44px;
  width: 44px;
  height: 44px;
  border: var(--line-w) solid var(--line-strong);
  background: var(--ground);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.thumb img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.ph {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 13px;
  color: var(--dim);
}
.idn {
  flex: 1;
  min-width: 0;
}
.iname {
  font-size: 15px;
  font-weight: 500;
}
.stats {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 1px;
  background: var(--line);
  border: var(--line-w) solid var(--line);
}
.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 8px 10px;
  background: var(--ground);
}
.stat .v {
  font-size: 16px;
}
.qtyrow {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.step {
  width: 52px;
  height: 52px;
  border: var(--line-w) solid var(--line-strong);
  color: var(--text);
  font-family: var(--font-display);
  font-size: 20px;
  font-weight: 800;
}
.step:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.qty {
  width: 104px;
  height: 52px;
  min-height: 52px;
  text-align: right;
  font-size: 20px;
  border-color: var(--line-strong);
}
.packs {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.lineval {
  margin-left: auto;
  text-align: right;
}
.money {
  font-size: 17px;
  color: var(--accent);
}
.note {
  margin: 0;
  padding: 8px 10px;
  border-left: 2px solid var(--warn);
  background: rgba(211, 165, 91, 0.08);
  color: var(--warn);
  font-size: 13px;
  min-height: 33px;
}
/* keeps the row's height fixed so nothing moves under the buyer's finger */
.note.empty {
  visibility: hidden;
  border-left-color: transparent;
  background: none;
}
.vendors {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 8px;
}
.vendor {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: 'top cost' 'meta delta';
  gap: 2px 10px;
  align-items: center;
  min-height: 62px;
  padding: 10px 12px;
  text-align: left;
  border: var(--line-w) solid var(--line-strong);
  background: var(--ground);
}
.vendor:hover:not(:disabled) {
  border-color: var(--muted);
}
.vendor.on {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.vtop {
  grid-area: top;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.vname {
  font-size: 14px;
  font-weight: 500;
}
.vpref {
  color: var(--accent);
  font-size: 9px;
}
.vmeta {
  grid-area: meta;
  min-width: 0;
  letter-spacing: 0.08em;
}
.vcost {
  grid-area: cost;
  font-size: 16px;
  text-align: right;
}
.vdelta {
  grid-area: delta;
  text-align: right;
  letter-spacing: 0.08em;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
@media (max-width: 767px) {
  .srow {
    padding: 12px 12px 12px 6px;
  }
  .stats {
    grid-template-columns: repeat(3, 1fr);
  }
  .lineval {
    width: 100%;
    text-align: left;
    margin-left: 0;
  }
  .vendors {
    grid-template-columns: 1fr;
  }
}
/* phone: the item name matters more than its thumbnail, and five stats do not fit across */
@media (max-width: 479px) {
  .thumb {
    display: none;
  }
  .iname {
    white-space: normal;
  }
  .stats {
    grid-template-columns: repeat(2, 1fr);
  }
  .stat .label {
    letter-spacing: 0.12em;
  }
  .qty,
  .step {
    height: 48px;
    min-height: 48px;
  }
}
</style>
