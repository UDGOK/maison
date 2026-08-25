<script lang="ts">
/**
 * v1.2 §C — **the month-end statement**: what each store owes for a period.
 *
 * One row per store (client decision 5 — line detail belongs in the CSV, not on the screen),
 * netted of what the store did not actually receive (decision 4), showing Houston's cost and the
 * margin because it is an internal document (decision 3). Every enabled store appears, with zeros
 * when nothing was sent — an absent row reads as an oversight and somebody rings up about it.
 *
 * **It is a report, not an invoice.** Nothing on this screen may read as a receivable: there is no
 * "amount due", no ageing, no "outstanding", no payment state and no Send button. It says what it
 * is, in words, at the top — because sooner or later somebody forwards this to a store owner, and
 * the row next to what they are charged is what Houston paid.
 *
 * The two figures a reader will otherwise get wrong:
 *
 *  · **not priced** — consignments that shipped before v1.2 carry no stamped value. Their units
 *    are counted and never valued. A silent zero would read as "worth nothing".
 *  · **the chain total** — computed from the rows on screen (`statementTotals`), so the screen can
 *    be checked against itself, and never by adding eleven margin percentages together.
 */
import type { StatementStore } from '@/api/pricing'

/** The period presets, in the order a month end is actually run. */
export type PeriodPreset = 'last' | 'this' | 'custom'
export const PERIOD_PRESETS: { key: PeriodPreset; label: string }[] = [
  { key: 'last', label: 'Last month' },
  { key: 'this', label: 'This month' },
  { key: 'custom', label: 'Choose dates' }
]

