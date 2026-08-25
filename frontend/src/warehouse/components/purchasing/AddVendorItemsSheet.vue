<script lang="ts">
/**
 * v1.2 §E — **Vendors → a vendor → Catalogue → Add items.**
 *
 * `vendor_catalogue` answers "what does this vendor sell us?". Its mirror image was missing: a rep
 * hands over a sheet of twenty new lines and the only way to record them was to open twenty Items
 * in the ERP back office, one at a time. This is the sheet.
 *
 * Two things it has to make plain:
 *
 *  · **An item with no vendor at all sorts first, and says so.** That is the row blocking the
 *    Buying board — the whole reason a buyer came here — so it leads, marked *nobody sells us this*.
 *  · **A cost written here writes through to the vendor's own buying price list**, exactly as a
 *    single edit on the catalogue tab does. Nothing here is a second price mechanism.
 *
 * The server validates the whole sheet **before** it writes any of it: a half-added sheet is worse
 * than a refused one, because the buyer has no way of telling which twenty of their thirty lines
 * landed. The refusal is rendered verbatim.
 */
import type { VendorCandidate } from '@/api/purchasing'

/** One row as the buyer has filled it in. */
export interface CandidateDraft {
  picked: boolean
  cost: string
  case_pack: string
  moq: string
  vendor_sku: string
}

export function draftFor(row: VendorCandidate): CandidateDraft {
  return {
    picked: false,
    cost: row.suggested_cost ? String(row.suggested_cost) : '',
    case_pack: String(row.case_pack || 1),
    moq: String(row.moq || 0),
    vendor_sku: ''
  }
}

export interface CandidateProblem {
  item_code: string
  message: string
}

/** What is wrong with the picked rows, before anything is posted. */
export function candidateProblems(rows: VendorCandidate[], drafts: Record<string, CandidateDraft>): CandidateProblem[] {
  const out: CandidateProblem[] = []
  for (const row of rows || []) {
    const draft = drafts[row.item_code]
    if (!draft?.picked) continue
    const cost = Number(draft.cost)
    if (draft.cost.trim() === '' || !Number.isFinite(cost)) out.push({ item_code: row.item_code, message: `${row.item_code} — type what they charge us` })
    else if (cost < 0) out.push({ item_code: row.item_code, message: `${row.item_code} — a cost cannot be negative` })
    const pack = Number(draft.case_pack)
    if (!Number.isFinite(pack) || pack < 1) out.push({ item_code: row.item_code, message: `${row.item_code} — a case pack is at least 1` })
    const moq = Number(draft.moq)
    if (!Number.isFinite(moq) || moq < 0) out.push({ item_code: row.item_code, message: `${row.item_code} — a minimum cannot be negative` })
  }
  return out
}

/** The picked rows as `add_vendor_items` wants them. */
export function linesFrom(rows: VendorCandidate[], drafts: Record<string, CandidateDraft>) {
  return (rows || [])
    .filter((r) => drafts[r.item_code]?.picked)
    .map((r) => {
      const d = drafts[r.item_code]
      return {
        item_code: r.item_code,
        cost: Number(d.cost) || 0,
        case_pack: Math.max(1, Math.trunc(Number(d.case_pack) || 1)),
        moq: Math.max(0, Math.trunc(Number(d.moq) || 0)),
        vendor_sku: d.vendor_sku.trim() || null
      }
    })
}

/** "Add 4 items to Gulf Coast Distributing" — the copy on the button. */
export function addCopy(count: number, vendorName: string): string {
  if (!count) return 'Nothing picked'
  return `Add ${count} item${count === 1 ? '' : 's'} to ${vendorName}`
}

