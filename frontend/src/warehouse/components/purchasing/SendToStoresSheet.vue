<script lang="ts">
/**
 * v1.1 §D — **Send to stores**: Houston pushes one item out to the eleven shops.
 *
 * Eleven stores with a quantity box each is a form. What makes it a *decision* is the context
 * beside each box — what that store already holds, how fast it sells it, how many days that
 * covers, and whether it has **ever sold the item at all**. So the position leads and the box
 * follows, on every row, at every width.
 *
 * The quick actions are one tap to a sensible starting point the manager then adjusts. *Split
 * evenly*, *Weight by sales* and *Top up* are the **server's** maths (`suggest_split`), not a
 * second implementation living in a component; *Same to all* and *Clear* are local because they
 * are not allocations, they are typing shortcuts.
 *
 * Two honest things this screen must say out loud:
 *
 *  · `suggest_split` is a **calculator, not a gate** — it will allocate more than Houston has. The
 *    footer's *left at Houston* figure turns red the moment it would go negative, **before** the
 *    send, and the Send button goes down. `send` is what actually refuses, and its refusal is
 *    multi-line with one bullet per item; it is rendered verbatim.
 *  · *Top up* can honestly allocate **nothing** — every store already covered is the common case
 *    on a well-stocked chain. The remainder is stated in words, with the cover-days control right
 *    there, rather than leaving the button looking broken.
 */
import type { SendResult, SplitResult } from '@/api/distribution'
import type { AllocationTotals } from '@/warehouse/distribution'

/** The sentence under the quick actions after a split — including the honest "nothing" case. */
export function splitNote(out: SplitResult): string {
  const mode = out.mode === 'velocity' ? 'Weighted by sales' : out.mode === 'topup' ? `Top up to ${out.cover_days} days` : 'Split evenly'
  const stores = out.lines.filter((l) => l.qty > 0).length
  // `split_by_velocity` falls back to an even split when there is no signal to weight by, which is
  // right — but saying "Weighted by sales" over a brand-new product with no sales anywhere is a
  // claim about history that does not exist, in exactly the case this release was built for.
  if (out.mode === 'velocity' && out.allocated > 0) {
    if (out.lines.every((l) => !l.velocity)) {
      return `No sales anywhere yet — split evenly across ${stores} store${stores === 1 ? '' : 's'} instead. Weight by sales once they have sold some.`
    }
    if (out.qty <= out.lines.length) {
      return `Only ${out.qty} to share — one each to the ${stores} busiest store${stores === 1 ? '' : 's'}, nothing to weight.`
    }
  }
  if (out.allocated <= 0) {
    if (out.mode === 'topup') {
      return `${mode} allocated nothing — every store already holds more than ${out.cover_days} days of cover. All ${out.qty} units stay at Houston. Raise the target to send anyway.`
    }
    return `${mode} allocated nothing — there is nothing to share out.`
  }
  const tail = out.remainder > 0 ? ` · ${out.remainder} left at Houston (every store is covered)` : ''
  return `${mode} — ${out.allocated} units across ${stores} store${stores === 1 ? '' : 's'}${tail}`
}

/** The copy on the Send button: it names the shipments it is about to create. */
export function pushCopy(totals: Pick<AllocationTotals, 'stores' | 'units' | 'over'>): string {
  if (totals.over) return 'More than Houston has'
  if (!totals.stores || !totals.units) return 'Nothing to send'
  return `Send ${totals.units} to ${totals.stores} store${totals.stores === 1 ? '' : 's'}`
}

/** The confirmation headline — one shipment per store, never batched (client decision 3). */
export function sentCopy(out: SendResult): string {
  return `${out.stores} shipment${out.stores === 1 ? '' : 's'} on the wall · ${out.units} unit${out.units === 1 ? '' : 's'} left Houston`
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { PUSH_PRIORITIES, type PlanStoreRow, type SplitMode } from '@/api/distribution'
import { useDistributionStore } from '@/stores/distribution'
import {
  allocationTotals,
  candidateStores,
  clearAllocation,
  coverAfter,
  coverText,
  coverTone,
  sameToAll,
  sendBlocked,
  sendLines,
  shortfallMessage,
  stocksIt,
  storyFor,
  validateAllocation,
  velocityText,
  type Allocation
} from '@/warehouse/distribution'
import { fmtInt } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'

const props = defineProps<{ itemCode: string; itemName?: string | null; reason?: string | null }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; sent: [out: SendResult] }>()

