<script lang="ts">
/**
 * v1.2 §G — **New despatch**: a basket of items for **one** store.
 *
 * v1.1 shipped *one item → many stores*, which is right for introducing a new product and wrong
 * for the everyday job. What the warehouse actually does all day is fill one store's order —
 * three SKUs to Bixby, four to Sapulpa — and this is that screen. It posts through the same
 * `distribution.send` the *Send to stores* sheet uses, so the wall, the picking, the labels and
 * the store's Receive screen cannot tell the two routes apart.
 *
 * The rules, and each one is a rule rather than a preference:
 *
 *  · **One destination per basket.** The store is chosen on the basket, not per line — the manager
 *    is filling one box for one shop, and a per-line destination invites the mistake of sending
 *    half a basket to the wrong place.
 *  · **A scan of something already in the basket increments it.** Six scans of the same box is one
 *    line of six, never six lines of one.
 *  · **Never more than Houston has available.** The shortfall is named per item *before* the send,
 *    in the words the server would refuse with, and nothing is written on a failure.
 *  · **A line the destination has never sold is flagged, quietly.** It is usually deliberate —
 *    that is how a product reaches a new shop — so it is a note, never a block.
 *  · **The footer is internal** (client decision 3): lines, units, what the store is charged, and
 *    what it cost Houston.
 *
 * *Send another* clears the destination and puts the cursor back in the search box, because the
 * next thing the manager does is Sapulpa.
 */
import type { SendResult } from '@/api/distribution'

/** "Bixby’s box is on the wall" — the headline over the confirmation. */
export function doneHeadline(out: SendResult): string {
  const where = out.shipments[0]?.boutique_name || out.shipments[0]?.boutique || 'The store'
  return `${where}’s consignment is on the wall`
}
</script>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { PUSH_PRIORITIES } from '@/api/distribution'
import { purchasingApi, type StockRow } from '@/api/purchasing'
import { useDistributionStore } from '@/stores/distribution'
import { usePricingStore } from '@/stores/pricing'
import {
  applyPlan,
  availabilityProblems,
  basketTotals,
  bump,
  indexOf,
  lineFor,
  neverSoldCount,
  neverSoldNote,
  positionCopy,
  refusalMessage,
  removeLine,
  scanInto,
  sendBlocked,
  sendCopy,
  sendLines,
  sentCopy,
  setQty,
  type BasketLine
} from '@/warehouse/despatch'
import { marginPctText, marginTone } from '@/warehouse/pricing'
import { fmtInt, fmtMoney } from '@/utils/money'

const props = withDefaults(defineProps<{ boutique?: string | null }>(), { boutique: null })
const emit = defineEmits<{ close: []; notice: [msg: string]; sent: [out: SendResult] }>()

const dist = useDistributionStore()
const pricing = usePricingStore()

/**
 * What HOU-WH is holding, read once when the sheet opens. Held **locally** rather than in the
 * purchasing store: a scan narrows this list, and narrowing the desk's shared Stock list
 * underneath the board behind the sheet is how a screen quietly lies about what the warehouse has.
 */
const pool = ref<StockRow[]>([])
const loadError = ref('')

const destination = ref(props.boutique || '')
const lines = ref<BasketLine[]>([])
const q = ref('')
const searching = ref(false)
const reason = ref('')
const priority = ref<string>('Normal')
const note = ref('')
const sent = ref<SendResult | null>(null)
const searchBox = ref<HTMLInputElement | null>(null)

const stores = computed(() => dist.stores)
const totals = computed(() => basketTotals(lines.value))
const problems = computed(() => availabilityProblems(lines.value))
const refusal = computed(() => refusalMessage(problems.value))
const blocked = computed(() => sendBlocked(destination.value, lines.value, problems.value))
const busy = computed(() => dist.busy === 'send')
const strangers = computed(() => neverSoldCount(lines.value))
const currency = computed(() => pricing.currency)
const money = (n: number) => fmtMoney(n, currency.value)

