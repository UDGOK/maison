<script lang="ts">
/**
 * v1.4 — **Stores** (the seventh section of the warehouse desk): every location the chain runs,
 * with what it holds and who works there, and the one form that adds or edits a store.
 *
 * The rules the screen states out loud:
 *  · a store is **closed, never deleted** — its sales and shipments refer to it; closing needs
 *    zero stock and no open shipment, and is reversible;
 *  · the **code is forever** (it names the warehouse, the cost centre and the POS profile);
 *  · adding a store provisions everything behind it — the same objects the seed built.
 */
import type { StoreRow } from '@/api/stores'

/** Warehouse row first, then open stores by name, then closed ones. */
export function sortStores(rows: StoreRow[]): StoreRow[] {
  return [...rows].sort((a, b) => {
    const wa = a.is_warehouse ? 0 : 1
    const wb = b.is_warehouse ? 0 : 1
    if (wa !== wb) return wa - wb
    if (!!a.enabled !== !!b.enabled) return a.enabled ? -1 : 1
    return (a.name || '').localeCompare(b.name || '')
  })
}

export function fmtHours(hours: Record<string, string> | null | undefined): string {
  const h = hours || {}
  const keys = Object.keys(h)
  if (!keys.length) return '—'
  const parts: string[] = []
  if (h.default) parts.push(h.default)
  for (const k of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']) if (h[k]) parts.push(`${k[0].toUpperCase()}${k.slice(1)} ${h[k]}`)
  return parts.join(' · ')
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { storesApi, draftOf, emptyDraft, payloadOf, validateStoreDraft, DAYS, DAY_LABEL, type StoreDraft, type StoresList, type HoursRow } from '@/api/stores'
import Modal from '@/components/Modal.vue'
import { fmtInt } from '@/utils/money'

const emit = defineEmits<{ (e: 'notice', msg: string): void }>()

const data = ref<StoresList | null>(null)
const loading = ref(false)
const error = ref('')
const includeClosed = ref(true)
const q = ref('')

const editing = ref<StoreDraft | null>(null)
const editingCode = ref<string | null>(null) // null while creating
const formError = ref('')
const busy = ref<'save' | 'close' | 'reopen' | null>(null)
const closing = ref<StoreRow | null>(null)
const closeReason = ref('')
const lastCreated = ref<Record<string, string | null> | null>(null)

const rows = computed(() => {
  const all = sortStores(data.value?.stores || [])
  const needle = q.value.trim().toLowerCase()
  return all.filter((r) => (includeClosed.value || r.enabled) && (!needle || `${r.code} ${r.name} ${r.city || ''} ${r.region || ''}`.toLowerCase().includes(needle)))
})
const openCount = computed(() => (data.value?.stores || []).filter((r) => r.enabled && !r.is_warehouse).length)

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await storesApi.list(true)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

function startAdd() {
  editing.value = emptyDraft(data.value?.timezone || 'America/Chicago', data.value?.template_tax_rate ?? null)
  editingCode.value = null
  formError.value = ''
  lastCreated.value = null
}
function startEdit(row: StoreRow) {
  editing.value = draftOf(row)
  editingCode.value = row.code
  formError.value = ''
  lastCreated.value = null
}
function addHoursRow() {
  if (!editing.value) return
  const used = new Set(editing.value.hours.map((r) => r.day))
  const next = DAYS.find((d) => !used.has(d))
  if (next) editing.value.hours.push({ day: next, hours: '' })
}
function removeHoursRow(i: number) {
  editing.value?.hours.splice(i, 1)
}
function dayOptions(row: HoursRow): HoursRow['day'][] {
  const used = new Set((editing.value?.hours || []).filter((r) => r !== row).map((r) => r.day))
  return DAYS.filter((d) => d === row.day || !used.has(d))
}

async function save() {
  if (!editing.value) return
  const problem = validateStoreDraft(editing.value, editingCode.value === null)
  if (problem) {
    formError.value = problem
    return
  }
  busy.value = 'save'
  formError.value = ''
  try {
    const payload = payloadOf(editing.value)
    if (editingCode.value === null) {
      const out = await storesApi.create(payload)
      lastCreated.value = out.created
      emit('notice', `${out.store.name} is open — warehouse, cost centre, POS profile and tax template are in place`)
    } else {
      const out = await storesApi.update(editingCode.value, payload)
      emit('notice', out.changed.length ? `${out.store.name} updated (${out.changed.join(', ')})` : `${out.store.name}: nothing changed`)
    }
    editing.value = null
    editingCode.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}

async function confirmClose() {
  if (!closing.value) return
  busy.value = 'close'
  try {
    const out = await storesApi.close(closing.value.code, closeReason.value.trim() || undefined)
    emit('notice', out.closed ? `${out.store.name} is closed — it has left every list and the till` : `${out.store.name} was already closed`)
    closing.value = null
    closeReason.value = ''
    await load()
  } catch (e) {
    error.value = (e as Error).message
    closing.value = null
  } finally {
    busy.value = null
  }
}
async function reopen(row: StoreRow) {
  busy.value = 'reopen'
  try {
    const out = await storesApi.reopen(row.code)
    emit('notice', `${out.store.name} is open again`)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
</script>

<template>
  <div class="board" data-testid="stores-board">
    <div class="bar">
      <input v-model="q" class="input search" placeholder="Search store, code, city or region" data-testid="stores-search" />
      <div class="seg">
        <button class="chip" :class="{ active: !includeClosed }" @click="includeClosed = false">Open</button>
        <button class="chip" :class="{ active: includeClosed }" @click="includeClosed = true">All</button>
      </div>
      <div class="spacer"></div>
      <span v-if="data" class="label label-dim">{{ openCount }} open store{{ openCount === 1 ? '' : 's' }} · {{ data.company }}</span>
      <button class="btn btn-primary" data-testid="store-add" @click="startAdd">Add store</button>
    </div>

    <div v-if="error" class="banner crit-banner" data-testid="stores-error">
      <span>{{ error }}</span>
      <div class="row">
        <button class="btn btn-ghost" @click="load">Try again</button>
        <button class="btn btn-ghost" @click="error = ''">Dismiss</button>
      </div>
    </div>

    <div v-if="loading && !rows.length" class="empty"><div class="label label-dim">Loading stores…</div></div>
    <div v-else-if="!rows.length" class="empty" data-testid="stores-empty">
      <div class="display" style="font-size: 18px">{{ q ? 'No store matches that' : 'No stores yet' }}</div>
      <div class="muted">{{ q ? 'Try the code or the city.' : 'Add the first store — the warehouse, cost centre, POS profile and tax template are created with it.' }}</div>
    </div>

    <div v-else class="tablewrap">
      <table class="table stores">
        <thead>
          <tr>
            <th>Store</th>
            <th>Address</th>
            <th>Region</th>
            <th class="num">Tax</th>
            <th>Hours</th>
            <th class="num">On hand</th>
            <th class="num">Staff</th>
            <th class="num">Requests</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in rows" :key="s.code" class="srow" :class="{ off: !s.enabled }" :data-testid="`store-${s.code}`">
            <td>
              <div class="row" style="gap: 8px">
                <button class="link" :data-testid="`open-store-${s.code}`" @click="startEdit(s)">{{ s.name }}</button>
                <span v-if="s.is_warehouse" class="pill">Warehouse</span>
                <span v-if="!s.enabled" class="pill pill-crit">Closed</span>
              </div>
              <div class="label label-dim">{{ s.code }}<span v-if="s.phone"> · {{ s.phone }}</span></div>
            </td>
            <td>
              <div class="ellipsis" style="max-width: 220px">{{ s.address_line || '—' }}</div>
              <div class="label label-dim ellipsis" style="max-width: 220px">{{ s.city || '' }}</div>
            </td>
            <td>{{ s.region || '—' }}</td>
            <td class="num">{{ s.tax_rate === null || s.tax_rate === undefined ? '—' : `${s.tax_rate}%` }}</td>
            <td><div class="label label-dim ellipsis" style="max-width: 200px">{{ fmtHours(s.hours) }}</div></td>
            <td class="num" :data-testid="`store-onhand-${s.code}`">{{ fmtInt(s.on_hand_units || 0) }}</td>
            <td class="num">{{ s.staff ?? '—' }}</td>
            <td class="num">{{ s.open_requests ?? '—' }}</td>
            <td class="num">
              <div class="row" style="gap: 6px; justify-content: flex-end">
                <button class="btn btn-ghost small" @click="startEdit(s)">Edit</button>
                <button v-if="s.enabled && !s.is_warehouse" class="btn btn-ghost small" :data-testid="`close-store-${s.code}`" @click="closing = s">Close</button>
                <button v-else-if="!s.enabled" class="btn btn-ghost small" :disabled="busy === 'reopen'" :data-testid="`reopen-store-${s.code}`" @click="reopen(s)">Reopen</button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <Modal v-if="editing" :title="editingCode === null ? 'Add store' : `Edit ${editing.boutique_name || editingCode}`" width="760px" @close="editing = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="store-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field">
          <label class="label" for="st-code">Store code</label>
          <input id="st-code" v-model="editing.code" class="input mono" :disabled="editingCode !== null" placeholder="e.g. OK-BIX" maxlength="12" data-testid="store-code" @input="editing.code = editing.code.toUpperCase()" />
          <div class="label label-dim">{{ editingCode === null ? 'Letters, digits and dashes. It names the warehouse and the POS profile and cannot change later.' : 'The code cannot change — it names the warehouse, the cost centre and the POS profile.' }}</div>
        </div>
        <div class="field">
          <label class="label" for="st-name">Store name</label>
          <input id="st-name" v-model="editing.boutique_name" class="input" placeholder="e.g. Scents of Arabia Bixby" data-testid="store-name" />
        </div>
        <div class="field span">
          <label class="label" for="st-addr">Address</label>
          <input id="st-addr" v-model="editing.address_line" class="input" placeholder="Street address" data-testid="store-address" />
        </div>
        <div class="field">
          <label class="label" for="st-city">City, state ZIP (as printed on receipts)</label>
          <input id="st-city" v-model="editing.city" class="input" placeholder="e.g. Bixby, OK 74008" />
        </div>
        <div class="field two">
          <div>
            <label class="label" for="st-state">State</label>
            <input id="st-state" v-model="editing.state" class="input" placeholder="OK" maxlength="12" />
          </div>
          <div>
            <label class="label" for="st-zip">ZIP</label>
            <input id="st-zip" v-model="editing.zip" class="input" placeholder="74008" />
          </div>
        </div>
        <div class="field">
          <label class="label" for="st-phone">Phone</label>
          <input id="st-phone" v-model="editing.phone" class="input" placeholder="(918) 555-0100" />
        </div>
        <div class="field">
          <label class="label" for="st-email">Store e-mail</label>
          <input id="st-email" v-model="editing.email" class="input" placeholder="bixby@example.com" />
        </div>
        <div class="field">
          <label class="label" for="st-region">Region</label>
          <input id="st-region" v-model="editing.region" class="input" list="st-regions" placeholder="e.g. Tulsa Metro" />
          <datalist id="st-regions"><option v-for="r in data?.regions || []" :key="r" :value="r" /></datalist>
        </div>
        <div class="field">
          <label class="label" for="st-tax">Sales tax rate (%)</label>
          <input id="st-tax" v-model.number="editing.tax_rate" class="input" inputmode="decimal" placeholder="e.g. 8.917" data-testid="store-tax" />
          <div class="label label-dim">The combined state + local rate charged at this store. Leave blank to use the chain's template.</div>
        </div>
        <div class="field">
          <label class="label" for="st-tz">Time zone</label>
          <input id="st-tz" v-model="editing.timezone" class="input" placeholder="America/Chicago" />
        </div>
        <div class="field">
          <label class="label">Product images on the till</label>
          <label class="row" style="gap: 8px"><input v-model="editing.show_product_images" type="checkbox" /> <span>Show images on tiles</span></label>
        </div>
        <div class="field span">
          <label class="label">Opening hours</label>
          <div v-for="(h, i) in editing.hours" :key="i" class="row hours-row">
            <select v-model="h.day" class="input day">
              <option v-for="d in dayOptions(h)" :key="d" :value="d">{{ DAY_LABEL[d] }}</option>
            </select>
            <input v-model="h.hours" class="input" placeholder="10:00-21:00 or closed" />
            <button class="btn btn-ghost small" :disabled="editing.hours.length === 1" @click="removeHoursRow(i)">Remove</button>
          </div>
          <button class="btn btn-ghost small" :disabled="editing.hours.length >= DAYS.length" @click="addHoursRow">Add a day</button>
        </div>
      </div>
      <p v-if="editingCode === null" class="muted note">
        Saving creates the store's warehouse, cost centre, POS profile (a copy of {{ data?.template_store || 'the head-office store' }}'s, so payments and price list match the chain), tax template and in-transit warehouse. Add its people under Staff.
      </p>
      <template #footer>
        <button class="btn btn-ghost" @click="editing = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy === 'save'" data-testid="store-save" @click="save">
          {{ busy === 'save' ? 'Saving…' : editingCode === null ? 'Add store' : 'Save changes' }}
        </button>
      </template>
    </Modal>

    <Modal v-if="closing" :title="`Close ${closing.name}?`" width="520px" @close="closing = null">
      <p>The store leaves every list, the till, the online store's collection points and the wall. Nothing is deleted — its history stays and it can be reopened here.</p>
      <p v-if="(closing.on_hand_units || 0) > 0" class="crit" data-testid="close-blocked">It still holds {{ fmtInt(closing.on_hand_units || 0) }} units. Send them back to the warehouse first; closing will be refused until it is empty.</p>
      <div class="field"><label class="label" for="st-close-reason">Reason (kept on the store's record)</label><input id="st-close-reason" v-model="closeReason" class="input" placeholder="e.g. lease ended" /></div>
      <template #footer>
        <button class="btn btn-ghost" @click="closing = null">Keep open</button>
        <button class="btn btn-primary" :disabled="busy === 'close'" data-testid="close-store-confirm" @click="confirmClose">{{ busy === 'close' ? 'Closing…' : 'Close store' }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.search {
  max-width: 360px;
}
.seg {
  display: flex;
  gap: 4px;
}
.spacer {
  flex: 1;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border: var(--line-w) solid var(--line);
}
.crit-banner {
  border-color: var(--crit);
  color: var(--crit);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 40px 0;
}
.empty .muted {
  max-width: 520px;
}
.tablewrap {
  overflow-x: auto;
}
.stores td {
  vertical-align: top;
}
.srow.off td {
  color: var(--muted);
}
.link {
  background: none;
  border: 0;
  padding: 0;
  color: var(--text);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
.link:hover {
  color: var(--accent);
}
.form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
}
.form .span {
  grid-column: 1 / -1;
}
.form .two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  letter-spacing: 0.08em;
}
.hours-row {
  gap: 8px;
  margin-bottom: 8px;
}
.hours-row .day {
  max-width: 150px;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
.note {
  margin-top: 14px;
}
@media (max-width: 640px) {
  .form {
    grid-template-columns: 1fr;
  }
}
</style>