/** "3 added · 1 of them was blocking the buying list" — the line after a successful post. */
export function addedCopy(added: number, unblocked: number, vendorName: string): string {
  const head = `${added} item${added === 1 ? '' : 's'} added to ${vendorName}`
  if (!unblocked) return head
  return `${head} — ${unblocked} buying row${unblocked === 1 ? '' : 's'} can be ordered now`
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { usePurchasingStore } from '@/stores/purchasing'
import { fmtMoney } from '@/utils/money'

const props = defineProps<{ supplier: string; supplierName?: string | null }>()
const emit = defineEmits<{ close: []; notice: [msg: string]; added: [] }>()

const store = usePurchasingStore()

const q = ref('')
const rows = ref<VendorCandidate[]>([])
const total = ref(0)
const drafts = ref<Record<string, CandidateDraft>>({})
const loading = ref(false)
const posting = ref(false)
const localError = ref('')
let timer: ReturnType<typeof setTimeout> | null = null

const vendorName = computed(() => props.supplierName || props.supplier)
const picked = computed(() => rows.value.filter((r) => drafts.value[r.item_code]?.picked))
const problems = computed(() => candidateProblems(rows.value, drafts.value))
const orphans = computed(() => rows.value.filter((r) => r.unorderable).length)

async function load() {
  loading.value = true
  localError.value = ''
  const out = await store.loadVendorCandidates(props.supplier, q.value.trim() || undefined)
  loading.value = false
  if (!out) return
  rows.value = out.items
  total.value = out.total
  const next: Record<string, CandidateDraft> = {}
  for (const row of out.items) next[row.item_code] = drafts.value[row.item_code] ?? draftFor(row)
  drafts.value = next
}
onMounted(load)
watch(() => props.supplier, load)
watch(q, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void load(), 300)
})
onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})

function toggle(itemCode: string) {
  const draft = drafts.value[itemCode]
  if (!draft) return
  drafts.value = { ...drafts.value, [itemCode]: { ...draft, picked: !draft.picked } }
}
function pickAllOrphans() {
  const next = { ...drafts.value }
  for (const row of rows.value) if (row.unorderable && next[row.item_code]) next[row.item_code] = { ...next[row.item_code], picked: true }
  drafts.value = next
}

async function save() {
  if (!picked.value.length || problems.value.length) return
  posting.value = true
  localError.value = ''
  const out = await store.addVendorItems(props.supplier, linesFrom(rows.value, drafts.value))
  posting.value = false
  if (!out) {
    localError.value = store.error || 'Nothing was added'
    return
  }
  store.clearNotice()
  emit('notice', addedCopy(out.count, out.suggestions.filter((s) => s.orderable).length, vendorName.value))
  emit('added')
  drafts.value = {}
  await load()
}
</script>