/** Everything HOU-WH is holding, as the search source — it matches item, code **and** barcode. */
const results = computed(() => {
  const needle = q.value.trim().toLowerCase()
  if (!needle) return []
  return pool.value.filter((r) => `${r.item_code} ${r.item_name || ''} ${r.barcode || ''}`.toLowerCase().includes(needle)).slice(0, 8)
})

function focusSearch() {
  void nextTick(() => searchBox.value?.focus())
}

// ------------------------------------------------------------------ loading
/** Houston's position for everything in the basket, and the destination's history of each. */
async function refreshPlan() {
  const codes = lines.value.map((l) => l.item_code)
  if (!codes.length) return
  const plan = await dist.loadPlan(codes, destination.value ? [destination.value] : null)
  const prices = await pricing.loadWholesale(codes)
  const priced: Record<string, { wholesale: number; cost: number }> = {}
  for (const row of prices?.items || []) priced[row.item_code] = { wholesale: row.wholesale, cost: row.cost }
  // `applyPlan` is the pure part: it keeps the quantities the manager has already typed
  lines.value = applyPlan(lines.value, plan?.items || [], destination.value || null, priced)
}

async function loadPool(search?: string): Promise<StockRow[]> {
  try {
    const out = await purchasingApi.stock(search)
    loadError.value = ''
    return out.rows
  } catch (e) {
    loadError.value = (e as Error).message || 'Could not read what Houston is holding'
    return []
  }
}

watch(destination, () => void refreshPlan())

onMounted(async () => {
  await Promise.all([dist.loadStores(), pricing.loadSettings()])
  pool.value = await loadPool()
  focusSearch()
})

// ------------------------------------------------------------------ the basket
async function add(row: { item_code: string; item_name?: string | null; barcode?: string | null; actual_qty?: number; valuation_rate?: number }, qty = 1) {
  const at = indexOf(lines.value, row.item_code)
  if (at >= 0) {
    lines.value = bump(lines.value, row.item_code, qty)
    note.value = `${row.item_code} is already in the basket — added ${qty} more.`
  } else {
    lines.value = [
      ...lines.value,
      lineFor({ item_code: row.item_code, item_name: row.item_name ?? null, barcode: row.barcode ?? null, on_hand: row.actual_qty ?? 0, committed: 0, cost: row.valuation_rate ?? 0 }, qty)
    ]
    note.value = ''
  }
  q.value = ''
  focusSearch()
  await refreshPlan()
}

/**
 * A scan (or Enter in the search box). An exact code already in the basket increments it without
 * a round trip; otherwise the stock list answers, and a single match is added straight away —
 * a picker holding a box should not have to choose it out of a list of one.
 */
async function scan() {
  const code = q.value.trim()
  if (!code) return
  const hit = scanInto(lines.value, code)
  if (hit.outcome === 'incremented') {
    lines.value = hit.lines
    note.value = `${hit.line!.item_code} was already in the basket — now ${fmtInt(hit.line!.qty)}.`
    q.value = ''
    focusSearch()
    await refreshPlan()
    return
  }
  searching.value = true
  const rows = await loadPool(code)
  searching.value = false
  const exact = rows.find((r) => (r.barcode || '').toLowerCase() === code.toLowerCase() || r.item_code.toLowerCase() === code.toLowerCase())
  if (exact) {
    await add(exact)
    return
  }
  if (rows.length === 1) {
    await add(rows[0])
    return
  }
  if (!rows.length) note.value = `Nothing at Houston matches “${code}”.`
  else note.value = `${rows.length} items match “${code}” — pick one.`
}

async function setLineQty(itemCode: string, value: unknown) {
  lines.value = setQty(lines.value, itemCode, value)
}
function step(itemCode: string, by: number) {
  lines.value = bump(lines.value, itemCode, by)
}
function drop(itemCode: string) {
  lines.value = removeLine(lines.value, itemCode)
  note.value = ''
}
function clearBasket() {
  lines.value = []
  note.value = ''
  dist.clearError()
}

