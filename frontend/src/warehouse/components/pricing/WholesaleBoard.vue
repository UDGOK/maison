<script lang="ts">
/**
 * v1.2 §A — **Wholesale**: what a store pays Houston, and the one rule that sets it.
 *
 * A chain-wide markup on what Houston actually paid, unless somebody typed a price on the item.
 * **One price for every store** (client decision 1): Sapulpa and Montrose pay the same, and there
 * is deliberately nowhere on this screen to make them differ.
 *
 * The cost it marks up is the item's **moving-average valuation at the main warehouse**, not a
 * price list — a buying price list says what a vendor charges today, which is a different question
 * from what the stock on the shelf cost.
 *
 * A markup of **0 is a legitimate answer** (ship at cost), so the box refuses a negative and an
 * absurd one and nothing else.
 */
import type { WholesaleRow } from '@/api/pricing'

/** Overrides first — they are the exceptions somebody typed — then by item name. */
export function sortWholesale(rows: WholesaleRow[]): WholesaleRow[] {
  return [...(rows || [])].sort(
    (a, b) => Number(b.source === 'override') - Number(a.source === 'override') || (a.item_name || a.item_code).localeCompare(b.item_name || b.item_code)
  )
}

/** "8 of 11 on the chain rule · 3 priced by hand" — the state of play in one line. */
export function ruleSummary(rows: WholesaleRow[], markupPct: number): string {
  const all = rows || []
  if (!all.length) return 'Nothing loaded yet.'
  const typed = all.filter((r) => r.source === 'override').length
  const ruled = all.length - typed
  const parts = [`${ruled} on the ${markupPct}% chain rule`]
  if (typed) parts.push(`${typed} priced by hand`)
  return `${parts.join(' · ')}.`
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { usePricingStore } from '@/stores/pricing'
import { usePurchasingStore } from '@/stores/purchasing'
import { applyMarkup, markupProblem, marginTone, wholesaleSourceCopy } from '@/warehouse/pricing'
import { fmtMoney } from '@/utils/money'

const emit = defineEmits<{ notice: [msg: string]; 'open-item': [itemCode: string] }>()

const pricing = usePricingStore()
const purchasing = usePurchasingStore()

const markup = ref('')
const q = ref('')
/** item_code → the price being typed into its override box */
const typed = ref<Record<string, string>>({})

const settings = computed(() => pricing.settings)
const rows = computed(() => {
  const list = sortWholesale(pricing.wholesale)
  const needle = q.value.trim().toLowerCase()
  return needle ? list.filter((r) => `${r.item_code} ${r.item_name || ''}`.toLowerCase().includes(needle)) : list
})
const currency = computed(() => pricing.currency)
const money = (n: number) => fmtMoney(n, currency.value)
const markupError = computed(() => (markup.value.trim() === '' ? '' : markupProblem(markup.value)))
const markupDirty = computed(() => markup.value.trim() !== '' && Number(markup.value) !== (settings.value?.markup_pct ?? 50))

async function load() {
  await pricing.loadSettings()
  markup.value = String(settings.value?.markup_pct ?? '')
  // the wholesale price of everything Houston is holding — the Stock board's own list
  if (!purchasing.stock.length) await purchasing.loadStock()
  await pricing.loadWholesale(purchasing.stock.map((r) => r.item_code))
}
onMounted(load)
watch(
  () => settings.value?.markup_pct,
  (pct) => {
    if (pct !== undefined && !markupDirty.value) markup.value = String(pct)
  }
)

function drain() {
  if (pricing.notice) {
    emit('notice', pricing.notice)
    pricing.clearNotice()
  }
}

async function saveMarkup() {
  if (markupError.value) return
  const out = await pricing.setMarkup(Number(markup.value))
  if (out) {
    markup.value = String(out.markup_pct)
    drain()
  }
}

async function saveOverride(itemCode: string) {
  const raw = (typed.value[itemCode] ?? '').trim()
  const out = await pricing.setWholesale(itemCode, raw === '' ? null : Number(raw))
  if (out) {
    delete typed.value[itemCode]
    drain()
  }
}
async function clearOverride(itemCode: string) {
  const out = await pricing.setWholesale(itemCode, null)
  if (out) {
    delete typed.value[itemCode]
    drain()
  }
}
</script>

<template>
  <div class="wholesale" data-testid="wholesale-board">
    <!-- ============================================================ the rule -->
    <section class="card rule">
      <div class="rule-say">
        <div class="section-title">The chain-wide rule</div>
        <p class="muted">
          Every store pays the same (client decision 1). The markup is applied to
          <b>{{ settings?.cost_basis || 'the moving-average valuation at the main warehouse' }}</b> — what Houston actually paid for the units it is
          sending, not what a vendor charges today. A markup of 0 is legal: it ships at cost.
        </p>
      </div>
      <div class="rule-set">
        <div class="field">
          <label class="label" for="wh-markup">Markup on cost</label>
          <div class="row">
            <input
              id="wh-markup"
              v-model="markup"
              class="input pct"
              inputmode="decimal"
              :class="{ bad: !!markupError }"
              data-testid="wholesale-markup"
              @keydown.enter.prevent="saveMarkup"
            />
            <span class="label label-dim">%</span>
            <button class="btn btn-primary" :disabled="!markupDirty || !!markupError || pricing.busy === 'markup'" data-testid="wholesale-markup-save" @click="saveMarkup">
              {{ pricing.busy === 'markup' ? 'Saving…' : 'Set markup' }}
            </button>
          </div>
          <span v-if="markupError" class="label crit" data-testid="wholesale-markup-error">{{ markupError }}</span>
          <span v-else class="label label-dim">Default {{ settings?.default_markup_pct ?? 50 }}% · priced at {{ settings?.warehouse || 'HOU-WH' }}</span>
        </div>
      </div>
    </section>

    <p class="banner internal-note">
      <b>Internal.</b> {{ settings?.notice || 'These are AWANZ’s own cost and margin figures.' }}
    </p>

    <div v-if="pricing.error" class="banner crit-banner" data-testid="wholesale-error">
      <span>{{ pricing.error }}</span>
      <button class="btn btn-ghost" @click="pricing.clearError()">Dismiss</button>
    </div>

    <!-- ============================================================ per item -->
    <div class="bar">
      <input v-model="q" class="input search" placeholder="Search item or code" data-testid="wholesale-search" />
      <span class="label label-dim" data-testid="wholesale-summary">{{ ruleSummary(pricing.wholesale, settings?.markup_pct ?? 50) }}</span>
      <div class="spacer"></div>
      <button class="btn" :disabled="pricing.loading" data-testid="wholesale-refresh" @click="load">{{ pricing.loading ? 'Working…' : 'Refresh' }}</button>
    </div>

    <div v-if="!rows.length" class="empty" data-testid="wholesale-empty">
      <div class="display" style="font-size: 18px">{{ pricing.wholesale.length ? 'Nothing matches that search' : 'Nothing to price yet' }}</div>
      <div class="muted">
        {{ pricing.wholesale.length ? 'Widen the search.' : 'Receive a vendor delivery on Inbound and the item picks up a moving-average cost to mark up.' }}
      </div>
    </div>

    <div v-else class="tablewrap">
      <table class="table wh">
        <thead>
          <tr>
            <th>Item</th>
            <th class="num">Cost at HOU-WH</th>
            <th>Where the price comes from</th>
            <th class="num">Store pays</th>
            <th class="num">AWANZ margin</th>
            <th class="num type-col">Price it by hand</th>
            <th class="acts-col"><span class="vh">Prices</span></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.item_code" :class="{ typed: r.source === 'override' }" :data-testid="`wh-${r.item_code}`">
            <td>
              <div class="ellipsis wide">{{ r.item_name || r.item_code }}</div>
              <div class="label label-dim">{{ r.item_code }}</div>
            </td>
            <td class="num money">{{ money(r.cost) }}</td>
            <td class="where-col">
              <span class="pill" :class="r.source === 'override' ? 'pill-accent' : ''" :title="wholesaleSourceCopy(r.source, r.markup_pct)">
                {{ r.source === 'override' ? 'Typed on the item' : 'Chain rule' }}
              </span>
              <!-- for a hand-priced item, what it is being priced *away from* is the useful fact -->
              <div class="label label-dim">
                {{ r.source === 'override' ? `the rule would be ${money(applyMarkup(r.cost, r.markup_pct))}` : `${r.markup_pct}% on cost` }}
              </div>
            </td>
            <td class="num money accent" :data-testid="`wh-rate-${r.item_code}`">{{ money(r.wholesale) }}</td>
            <td class="num">
              <span :class="marginTone(r.margin_pct)">{{ r.wholesale ? `${r.margin_pct} %` : '—' }}</span>
              <div class="label label-dim">{{ money(r.margin) }}</div>
            </td>
            <td class="num type-col">
              <input
                class="input cell"
                inputmode="decimal"
                :placeholder="r.override ? String(r.override) : 'rule'"
                :value="typed[r.item_code] ?? ''"
                :aria-label="`Wholesale price for ${r.item_code}`"
                :data-testid="`wh-override-${r.item_code}`"
                @input="typed[r.item_code] = ($event.target as HTMLInputElement).value"
                @keydown.enter.prevent="saveOverride(r.item_code)"
              />
            </td>
            <td class="acts-col">
              <div class="rowacts">
              <button
                v-if="typed[r.item_code]"
                class="btn compact"
                :disabled="pricing.busy === r.item_code"
                :data-testid="`wh-save-${r.item_code}`"
                @click="saveOverride(r.item_code)"
              >
                Save
              </button>
              <button
                v-else-if="r.source === 'override'"
                class="btn btn-ghost compact"
                :disabled="pricing.busy === r.item_code"
                :data-testid="`wh-clear-${r.item_code}`"
                @click="clearOverride(r.item_code)"
              >
                Back to the rule
              </button>
              <button class="btn btn-ghost compact" :data-testid="`wh-prices-${r.item_code}`" @click="emit('open-item', r.item_code)">Shelf prices</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.wholesale {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.rule {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  flex-wrap: wrap;
  padding: 16px 20px;
}
.rule-say {
  flex: 1 1 380px;
  min-width: 0;
}
.rule-say p {
  margin-top: 6px;
  font-size: 13px;
  max-width: 78ch;
}
.rule-set {
  flex: 0 0 auto;
}
.pct {
  width: 110px;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 18px;
}
.input.bad {
  border-color: var(--crit);
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 13px;
}
.internal-note {
  display: block;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  color: var(--text);
  max-width: 110ch;
}
.crit-banner {
  border-left: 3px solid var(--crit);
  background: rgba(196, 115, 106, 0.1);
  color: var(--crit);
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.bar .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.search {
  width: 280px;
  flex: 1 1 200px;
  max-width: 360px;
}
.spacer {
  flex: 1;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 48px 16px;
  text-align: center;
  border: var(--line-w) dashed var(--line-strong);
  background: var(--surface);
}
.tablewrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
}
.wh {
  min-width: 980px;
}
.wh th,
.wh td {
  white-space: nowrap;
}
/* the only column carrying a sentence — let it wrap rather than set the table's whole width */
.where-col {
  white-space: normal;
  min-width: 180px;
}
.wide {
  max-width: 260px;
}
tr.typed td {
  background: rgba(201, 169, 110, 0.06);
}
.money {
  font-family: var(--font-display);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.type-col {
  width: 128px;
}
.cell {
  width: 104px;
  min-height: var(--touch);
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
}
/*
 * `display: flex` on a `<td>` takes the cell out of the table's own layout — the browser wraps it
 * in an anonymous cell and the column stops being a column, which stacked these buttons on top of
 * the "price it by hand" box next door. The cell stays a cell; the row of buttons is a div inside
 * it (the same shape the Stock board uses).
 */
.acts-col {
  width: 1%;
  white-space: nowrap;
  /* the screen-reader-only header inside is `position: absolute`; without a positioned ancestor
     its containing block is the page, so it sat 1310 px out and made the *document* scroll
     sideways on a phone while the table's own scroller looked innocent */
  position: relative;
}
.rowacts {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  align-items: center;
}
.compact {
  min-height: 40px;
  padding: 0 12px;
  letter-spacing: 0.1em;
}
.vh {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
@media (max-width: 767px) {
  .rule {
    padding: 14px;
  }
  /* `flex: 0 0 auto` sizes this to max-content, and its paragraph carries a 78ch max-width — at
     390 px that is 608 px of text hanging off the right-hand edge. A 100% basis makes it wrap. */
  .rule-say {
    flex: 1 1 100%;
    min-width: 0;
  }
  .rule-say p {
    max-width: none;
  }
  .rule-set,
  .search {
    width: 100%;
    max-width: none;
  }
  .rule-set .row {
    flex-wrap: wrap;
  }
  .rule-set .btn {
    flex: 1 1 100%;
  }
  .wide {
    max-width: 180px;
  }
}
</style>