/** Biggest bill first; a store with nothing shipped sorts by name, not to the top. */
export function sortStores(rows: StatementStore[]): StatementStore[] {
  return [...(rows || [])].sort((a, b) => b.wholesale_value - a.wholesale_value || String(a.boutique).localeCompare(String(b.boutique)))
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { usePricingStore } from '@/stores/pricing'
import {
  DO_NOT_SEND,
  INTERNAL_HEADLINE,
  NOT_AN_INVOICE,
  hasUnpriced,
  isQuiet,
  marginTone,
  monthToDate,
  netNote,
  periodProblem,
  previousMonth,
  statementTotals,
  unpricedNote
} from '@/warehouse/pricing'
import { fmtInt, fmtMoney } from '@/utils/money'
import { fmtDate, fmtDateTime, todayISO } from '@/utils/device'

const emit = defineEmits<{ notice: [msg: string] }>()

const pricing = usePricingStore()

const preset = ref<PeriodPreset>('last')
// the site clock, never the browser's — a run just past midnight in another zone would otherwise
// ask for the wrong month
const today = todayISO()
const last = previousMonth(today)
const from = ref(last.from)
const to = ref(last.to)
const boutique = ref('')

const statement = computed(() => pricing.statement)
const stores = computed(() => sortStores(statement.value?.stores ?? []))
/** Added up from the rows on screen, so the screen can be checked against itself. */
const totals = computed(() => statementTotals(stores.value))
const currency = computed(() => statement.value?.currency || pricing.currency)
const money = (n: number) => fmtMoney(n, currency.value)
const problem = computed(() => periodProblem({ from: from.value, to: to.value }))
const anyUnpriced = computed(() => hasUnpriced(stores.value))
const storeOptions = computed(() => (statement.value?.stores ?? []).map((s) => ({ code: s.boutique as string, name: s.boutique_name })))

function choose(key: PeriodPreset) {
  preset.value = key
  if (key === 'last') {
    const p = previousMonth(today)
    from.value = p.from
    to.value = p.to
    void load()
  } else if (key === 'this') {
    const p = monthToDate(today)
    from.value = p.from
    to.value = p.to
    void load()
  }
}

/** `quiet` on the first read: the desk banner is for something the manager did, not for a mount. */
async function load(quiet = false) {
  if (problem.value) return
  const out = await pricing.loadStatement(from.value, to.value, boutique.value || null)
  if (out && !quiet) emit('notice', `Statement ${fmtDate(out.from_date)} – ${fmtDate(out.to_date)} · ${out.shipments} consignment${out.shipments === 1 ? '' : 's'}`)
}

onMounted(async () => {
  await pricing.loadSettings()
  await load(true)
})
</script>

<template>
  <div class="statement" data-testid="statement-board">
    <!-- ============================================================ what this is, in words -->
    <section class="notice card" data-testid="statement-internal">
      <div class="ntop">
        <span class="pill pill-warn">Internal</span>
        <span class="display nhead">{{ INTERNAL_HEADLINE }}</span>
      </div>
      <p class="muted">{{ NOT_AN_INVOICE }} <b>{{ DO_NOT_SEND }}</b></p>
    </section>

    <!-- ============================================================ the period -->
    <div class="bar">
      <div class="seg">
        <button v-for="p in PERIOD_PRESETS" :key="p.key" class="chip" :class="{ active: preset === p.key }" :data-testid="`stmt-preset-${p.key}`" @click="choose(p.key)">
          {{ p.label }}
        </button>
      </div>
      <div v-if="preset === 'custom'" class="dates">
        <label class="label" for="stmt-from">From</label>
        <input id="stmt-from" v-model="from" class="input date" type="date" data-testid="stmt-from" />
        <label class="label" for="stmt-to">To</label>
        <input id="stmt-to" v-model="to" class="input date" type="date" data-testid="stmt-to" />
      </div>
      <select v-model="boutique" class="input sel" aria-label="Store" data-testid="stmt-store" @change="load()">
        <option value="">Every store</option>
        <option v-for="s in storeOptions" :key="s.code" :value="s.code">{{ s.name }}</option>
      </select>
      <div class="spacer"></div>
      <button class="btn btn-primary" :disabled="pricing.loading || !!problem" data-testid="stmt-run" @click="load()">
        {{ pricing.loading ? 'Working…' : 'Run statement' }}
      </button>
    </div>

    <div v-if="problem" class="banner crit-banner" data-testid="stmt-period-error">{{ problem }}</div>
    <div v-if="pricing.error" class="banner crit-banner" data-testid="stmt-error">
      <span>{{ pricing.error }}</span>
      <button class="btn btn-ghost" @click="pricing.clearError()">Dismiss</button>
    </div>

    <div v-if="!statement && pricing.loading" class="empty"><div class="label label-dim">Adding up the consignments…</div></div>

    <template v-else-if="statement">
      <!-- ============================================================ the chain -->
      <div class="kpis" data-testid="stmt-totals">
        <div class="kpi">
          <div class="label">What the stores owe</div>
          <div class="num v accent" data-testid="stmt-wholesale">{{ money(totals.wholesale_value) }}</div>
          <div class="label label-dim">{{ fmtInt(totals.billable_units) }} units actually received</div>
        </div>
        <div class="kpi">
          <div class="label">What it cost Houston<span class="warn"> · internal</span></div>
          <div class="num v" data-testid="stmt-cost">{{ money(totals.cost_value) }}</div>
          <div class="label label-dim">moving average when each consignment shipped</div>
        </div>
        <div class="kpi">
          <div class="label">AWANZ margin</div>
          <div class="num v" :class="marginTone(totals.margin_pct)" data-testid="stmt-margin">{{ money(totals.margin) }}</div>
          <div class="label label-dim">{{ totals.margin_pct }} % of what is charged</div>
        </div>
        <div class="kpi">
          <div class="label">Consignments</div>
          <div class="num v">{{ fmtInt(totals.shipments) }}</div>
          <div class="label label-dim">{{ fmtInt(totals.units) }} units shipped · {{ statement.markup_pct }}% chain markup</div>
        </div>
      </div>

      <div class="caption">
        <span class="label label-dim" data-testid="stmt-period">
          {{ fmtDate(statement.from_date) }} – {{ fmtDate(statement.to_date) }} · built {{ fmtDateTime(statement.generated_at) }}
        </span>
        <span class="label label-dim">Line detail is in the CSV export, not on this screen.</span>
      </div>

      <div v-if="anyUnpriced" class="banner warn-banner" data-testid="stmt-unpriced">
        Some consignments carry <b>no stamped value</b>: they shipped before wholesale pricing existed. Their units are counted and never valued — they are
        not worth nothing, they are simply not priced, and no figure on this statement guesses at them.
      </div>

      <!-- ============================================================ store by store -->
      <div class="tablewrap">
        <table class="table stmt">
          <thead>
            <tr>
              <th>Store</th>
              <th class="num">Consignments</th>
              <th class="num">Units sent</th>
              <th class="num">Not received</th>
              <th class="num">Billable</th>
              <th class="num">Owes</th>
              <th class="num">Cost · internal</th>
              <th class="num">Margin</th>
              <th class="num">Margin %</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in stores" :key="s.boutique || 'total'" :class="{ quiet: isQuiet(s) }" :data-testid="`stmt-${s.boutique}`">
              <td>
                <div class="ellipsis wide">{{ s.boutique_name }}</div>
                <div class="label label-dim">{{ s.boutique }}</div>
                <div v-if="unpricedNote(s)" class="label warn note" :data-testid="`stmt-unpriced-${s.boutique}`">{{ unpricedNote(s) }}</div>
              </td>
              <td class="num">{{ fmtInt(s.shipments) }}</td>
              <td class="num">{{ fmtInt(s.units) }}</td>
              <td class="num">
                <span v-if="netNote(s)" class="warn" :data-testid="`stmt-net-${s.boutique}`">{{ netNote(s) }}</span>
                <span v-else class="dim">—</span>
              </td>
              <td class="num">{{ fmtInt(s.billable_units) }}</td>
              <td class="num money accent" :data-testid="`stmt-owes-${s.boutique}`">{{ money(s.wholesale_value) }}</td>
              <td class="num money dim">{{ money(s.cost_value) }}</td>
              <td class="num money">{{ money(s.margin) }}</td>
              <td class="num" :class="marginTone(s.wholesale_value ? s.margin_pct : null)">{{ s.wholesale_value ? `${s.margin_pct} %` : '—' }}</td>
            </tr>
          </tbody>
          <tfoot>
            <tr data-testid="stmt-chain-total">
              <td><div class="display total-label">Chain total</div></td>
              <td class="num">{{ fmtInt(totals.shipments) }}</td>
              <td class="num">{{ fmtInt(totals.units) }}</td>
              <td class="num">
                <span v-if="netNote(totals)" class="warn">{{ netNote(totals) }}</span>
                <span v-else class="dim">—</span>
              </td>
              <td class="num">{{ fmtInt(totals.billable_units) }}</td>
              <td class="num money accent">{{ money(totals.wholesale_value) }}</td>
              <td class="num money dim">{{ money(totals.cost_value) }}</td>
              <td class="num money">{{ money(totals.margin) }}</td>
              <td class="num" :class="marginTone(totals.wholesale_value ? totals.margin_pct : null)">{{ totals.wholesale_value ? `${totals.margin_pct} %` : '—' }}</td>
            </tr>
          </tfoot>
        </table>
      </div>

      <p class="foot-note muted" data-testid="stmt-how">
        Bill from this by hand. Export <b>AWANZ Store Statement</b> from the Reports list with <i>detail</i> ticked for the per-item breakdown; nothing here
        records what a store has paid, and nothing chases it.
      </p>
    </template>
  </div>
</template>

<style scoped>
.statement {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.notice {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  border-left: 3px solid var(--warn);
}
.ntop {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.nhead {
  font-size: 15px;
  letter-spacing: 0;
  text-transform: none;
}
.notice p {
  max-width: 92ch;
  font-size: 13px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.seg {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.dates {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.date {
  width: 168px;
}
.sel {
  width: 220px;
}
.spacer {
  flex: 1;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  font-size: 13px;
}
.crit-banner {
  border-left: 3px solid var(--crit);
  background: rgba(196, 115, 106, 0.1);
  color: var(--crit);
}
.warn-banner {
  display: block;
  border-left: 3px solid var(--warn);
  background: rgba(211, 165, 91, 0.09);
  color: var(--text);
  max-width: 110ch;
}
.empty {
  padding: 48px 16px;
  text-align: center;
  border: var(--line-w) dashed var(--line-strong);
  background: var(--surface);
}
.kpis {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
}
.kpi {
  padding: 14px 18px;
  border-right: var(--line-w) solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.kpi:last-child {
  border-right: 0;
}
.kpi .v {
  font-size: 24px;
}
.kpi .label-dim {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.caption {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.caption .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.tablewrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
}
.stmt {
  min-width: 1040px;
}
.stmt th,
.stmt td {
  white-space: nowrap;
}
.wide {
  max-width: 240px;
}
.note {
  white-space: normal;
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 11px;
  max-width: 42ch;
  margin-top: 3px;
}
tr.quiet td {
  color: var(--dim);
}
.money {
  font-family: var(--font-display);
  font-weight: 800;
  font-variant-numeric: tabular-nums;
}
tfoot td {
  border-top: var(--line-w) solid var(--line-strong);
  border-bottom: 0;
  background: var(--surface-2);
}
.total-label {
  font-size: 13px;
}
.foot-note {
  font-size: 13px;
  max-width: 96ch;
}
@media (max-width: 1100px) {
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .kpi:nth-child(2) {
    border-right: 0;
  }
}
@media (max-width: 767px) {
  /* the internal notice has to be *read*, and it has to leave room for the figures it warns
     about: same words, tighter type */
  .notice {
    padding: 12px;
    gap: 6px;
  }
  .nhead {
    font-size: 14px;
  }
  .notice p {
    font-size: 12px;
  }
  .date,
  .sel {
    width: 100%;
  }
  .dates {
    width: 100%;
  }
  .dates .date {
    flex: 1 1 130px;
    width: auto;
  }
  .bar .btn {
    width: 100%;
  }
  /* four full-width tiles is four screens of scrolling before the table — two columns instead */
  .kpis {
    grid-template-columns: repeat(2, 1fr);
  }
  .kpi {
    padding: 10px 12px;
    border-bottom: var(--line-w) solid var(--line);
  }
  .kpi:nth-child(2n) {
    border-right: 0;
  }
  .kpi:nth-last-child(-n + 2) {
    border-bottom: 0;
  }
  .kpi .v {
    font-size: 18px;
  }
  .kpi .label-dim {
    font-size: 11px;
  }
}
</style>
