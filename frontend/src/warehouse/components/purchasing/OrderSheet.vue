<script lang="ts">
/**
 * v1.0 "Procurement" §D — one purchase order.
 *
 * Locked decisions this screen exists to honour:
 *   3. **Freight is manual.** One prominent currency field on the order; it lands in the
 *      moving-average cost of everything on it. Setting it to 0 removes the charge.
 *   4. **Every price is manually overridable.** The rate on every line is a plain input, in the
 *      open — not behind a menu.
 *   6. **Buying is centralised in Houston.** A drop-ship order is the only way a vendor delivers
 *      to a store, and the whole order goes there.
 *
 * Totals are `buying.ts` (`orderNet`, `orderLanded`, `freightSharePerUnit`) so the screen, the
 * receive sheet and the server never disagree.
 */
import { freightSharePerUnit, orderLanded, orderNet } from '../../buying'
import type { PurchaseOrderDetail } from '@/api/purchasing'

export interface FreightView {
  units: number
  net: number
  freight: number
  /** freight spread evenly over every unit on the order */
  perUnit: number
  /** net + freight — what the stock is actually worth when it lands */
  landed: number
}

/** Exactly what the freight panel renders. */
export function freightView(lines: { qty: number; rate: number }[], freight = 0): FreightView {
  const rows = lines || []
  const amount = Number(freight) || 0
  return {
    units: rows.reduce((sum, l) => sum + (Number(l.qty) || 0), 0),
    net: orderNet(rows),
    freight: amount,
    perUnit: freightSharePerUnit(rows, amount),
    landed: orderLanded(rows, amount)
  }
}

/**
 * Why this order cannot be edited — '' when it can. `can_edit` is "draft **and** the caller may
 * buy", so a false value is either the state of the document or the role of the person.
 */
export function readOnlyReason(order: Pick<PurchaseOrderDetail, 'can_edit' | 'docstatus' | 'status'> | null): string {
  if (!order || order.can_edit) return ''
  if (order.docstatus === 2) return 'This order was cancelled. Nothing on it can be changed.'
  if (order.status === 'Closed') return 'This order is closed. Its lines, rates and freight are final.'
  if (order.docstatus === 1) return 'This order is submitted — quantities, rates and freight are fixed. Close it if the buy is off.'
  return 'Read only. Buying is centralised in Houston: only a warehouse admin or head office may edit an order.'
}

/**
 * A bare `YYYY-MM-DD` used to render a day early west of UTC. `utils/time.ts::parseServer` now
 * reads a date-only string as a site-zone calendar day, so this is a pass-through kept for the
 * screens that already call it.
 */
export function dayStamp(value?: string | null): string {
  return (value || '').trim()
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { usePurchasingStore } from '@/stores/purchasing'
import { useWarehouseStore } from '@/stores/warehouse'
import { ORDER_METHODS, type OrderMethod, type SendOrderResult } from '@/api/purchasing'
import { fmtDate, fmtDateTime } from '@/utils/device'
import { fmtInt, fmtMoney } from '@/utils/money'

const props = defineProps<{ order: string }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; changed: [] }>()

const store = usePurchasingStore()
const wh = useWarehouseStore()

interface LineDraft {
  qty: number
  rate: number
}
const draft = ref<Record<string, LineDraft>>({})
const freight = ref(0)
const dropship = ref('')
const dropshipNote = ref('')
const sendOpen = ref(false)
const sendMethod = ref<OrderMethod | string>('Email')
const recipient = ref('')
const sent = ref<SendOrderResult | null>(null)
const closing = ref(false)
const closeReason = ref('')
const localError = ref('')

const doc = computed(() => (store.orderDetail?.name === props.order ? store.orderDetail : null))
const vendor = computed(() => doc.value?.supplier_profile ?? null)
const currency = computed(() => doc.value?.currency || 'USD')
const readOnly = computed(() => readOnlyReason(doc.value))
const editable = computed(() => !!doc.value?.can_edit)
const busy = computed(() => store.busy === props.order)
const stores = computed(() => wh.me?.stores || [])

