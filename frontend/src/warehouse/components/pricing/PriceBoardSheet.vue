<script lang="ts">
/**
 * v1.2 §D — **the price board that never existed.**
 *
 * `AWANZ Price Change Request` and the `AWANZ Price Approval` workflow have been in the app since
 * v0.1, and v1.0 gave them endpoints. No screen has ever called them: setting a store's shelf
 * price meant filling in a submittable document in the ERP back office. This is the screen.
 *
 * Every enabled store as a row: the price in force, **where that price comes from** (a store
 * override or the chain default), what the store pays Houston, and the margin that price makes.
 * Type a new price on any row and it raises a request for that store; type on several rows and it
 * raises several. Approving is what creates the store-scoped Pricing Rule — that is v0.1
 * behaviour, and nothing here reimplements it.
 *
 * Three things this screen has to get right, and each one is a rule rather than a preference:
 *
 *  · **A reason is required.** The server refuses a blank one — *"Say why the price is changing —
 *    head office reads it when they approve"* — so it is collected here rather than met as a
 *    server error after eleven prices have been typed. It is one box for the sheet, because a
 *    manager repricing four shops is doing it for one reason.
 *  · **A store already waiting is not invited to ask again.** A row with a pending request shows
 *    what was asked and by whom instead of a price box; raising a second one for the same store
 *    and item would give head office two documents and one shelf.
 *  · **`margin_pct` is `null` on an unpriced item** and renders `—`. An item the chain has never
 *    priced is not a 0 % margin (`warehouse/pricing.ts::marginPctText`).
 *
 * Cost, wholesale and margin are **internal AWANZ figures**. The sheet says so in words, because
 * this screen is one screenshot away from a store owner.
 */
import type { StorePriceRow } from '@/api/pricing'

/** "Waiting on head office since Tue — Bixby asked for $22.99" — the copy on a pending row. */
export function pendingCopy(row: StorePriceRow, fmt: (n: number) => string): string {
  if (!row.pending) return ''
  const who = (row.pending.requested_by || '').split('@')[0] || 'somebody'
  return `${who} asked for ${fmt(row.pending.proposed_rate)} — waiting for approval`
}

/** "from Aug 26" · "Aug 26 – Sep 15" · "" — how long an override or a request is good for. */
export function windowCopy(from?: string | null, upto?: string | null, fmtDay: (d: string) => string = (d) => d): string {
  const a = (from || '').slice(0, 10)
  const b = (upto || '').slice(0, 10)
  if (!a && !b) return ''
  if (a && b) return `${fmtDay(a)} – ${fmtDay(b)}`
  if (a) return `from ${fmtDay(a)}`
  return `until ${fmtDay(b)}`
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { usePricingStore } from '@/stores/pricing'
import {
  boardProblems,
  boardSummary,
  changeCopy,
  isTouched,
  marginAt,
  marginPctText,
  marginTone,
  proposalsFrom,
  raiseCopy,
  raisedCopy,
  wholesaleSourceCopy,
  type PriceDraft
} from '@/warehouse/pricing'
import { fmtMoney } from '@/utils/money'
import { fmtDate } from '@/utils/device'

const props = defineProps<{ itemCode: string; itemName?: string | null }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; changed: [] }>()

const pricing = usePricingStore()

const drafts = ref<Record<string, PriceDraft>>({})
/** One reason for the sheet: a manager repricing four shops is doing it for one reason. */
const reason = ref('')
const validFrom = ref('')
const validUpto = ref('')
const raised = ref<string[]>([])
const posting = ref(false)

const board = computed(() => (pricing.board?.item_code === props.itemCode ? pricing.board : null))
const rows = computed<StorePriceRow[]>(() => board.value?.stores ?? [])
const currency = computed(() => board.value?.currency || 'USD')
const money = (n: number) => fmtMoney(n, currency.value)
const day = (d: string) => fmtDate(d)

const proposals = computed(() => proposalsFrom(board.value, drafts.value))
const problems = computed(() => boardProblems(board.value, drafts.value))
const rateProblems = computed(() => {
  const out: Record<string, string> = {}
  for (const p of problems.value) {
    const rate = p.problems.find((x) => x.field === 'rate')
    if (rate) out[p.boutique] = rate.message
  }
  return out
})
const reasonProblem = computed(() => problems.value.some((p) => p.problems.some((x) => x.field === 'reason')))
const touchedCount = computed(() => rows.value.filter((r) => isTouched(drafts.value[r.boutique])).length)