<template>
  <Modal :title="`Add items to ${vendorName}`" width="1080px" @close="emit('close')">
    <div class="sheet" data-testid="add-items-sheet">
      <p class="intro muted">
        Everything not already on {{ vendorName }}’s catalogue. A cost saved here writes through to their buying price list, so the next purchase order
        picks it up — the same path a single edit on the Catalogue tab takes.
      </p>

      <div class="bar">
        <input v-model="q" class="input search" placeholder="Search our item, code or barcode" data-testid="add-items-search" />
        <button v-if="orphans" class="chip" data-testid="add-items-orphans" @click="pickAllOrphans">
          Pick the {{ orphans }} nobody sells us
        </button>
        <div class="spacer"></div>
        <span class="label label-dim">{{ rows.length }} of {{ total }} candidates</span>
      </div>

      <div v-if="orphans" class="banner warn-banner" data-testid="add-items-orphan-note">
        {{ orphans }} of these have <b>no vendor at all</b>. Those are the rows the Buying board cannot order — attaching a vendor here is what unblocks them.
      </div>

      <div v-if="localError || store.error" class="banner crit-banner pre" data-testid="add-items-error">
        <span>{{ localError || store.error }}</span>
        <button class="btn btn-ghost" @click="((localError = ''), store.clearError())">Dismiss</button>
      </div>

      <div v-if="loading && !rows.length" class="empty"><div class="label label-dim">Reading the catalogue…</div></div>
      <div v-else-if="!rows.length" class="empty" data-testid="add-items-empty">
        <div class="display" style="font-size: 18px">{{ q ? 'Nothing matches that' : 'Every item is already on this vendor' }}</div>
        <div class="muted">{{ q ? 'Try the code or the barcode.' : 'There is nothing left to attach — edit what they charge on the Catalogue tab instead.' }}</div>
      </div>

      <div v-else class="tablewrap">
        <table class="table cand">
          <thead>
            <tr>
              <th class="pick-col"><span class="vh">Pick</span></th>
              <th>Item</th>
              <th class="num">They charge</th>
              <th class="num">Case pack</th>
              <th class="num">MOQ</th>
              <th>Their SKU</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="r in rows" :key="r.item_code">
              <tr v-if="drafts[r.item_code]" :class="{ picked: drafts[r.item_code].picked, orphan: r.unorderable }" :data-testid="`cand-${r.item_code}`">
                <td class="pick-col">
                  <label class="pick" :aria-label="`Add ${r.item_name || r.item_code}`">
                    <input type="checkbox" :checked="drafts[r.item_code].picked" :data-testid="`cand-pick-${r.item_code}`" @change="toggle(r.item_code)" />
                  </label>
                </td>
                <td>
                  <div class="ellipsis wide">{{ r.item_name || r.item_code }}</div>
                  <div class="label label-dim">
                    {{ r.item_code }}<span v-if="r.item_group"> · {{ r.item_group }}</span><span v-if="r.barcode"> · {{ r.barcode }}</span>
                  </div>
                  <div v-if="r.unorderable" class="label crit orphan-note" :data-testid="`cand-orphan-${r.item_code}`">Nobody sells us this yet</div>
                </td>
                <td class="num">
                  <input
                    v-model="drafts[r.item_code].cost"
                    class="input cell"
                    inputmode="decimal"
                    :aria-label="`Cost for ${r.item_code}`"
                    :data-testid="`cand-cost-${r.item_code}`"
                  />
                  <div v-if="r.suggested_cost" class="label label-dim">last paid {{ fmtMoney(r.suggested_cost) }}</div>
                </td>
                <td class="num">
                  <input v-model="drafts[r.item_code].case_pack" class="input cell narrow" inputmode="numeric" :aria-label="`Case pack for ${r.item_code}`" />
                </td>
                <td class="num">
                  <input v-model="drafts[r.item_code].moq" class="input cell narrow" inputmode="numeric" :aria-label="`Minimum order for ${r.item_code}`" />
                </td>
                <td>
                  <input
                    v-model="drafts[r.item_code].vendor_sku"
                    class="input cell wide-cell"
                    placeholder="their number"
                    :aria-label="`Their SKU for ${r.item_code}`"
                  />
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>

      <div v-if="problems.length" class="banner crit-banner" data-testid="add-items-problems">
        <div>
          <div v-for="p in problems" :key="p.item_code + p.message">{{ p.message }}</div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="foot">
        <span class="label label-dim">
          {{ picked.length ? `${picked.length} picked` : 'Tick the lines off the rep’s sheet, type what they charge, and add them in one go.' }}
        </span>
        <div class="row">
          <button class="btn btn-ghost" @click="emit('close')">Close</button>
          <button class="btn btn-primary" :disabled="!picked.length || !!problems.length || posting" data-testid="add-items-save" @click="save">
            {{ posting ? 'Adding…' : addCopy(picked.length, vendorName) }}
          </button>
        </div>
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
.intro {
  font-size: 13px;
  max-width: 92ch;
}
.bar {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.search {
  width: 300px;
  flex: 1 1 200px;
  max-width: 400px;
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
.warn-banner {
  display: block;
  border-left: 3px solid var(--warn);
  background: rgba(211, 165, 91, 0.09);
  color: var(--text);
}
.crit-banner {
  border-left: 3px solid var(--crit);
  background: rgba(196, 115, 106, 0.1);
  color: var(--crit);
}
.pre {
  white-space: pre-line;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 44px 16px;
  text-align: center;
}
.tablewrap {
  overflow-x: auto;
  overscroll-behavior-x: contain;
  max-height: 54vh;
  overflow-y: auto;
}
.cand {
  min-width: 900px;
}
.cand th,
.cand td {
  white-space: nowrap;
}
.cand thead th {
  position: sticky;
  top: 0;
  background: var(--surface);
  z-index: 1;
}
.pick-col {
  width: 44px;
  /* positions the visually-hidden column header against this cell rather than the page */
  position: relative;
}
.pick {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 44px;
  cursor: pointer;
}
tr.picked td {
  background: var(--accent-soft);
}
/* the row the buyer came here to fix — it leads the list and it leads the eye */
tr.orphan {
  border-left: 3px solid var(--crit);
}
.orphan-note {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 11px;
  margin-top: 2px;
}
.wide {
  max-width: 300px;
}
.cell {
  width: 96px;
  min-height: 44px;
  text-align: right;
}
.cell.narrow {
  width: 76px;
}
.cell.wide-cell {
  width: 140px;
  text-align: left;
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  flex-wrap: wrap;
}
.foot .label {
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
  .search {
    width: 100%;
    max-width: none;
  }
  .tablewrap {
    max-height: none;
  }
  .wide {
    max-width: 200px;
  }
  .foot .row {
    width: 100%;
  }
  .foot .row .btn {
    flex: 1;
  }
}
</style>
