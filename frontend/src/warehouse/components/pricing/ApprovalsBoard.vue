<script lang="ts">
/**
 * v1.2 §D — **Approvals**: head office's queue of shelf-price changes.
 *
 * One card per request: which store, which item, what it sells at now, what they want, who asked,
 * **why**, and — because head office is the only party who may see it — the margin the store makes
 * now against the margin it would make at the proposed price. Approve or reject in one tap.
 *
 * Two rules:
 *
 *  · **A reject must say why.** Approving is silent; rejecting sends a store manager away with no
 *    price change and no explanation unless one is typed, so the reason box opens with the reject.
 *  · **Approving is what creates the store-scoped Pricing Rule.** That is v0.1 behaviour driven by
 *    the workflow, and nothing here reimplements it — this screen only drives
 *    `purchasing.approve_price_change` and re-reads the queue.
 *
 * `margin_now` / `margin_proposed` are attached by the server **only for a purchasing admin**. A
 * row that arrives without them renders an em dash rather than a fabricated zero.
 */
import type { MarginView, PriceChangeRequest } from '@/api/pricing'

/** The queue's status filter, in the order head office works them. */
export const REQUEST_STATUSES = ['Pending Approval', 'Approved', 'Rejected', 'all'] as const

/** Pending first, then newest — an approved row is history, a pending one is work. */
export function sortRequests(rows: PriceChangeRequest[]): PriceChangeRequest[] {
  const rank = (r: PriceChangeRequest) => (r.workflow_state === 'Pending Approval' ? 0 : r.workflow_state === 'Rejected' ? 2 : 1)
  return [...(rows || [])].sort((a, b) => rank(a) - rank(b) || b.name.localeCompare(a.name))
}

/** "−$2.00 a unit" · "+$1.50 a unit" · "no change" — what the shelf price is moving by. */
export function moveCopy(from: number, to: number, fmt: (n: number) => string): string {
  const delta = Math.round(((Number(to) || 0) - (Number(from) || 0) + Number.EPSILON) * 100) / 100
  if (!delta) return 'no change'
  return `${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta))} a unit`
}

/**
 * Does this row carry the margin figures? A store manager reading their own queue gets exactly
 * the payload v1.0 gave them — no wholesale, no margin — because what we pay for the stock is not
 * shop-floor information. The card must render that case, not assume the keys are there.
 */
export function hasMargins(row: PriceChangeRequest): row is PriceChangeRequest & { margin_now: MarginView; margin_proposed: MarginView } {
  return !!row.margin_now && !!row.margin_proposed
}