const dist = useDistributionStore()

const qty = ref<Allocation>({})
const pool = ref('')
const each = ref('6')
const coverTarget = ref('21')
const stockingOnly = ref(false)
const reason = ref(props.reason || '')
const priority = ref<string>('Normal')
const note = ref('')
const sent = ref<SendResult | null>(null)

const item = computed(() => dist.planFor(props.itemCode))
const rows = computed<PlanStoreRow[]>(() => item.value?.stores ?? [])
const candidates = computed(() => candidateStores(rows.value, stockingOnly.value))
const stocking = computed(() => rows.value.filter(stocksIt).length)
const totals = computed(() => allocationTotals(qty.value, item.value?.available ?? 0))
const problems = computed(() => validateAllocation(qty.value, rows.value))
const blocked = computed(() => sendBlocked(totals.value, problems.value))
const shortfall = computed(() => shortfallMessage(props.itemCode, totals.value))
const busy = computed(() => dist.busy === 'send')
const splitting = computed(() => (dist.busy || '').startsWith('split:'))

function num(value: unknown): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : 0
}

/** Every store starts at zero, so an unloaded row can never post an `undefined`. */
function seed() {
  const next: Allocation = {}
  for (const row of rows.value) next[row.boutique] = qty.value[row.boutique] ?? 0
  qty.value = next
}

async function load() {
  await dist.loadPlan([props.itemCode])
  seed()
  if (!pool.value) pool.value = String(Math.max(0, item.value?.available ?? 0))
}

onMounted(load)
watch(() => props.itemCode, load)

// ------------------------------------------------------------------ quantity boxes
function set(boutique: string, value: unknown) {
  qty.value = { ...qty.value, [boutique]: Math.max(0, Math.trunc(num(value))) }
}
function bump(boutique: string, by: number) {
  set(boutique, (qty.value[boutique] || 0) + by)
}

// ------------------------------------------------------------------ quick actions
/**
 * The three allocations come from the **server** so the maths is tested once, not re-implemented
 * here. Stores outside the candidate set are zeroed rather than left holding a stale figure.
 */
async function split(mode: SplitMode) {
  const codes = candidates.value.map((r) => r.boutique)
  if (!codes.length) {
    note.value = 'No store stocks this yet — turn the filter off to introduce it somewhere.'
    return
  }
  const want = mode === 'topup' ? Math.max(0, Math.trunc(num(pool.value))) || Math.max(0, item.value?.available ?? 0) : Math.max(0, Math.trunc(num(pool.value)))
  const out = await dist.suggest(props.itemCode, want, mode, mode === 'topup' ? Math.max(1, Math.trunc(num(coverTarget.value))) : null, codes)
  if (!out) return
  const next = clearAllocation(rows.value)
  for (const line of out.lines) next[line.boutique] = line.qty
  qty.value = next
  note.value = splitNote(out)
}

function applySameToAll() {
  const next = clearAllocation(rows.value)
  for (const [boutique, value] of Object.entries(sameToAll(num(each.value), candidates.value))) next[boutique] = value
  qty.value = next
  const n = Math.max(0, Math.trunc(num(each.value)))
  note.value = `${n} to each of ${candidates.value.length} store${candidates.value.length === 1 ? '' : 's'} — ${n * candidates.value.length} units`
}

function toggleStocking() {
  stockingOnly.value = !stockingOnly.value
  if (!stockingOnly.value) {
    note.value = 'All eleven stores are back in play.'
    return
  }
  // zero the stores this filter just took out of play, so the footer cannot lie
  const next = { ...qty.value }
  for (const row of rows.value) if (!stocksIt(row)) next[row.boutique] = 0
  qty.value = next
  note.value = stocking.value
    ? `${stocking.value} of ${rows.value.length} stores stock this — the rest are out of the quick actions.`
    : 'No store stocks this yet. Turn the filter off to introduce it somewhere.'
}