const lines = computed(() => doc.value?.items ?? [])
const edited = computed(() => lines.value.map((l) => ({ qty: draft.value[l.name]?.qty ?? l.qty, rate: draft.value[l.name]?.rate ?? l.rate })))
const view = computed(() => freightView(edited.value, freight.value))
const dirty = computed(() => {
  if (!doc.value) return false
  if ((Number(freight.value) || 0) !== doc.value.freight) return true
  return lines.value.some((l) => (draft.value[l.name]?.qty ?? l.qty) !== l.qty || (draft.value[l.name]?.rate ?? l.rate) !== l.rate)
})
const dropshipDirty = computed(() => dropship.value !== (doc.value?.dropship_store || ''))

function seed() {
  const d = doc.value
  if (!d) return
  draft.value = Object.fromEntries(d.items.map((l) => [l.name, { qty: l.qty, rate: l.rate }]))
  freight.value = d.freight
  dropship.value = d.dropship_store || ''
  sendMethod.value = ORDER_METHODS.includes(d.supplier_profile?.order_method as OrderMethod) ? (d.supplier_profile.order_method as OrderMethod) : 'Email'
  recipient.value = d.supplier_profile?.rep_email || ''
}

async function load() {
  localError.value = ''
  sent.value = null
  dropshipNote.value = ''
  const out = await store.loadOrder(props.order)
  if (out) seed()
}
onMounted(load)
watch(() => props.order, load)
watch(doc, (d, prev) => {
  // reseed after a write replaced the document (a save, a submit, a send)
  if (d && d !== prev) seed()
})

/** Run a store write: it never throws — it sets `notice` on success and `error` on failure. */
async function run<T>(fn: () => Promise<T | null>): Promise<T | null> {
  localError.value = ''
  const out = await fn()
  if (out) {
    if (store.notice) {
      emit('notice', store.notice)
      store.clearNotice()
    }
    emit('changed')
  }
  return out
}

async function save() {
  const wanted = dropship.value
  const changingStore = dropshipDirty.value
  const payload = lines.value.map((l) => ({ item_code: l.item_code, qty: draft.value[l.name]?.qty ?? l.qty, rate: draft.value[l.name]?.rate ?? l.rate }))
  const out = await run(() => store.updateOrder(props.order, payload, Number(freight.value) || 0))
  if (!out) return
  // `update_order` carries lines and freight only — an existing order's destination is fixed.
  dropshipNote.value =
    changingStore && (out.dropship_store || '') !== wanted
      ? `Lines and freight saved. The delivery address could not be changed on an order that already exists — it is set when the order is created. Create the order from Buying with the store chosen, and close this one.`
      : ''
  if (dropshipNote.value) dropship.value = out.dropship_store || ''
}

const submit = () => run(() => store.submitOrder(props.order))

async function send() {
  if (sendMethod.value === 'Email' && !recipient.value.trim()) {
    localError.value = 'An e-mail address is needed, or record the order as sent by phone or portal.'
    return
  }
  const out = await run(() => store.sendOrder(props.order, sendMethod.value, sendMethod.value === 'Email' ? recipient.value.trim() : undefined))
  if (out) {
    sent.value = out
    sendOpen.value = false
  }
}

async function closeOrder() {
  if (!closeReason.value.trim()) {
    localError.value = 'A reason is kept with the order — say why it is being closed.'
    return
  }
  const out = await run(() => store.closeOrder(props.order, closeReason.value.trim()))
  if (out) {
    closing.value = false
    closeReason.value = ''
  }
}

const pendingOf = (qty: number, received: number) => Math.max(0, qty - received)
const statusTone = (status: string, docstatus: number) =>
  docstatus === 0 ? 'pill-accent' : status === 'Completed' ? 'pill-good' : status === 'Closed' || status === 'Cancelled' ? 'pill-crit' : 'pill-accent-fill'
</script>