export function stateTone(state: string): string {
  if (state === 'Pending Approval') return 'pill-accent'
  if (state === 'Rejected') return 'pill-crit'
  if (state === 'Approved') return 'pill-good'
  return ''
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { usePricingStore } from '@/stores/pricing'
import { decisionProblem, marginPctText, marginTone } from '@/warehouse/pricing'
import { fmtMoney } from '@/utils/money'
import { fmtDate, fmtDateTime } from '@/utils/device'

const emit = defineEmits<{ notice: [msg: string]; 'open-item': [itemCode: string] }>()

const pricing = usePricingStore()

const status = ref<string>('Pending Approval')
const storeFilter = ref('')
/** the request a reject is being written for */
const rejecting = ref<string | null>(null)
const rejectReason = ref('')

const rows = computed(() => {
  const list = sortRequests(pricing.requests)
  return storeFilter.value ? list.filter((r) => r.boutique === storeFilter.value) : list
})
const stores = computed(() => [...new Set(pricing.requests.map((r) => r.boutique))].sort())
const currency = computed(() => pricing.currency)
const money = (n: number) => fmtMoney(n, currency.value)
const rejectProblem = computed(() => decisionProblem('Reject', rejectReason.value))

async function load() {
  await pricing.loadSettings()
  await pricing.loadRequests({ status: status.value })
}
onMounted(load)
watch(status, load)

function drain() {
  if (pricing.notice) {
    emit('notice', pricing.notice)
    pricing.clearNotice()
  }
}

async function approve(name: string) {
  const out = await pricing.decide(name, 'Approve')
  if (out) {
    drain()
    await pricing.loadRequests({ status: status.value })
  }
}
async function reject() {
  if (!rejecting.value || rejectProblem.value) return
  const out = await pricing.decide(rejecting.value, 'Reject', rejectReason.value.trim())
  if (out) {
    rejecting.value = null
    rejectReason.value = ''
    drain()
    await pricing.loadRequests({ status: status.value })
  }
}
</script>

<template>
  <div class="approvals" data-testid="approvals-board">
    <div class="bar">
      <div class="seg">
        <button
          v-for="s in REQUEST_STATUSES"
          :key="s"
          class="chip"
          :class="{ active: status === s }"
          :data-testid="`appr-status-${s.replace(/\s+/g, '-').toLowerCase()}`"
          @click="status = s"
        >
          {{ s === 'all' ? 'All' : s === 'Pending Approval' ? 'Waiting' : s }}
        </button>
      </div>
      <select v-if="stores.length > 1" v-model="storeFilter" class="input sel" aria-label="Store" data-testid="appr-store">
        <option value="">Every store</option>
        <option v-for="s in stores" :key="s" :value="s">{{ s }}</option>
      </select>
      <div class="spacer"></div>
      <button class="btn" :disabled="pricing.loading" data-testid="appr-refresh" @click="load">{{ pricing.loading ? 'Working…' : 'Refresh' }}</button>
    </div>

    <div v-if="pricing.error" class="banner crit-banner" data-testid="appr-error">
      <span>{{ pricing.error }}</span>
      <button class="btn btn-ghost" @click="pricing.clearError()">Dismiss</button>
    </div>

    <div v-if="pricing.loading && !rows.length" class="empty"><div class="label label-dim">Reading the queue…</div></div>
    <div v-else-if="!rows.length" class="empty" data-testid="appr-empty">
      <div class="display" style="font-size: 18px">
        {{ status === 'Pending Approval' ? 'Nothing waiting for head office' : 'No request matches that filter' }}
      </div>
      <div class="muted">
        {{
          status === 'Pending Approval'
            ? 'Every shelf price change has been decided. A store raises one from its own price board; head office approves it here, and approving is what writes the store’s pricing rule.'
            : 'Widen the filter to see the rest of the queue.'
        }}
      </div>
    </div>

    <div v-else class="rows">
      <article v-for="r in rows" :key="r.name" class="req" :class="{ decided: r.workflow_state !== 'Pending Approval' }" :data-testid="`appr-${r.name}`">
        <header class="rhead">
          <div class="who">
            <div class="display store">{{ r.boutique }}</div>
            <div class="label label-dim">{{ r.name }} · asked by {{ (r.requested_by || 'somebody').split('@')[0] }}</div>
          </div>
          <button class="link item" :data-testid="`appr-item-${r.name}`" @click="emit('open-item', r.item_code)">
            <span class="ellipsis">{{ r.item_name || r.item_code }}</span>
            <span class="label label-dim">{{ r.item_code }}</span>
          </button>
          <span class="pill" :class="stateTone(r.workflow_state)">{{ r.workflow_state === 'Pending Approval' ? 'Waiting' : r.workflow_state }}</span>
        </header>

        <div class="figures">
          <div class="fig">
            <span class="label">Sells at</span>
            <span class="num v">{{ money(r.current_rate) }}</span>
            <span class="label label-dim">
              margin
              <span v-if="hasMargins(r)" :class="marginTone(r.margin_now.margin_pct)">{{ marginPctText(r.margin_now.margin_pct) }}</span>
              <span v-else>—</span>
            </span>
          </div>
          <div class="arrow" aria-hidden="true">→</div>
          <div class="fig">
            <span class="label">Wants</span>
            <span class="num v accent" :data-testid="`appr-proposed-${r.name}`">{{ money(r.proposed_rate) }}</span>
            <span class="label label-dim">
              margin
              <span v-if="hasMargins(r)" :class="marginTone(r.margin_proposed.margin_pct)" :data-testid="`appr-margin-${r.name}`">
                {{ marginPctText(r.margin_proposed.margin_pct) }}
              </span>
              <span v-else>—</span>
            </span>
          </div>
          <div class="fig">
            <span class="label">Change</span>
            <span class="num v">{{ moveCopy(r.current_rate, r.proposed_rate, money) }}</span>
            <span class="label label-dim">
              <span v-if="r.wholesale">store pays us {{ money(r.wholesale) }}</span>
              <span v-else>wholesale not shown</span>
            </span>
          </div>
          <div class="fig">
            <span class="label">In force</span>
            <span class="num v small">{{ r.valid_from ? fmtDate(r.valid_from) : 'straight away' }}</span>
            <span class="label label-dim">{{ r.valid_upto ? `until ${fmtDate(r.valid_upto)}` : 'no end date' }}</span>
          </div>
        </div>

        <p class="reason" :data-testid="`appr-reason-${r.name}`">{{ r.reason || 'No reason was given.' }}</p>

        <footer class="ract">
          <span v-if="r.workflow_state !== 'Pending Approval'" class="label label-dim">
            {{ r.workflow_state }} by {{ (r.approved_by || 'head office').split('@')[0] }}<span v-if="r.approved_on"> · {{ fmtDateTime(r.approved_on) }}</span>
            <span v-if="r.pricing_rule"> · rule {{ r.pricing_rule }}</span>
          </span>
          <template v-else>
            <span class="label label-dim">Approving writes {{ r.boutique }}’s pricing rule for {{ r.item_code }}.</span>
            <div class="row">
              <button
                class="btn btn-crit"
                :disabled="pricing.busy === r.name"
                :data-testid="`appr-reject-${r.name}`"
                @click="((rejecting = r.name), (rejectReason = ''))"
              >
                Reject…
              </button>
              <button class="btn btn-primary" :disabled="pricing.busy === r.name" :data-testid="`appr-approve-${r.name}`" @click="approve(r.name)">
                {{ pricing.busy === r.name ? 'Working…' : 'Approve' }}
              </button>
            </div>
          </template>
        </footer>
      </article>
    </div>

    <Modal v-if="rejecting" :title="`Reject ${rejecting}`" @close="rejecting = null">
      <p class="muted" style="margin-bottom: 12px">
        The store keeps its current price. Say why — the manager who asked reads this, and a rejection with no reason is how a shop stops asking.
      </p>
      <div class="field">
        <label class="label" for="reject-reason">Why it is being rejected</label>
        <input
          id="reject-reason"
          v-model="rejectReason"
          class="input"
          :class="{ bad: !!rejectProblem }"
          placeholder="e.g. margin is too thin — hold at 24.99 until the next buy"
          data-testid="reject-reason"
        />
        <span v-if="rejectProblem" class="label crit" data-testid="reject-error">{{ rejectProblem }}</span>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="rejecting = null">Keep it waiting</button>
        <button class="btn btn-crit" :disabled="!!rejectProblem || pricing.busy === rejecting" data-testid="reject-confirm" @click="reject">Reject it</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.approvals {
  display: flex;
  flex-direction: column;
  gap: 14px;
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
.sel {
  width: 200px;
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
  font-size: 14px;
}
.crit-banner {
  border-left: 3px solid var(--crit);
  background: rgba(196, 115, 106, 0.1);
  color: var(--crit);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 56px 16px;
  text-align: center;
  border: var(--line-w) dashed var(--line-strong);
  background: var(--surface);
}
.empty .muted {
  max-width: 62ch;
}
.rows {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.req {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px 16px;
  border: var(--line-w) solid var(--line);
  border-left: 3px solid var(--accent);
  background: var(--surface);
}
.req.decided {
  border-left-color: var(--line-strong);
  opacity: 0.78;
}
.rhead {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
}
.store {
  font-size: 16px;
}
.who {
  min-width: 0;
}
.item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: flex-start;
  text-align: left;
  min-width: 0;
  max-width: 320px;
  margin-left: auto;
  padding: 0;
  min-height: 0;
  color: var(--accent);
}
.item .ellipsis {
  max-width: 320px;
}
.figures {
  display: flex;
  align-items: stretch;
  gap: 1px;
  background: var(--line);
  border: var(--line-w) solid var(--line);
  flex-wrap: wrap;
}
.fig {
  flex: 1 1 150px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 10px 12px;
  background: var(--ground);
  min-width: 0;
}
.fig .v {
  font-size: 20px;
}
.fig .v.small {
  font-size: 14px;
}
.fig .label-dim {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.arrow {
  display: flex;
  align-items: center;
  padding: 0 8px;
  background: var(--ground);
  color: var(--dim);
  font-size: 18px;
}
.reason {
  margin: 0;
  padding: 10px 12px;
  border-left: 2px solid var(--line-strong);
  background: var(--surface-2);
  color: var(--muted);
  font-size: 13px;
  white-space: pre-line;
}
.ract {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
}
.ract .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
.link {
  padding: 0;
  min-height: 0;
  min-width: 0;
}
.input.bad {
  border-color: var(--crit);
}
@media (max-width: 767px) {
  .sel {
    width: 100%;
  }
  /* a right-floating 100 px stub under a full-width select reads as a mistake — full width */
  .bar .spacer {
    display: none;
  }
  .bar > .btn {
    flex: 1 1 100%;
  }
  .item {
    margin-left: 0;
    max-width: 100%;
  }
  .item .ellipsis {
    max-width: 70vw;
  }
  .arrow {
    display: none;
  }
  .fig {
    flex: 1 1 44%;
  }
  .ract .row {
    width: 100%;
  }
  .ract .row .btn {
    flex: 1;
  }
}
</style>