function clearAll() {
  qty.value = clearAllocation(rows.value)
  note.value = ''
  dist.clearError()
}

// ------------------------------------------------------------------ send
async function send() {
  const lines = sendLines(props.itemCode, qty.value)
  const out = await dist.send(lines, reason.value.trim() || null, priority.value)
  if (!out) return
  sent.value = out
  dist.clearNotice()
  emit('notice', sentCopy(out))
  emit('sent', out)
}

function done() {
  emit('close')
}
</script>

<template>
  <Modal :title="sent ? 'Sent to stores' : `Send ${itemCode} to stores`" width="1120px" @close="emit('close')">
    <!-- ============================================================ confirmation -->
    <div v-if="sent" class="sheet" data-testid="send-confirmation">
      <div class="done">
        <div class="display done-h">{{ sentCopy(sent) }}</div>
        <p class="muted">
          One shipment per store — separate parcels, separate labels. They are on the wall now, waiting to be picked, and each store's Receive screen
          already lists its own.
        </p>
      </div>
      <div class="scroller">
        <table class="table">
          <thead>
            <tr>
              <th>Store</th>
              <th>Shipment</th>
              <th>Request</th>
              <th class="num">Units</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sent.shipments" :key="s.name" :data-testid="`sent-${s.boutique}`">
              <td>
                <div class="ellipsis wide">{{ s.boutique_name || s.boutique }}</div>
                <div class="label label-dim">{{ s.boutique }}</div>
              </td>
              <td class="num-mono">{{ s.name }}</td>
              <td class="num-mono muted">{{ s.replenishment_request || '—' }}</td>
              <td class="num">{{ fmtInt(s.units) }}</td>
              <td><span class="pill pill-accent">{{ s.status }}</span></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="label label-dim">
        Stamped “{{ sent.reason }}” at {{ sent.priority }} priority, and marked as a warehouse push — so every report can tell it apart from a store's
        own request for ever.
      </p>
    </div>

    <!-- ============================================================ the sheet -->
    <div v-else class="sheet" data-testid="send-sheet">
      <div class="head">
        <div class="head-id">
          <div class="display item">{{ item?.item_name || itemName || itemCode }}</div>
          <div class="label label-dim">
            {{ itemCode }}<span v-if="item?.barcode"> · {{ item.barcode }}</span><span v-if="item?.item_group"> · {{ item.item_group }}</span>
            <span v-if="dist.asOf"> · as of {{ fmtDateTime(dist.asOf) }}</span>
          </div>
        </div>
        <div class="houston">
          <div class="hk">
            <span class="label">On hand</span>
            <span class="num v">{{ fmtInt(item?.on_hand ?? 0) }}</span>
          </div>
          <div class="hk">
            <span class="label">Committed</span>
            <span class="num v" :class="{ warn: (item?.committed ?? 0) > 0 }">{{ fmtInt(item?.committed ?? 0) }}</span>
          </div>
          <div class="hk">
            <span class="label">Available</span>
            <span class="num v accent">{{ fmtInt(item?.available ?? 0) }}</span>
          </div>
        </div>
      </div>

      <div v-if="item && !item.is_stock_item" class="banner crit" data-testid="send-not-stock">
        {{ itemCode }} is not a stock item, so it cannot be shipped to a store.
      </div>
      <div v-else-if="item?.disabled" class="banner crit" data-testid="send-disabled">{{ itemCode }} is disabled — enable it before sending it out.</div>

      <div v-if="dist.error" class="banner crit pre" data-testid="send-error">{{ dist.error }}</div>

      <!-- quick actions: one tap to a sensible starting point -->
      <div class="quick" data-testid="send-quick">
        <div class="qcard">
          <label class="label" for="dist-pool">Share out</label>
          <div class="row qrow">
            <input id="dist-pool" v-model="pool" class="input qnum" inputmode="numeric" data-testid="send-pool" />
            <span class="label label-dim">units</span>
          </div>
          <div class="row qbtns">
            <button class="btn" :disabled="splitting" data-testid="send-split-even" @click="split('even')">Split evenly</button>
            <button class="btn" :disabled="splitting" data-testid="send-split-velocity" @click="split('velocity')">Weight by sales</button>
          </div>
        </div>
        <div class="qcard">
          <label class="label" for="dist-each">Give every store</label>
          <div class="row qrow">
            <input id="dist-each" v-model="each" class="input qnum" inputmode="numeric" data-testid="send-each" />
            <span class="label label-dim">each</span>
          </div>
          <div class="row qbtns">
            <button class="btn" data-testid="send-same-all" @click="applySameToAll">Same to all</button>
          </div>
        </div>
        <div class="qcard">
          <label class="label" for="dist-cover">Top up to</label>
          <div class="row qrow">
            <input id="dist-cover" v-model="coverTarget" class="input qnum" inputmode="numeric" data-testid="send-cover-days" />
            <span class="label label-dim">days of cover</span>
          </div>
          <div class="row qbtns">
            <button class="btn" :disabled="splitting" data-testid="send-split-topup" @click="split('topup')">Top up</button>
          </div>
        </div>
        <div class="qcard qfilters">
          <span class="label">Who is in play</span>
          <button class="chip" :class="{ active: stockingOnly }" data-testid="send-stocking-only" @click="toggleStocking">
            Only stores that stock it<span class="label-dim"> · {{ stocking }}</span>
          </button>
          <button class="chip" data-testid="send-clear" @click="clearAll">Clear</button>
        </div>
      </div>

      <p class="note label" :class="{ 'label-dim': !note }" data-testid="send-note">{{ note || 'Pick a starting point, then adjust any store by hand.' }}</p>

      <!-- the stores -->
      <div v-if="dist.loading && !rows.length" class="empty" data-testid="send-loading">
        <div class="label label-dim">Reading every store's position…</div>
      </div>
      <div v-else-if="!rows.length" class="empty" data-testid="send-no-stores">
        <div class="display" style="font-size: 18px">No store to send to</div>
        <p class="muted">Every shop is disabled, or this bench has none. Houston cannot push to itself.</p>
      </div>
      <div v-else class="scroller">
        <table class="table stores">
          <thead>
            <tr>
              <th>Store</th>
              <th class="num pos-col">On hand</th>
              <th class="num pos-col">Sells</th>
              <th class="num pos-col">Cover</th>
              <th class="num send-col">Send</th>
              <th class="after-col">After</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="r in rows"
              :key="r.boutique"
              :class="{ dimmed: stockingOnly && !stocksIt(r), picked: (qty[r.boutique] || 0) > 0 }"
              :data-testid="`send-row-${r.boutique}`"
            >
              <td>
                <div class="ellipsis wide">{{ r.boutique_name || r.boutique }}</div>
                <div class="label label-dim">
                  {{ r.boutique }}<span v-if="r.city"> · {{ r.city }}</span>
                  <span v-if="!r.ever_sold" class="new-here"> · never sold here</span>
                </div>
                <!-- on a phone the three position columns fold into the row they describe: the
                     stepper is the one thing that must never be pushed off the right edge -->
                <div class="label pos-inline">
                  <span :class="{ crit: r.on_hand <= 0 }">{{ fmtInt(r.on_hand) }} on hand</span> ·
                  <span :class="{ dim: !r.velocity }">{{ velocityText(r.velocity) }}</span> ·
                  <span :class="coverTone(r.cover_days)">{{ coverText(r.cover_days) }}</span>
                  <span v-if="(qty[r.boutique] || 0) > 0" class="accent"> → {{ coverText(coverAfter(r, qty[r.boutique] || 0)) }}</span>
                </div>
              </td>
              <td class="num pos-col" :class="{ crit: r.on_hand <= 0 }">{{ fmtInt(r.on_hand) }}</td>
              <td class="num pos-col" :class="{ dim: !r.velocity }">{{ velocityText(r.velocity) }}</td>
              <td class="num pos-col" :data-testid="`send-cover-${r.boutique}`">
                <span :class="coverTone(r.cover_days)">{{ coverText(r.cover_days) }}</span>
              </td>
              <td class="num send-col">
                <div class="stepper">
                  <button class="step" :aria-label="`One fewer for ${r.boutique}`" :data-testid="`send-minus-${r.boutique}`" @click="bump(r.boutique, -1)">−</button>
                  <input
                    class="input qty"
                    inputmode="numeric"
                    :value="qty[r.boutique] ?? 0"
                    :aria-label="`Units for ${r.boutique}`"
                    :data-testid="`send-qty-${r.boutique}`"
                    @input="set(r.boutique, ($event.target as HTMLInputElement).value)"
                  />
                  <button class="step" :aria-label="`One more for ${r.boutique}`" :data-testid="`send-plus-${r.boutique}`" @click="bump(r.boutique, 1)">+</button>
                </div>
              </td>
              <td class="after-col">
                <span v-if="(qty[r.boutique] || 0) > 0" class="label story">{{ storyFor(r, qty[r.boutique] || 0) }}</span>
                <span v-else class="label label-dim story">—</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <div v-if="problems.length" class="banner crit" data-testid="send-problems">
        <div v-for="p in problems" :key="p.boutique">{{ p.message }}</div>
      </div>

      <div class="stamp">
        <div class="field grow">
          <label class="label" for="dist-reason">Why (stamped on every request)</label>
          <input
            id="dist-reason"
            v-model="reason"
            class="input"
            placeholder="e.g. new product — one case each to try"
            data-testid="send-reason"
          />
        </div>
        <div class="field">
          <label class="label" for="dist-priority">Priority</label>
          <select id="dist-priority" v-model="priority" class="input sel" data-testid="send-priority">
            <option v-for="p in PUSH_PRIORITIES" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
      </div>
    </div>

    <template #footer>
      <div v-if="sent" class="foot">
        <span class="label label-dim">{{ sent.shipments.length }} on the wall</span>
        <button class="btn btn-primary btn-big" data-testid="send-done" @click="done">Done</button>
      </div>
      <div v-else class="foot" data-testid="send-footer">
        <div class="totals">
          <div class="tot">
            <span class="label">Stores</span>
            <span class="num v" data-testid="send-total-stores">{{ fmtInt(totals.stores) }}</span>
          </div>
          <div class="tot">
            <span class="label">Units</span>
            <span class="num v" data-testid="send-total-units">{{ fmtInt(totals.units) }}</span>
          </div>
          <div class="tot">
            <span class="label">Left at Houston</span>
            <span class="num v" :class="totals.tone" data-testid="send-left">{{ fmtInt(totals.left) }}</span>
          </div>
        </div>
        <div class="foot-say">
          <span v-if="shortfall" class="label crit" data-testid="send-shortfall">{{ shortfall }}</span>
          <span v-else-if="totals.tone === 'warn' && totals.units" class="label warn">That is every unit Houston has of it.</span>
          <span v-else-if="!totals.units" class="label label-dim">Nothing allocated yet.</span>
          <span v-else class="label label-dim">Creates {{ totals.stores }} shipment{{ totals.stores === 1 ? '' : 's' }}, one per store.</span>
        </div>
        <button class="btn btn-primary btn-big" :disabled="blocked || busy" data-testid="send-go" @click="send">
          {{ busy ? 'Sending…' : pushCopy(totals) }}
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
.houston {
  display: flex;
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
}
.hk {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 16px;
  border-right: var(--line-w) solid var(--line);
  min-width: 96px;
}
.hk:last-child {
  border-right: 0;
}
.hk .v {
  font-size: 22px;
}
.banner {
  padding: 10px 12px;
  border: var(--line-w) solid currentColor;
}
/* `send`'s refusal is multi-line with one `•` per item — never collapse it into a paragraph */
.pre {
  white-space: pre-line;
}