// ------------------------------------------------------------------ send
async function send() {
  const out = await dist.send(sendLines(destination.value, lines.value), reason.value.trim() || null, priority.value)
  if (!out) return
  sent.value = out
  dist.clearNotice()
  emit('notice', sentCopy({ shipments: out.shipments.map((s) => ({ name: s.name, boutique: s.boutique })), units: out.units, items: out.items }))
  emit('sent', out)
}

/** The next thing they do is Sapulpa: clear the destination, empty the basket, focus the search. */
async function another() {
  sent.value = null
  destination.value = ''
  lines.value = []
  q.value = ''
  reason.value = ''
  note.value = ''
  dist.clearError()
  pool.value = await loadPool()
  focusSearch()
}
</script>

<template>
  <Modal :title="sent ? 'Despatch sent' : 'New despatch'" width="1140px" @close="emit('close')">
    <!-- ============================================================ confirmation -->
    <div v-if="sent" class="sheet" data-testid="despatch-confirmation">
      <div class="done">
        <div class="display done-h">{{ doneHeadline(sent) }}</div>
        <p class="muted">
          {{ sentCopy({ shipments: sent.shipments.map((s) => ({ name: s.name, boutique: s.boutique })), units: sent.units, items: sent.items }) }}. It is
          waiting to be picked, and {{ sent.shipments[0]?.boutique }}’s Receive screen already lists it — a despatch built here and a push from Stock are
          the same shipment to everyone downstream.
        </p>
      </div>
      <table class="table">
        <thead>
          <tr><th>Store</th><th>Shipment</th><th>Request</th><th class="num">Lines</th><th class="num">Units</th><th>Status</th></tr>
        </thead>
        <tbody>
          <tr v-for="s in sent.shipments" :key="s.name" :data-testid="`despatch-sent-${s.boutique}`">
            <td>
              <div class="ellipsis wide">{{ s.boutique_name || s.boutique }}</div>
              <div class="label label-dim">{{ s.boutique }}</div>
            </td>
            <td class="num-mono">{{ s.name }}</td>
            <td class="num-mono muted">{{ s.replenishment_request || '—' }}</td>
            <td class="num">{{ fmtInt(s.items || 0) }}</td>
            <td class="num">{{ fmtInt(s.units) }}</td>
            <td><span class="pill pill-accent">{{ s.status }}</span></td>
          </tr>
        </tbody>
      </table>
      <p class="label label-dim">Stamped “{{ sent.reason }}” at {{ sent.priority }} priority, and marked as a warehouse push.</p>
    </div>

    <!-- ============================================================ the basket -->
    <div v-else class="sheet" data-testid="despatch-sheet">
      <!-- one destination for the whole basket -->
      <div class="dest" :class="{ unset: !destination }">
        <div class="field grow">
          <label class="label" for="dsp-store">Where the box is going<span class="label-dim"> — one store for the whole basket</span></label>
          <select id="dsp-store" v-model="destination" class="input" data-testid="despatch-store">
            <option value="">Choose a store…</option>
            <option v-for="s in stores" :key="s.boutique" :value="s.boutique">{{ s.boutique_name }} · {{ s.boutique }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="dsp-priority">Priority</label>
          <select id="dsp-priority" v-model="priority" class="input sel" data-testid="despatch-priority">
            <option v-for="p in PUSH_PRIORITIES" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
      </div>

      <!-- scan or search -->
      <div class="finder">
        <div class="field grow">
          <label class="label" for="dsp-scan">Scan a barcode, or search</label>
          <input
            id="dsp-scan"
            ref="searchBox"
            v-model="q"
            class="input"
            placeholder="Scan, or type an item, code or barcode"
            autocomplete="off"
            data-testid="despatch-scan"
            @keydown.enter.prevent="scan"
            @keydown.esc="q = ''"
          />
        </div>
        <button class="btn" :disabled="!q.trim() || searching" data-testid="despatch-add" @click="scan">{{ searching ? 'Looking…' : 'Add' }}</button>
      </div>

      <ul v-if="results.length" class="results" data-testid="despatch-results">
        <li v-for="r in results" :key="r.item_code">
          <button class="result" :data-testid="`despatch-result-${r.item_code}`" @click="add(r)">
            <span class="rname ellipsis">{{ r.item_name || r.item_code }}</span>
            <span class="label label-dim ellipsis">{{ r.item_code }}<span v-if="r.barcode"> · {{ r.barcode }}</span></span>
            <span class="num rqty" :class="{ crit: r.actual_qty <= 0 }">{{ fmtInt(r.actual_qty) }}</span>
          </button>
        </li>
      </ul>

      <p class="note label" :class="{ 'label-dim': !note }" data-testid="despatch-note">
        {{ note || 'Scanning something already in the basket adds one more to that line rather than a second line.' }}
      </p>

      <div v-if="dist.error" class="banner crit-banner pre" data-testid="despatch-error">{{ dist.error }}</div>
      <div v-else-if="refusal" class="banner crit-banner pre" data-testid="despatch-refusal">{{ refusal }}</div>
      <div v-else-if="loadError" class="banner crit-banner" data-testid="despatch-load-error">{{ loadError }}</div>

      <!-- the lines -->
      <div v-if="!lines.length" class="empty" data-testid="despatch-empty">
        <div class="display" style="font-size: 18px">Nothing in the basket yet</div>
        <p class="muted">Scan the first box, or search for it. Three SKUs to Bixby, four to Sapulpa — one basket, one store.</p>
      </div>
      <div v-else class="scroller">
        <table class="table basket">
          <thead>
            <tr>
              <th>Item</th>
              <th class="num pos-col">At Houston</th>
              <th class="num qty-col">Send</th>
              <th class="num val-col">Store pays</th>
              <th class="acts-col"><span class="vh">Remove</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="l in lines" :key="l.item_code" :class="{ over: l.qty > l.available }" :data-testid="`despatch-line-${l.item_code}`">
              <td>
                <div class="ellipsis wide">{{ l.item_name || l.item_code }}</div>
                <div class="label label-dim">
                  {{ l.item_code }}<span v-if="l.barcode"> · {{ l.barcode }}</span>
                  <span v-if="neverSoldNote(l, destination)" class="new-here" :data-testid="`despatch-new-${l.item_code}`"> · {{ neverSoldNote(l, destination) }}</span>
                </div>
                <div class="label pos-inline">{{ positionCopy(l) }}</div>
              </td>
              <td class="num pos-col">
                <span :class="{ crit: l.available <= 0 }">{{ fmtInt(l.available) }}</span>
                <div class="label label-dim">{{ fmtInt(l.on_hand) }} on hand<span v-if="l.committed"> · {{ fmtInt(l.committed) }} committed</span></div>
              </td>
              <td class="num qty-col">
                <div class="stepper">
                  <button class="step" :aria-label="`One fewer ${l.item_code}`" :data-testid="`despatch-minus-${l.item_code}`" @click="step(l.item_code, -1)">−</button>
                  <input
                    class="input qty"
                    inputmode="numeric"
                    :value="l.qty"
                    :aria-label="`Units of ${l.item_code}`"
                    :data-testid="`despatch-qty-${l.item_code}`"
                    @input="setLineQty(l.item_code, ($event.target as HTMLInputElement).value)"
                  />
                  <button class="step" :aria-label="`One more ${l.item_code}`" :data-testid="`despatch-plus-${l.item_code}`" @click="step(l.item_code, 1)">+</button>
                </div>
              </td>
              <td class="num val-col">
                <span class="money">{{ money(l.qty * l.wholesale) }}</span>
                <div class="label label-dim">{{ l.wholesale ? `${money(l.wholesale)} a unit` : 'not priced' }}</div>
              </td>
              <td class="acts-col">
                <button class="btn btn-ghost compact" :data-testid="`despatch-drop-${l.item_code}`" @click="drop(l.item_code)">Remove</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p v-if="strangers" class="label warn quiet-flag" data-testid="despatch-strangers">
        {{ strangers }} line{{ strangers === 1 ? '' : 's' }} {{ destination }} has never sold. Usually deliberate — occasionally a scanning slip.
      </p>

      <div class="stamp">
        <div class="field grow">
          <label class="label" for="dsp-reason">Why (stamped on the request)</label>
          <input id="dsp-reason" v-model="reason" class="input" placeholder="e.g. Bixby’s Tuesday order" data-testid="despatch-reason" />
        </div>
        <button v-if="lines.length" class="btn btn-ghost" data-testid="despatch-clear" @click="clearBasket">Empty the basket</button>
      </div>
    </div>

    <template #footer>
      <div v-if="sent" class="foot">
        <span class="label label-dim">{{ sent.shipments.length }} on the wall</span>
        <div class="row">
          <button class="btn btn-ghost" data-testid="despatch-done" @click="emit('close')">Done</button>
          <button class="btn btn-primary btn-big" data-testid="despatch-another" @click="another">Send another</button>
        </div>
      </div>
      <div v-else class="foot" data-testid="despatch-footer">
        <div class="totals">
          <div class="tot"><span class="label">Lines</span><span class="num v" data-testid="despatch-lines">{{ fmtInt(totals.lines) }}</span></div>
          <div class="tot"><span class="label">Units</span><span class="num v" data-testid="despatch-units">{{ fmtInt(totals.units) }}</span></div>
          <div class="tot">
            <span class="label">Store pays</span>
            <span class="num v accent" data-testid="despatch-value">{{ money(totals.wholesale_value) }}</span>
          </div>
          <div class="tot internal">
            <span class="label">Cost · margin<span class="warn"> · internal</span></span>
            <span class="num v small" data-testid="despatch-margin">
              {{ money(totals.cost_value) }} ·
              <span :class="marginTone(totals.margin_pct)">{{ marginPctText(totals.margin_pct) }}</span>
            </span>
          </div>
        </div>
        <div class="foot-say">
          <span v-if="problems.length" class="label crit">Houston cannot cover this basket.</span>
          <span v-else-if="!destination" class="label label-dim">Choose the store this box is going to.</span>
          <span v-else-if="!totals.units" class="label label-dim">Scan or search to fill the basket.</span>
          <span v-else-if="totals.unpriced" class="label warn">One line carries no wholesale price — it will ship, but it will not be valued.</span>
          <span v-else class="label label-dim">One consignment, straight onto the wall.</span>
        </div>
        <button class="btn btn-primary btn-big" :disabled="blocked || busy" data-testid="despatch-send" @click="send">
          {{ busy ? 'Sending…' : sendCopy(destination, totals, problems) }}
        </button>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.dest,
.finder,
.stamp {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.dest {
  padding: 12px 14px;
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
}
/* The destination is the one decision that governs the whole basket — say so until it is made.
   Deliberately **not** called `.empty`: this sheet already has an `.empty` state block, and a
   `.dest.empty` element picked up its `flex-direction: column` and 40 px padding, which turned
   the destination strip into a 490 px column with the two selects stranded at either end. */
.dest.unset {
  border-color: var(--accent);
}
.grow {
  flex: 1 1 320px;
  min-width: 0;
}
.sel {
  width: 170px;
}
.results {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 2px;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
  max-height: 240px;
  overflow-y: auto;
}
.result {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-areas: 'name qty' 'meta qty';
  gap: 2px 12px;
  width: 100%;
  min-height: var(--touch);
  padding: 8px 14px;
  text-align: left;
  align-items: center;
}
.result:hover {
  background: var(--accent-soft);
}
.rname {
  grid-area: name;
  font-size: 14px;
}
.result .label {
  grid-area: meta;
}
.rqty {
  grid-area: qty;
  font-size: 16px;
}
.note {
  margin: 0;
  min-height: 16px;
  text-transform: none;
  letter-spacing: 0.04em;
  font-size: 13px;
}
.banner {
  padding: 10px 12px;
  border: var(--line-w) solid currentColor;
  font-size: 13px;
}
.crit-banner {
  border-color: var(--crit);
  color: var(--crit);
  background: rgba(196, 115, 106, 0.08);
}
/* the refusal is multi-line with one `•` per item — never collapse it into a paragraph */
.pre {
  white-space: pre-line;
}
.empty {
  padding: 40px 16px;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  border: var(--line-w) dashed var(--line-strong);
}
.empty .muted {
  max-width: 56ch;
}
.scroller {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  max-height: 42vh;
  overflow-y: auto;
}
.scroller .table thead th {
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
}
.wide {
  max-width: 280px;
}
.new-here {
  color: var(--warn);
}
tr.over td {
  background: rgba(196, 115, 106, 0.08);
}
.pos-col {
  width: 132px;
}
.qty-col {
  width: 176px;
}
.val-col {
  width: 150px;
}
.acts-col {
  width: 1%;
  white-space: nowrap;
  text-align: right;
  /* positions the visually-hidden column header against this cell rather than the page */
  position: relative;
}
.money {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 15px;
}
.stepper {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 4px;
}
.step {
  width: var(--touch);
  min-height: var(--touch);
  border: var(--line-w) solid var(--line-strong);
  color: var(--text);
  font-family: var(--font-display);
  font-size: 18px;
  line-height: 1;
}
.step:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.qty {
  width: 72px;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
}
.compact {
  min-height: 40px;
  padding: 0 12px;
  letter-spacing: 0.1em;
}
/* the folded position line: desktop keeps the column, the phone keeps the row */
.pos-inline {
  display: none;
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
  margin-top: 2px;
}
.quiet-flag {
  margin: 0;
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.num-mono {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
}
.done {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  border: var(--line-w) solid var(--good);
}
.done-h {
  font-size: 20px;
  color: var(--good);
}
.done .muted {
  max-width: 84ch;
  font-size: 13px;
}
.foot {
  display: flex;
  align-items: center;
  gap: 16px;
  width: 100%;
  flex-wrap: wrap;
}
.totals {
  display: flex;
  gap: 20px;
}
.tot {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tot .v {
  font-size: 22px;
}
.tot .v.small {
  font-size: 15px;
}
.foot-say {
  flex: 1 1 220px;
  min-width: 0;
}
.foot-say .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
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
  .dest,
  .finder,
  .stamp {
    flex-direction: column;
    align-items: stretch;
  }
  .grow {
    flex: 0 0 auto;
  }
  .sel {
    width: 100%;
  }
  .scroller {
    max-height: none;
  }
  /* At 390 px five columns pushed the stepper off the right-hand edge: the manager could see a
     quantity but not reach the − and + that set it. The position and the value fold into the row
     they describe, so a line is just *what* and *how many*. */
  .pos-col,
  .val-col {
    display: none;
  }
  .pos-inline {
    display: block;
  }
  .qty-col {
    width: 1%;
  }
  .wide {
    max-width: 42vw;
  }
  .basket td,
  .basket th {
    padding: 10px 6px;
  }
  .qty {
    width: 52px;
  }
  .step {
    width: 40px;
  }
  .acts-col .compact {
    padding: 0 8px;
  }
  .foot {
    flex-direction: column;
    align-items: stretch;
  }
  /* four figures at desk size is a strip; at 390 px it was 470 px of an 844 px screen, and the
     basket it describes was squeezed into what was left. Two columns, small type. */
  .totals {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 6px 14px;
  }
  .tot .v {
    font-size: 15px;
  }
  .tot .v.small {
    font-size: 13px;
  }
  .tot .label {
    font-size: 10px;
    letter-spacing: 0.12em;
  }
  .foot {
    gap: 8px;
  }
  .foot-say .label {
    font-size: 11px;
  }
  /* a column flex container reads `flex-basis` as a height — 220 px of empty footer */
  .foot-say {
    flex: 0 0 auto;
  }
  .foot .btn,
  .foot .row {
    width: 100%;
  }
  .foot .row .btn {
    flex: 1;
  }
}
</style>