<template>
  <Modal :title="order" width="1100px" @close="emit('close')">
    <div v-if="store.error || localError" class="banner crit-banner" data-testid="order-error">
      <span>{{ localError || store.error }}</span>
      <button class="btn btn-ghost" @click="((localError = ''), store.clearError())">Dismiss</button>
    </div>

    <div v-if="!doc && store.loading" class="empty"><div class="label label-dim">Loading order…</div></div>
    <div v-else-if="!doc" class="empty" data-testid="order-missing">
      <div class="display" style="font-size: 18px">Order not available</div>
      <div class="muted">{{ order }} could not be opened. It may have been cancelled, or you may not have access to it.</div>
      <button class="btn" @click="load">Try again</button>
    </div>

    <div v-else class="sheet" data-testid="order-sheet">
      <!-- header -->
      <header class="ohead">
        <div class="who">
          <div class="display vname">{{ doc.supplier_name || doc.supplier }}</div>
          <div class="label label-dim">
            {{ doc.supplier }}<span v-if="vendor?.account_number"> · our account {{ vendor.account_number }}</span>
          </div>
          <div v-if="vendor" class="rep">
            <span>{{ vendor.rep_name || 'No rep on file' }}</span>
            <span v-if="vendor.rep_phone" class="muted">· {{ vendor.rep_phone }}</span>
            <span v-if="vendor.rep_email" class="muted">· {{ vendor.rep_email }}</span>
            <span class="pill">{{ vendor.order_method || 'Email' }}</span>
          </div>
        </div>
        <div class="when">
          <span class="pill" :class="statusTone(doc.status, doc.docstatus)" data-testid="order-status">{{ doc.docstatus === 0 ? 'Draft' : doc.status }}</span>
          <div class="label label-dim">Ordered {{ fmtDate(dayStamp(doc.transaction_date)) }}</div>
          <div class="label label-dim">Expected {{ fmtDate(dayStamp(doc.schedule_date)) }}</div>
          <div v-if="doc.dropship_store" class="pill pill-warn" data-testid="order-dropship">Drop-ship · {{ doc.dropship_store }}</div>
          <div v-else class="label label-dim">{{ doc.set_warehouse || 'HOU-WH' }}</div>
        </div>
      </header>

      <div v-if="readOnly" class="banner readonly" data-testid="order-readonly">{{ readOnly }}</div>

      <!-- lines -->
      <section class="block">
        <div class="between">
          <div class="section-title">Lines</div>
          <div class="label label-dim">{{ fmtInt(view.units) }} units · every rate is editable while the order is a draft</div>
        </div>
        <div class="tablewrap">
          <table class="table">
            <thead>
              <tr>
                <th>Item</th>
                <th class="num">Ordered</th>
                <th class="num rate-col">Unit rate</th>
                <th class="num">Amount</th>
                <th class="num">Received</th>
                <th class="num">Pending</th>
              </tr>
            </thead>
            <tbody>
              <!-- guarded: the drafts are seeded the moment the document lands, but never render a row without one -->
              <template v-for="l in lines" :key="l.name">
              <tr v-if="draft[l.name]" :data-testid="`order-line-${l.item_code}`">
                <td>
                  <div class="ellipsis" style="max-width: 320px">{{ l.item_name || l.item_code }}</div>
                  <div class="label label-dim">{{ l.item_code }}<span v-if="l.uom"> · {{ l.uom }}</span></div>
                </td>
                <td class="num">
                  <input
                    v-model.number="draft[l.name].qty"
                    class="input cell"
                    inputmode="numeric"
                    :disabled="!editable || busy"
                    :aria-label="`Quantity for ${l.item_code}`"
                    :data-testid="`order-qty-${l.item_code}`"
                  />
                </td>
                <td class="num rate-col">
                  <div class="rate" :class="{ locked: !editable }">
                    <span class="cur label">{{ currency }}</span>
                    <input
                      v-model.number="draft[l.name].rate"
                      class="input cell rate-in"
                      inputmode="decimal"
                      :disabled="!editable || busy"
                      :aria-label="`Unit rate for ${l.item_code}`"
                      :data-testid="`order-rate-${l.item_code}`"
                    />
                  </div>
                  <div v-if="editable && draft[l.name].rate !== l.rate" class="label warn">was {{ fmtMoney(l.rate, currency) }}</div>
                </td>
                <td class="num money">{{ fmtMoney((draft[l.name]?.qty ?? l.qty) * (draft[l.name]?.rate ?? l.rate), currency) }}</td>
                <td class="num" :class="{ good: l.received_qty > 0 }">{{ fmtInt(l.received_qty) }}</td>
                <td class="num" :class="{ dim: pendingOf(l.qty, l.received_qty) === 0 }">{{ fmtInt(pendingOf(l.qty, l.received_qty)) }}</td>
              </tr>
              </template>
            </tbody>
          </table>
        </div>
      </section>

      <!-- freight + totals -->
      <section class="block freight" data-testid="order-freight">
        <div class="fgrid">
          <div class="field fbox">
            <label class="label" for="freight-amount">Freight on this order</label>
            <div class="rate big" :class="{ locked: !editable }">
              <span class="cur label">{{ currency }}</span>
              <input
                id="freight-amount"
                v-model.number="freight"
                class="input cell rate-in"
                inputmode="decimal"
                :disabled="!editable || busy"
                data-testid="order-freight-input"
              />
            </div>
            <div class="label label-dim">Entered by hand. Set it to 0 to remove the charge.</div>
          </div>
          <div class="fstat"><span class="label">Freight per unit</span><span class="num v" data-testid="order-freight-per-unit">{{ fmtMoney(view.perUnit, currency) }}</span></div>
          <div class="fstat"><span class="label">Net</span><span class="num v">{{ fmtMoney(view.net, currency) }}</span></div>
          <div class="fstat lead"><span class="label">Landed total</span><span class="num v accent" data-testid="order-landed">{{ fmtMoney(view.landed, currency) }}</span></div>
        </div>
        <p class="explain">
          Freight is spread across the order and lands in each item's moving-average cost — it is what the stock is really worth, so there is no
          separate landed-cost paperwork.
        </p>
      </section>

      <!-- drop-ship -->
      <section class="block">
        <div class="section-title">Deliver to</div>
        <div class="row wrap">
          <select
            v-model="dropship"
            class="input pick"
            :disabled="!editable || busy || !vendor?.dropship_capable"
            aria-label="Drop-ship destination"
            data-testid="order-dropship-picker"
          >
            <option value="">Houston warehouse — {{ doc.set_warehouse || 'HOU-WH' }}</option>
            <option v-for="s in stores" :key="s" :value="s">Drop-ship direct to {{ s }}</option>
          </select>
          <span v-if="!vendor?.dropship_capable" class="label label-dim">{{ doc.supplier_name || doc.supplier }} is not marked drop-ship capable on their profile.</span>
          <span v-else-if="!editable" class="label label-dim">Set while the order is a draft.</span>
        </div>
        <p v-if="dropship" class="warnbox" data-testid="order-dropship-warning">
          Every line on this order is delivered to <b>{{ dropship }}</b> instead of the Houston warehouse. That store receives it on their own Receive
          screen; nothing is shipped on from Houston.
        </p>
        <p v-if="dropshipNote" class="warnbox" data-testid="order-dropship-note">{{ dropshipNote }}</p>
      </section>

      <!-- sending -->
      <section class="block">
        <div class="between">
          <div class="section-title">Sent to the vendor</div>
          <button v-if="doc.docstatus === 1 && doc.status !== 'Closed'" class="btn" :disabled="busy" data-testid="order-send-open" @click="sendOpen = !sendOpen">
            {{ doc.sent_on ? 'Send again' : 'Send order' }}
          </button>
        </div>
        <div v-if="doc.sent_on" class="sentline good" data-testid="order-sent">
          Sent {{ fmtDateTime(doc.sent_on) }} by {{ doc.sent_method }}<span v-if="doc.sent_by"> · {{ doc.sent_by }}</span>
        </div>
        <div v-else class="label label-dim">{{ doc.docstatus === 1 ? 'Not sent yet.' : 'Submit the order before sending it.' }}</div>
        <div v-if="sent?.warning" class="warnbox" data-testid="order-send-warning">{{ sent.warning }}</div>
        <div v-else-if="sent && !sent.emailed && sent.method === 'Email'" class="warnbox">The order is stamped as sent, but no e-mail left this site.</div>

        <div v-if="sendOpen" class="sendbox">
          <div class="seg">
            <button v-for="m in ORDER_METHODS" :key="m" class="chip" :class="{ active: sendMethod === m }" :data-testid="`send-method-${m}`" @click="sendMethod = m">{{ m }}</button>
          </div>
          <div v-if="sendMethod === 'Email'" class="field">
            <label class="label" for="send-to">Send the order PDF to</label>
            <input id="send-to" v-model="recipient" class="input" placeholder="rep@vendor.example" data-testid="send-recipient" />
            <div class="label label-dim">Defaults to the rep on the vendor profile — override it for a one-off.</div>
          </div>
          <div v-else class="label label-dim">
            {{ sendMethod === 'Portal' ? 'Records that the order was keyed into the vendor portal.' : sendMethod === 'Phone' ? 'Records that the order was placed by phone.' : 'Records that the order went out over EDI.' }}
          </div>
          <div class="row" style="justify-content: flex-end">
            <button class="btn btn-ghost" :disabled="busy" @click="sendOpen = false">Cancel</button>
            <button class="btn btn-primary" :disabled="busy" data-testid="order-send" @click="send">{{ busy ? 'Sending…' : `Send by ${sendMethod}` }}</button>
          </div>
        </div>
      </section>

      <!-- what actually arrived -->
      <section v-if="doc.receipts.length || doc.discrepancies.length" class="block">
        <div class="section-title">What arrived</div>
        <div v-if="doc.receipts.length" class="tablewrap">
          <table class="table">
            <thead>
              <tr><th>Receipt</th><th>Item</th><th class="num">Accepted</th><th class="num">Rejected</th><th class="num">Rate</th><th>Warehouse</th></tr>
            </thead>
            <tbody>
              <tr v-for="(r, i) in doc.receipts" :key="`${r.purchase_receipt}-${r.item_code}-${i}`">
                <td>{{ r.purchase_receipt }}</td>
                <td><div class="ellipsis" style="max-width: 260px">{{ r.item_code }}</div></td>
                <td class="num">{{ fmtInt(r.qty) }}</td>
                <td class="num" :class="{ crit: r.rejected_qty > 0 }">{{ fmtInt(r.rejected_qty) }}</td>
                <td class="num money">{{ fmtMoney(r.rate, currency) }}</td>
                <td class="muted">{{ r.warehouse || '—' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="label label-dim">Nothing received against this order yet.</div>
        <div v-if="doc.discrepancies.length" class="discs">
          <div class="label">Discrepancies raised against {{ doc.supplier_name || doc.supplier }}</div>
          <div v-for="d in doc.discrepancies" :key="d.name" class="disc" :data-testid="`order-disc-${d.name}`">
            <span class="pill" :class="d.type === 'Short' ? 'pill-crit' : 'pill-warn'">{{ d.type }}</span>
            <span class="ellipsis">{{ d.item_name || d.item_code }}</span>
            <span class="num">{{ fmtInt(d.short_qty || d.over_qty || d.damaged_qty || 0) }}</span>
            <span class="label label-dim">{{ d.name }}</span>
          </div>
        </div>
      </section>
    </div>

    <template #footer>
      <div v-if="doc" class="foot">
        <div class="left">
          <template v-if="closing">
            <input v-model="closeReason" class="input" placeholder="Why is this order being closed?" data-testid="order-close-reason" />
            <button class="btn btn-crit" :disabled="busy" data-testid="order-close-confirm" @click="closeOrder">Close order</button>
            <button class="btn btn-ghost" :disabled="busy" @click="closing = false">Back</button>
          </template>
          <template v-else>
            <button
              class="btn btn-ghost"
              :disabled="busy || doc.docstatus !== 1 || doc.status === 'Closed'"
              :title="doc.docstatus === 0 ? 'A draft has to be submitted before it can be closed — orders are never deleted' : ''"
              data-testid="order-close"
              @click="closing = true"
            >
              Close order…
            </button>
            <span v-if="doc.docstatus === 0" class="label label-dim">Orders are kept, never deleted — submit then close one you have abandoned.</span>
          </template>
        </div>
        <div class="right">
          <span v-if="dirty && editable" class="label warn">Unsaved changes</span>
          <button v-if="editable" class="btn" :disabled="busy || (!dirty && !dropshipDirty)" data-testid="order-save" @click="save">{{ busy ? 'Saving…' : 'Save changes' }}</button>
          <button v-if="editable" class="btn btn-primary" :disabled="busy || dirty" :title="dirty ? 'Save your changes first' : ''" data-testid="order-submit" @click="submit">Submit order</button>
        </div>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 14px;
  font-size: 14px;
}
.crit-banner {
  border-left: 3px solid var(--crit);
  background: rgba(196, 115, 106, 0.1);
  color: var(--crit);
}
.readonly {
  border-left: 3px solid var(--muted);
  background: var(--surface-2);
  color: var(--muted);
  margin-bottom: 0;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 48px 16px;
  text-align: center;
}
.ohead {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 20px;
  flex-wrap: wrap;
}
.vname {
  font-size: 22px;
}
.rep {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-top: 8px;
  font-size: 14px;
}
.when {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  text-align: right;
}
.block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  border-top: var(--line-w) solid var(--line);
}
.tablewrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.tablewrap .table {
  min-width: 720px;
}
.cell {
  width: 96px;
  min-height: 44px;
  text-align: right;
  font-family: var(--font-display);
  font-weight: 800;
}
.rate-col {
  white-space: nowrap;
}
.rate {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding-left: 8px;
  border-bottom: 2px solid var(--accent);
  background: var(--accent-soft);
}
.rate.locked {
  border-bottom-color: var(--line-strong);
  background: transparent;
}
.rate .cur {
  font-size: 10px;
}
.rate-in {
  width: 96px;
  border: 0;
  background: transparent;
}
.rate.big .rate-in {
  width: 148px;
  font-size: 20px;
  min-height: 56px;
}
.money {
  font-variant-numeric: tabular-nums;
}
.freight {
  background: var(--surface-2);
  padding: 16px;
  border: var(--line-w) solid var(--line-strong);
  border-top: var(--line-w) solid var(--line-strong);
}
.fgrid {
  display: grid;
  grid-template-columns: minmax(220px, 1fr) repeat(3, minmax(120px, auto));
  gap: 16px;
  align-items: end;
}
.fbox {
  gap: 8px;
}
.fstat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  text-align: right;
}
.fstat .v {
  font-size: 18px;
}
.fstat.lead .v {
  font-size: 24px;
}
.explain {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  max-width: 74ch;
}
.warnbox {
  margin: 0;
  padding: 10px 12px;
  border-left: 2px solid var(--warn);
  background: rgba(211, 165, 91, 0.08);
  color: var(--warn);
  font-size: 13px;
}
.pick {
  width: 320px;
}
.wrap {
  flex-wrap: wrap;
}
.sentline {
  font-size: 14px;
}
.sendbox {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
  border: var(--line-w) solid var(--line-strong);
  background: var(--ground);
}
.seg {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}
.discs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 6px;
}
.disc {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 0;
  border-bottom: var(--line-w) solid var(--line);
  font-size: 14px;
}
.disc .ellipsis {
  flex: 1;
  min-width: 0;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  flex-wrap: wrap;
}
.left,
.right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.left .input {
  width: 280px;
}
@media (max-width: 767px) {
  .fgrid {
    grid-template-columns: 1fr 1fr;
  }
  .when {
    align-items: flex-start;
    text-align: left;
  }
  .pick {
    width: 100%;
  }
  .left .input {
    width: 100%;
  }
}
</style>