function draftFor(boutique: string): PriceDraft {
  if (!drafts.value[boutique]) drafts.value[boutique] = { rate: '', reason: reason.value }
  return drafts.value[boutique]
}
function setRate(boutique: string, value: string) {
  drafts.value = { ...drafts.value, [boutique]: { ...draftFor(boutique), rate: value, reason: reason.value, valid_from: validFrom.value, valid_upto: validUpto.value } }
}
/** The shared reason is written onto every touched row, so the pure maths still sees per-row data. */
watch([reason, validFrom, validUpto], () => {
  const next: Record<string, PriceDraft> = {}
  for (const [boutique, draft] of Object.entries(drafts.value)) {
    next[boutique] = { ...draft, reason: reason.value, valid_from: validFrom.value, valid_upto: validUpto.value }
  }
  drafts.value = next
})

/** What one row's margin becomes at the price being typed into it. */
function proposedMargin(row: StorePriceRow) {
  const typed = Number(drafts.value[row.boutique]?.rate)
  if (!Number.isFinite(typed) || typed <= 0) return null
  return marginAt(typed, row.wholesale)
}

async function load() {
  drafts.value = {}
  raised.value = []
  await pricing.loadSettings()
  await pricing.loadBoard(props.itemCode)
}
onMounted(load)
watch(() => props.itemCode, load)

async function raise() {
  const wanted = proposals.value
  if (!wanted.length) return
  posting.value = true
  pricing.clearError()
  const names: string[] = []
  let failed = 0
  for (const p of wanted) {
    const out = await pricing.raisePriceChange(p.item_code, p.boutique, p.proposed_rate, {
      reason: p.reason,
      valid_from: p.valid_from,
      valid_upto: p.valid_upto
    })
    if (out) names.push(out.name)
    else failed += 1
  }
  posting.value = false
  raised.value = names
  if (names.length) {
    drafts.value = {}
    reason.value = ''
    await pricing.loadBoard(props.itemCode)
    emit('notice', raisedCopy(names, failed))
    emit('changed')
  }
}

function clearAll() {
  drafts.value = {}
  reason.value = ''
  validFrom.value = ''
  validUpto.value = ''
  pricing.clearError()
}
</script>

