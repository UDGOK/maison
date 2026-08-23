<script setup lang="ts">
/**
 * v0.6 P — tap a card: shipment detail with the pick list (bin locations), Packed (parcels), Buy label
 * (rates, cheapest pre-selected, fastest toggle), Print packing list / label, Ship, Cancel, tracking.
 * Shared by the wall (large type) and the admin desk.
 */
import { computed, onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import RateChooser from './RateChooser.vue'
import { warehouseApi, type Parcel, type PickList, type Rate, type RatesResult, type ShipmentDetail } from '@/api/warehouse'
import { useWarehouseStore } from '@/stores/warehouse'
import { fmtMoney } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'
import { ageTier, fmtAge, liveAge } from '../wall'

const props = defineProps<{ name: string; large?: boolean }>()
const emit = defineEmits<{ close: []; changed: [] }>()
const wh = useWarehouseStore()

const doc = ref<ShipmentDetail | null>(null)
const pickList = ref<PickList | null>(null)
const picked = ref<Record<string, number>>({})
const parcels = ref<Parcel[]>([])
const quote = ref<RatesResult | null>(null)
const chosen = ref<Rate | null>(null)
const tab = ref<'pick' | 'pack' | 'label' | 'track'>('pick')
const error = ref('')
const busy = ref('')
const tracking = ref<{ status: string | null; events: { status?: string; at?: string; location?: string; description?: string }[] } | null>(null)
const loadedAt = ref(Date.now())

const status = computed(() => doc.value?.status)
const canPick = computed(() => status.value === 'Pending' || status.value === 'Picking')
const canPack = computed(() => !!status.value && ['Pending', 'Picking', 'Packed'].includes(status.value))
const canLabel = computed(() => !!status.value && !['Shipped', 'Received', 'Cancelled'].includes(status.value))
const canShip = computed(() => canLabel.value && (doc.value?.units_picked || 0) > 0 || status.value === 'Packed')
const age = computed(() => (doc.value ? liveAge(doc.value, loadedAt.value) : 0))
const tier = computed(() => ageTier(age.value, wh.wall?.warn_seconds, wh.wall?.crit_seconds))
const allPicked = computed(() => !!doc.value && doc.value.lines.every((l) => (picked.value[l.item_code] ?? 0) >= l.qty))

async function load() {
  error.value = ''
  try {
    doc.value = await warehouseApi.admin.shipment(props.name)
    loadedAt.value = Date.now()
    picked.value = Object.fromEntries(doc.value.lines.map((l) => [l.item_code, l.picked_qty || 0]))
    parcels.value = doc.value.parcels.length ? doc.value.parcels.map((p) => ({ ...p })) : [{ length: doc.value.est_dims[0], width: doc.value.est_dims[1], height: doc.value.est_dims[2], weight: doc.value.est_weight }]
    if (doc.value.rate_options?.length && !quote.value) quote.value = { shipment: doc.value.name, provider: doc.value.provider || wh.wall?.provider || 'simulated', test_mode: false, prefer: wh.prefer, rates: doc.value.rate_options, selected: null, cheapest: null, fastest: null, parcels: parcels.value, ship_to: doc.value.ship_to, ship_from: doc.value.ship_from }
    pickList.value = await warehouseApi.admin.pick_list(props.name)
    if (status.value === 'Packed' && !doc.value.label_url) tab.value = 'label'
    else if (status.value === 'Packed' && doc.value.label_url) tab.value = 'label'
    else if (status.value === 'Shipped') tab.value = 'track'
  } catch (e) {
    error.value = (e as Error).message
  }
}
onMounted(load)
watch(() => props.name, load)

async function run(label: string, fn: () => Promise<unknown>, close = false) {
  busy.value = label
  error.value = ''
  try {
    await fn()
    emit('changed')
    if (close) emit('close')
    else await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = ''
  }
}

const pickLines = () => doc.value!.lines.map((l) => ({ item_code: l.item_code, picked_qty: picked.value[l.item_code] ?? 0 }))
const startPick = () => run('pick', () => warehouseApi.admin.pick(props.name, pickLines()))
const pickAll = () => {
  for (const l of doc.value!.lines) picked.value[l.item_code] = l.qty
}
const packed = () => run('pack', () => warehouseApi.admin.pack(props.name, pickLines(), parcels.value))
const getRates = () =>
  run('rates', async () => {
    quote.value = await warehouseApi.admin.rates(props.name, wh.prefer)
  })
const buy = () => run('buy', () => wh.buy(props.name, chosen.value))
const ship = () => run('ship', () => wh.mark(props.name, 'Shipped'), true)
const cancel = () => {
  if (!confirm(`Cancel ${props.name}? The request stays approved.`)) return
  void run('cancel', () => wh.mark(props.name, 'Cancelled'), true)
}
const printPacking = () => run('print', () => wh.printPackingList(props.name))
const printLabel = () => run('print', () => wh.printLabel(props.name, doc.value!.label_url!))
const track = () =>
  run('track', async () => {
    tracking.value = await warehouseApi.admin.track(props.name)
  })

function addParcel() {
  parcels.value.push({ length: 40, width: 30, height: 25, weight: 1 })
}
function removeParcel(i: number) {
  if (parcels.value.length > 1) parcels.value.splice(i, 1)
}
watch(
  () => wh.prefer,
  () => {
    if (quote.value) chosen.value = null
  }
)
</script>

<template>
  <Modal :title="name" :width="large ? '1100px' : '860px'" @close="emit('close')">
    <div v-if="error" class="crit" style="margin-bottom: 12px" data-testid="sheet-error">{{ error }}</div>
    <div v-if="!doc" class="muted">Loading…</div>
    <div v-else class="sheet" :class="{ large }" data-testid="shipment-sheet">
      <div class="head">
        <div>
          <div class="store display">{{ doc.boutique }} <span class="muted">{{ doc.boutique_name }}</span></div>
          <div class="label label-dim" style="margin-top: 4px">
            {{ doc.items }} items · {{ doc.units }} units · est. {{ doc.est_weight.toFixed(2) }} kg · {{ doc.from_warehouse }} → {{ doc.to_warehouse }}
          </div>
        </div>
        <div class="right">
          <span class="pill" :class="doc.status === 'Shipped' ? 'pill-good' : doc.status === 'Cancelled' ? 'pill-crit' : 'pill-accent'" data-testid="sheet-status">{{ doc.status }}</span>
          <span class="pill" :class="tier === 'crit' ? 'pill-crit' : tier === 'warn' ? 'pill-warn' : ''">{{ fmtAge(age) }}</span>
          <span v-if="doc.priority && doc.priority !== 'Normal'" class="pill pill-warn">⚑ {{ doc.priority }}</span>
        </div>
      </div>

      <div class="tabs">
        <button class="chip" :class="{ active: tab === 'pick' }" @click="tab = 'pick'">Pick list</button>
        <button class="chip" :class="{ active: tab === 'pack' }" @click="tab = 'pack'">Pack</button>
        <button class="chip" :class="{ active: tab === 'label' }" data-testid="tab-label" @click="tab = 'label'">Label</button>
        <button class="chip" :class="{ active: tab === 'track' }" @click="tab = 'track'">Tracking</button>
        <div class="spacer"></div>
        <button class="btn" :disabled="!!busy" data-testid="print-packing-list" @click="printPacking">Print packing list</button>
        <button v-if="doc.label_url" class="btn" :disabled="!!busy" data-testid="print-label" @click="printLabel">Print label</button>
      </div>

      <!-- pick -->
      <div v-if="tab === 'pick'" class="panel">
        <table class="table">
          <thead>
            <tr><th>Bin</th><th>Item</th><th>Barcode</th><th class="num">On hand</th><th class="num">Qty</th><th class="num">Picked</th></tr>
          </thead>
          <tbody>
            <tr v-for="l in pickList?.lines || []" :key="l.item_code" :class="{ done: (picked[l.item_code] ?? 0) >= l.qty }">
              <td class="bin display">{{ l.bin_location }}</td>
              <td><div class="ellipsis" style="max-width: 340px">{{ l.item_name || l.item_code }}</div><div class="label label-dim">{{ l.item_code }}</div></td>
              <td class="muted">{{ l.barcode }}</td>
              <td class="num" :class="{ crit: l.on_hand < l.qty }">{{ l.on_hand }}</td>
              <td class="num">{{ l.qty }}</td>
              <td class="num">
                <input v-model.number="picked[l.item_code]" class="input qty" inputmode="numeric" :disabled="!canPick && doc.status !== 'Packed'" :max="l.qty" />
              </td>
            </tr>
          </tbody>
        </table>
        <div class="row" style="margin-top: 14px; justify-content: flex-end">
          <button class="btn" :disabled="!canPick && doc.status !== 'Packed'" @click="pickAll">All picked</button>
          <button v-if="canPick" class="btn btn-primary" :disabled="!!busy" data-testid="action-pick" @click="startPick">{{ doc.status === 'Pending' ? 'Start picking' : 'Save picks' }}</button>
          <button v-if="canPack" class="btn btn-primary" :disabled="!!busy || !allPicked" data-testid="action-packed" @click="packed">Packed</button>
        </div>
      </div>

      <!-- pack -->
      <div v-if="tab === 'pack'" class="panel">
        <div class="label label-dim" style="margin-bottom: 10px">Parcels (cm / kg) — estimate {{ doc.est_dims.join(' × ') }} cm, {{ doc.est_weight.toFixed(2) }} kg</div>
        <div v-for="(p, i) in parcels" :key="i" class="parcel">
          <span class="label">#{{ i + 1 }}</span>
          <input v-model.number="p.length" class="input dim" inputmode="decimal" placeholder="L" :disabled="!canPack" />
          <span class="muted">×</span>
          <input v-model.number="p.width" class="input dim" inputmode="decimal" placeholder="W" :disabled="!canPack" />
          <span class="muted">×</span>
          <input v-model.number="p.height" class="input dim" inputmode="decimal" placeholder="H" :disabled="!canPack" />
          <input v-model.number="p.weight" class="input dim" inputmode="decimal" placeholder="kg" :disabled="!canPack" />
          <span class="label label-dim">kg</span>
          <button class="btn btn-ghost" :disabled="parcels.length < 2 || !canPack" @click="removeParcel(i)">Remove</button>
        </div>
        <div class="row" style="margin-top: 14px; justify-content: space-between">
          <button class="btn" :disabled="!canPack" @click="addParcel">Add parcel</button>
          <button v-if="canPack" class="btn btn-primary" :disabled="!!busy" @click="packed">Save & mark Packed</button>
        </div>
      </div>

      <!-- label -->
      <div v-if="tab === 'label'" class="panel">
        <div v-if="doc.label_url" class="label-box" data-testid="label-bought">
          <div>
            <div class="display" style="font-size: 18px">{{ doc.carrier }} {{ doc.service }}</div>
            <div class="label label-dim" style="margin-top: 4px">{{ fmtMoney(doc.rate_amount || 0) }} · {{ doc.rate_days }} d · tracking {{ doc.tracking_no }}</div>
          </div>
          <div class="row">
            <a class="btn" :href="doc.label_url" target="_blank" rel="noopener">Open label</a>
            <button class="btn" :disabled="!!busy" @click="printLabel">Print label</button>
          </div>
        </div>
        <template v-else-if="canLabel">
          <div class="addr">
            <div><div class="label label-dim">Ship to</div><div>{{ doc.ship_to.name }}</div><div class="muted">{{ doc.ship_to.street1 }}, {{ doc.ship_to.city }} {{ doc.ship_to.state }} {{ doc.ship_to.zip }}</div></div>
            <div><div class="label label-dim">Ship from</div><div>{{ doc.ship_from.name }}</div><div class="muted">{{ doc.ship_from.street1 }}, {{ doc.ship_from.city }} {{ doc.ship_from.state }} {{ doc.ship_from.zip }}</div></div>
          </div>
          <RateChooser v-if="quote" :rates="quote.rates" :prefer="wh.prefer" :provider="quote.provider" :test-mode="quote.test_mode" :disabled="!!busy" @update:prefer="wh.setPrefer" @select="(r) => (chosen = r)" />
          <div class="row" style="margin-top: 14px; justify-content: flex-end">
            <button class="btn" :disabled="!!busy" data-testid="action-rates" @click="getRates">{{ quote ? 'Refresh rates' : 'Get rates' }}</button>
            <button class="btn btn-primary" :disabled="!!busy || !quote" data-testid="action-buy" @click="buy">
              Buy label<span v-if="chosen"> · {{ fmtMoney(chosen.amount) }}</span>
            </button>
          </div>
        </template>
        <div v-else class="muted">No label on this shipment.</div>
      </div>

      <!-- tracking -->
      <div v-if="tab === 'track'" class="panel">
        <div class="row" style="justify-content: space-between; margin-bottom: 10px">
          <div>
            <div class="display" style="font-size: 18px">{{ doc.tracking_status || '—' }}</div>
            <div class="label label-dim">{{ doc.tracking_no || 'no tracking number yet' }}<span v-if="doc.tracking_updated_at"> · {{ fmtDateTime(doc.tracking_updated_at) }}</span></div>
          </div>
          <button class="btn" :disabled="!!busy || !doc.tracking_no" @click="track">Refresh</button>
        </div>
        <div v-for="(ev, i) in tracking?.events || []" :key="i" class="between trow">
          <span>{{ ev.status }} <span class="muted">{{ ev.description }}</span></span>
          <span class="muted">{{ ev.location }} · {{ ev.at ? fmtDateTime(ev.at) : '' }}</span>
        </div>
        <div class="label label-dim" style="margin-top: 14px">
          Stock: ship {{ doc.stock_entry_ship || '—' }} · receive {{ doc.stock_entry_receive || '—' }}<span v-if="doc.stock_entry_damaged"> · damaged {{ doc.stock_entry_damaged }}</span>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="between" style="width: 100%">
        <button v-if="doc && canLabel" class="btn btn-ghost" :disabled="!!busy" @click="cancel">Cancel shipment</button>
        <span v-else></span>
        <div class="row">
          <span v-if="busy" class="label label-dim">{{ busy }}…</span>
          <button v-if="doc && canShip" class="btn btn-primary btn-big" :disabled="!!busy" data-testid="action-ship" @click="ship">Ship</button>
        </div>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.sheet.large {
  font-size: 17px;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 16px;
}
.store {
  font-size: 22px;
  font-weight: 800;
}
.right {
  display: flex;
  gap: 8px;
  align-items: center;
}
.tabs {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-bottom: 14px;
}
.spacer {
  flex: 1;
}
.panel {
  border-top: var(--line-w) solid var(--line);
  padding-top: 14px;
}
.bin {
  font-size: 16px;
  font-weight: 800;
  color: var(--accent);
}
tr.done td {
  color: var(--dim);
}
tr.done .bin {
  color: var(--good);
}
.qty {
  width: 84px;
  text-align: right;
  min-height: 44px;
}
.parcel {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}
.dim {
  width: 88px;
  text-align: right;
}
.label-box {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 16px;
  padding: 14px;
  border: var(--line-w) solid var(--accent);
  background: var(--accent-soft);
}
.addr {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 16px;
  margin-bottom: 14px;
  font-size: 14px;
}
.trow {
  padding: 8px 0;
  border-bottom: var(--line-w) solid var(--line);
  font-size: 14px;
}
</style>
