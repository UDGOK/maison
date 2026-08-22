<script setup lang="ts">
/**
 * v0.4 D — Cycle count: scan every serial on the floor (wedge or camera), count the qty items,
 * compare with the warehouse and hand a draft Stock Reconciliation to the manager.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import { api, type CycleCountExpected, type CycleCountResult } from '@/api'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { useScanStore } from '@/stores/scan'
import { useSyncStore } from '@/stores/sync'
import { compareCount } from '@/inventory/count'
import { fmtDateTime } from '@/utils/device'

const session = useSessionStore()
const catalog = useCatalogStore()
const scan = useScanStore()
const sync = useSyncStore()
const router = useRouter()

const expected = ref<CycleCountExpected | null>(null)
const loading = ref(false)
const error = ref('')
const scanned = ref<string[]>([])
const counted = reactive<Record<string, number | null>>({})
const manual = ref('')
const submitting = ref(false)
const result = ref<CycleCountResult | null>(null)
const tab = ref<'serials' | 'qty'>('serials')
const lastScan = ref<{ code: string; ok: boolean } | null>(null)

const progress = computed(() =>
  expected.value ? compareCount(expected.value, scanned.value, counted) : null
)
const itemName = (code: string) => expected.value?.items[code] || catalog.byCode[code]?.item_name || code
const qtyItems = computed(() =>
  expected.value ? Object.keys(expected.value.qty).sort((a, b) => itemName(a).localeCompare(itemName(b))) : []
)
const countedAll = computed(() =>
  qtyItems.value.every((c) => counted[c] !== null && counted[c] !== undefined)
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    expected.value = await api.inventory.cycle_count_expected(session.boutique!.name)
    for (const code of Object.keys(expected.value.qty)) counted[code] = null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
function onCode(code: string) {
  const s = code.trim()
  if (!s) return
  const known =
    progress.value && expected.value
      ? Object.values(expected.value.serials).some((l) => l.includes(s))
      : false
  if (!scanned.value.includes(s)) scanned.value.push(s)
  lastScan.value = { code: s, ok: known }
  if (!known) sync.notify('warn', `${s} is not expected here`, 'Listed as unexpected')
}
function addManual() {
  onCode(manual.value)
  manual.value = ''
}
function unscan(s: string) {
  scanned.value = scanned.value.filter((x) => x !== s)
}
function fillExpected(code: string) {
  counted[code] = expected.value?.qty[code] ?? 0
}
async function submit() {
  if (!expected.value || submitting.value) return
  submitting.value = true
  error.value = ''
  try {
    const qty: Record<string, number> = {}
    for (const [k, v] of Object.entries(counted)) if (v !== null && v !== undefined) qty[k] = Number(v)
    result.value = await api.inventory.submit_cycle_count({
      boutique: session.boutique!.name,
      serials: [...scanned.value],
      qty,
      device_id: session.device_id
    })
    sync.notify(
      result.value.clean ? 'good' : 'warn',
      result.value.clean ? 'Count matches the system' : 'Count has discrepancies',
      result.value.cycle_count
    )
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    submitting.value = false
  }
}
function restart() {
  result.value = null
  scanned.value = []
  lastScan.value = null
  void load()
}

let uncapture: (() => void) | null = null
onMounted(() => {
  uncapture = scan.captureRaw(onCode)
  void load()
})
onBeforeUnmount(() => uncapture?.())
</script>

<template>
  <div class="page">
    <div class="page-body">
      <div class="between" style="margin-bottom: 18px">
        <div>
          <div class="page-title">Cycle count</div>
          <div class="muted" style="margin-top: 4px; font-size: 13px">
            {{ expected?.warehouse || session.boutique?.warehouse
            }}<span v-if="expected"> · system as of {{ fmtDateTime(expected.as_of) }}</span>
          </div>
        </div>
        <div class="row">
          <button class="btn" :disabled="loading" @click="load">{{ loading ? 'Loading' : 'Reload' }}</button>
          <button v-if="catalog.settings.scan_enabled" class="btn btn-primary" @click="scan.openSheet('raw')">
            Camera scan
          </button>
        </div>
      </div>
      <div v-if="error" class="crit" style="font-size: 13px; margin-bottom: 12px">{{ error }}</div>

      <template v-if="result">
        <div class="kpis">
          <div class="kpi">
            <div class="label">Count</div>
            <div class="num v">{{ result.cycle_count }}</div>
          </div>
          <div class="kpi">
            <div class="label">Serials scanned</div>
            <div class="num v">{{ result.scanned_serials }} / {{ result.expected_serials }}</div>
          </div>
          <div class="kpi">
            <div class="label">Unaccounted</div>
            <div class="num v" :class="{ crit: result.missing.length }">{{ result.missing.length }}</div>
          </div>
          <div class="kpi">
            <div class="label">Unexpected</div>
            <div class="num v" :class="{ warn: result.unexpected.length }">
              {{ result.unexpected.length }}
            </div>
          </div>
          <div class="kpi">
            <div class="label">Qty differences</div>
            <div class="num v" :class="{ warn: result.qty_differences.length }">
              {{ result.qty_differences.length }}
            </div>
          </div>
        </div>
        <div class="cols">
          <div class="card block">
            <div class="section-title">Unaccounted serials</div>
            <div v-if="!result.missing.length" class="good small">Every expected serial was scanned.</div>
            <div v-for="m in result.missing" :key="m.serial_no" class="between trow">
              <span>{{ itemName(m.item_code) }}</span
              ><span class="num crit">{{ m.serial_no }}</span>
            </div>
            <div v-if="result.unexpected.length" class="section-title" style="margin-top: 8px">
              Unexpected
            </div>
            <div v-for="u in result.unexpected" :key="u.serial_no" class="between trow">
              <span class="muted"
                >{{ u.item_code || 'unknown item' }} · {{ u.status
                }}<span v-if="u.warehouse"> · {{ u.warehouse }}</span></span
              ><span class="num warn">{{ u.serial_no }}</span>
            </div>
          </div>
          <div class="card block">
            <div class="section-title">Quantity differences</div>
            <div v-if="!result.qty_differences.length" class="good small">Counted quantities match.</div>
            <div v-for="d in result.qty_differences" :key="d.item_code" class="between trow">
              <span>{{ itemName(d.item_code) }}</span
              ><span class="num"
                >{{ d.expected }} → {{ d.counted }}
                <span :class="d.diff < 0 ? 'crit' : 'warn'"
                  >({{ d.diff > 0 ? '+' : '' }}{{ d.diff }})</span
                ></span
              >
            </div>
            <div v-if="result.stock_reconciliation" class="muted small">
              Draft Stock Reconciliation {{ result.stock_reconciliation }} is waiting for a manager in the
              desk.
            </div>
            <div class="row" style="margin-top: 8px">
              <button class="btn btn-primary" @click="restart">New count</button>
              <button class="btn btn-ghost" @click="router.push({ name: 'shift' })">Shift</button>
            </div>
          </div>
        </div>
      </template>

      <template v-else-if="expected && progress">
        <div class="kpis">
          <div class="kpi">
            <div class="label">Serials</div>
            <div class="num v">{{ progress.scanned_known }} / {{ progress.expected_serials }}</div>
          </div>
          <div class="kpi">
            <div class="label">Remaining</div>
            <div class="num v" :class="{ warn: progress.missing.length }">{{ progress.missing.length }}</div>
          </div>
          <div class="kpi">
            <div class="label">Unexpected</div>
            <div class="num v" :class="{ warn: progress.unexpected.length }">
              {{ progress.unexpected.length }}
            </div>
          </div>
          <div class="kpi">
            <div class="label">Qty items counted</div>
            <div class="num v">
              {{ qtyItems.filter((c) => counted[c] !== null && counted[c] !== undefined).length }} /
              {{ qtyItems.length }}
            </div>
          </div>
        </div>
        <div class="bar">
          <div
            class="fill"
            :style="{
              width:
                (progress.expected_serials
                  ? (100 * progress.scanned_known) / progress.expected_serials
                  : 100) + '%'
            }"
          ></div>
        </div>

        <div class="cols">
          <div class="card block">
            <div class="row">
              <button class="chip" :class="{ active: tab === 'serials' }" @click="tab = 'serials'">
                Serials
              </button>
              <button class="chip" :class="{ active: tab === 'qty' }" @click="tab = 'qty'">Quantities</button>
            </div>
            <template v-if="tab === 'serials'">
              <div class="row">
                <input
                  v-model="manual"
                  class="input"
                  placeholder="Scan a serial label, or type it"
                  @keydown.enter="addManual"
                />
                <button class="btn" :disabled="!manual.trim()" @click="addManual">Add</button>
              </div>
              <div v-if="lastScan" class="small" :class="lastScan.ok ? 'good' : 'warn'">
                Last: {{ lastScan.code }} · {{ lastScan.ok ? 'expected' : 'not expected here' }}
              </div>
              <div class="items">
                <div
                  v-for="b in progress.by_item"
                  :key="b.item_code"
                  class="item"
                  :class="{ done: b.scanned === b.expected }"
                >
                  <div class="between">
                    <span class="name">{{ itemName(b.item_code) }}</span>
                    <span class="num">{{ b.scanned }} / {{ b.expected }}</span>
                  </div>
                  <div class="serials">
                    <span
                      v-for="s in expected.serials[b.item_code]"
                      :key="s"
                      class="pill"
                      :class="scanned.includes(s) ? 'pill-good' : ''"
                      @click="scanned.includes(s) ? unscan(s) : onCode(s)"
                      >{{ s }}</span
                    >
                  </div>
                </div>
              </div>
            </template>
            <template v-else>
              <div class="label label-dim">Enter the number on hand for each item; leave blank to skip.</div>
              <div class="items">
                <div v-for="code in qtyItems" :key="code" class="item qtyrow between">
                  <span
                    ><span class="name">{{ itemName(code) }}</span
                    ><span class="muted small"> · system {{ expected.qty[code] }}</span></span
                  >
                  <span class="row" style="gap: 6px">
                    <input
                      v-model.number="counted[code]"
                      class="input qtyin"
                      inputmode="numeric"
                      placeholder="—"
                    />
                    <button class="btn" @click="fillExpected(code)">= {{ expected.qty[code] }}</button>
                  </span>
                </div>
              </div>
            </template>
          </div>

          <div class="card block summary">
            <div class="section-title">Review</div>
            <div class="between trow">
              <span class="label">Unaccounted</span
              ><span class="num" :class="{ crit: progress.missing.length }">{{
                progress.missing.length
              }}</span>
            </div>
            <div class="between trow">
              <span class="label">Unexpected</span
              ><span class="num" :class="{ warn: progress.unexpected.length }">{{
                progress.unexpected.length
              }}</span>
            </div>
            <div class="between trow">
              <span class="label">Qty differences</span
              ><span class="num" :class="{ warn: progress.qty_differences.length }">{{
                progress.qty_differences.length
              }}</span>
            </div>
            <div v-for="u in progress.unexpected" :key="u" class="between trow small">
              <span class="muted">unexpected</span
              ><span class="num warn"
                >{{ u }} <button class="icon-btn" aria-label="Remove" @click="unscan(u)">×</button></span
              >
            </div>
            <div class="hr"></div>
            <div class="muted small">
              Serial discrepancies are reported to the manager; quantity differences become a draft Stock
              Reconciliation for approval.
            </div>
            <button
              class="btn btn-primary btn-big btn-block"
              :disabled="submitting || (!scanned.length && !countedAll)"
              @click="submit"
            >
              {{ submitting ? 'Submitting' : 'Submit count' }}
            </button>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.kpis {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  border: var(--line-w) solid var(--line);
  background: var(--surface);
  margin-bottom: 10px;
}
.kpi {
  padding: 14px 18px;
  border-right: var(--line-w) solid var(--line);
}
.kpi:last-child {
  border-right: 0;
}
.kpi .v {
  font-size: 20px;
  margin-top: 4px;
}
.bar {
  height: 4px;
  background: var(--line);
  margin-bottom: 16px;
}
.fill {
  height: 100%;
  background: var(--accent);
  transition: width 0.2s;
}
.cols {
  display: grid;
  grid-template-columns: 1fr 320px;
  gap: 16px;
}
.block {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.items {
  display: flex;
  flex-direction: column;
  gap: var(--line-w);
  background: var(--line);
  border: var(--line-w) solid var(--line);
  max-height: 60vh;
  overflow: auto;
}
.item {
  background: var(--surface);
  padding: 10px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.item.done {
  box-shadow: inset 3px 0 0 var(--good);
}
.item .name {
  font-weight: 500;
  font-size: 14px;
}
.serials {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.serials .pill {
  cursor: pointer;
}
.qtyrow {
  flex-direction: row;
  align-items: center;
  min-height: var(--touch);
}
.qtyin {
  width: 90px;
  text-align: right;
}
.trow {
  font-size: 14px;
}
.small {
  font-size: 12px;
}
@media (max-width: 767px) {
  .cols {
    grid-template-columns: 1fr;
  }
}
</style>