/* ---------- quick actions ---------- */
.quick {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}
.qcard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
}
.qrow {
  align-items: center;
  gap: 8px;
}
.qnum {
  width: 84px;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
}
.qbtns {
  gap: 8px;
  flex-wrap: wrap;
}
.qbtns .btn {
  flex: 1 1 auto;
  padding: 0 14px;
}
.qfilters {
  justify-content: flex-start;
  gap: 8px;
}
.qfilters .chip {
  min-height: var(--touch);
  padding: 8px 14px;
  text-align: left;
  /* `.chip` is `nowrap` by default and this one is a sentence — it was clipped at the card edge */
  white-space: normal;
  line-height: 1.3;
}
.note {
  margin: 0;
  min-height: 16px;
  text-transform: none;
  letter-spacing: 0.04em;
  font-size: 13px;
}

/* ---------- the stores ---------- */
.scroller {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  max-height: 46vh;
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
.new-here {
  color: var(--warn);
}
/* the folded position line: desktop keeps the columns, the phone keeps the row */
.pos-inline {
  display: none;
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
  margin-top: 2px;
}
tr.picked td {
  background: var(--accent-soft);
}
tr.dimmed td {
  opacity: 0.45;
}
.send-col {
  width: 172px;
}
.after-col {
  min-width: 210px;
}
.story {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
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
  background: transparent;
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
.empty {
  padding: 32px 0;
  text-align: center;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
}
.num-mono {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 13px;
}

/* ---------- stamp ---------- */
.stamp {
  display: flex;
  gap: 12px;
  align-items: flex-end;
  flex-wrap: wrap;
}
.grow {
  flex: 1 1 320px;
  min-width: 0;
}
.sel {
  width: 160px;
}

/* ---------- confirmation ---------- */
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

/* ---------- footer ---------- */
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
  font-size: 24px;
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

@media (max-width: 900px) {
  .quick {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@media (max-width: 767px) {
  .quick {
    grid-template-columns: 1fr;
    gap: 8px;
  }
  /* label, number and buttons on as few lines as they will honestly fit in */
  .qcard {
    flex-direction: row;
    flex-wrap: wrap;
    align-items: center;
    padding: 10px;
    gap: 8px;
  }
  .qcard > .label {
    flex: 1 1 100%;
  }
  .qrow {
    flex: 0 0 auto;
  }
  .qbtns {
    flex: 1 1 150px;
  }
  /* `flex-wrap: wrap` above turns a *column* container into a multi-column one: these two chips
     wrapped into a second column and hung 38 px off the right-hand edge of the sheet. */
  .qfilters {
    flex-direction: column;
    flex-wrap: nowrap;
    align-items: stretch;
  }
  /* `.head` stays a row here: a 100% basis is what makes the title wrap instead of sizing to its
     own content and running off the right edge. `flex: 0 0 auto` sized it to max-content. */
  .head-id {
    flex: 1 1 100%;
  }
  .item {
    font-size: 17px;
    overflow-wrap: anywhere;
  }
  .houston {
    width: 100%;
  }
  .hk {
    flex: 1;
    min-width: 0;
  }
  .scroller {
    max-height: none;
  }
  /* `.ellipsis` is `nowrap`, so with no max-width the longest store name sets the table's
     min-content width and the stepper slid under the right-hand edge again */
  .wide {
    max-width: 40vw;
  }
  .stores td,
  .stores th {
    padding: 10px 8px;
  }
  /* At 390 px the six columns pushed the stepper clean off the right-hand edge: the manager could
     see a quantity but not reach the − and + that set it. The three position columns and the
     "after" story fold into the store cell instead, so the row is just *where* and *how many*. */
  .pos-col,
  .after-col {
    display: none;
  }
  .pos-inline {
    display: block;
  }
  .send-col {
    width: 1%;
  }
  .qty {
    width: 52px;
  }
  .step {
    width: 40px;
  }
  .foot {
    flex-direction: column;
    align-items: stretch;
  }
  .totals {
    justify-content: space-between;
  }
  /* a column flex container reads `flex-basis` as a height: 220px of empty footer, and the store
     rows squeezed off the screen behind it (the same trap StockBoard's `.head-id` fell into) */
  .foot-say {
    flex: 0 0 auto;
  }
  .foot .btn {
    width: 100%;
  }
  .sel {
    width: 100%;
  }
}
</style>