<template>
  <Modal :title="`Prices · ${itemCode}`" width="1180px" @close="emit('close')">
    <div class="sheet" data-testid="price-board">
      <!-- ============================================================ what it is -->
      <header class="head">
        <div class="head-id">
          <div class="display item">{{ board?.item_name || itemName || itemCode }}</div>
          <div class="label label-dim">
            {{ itemCode }}<span v-if="board?.barcode"> · {{ board.barcode }}</span><span v-if="board?.item_group"> · {{ board.item_group }}</span>
            <span v-if="board"> · {{ board.price_list }}</span>
          </div>
        </div>
        <div class="internal" data-testid="price-internal">
          <div class="ik">
            <span class="label">What it cost us</span>
            <span class="num v">{{ money(board?.cost ?? 0) }}</span>
          </div>
          <div class="ik">
            <span class="label">Store pays us</span>
            <span class="num v accent">{{ money(board?.wholesale ?? 0) }}</span>
          </div>
          <div class="ik">
            <span class="label">Chain default</span>
            <span class="num v">{{ board?.default_rate ? money(board.default_rate) : '—' }}</span>
          </div>
        </div>
      </header>

      <p class="banner internal-note" data-testid="price-internal-note">
        <b>Internal.</b> {{ board?.notice || 'Cost and wholesale are internal AWANZ figures — do not put them in front of a store.' }}
        <span class="label label-dim"> {{ wholesaleSourceCopy(board?.wholesale_source || 'markup', board?.markup_pct ?? pricing.markupPct) }}.</span>
      </p>

      <div v-if="pricing.error" class="banner crit-banner pre" data-testid="price-error">
        <span>{{ pricing.error }}</span>
        <button class="btn btn-ghost" @click="pricing.clearError()">Dismiss</button>
      </div>

      <div v-if="raised.length" class="banner good-banner" data-testid="price-raised">
        {{ raisedCopy(raised) }} — head office decides on the Approvals board.
      </div>

      <p class="label label-dim summary" data-testid="price-summary">{{ boardSummary(board) }}</p>

      <!-- ============================================================ the stores -->
      <div v-if="pricing.loading && !rows.length" class="empty" data-testid="price-loading">
        <div class="label label-dim">Reading every store’s shelf price…</div>
      </div>
      <div v-else-if="!rows.length" class="empty" data-testid="price-no-stores">
        <div class="display" style="font-size: 18px">No store to price this for</div>
        <p class="muted">Every shop is disabled, or this bench has none.</p>
      </div>
      <div v-else class="scroller">
        <table class="table stores">
          <thead>
            <tr>
              <th>Store</th>
              <th class="num">Sells at</th>
              <th class="where-col">Where from</th>
              <th class="num">Store margin</th>
              <th class="num new-col">New price</th>
              <th class="after-col">Becomes</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.boutique"
              :class="{ typed: isTouched(drafts[r.boutique]), waiting: !!r.pending }"
              :data-testid="`price-row-${r.boutique}`"
            >
              <td>
                <div class="ellipsis wide">{{ r.boutique_name || r.boutique }}</div>
                <div class="label label-dim">{{ r.boutique }}</div>
                <!-- on a phone the middle columns fold into the row they describe: the price box
                     is the one thing that must never be pushed off the right edge -->
                <div class="label fold">
                  <span>{{ r.has_price ? money(r.rate) : 'no price' }}</span> ·
                  <span :class="{ accent: r.is_override }">{{ r.source }}</span> ·
                  <span :class="marginTone(r.margin_pct)">{{ marginPctText(r.margin_pct) }}</span>
                </div>
              </td>
              <td class="num money" :class="{ dim: !r.has_price }">{{ r.has_price ? money(r.rate) : '—' }}</td>
              <td class="where-col">
                <span class="pill" :class="r.is_override ? 'pill-accent' : ''">{{ r.source }}</span>
                <div v-if="r.is_override" class="label label-dim">
                  {{ r.pricing_rule }}<span v-if="windowCopy(r.valid_from, r.valid_upto, day)"> · {{ windowCopy(r.valid_from, r.valid_upto, day) }}</span>
                </div>
              </td>
              <td class="num" :data-testid="`price-margin-${r.boutique}`">
                <span class="num" :class="marginTone(r.margin_pct)">{{ marginPctText(r.margin_pct) }}</span>
                <div class="label label-dim">{{ r.has_price ? money(r.margin) : 'never priced' }}</div>
              </td>
              <td class="num new-col">
                <template v-if="r.pending">
                  <span class="pill pill-warn" :data-testid="`price-pending-${r.boutique}`">Waiting</span>
                  <div class="label label-dim pending-note">{{ pendingCopy(r, money) }}</div>
                </template>
                <template v-else>
                  <input
                    class="input rate"
                    inputmode="decimal"
                    placeholder="—"
                    :value="drafts[r.boutique]?.rate ?? ''"
                    :aria-label="`New price for ${r.boutique_name || r.boutique}`"
                    :data-testid="`price-input-${r.boutique}`"
                    @input="setRate(r.boutique, ($event.target as HTMLInputElement).value)"
                  />
                  <div v-if="rateProblems[r.boutique]" class="label crit rowerr" :data-testid="`price-rowerr-${r.boutique}`">{{ rateProblems[r.boutique] }}</div>
                </template>
              </td>
              <td class="after-col">
                <template v-if="r.pending">
                  <span class="label label-dim story">{{ r.pending.reason || 'no reason given' }}</span>
                </template>
                <template v-else-if="proposedMargin(r)">
                  <span class="label story">{{ changeCopy(r.rate, Number(drafts[r.boutique]?.rate), money) }}</span>
                  <div class="label story">
                    margin
                    <span :class="marginTone(proposedMargin(r)!.margin_pct)">{{ marginPctText(proposedMargin(r)!.margin_pct) }}</span>
                    <span class="label-dim"> ({{ money(proposedMargin(r)!.margin) }} a unit)</span>
                  </div>
                </template>
                <span v-else class="label label-dim story">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <!-- ============================================================ why -->
      <div class="why">
        <div class="field grow">
          <label class="label" for="pb-reason">Why the price is changing<span class="label-dim"> — head office reads this when they approve</span></label>
          <input
            id="pb-reason"
            v-model="reason"
            class="input"
            :class="{ bad: reasonProblem }"
            placeholder="e.g. matching the shop two doors down"
            data-testid="price-reason"
          />
          <span v-if="reasonProblem" class="label crit" data-testid="price-reason-error">
            Say why the price is changing — head office reads it when they approve.
          </span>
        </div>
        <div class="field">
          <label class="label" for="pb-from">In force from</label>
          <input id="pb-from" v-model="validFrom" class="input date" type="date" data-testid="price-from" />
        </div>
        <div class="field">
          <label class="label" for="pb-upto">Until</label>
          <input id="pb-upto" v-model="validUpto" class="input date" type="date" data-testid="price-upto" />
        </div>
      </div>
    </div>

    <template #footer>
      <div class="foot" data-testid="price-footer">
        <div class="totals">
          <div class="tot">
            <span class="label">Typed</span>
            <span class="num v" data-testid="price-typed">{{ touchedCount }}</span>
          </div>
          <div class="tot">
            <span class="label">Will raise</span>
            <span class="num v accent" data-testid="price-will-raise">{{ proposals.length }}</span>
          </div>
        </div>
        <div class="foot-say">
          <!-- a blank reason is not a red row, and telling somebody to fix one sends them hunting -->
          <span v-if="reasonProblem && problems.every((p) => p.problems.every((x) => x.field === 'reason'))" class="label crit">
            Say why the price is changing — the box is under the table.
          </span>
          <span v-else-if="problems.length" class="label crit">Fix the rows marked in red first.</span>
          <span v-else-if="!touchedCount" class="label label-dim">Type a new price on any store to raise a change for it. Several rows raises several requests.</span>
          <span v-else class="label label-dim">One request per store, each waiting for head office. Approving is what writes the store’s pricing rule.</span>
        </div>
        <button v-if="touchedCount" class="btn btn-ghost" data-testid="price-clear" @click="clearAll">Clear</button>
        <button class="btn btn-primary btn-big" :disabled="!proposals.length || !!problems.length || posting" data-testid="price-raise" @click="raise">
          {{ posting ? 'Raising…' : raiseCopy(proposals, problems) }}
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
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-wrap: wrap;
}
.head-id {
  flex: 1 1 280px;
  min-width: 0;
}
.item {
  font-size: 22px;
}
.internal {
  display: flex;
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
}
.ik {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 16px;
  border-right: var(--line-w) solid var(--line);
  min-width: 108px;
}
.ik:last-child {
  border-right: 0;
}
.ik .v {
  font-size: 20px;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 13px;
}
/* the internal warning is a statement of fact, not an error — gold, not red */
.internal-note {
  display: block;
  border-left: 3px solid var(--accent);
  background: var(--accent-soft);
  color: var(--text);
}
.crit-banner {
  border-left: 3px solid var(--crit);
  background: rgba(196, 115, 106, 0.1);
  color: var(--crit);
}
.good-banner {
  border-left: 3px solid var(--good);
  background: rgba(127, 169, 138, 0.1);
  color: var(--good);
}
/* a server refusal can be multi-line — never collapse it into a paragraph */
.pre {
  white-space: pre-line;
}
.summary {
  margin: 0;
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.empty {
  padding: 32px 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.scroller {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  max-height: 48vh;
  overflow-y: auto;
}
.scroller .table thead th {
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
}
.wide {
  max-width: 240px;
}
tr.typed td {
  background: var(--accent-soft);
}
tr.waiting td {
  opacity: 0.72;
}
.money {
  font-family: var(--font-display);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
.where-col {
  min-width: 168px;
}
.new-col {
  width: 168px;
}
.after-col {
  min-width: 230px;
}
.story,
.pending-note,
.rowerr {
  display: block;
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
  line-height: 1.35;
}
.rate {
  width: 116px;
  min-height: var(--touch);
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
  border-color: var(--line-strong);
}
.input.bad {
  border-color: var(--crit);
}
/* the folded position line: desktop keeps the columns, the phone keeps the row */
.fold {
  display: none;
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
  margin-top: 3px;
}
.why {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  flex-wrap: wrap;
}
.grow {
  flex: 1 1 340px;
  min-width: 0;
}
.date {
  width: 170px;
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
  gap: 22px;
}
.tot {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.tot .v {
  font-size: 22px;
}
.foot-say {
  flex: 1 1 240px;
  min-width: 0;
}
.foot-say .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
@media (max-width: 767px) {
  .head-id {
    flex: 1 1 100%;
  }
  .item {
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  .internal {
    width: 100%;
  }
  .ik {
    flex: 1;
    min-width: 0;
    padding: 8px 10px;
  }
  .ik .v {
    font-size: 16px;
  }
  .scroller {
    max-height: none;
  }
  /* At 390 px six columns pushed the price box clean off the right-hand edge: the manager could
     read a price but not reach the box that changes it. The middle three fold into the store
     cell, so the row is just *which shop* and *what price*. */
  .where-col,
  .after-col,
  .stores td.num.money,
  .stores th.num.money,
  .stores td:nth-child(2),
  .stores th:nth-child(2),
  .stores td:nth-child(4),
  .stores th:nth-child(4) {
    display: none;
  }
  .fold {
    display: block;
  }
  .wide {
    max-width: 44vw;
    white-space: normal;
  }
  .new-col {
    width: 1%;
  }
  .rate {
    width: 92px;
  }
  .stores td,
  .stores th {
    padding: 10px 8px;
  }
  .date,
  .grow {
    flex: 1 1 100%;
    width: 100%;
  }
  .foot {
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
  }
  /* the eleven rows above matter more than the two counters: keep the footer a footer */
  .totals {
    justify-content: flex-start;
    gap: 26px;
  }
  .tot .v {
    font-size: 16px;
  }
  .foot-say .label {
    font-size: 11px;
  }
  /* a column flex container reads `flex-basis` as a height — 240 px of empty footer */
  .foot-say {
    flex: 0 0 auto;
  }
  .foot .btn {
    width: 100%;
  }
}
</style>
