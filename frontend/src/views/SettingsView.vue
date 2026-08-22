<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { usePrinterStore } from '@/stores/printer'
import { useSyncStore } from '@/stores/sync'
import { useCartStore } from '@/stores/cart'
import { IS_MOCK } from '@/api'
import { db } from '@/db'
import { fmtDateTime } from '@/utils/device'
import { buildReceiptXml } from '@/printer/epos'
import { sendToPrinter } from '@/printer/epos'
import { useScanStore } from '@/stores/scan'
import { useRecognitionStore } from '@/stores/recognition'
import RecognitionTile from '@/components/RecognitionTile.vue'

const session = useSessionStore()
const catalog = useCatalogStore()
const printer = usePrinterStore()
const sync = useSyncStore()
const cart = useCartStore()
const router = useRouter()
const scan = useScanStore()
const recognition = useRecognitionStore()

// ---- client recognition (v0.3)
const cameras = ref<{ deviceId: string; label: string }[]>([])
const deviceMode = computed({
  get: () => (recognition.deviceEnabled === null ? 'boutique' : recognition.deviceEnabled ? 'on' : 'off'),
  set: (v: string) => void recognition.setDeviceEnabled(v === 'boutique' ? null : v === 'on')
})
/** Slider works in hundredths of the maximum euclidean distance (face-api rule: < 0.60). Lower = stricter. */
const thresholdHundredths = computed({
  get: () => Math.round(recognition.threshold * 100),
  set: (v: number) => void recognition.setThreshold(v / 100)
})
const boutiqueThresholdHundredths = computed(() => Math.round(catalog.settings.match_threshold * 100))
async function listCameras() {
  try {
    const devs = await navigator.mediaDevices.enumerateDevices()
    cameras.value = devs.filter((d) => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }))
  } catch {
    cameras.value = []
  }
}
onMounted(() => void listCameras())
onBeforeUnmount(() => recognition.setTestMode(false))
async function refreshTemplates() {
  await recognition.syncTemplates(true)
}
const imagesMode = computed({
  get: () => (catalog.imagesOverride === null ? 'boutique' : catalog.imagesOverride ? 'on' : 'off'),
  set: (v: string) => void catalog.setImagesOverride(v === 'boutique' ? null : v === 'on')
})

const saved = ref(false)
const refreshing = ref(false)
const testResult = ref('')
const mockOffline = ref(!!window.__maisonOffline)
const hasStripeKey = !!import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY

async function save() {
  await printer.save()
  saved.value = true
  setTimeout(() => (saved.value = false), 1500)
}
async function refresh() {
  refreshing.value = true
  await catalog.bootstrap(session.boutique!.name)
  refreshing.value = false
}
async function testPrint() {
  testResult.value = ''
  const xml = buildReceiptXml(
    {
      boutique: session.boutique!.name,
      boutique_name: session.boutique!.boutique_name,
      address_line: session.boutique!.address_line,
      city: session.boutique!.city,
      phone: session.boutique!.phone,
      associate_name: session.associate!.full_name,
      lines: [{ item_code: 'TEST', item_name: 'Test print', qty: 1, rate: 0, amount: 0 }],
      net_total: 0,
      discount: 0,
      total_taxes: 0,
      tax_rate: catalog.taxRate,
      loyalty_amount: 0,
      loyalty_points_redeemed: 0,
      grand_total: 0,
      payments: [],
      points_earned: 0,
      currency: session.currency
    },
    { offline_uuid: 'test-print', posting_datetime: new Date().toISOString() }
  )
  try {
    if (!printer.effectiveIp) throw new Error('No printer IP')
    await sendToPrinter(printer.effectiveIp, xml, 4000)
    testResult.value = 'Sent to ' + printer.effectiveIp
  } catch (e) {
    testResult.value = 'Failed: ' + (e as Error).message
  }
}
function toggleMockOffline() {
  window.__maisonOffline = mockOffline.value
  void sync.heartbeat()
  if (!mockOffline.value) void sync.replay()
}
async function resetDevice() {
  if (!confirm('Clear catalog, clients, queue and boutique from this device?')) return
  await Promise.all([db.catalog.clear(), db.prices.clear(), db.pricing_rules.clear(), db.serials.clear(), db.stock.clear(), db.customers.clear(), db.queue.clear(), db.settings.clear()])
  cart.clear()
  await session.forgetBoutique()
  catalog.$reset()
  router.push({ name: 'unlock' })
}
</script>

<template>
  <div class="page">
    <div class="page-body">
      <div class="page-title" style="margin-bottom: 20px">Settings</div>
      <div class="grid">
        <div class="card block">
          <div class="section-title">Boutique</div>
          <div class="kv"><span class="label">Name</span><span>{{ session.boutique?.boutique_name }}</span></div>
          <div class="kv"><span class="label">Code</span><span>{{ session.boutique?.name }}</span></div>
          <div class="kv"><span class="label">Warehouse</span><span>{{ session.boutique?.warehouse }}</span></div>
          <div class="kv"><span class="label">POS profile</span><span>{{ session.boutique?.pos_profile }}</span></div>
          <div class="kv"><span class="label">Tax</span><span>{{ session.boutique?.tax_template }} ({{ catalog.taxRate }}%)</span></div>
          <div class="kv"><span class="label">Device</span><span>{{ session.device_id }}</span></div>
          <div class="kv"><span class="label">Catalog</span><span>{{ catalog.items.length }} items &middot; {{ catalog.version ? fmtDateTime(catalog.version) : 'never' }}</span></div>
          <div class="row" style="margin-top: 6px">
            <button class="btn" :disabled="refreshing || !sync.browserOnline" @click="refresh">{{ refreshing ? 'Refreshing' : 'Refresh catalog' }}</button>
            <button class="btn btn-ghost" @click="session.forgetBoutique().then(() => router.push({ name: 'unlock' }))">Change boutique</button>
          </div>
        </div>

        <div class="card block">
          <div class="section-title">Printer</div>
          <div class="field">
            <label class="label">Printer IP (ePOS-Print)</label>
            <input v-model="printer.printer_ip" class="input" :placeholder="session.boutique?.printer_ip || '192.168.1.50'" inputmode="decimal" />
          </div>
          <label class="check">
            <input v-model="printer.openDrawerOnCash" type="checkbox" />
            <span>Open cash drawer on cash sales</span>
          </label>
          <div class="row">
            <button class="btn btn-primary" @click="save">{{ saved ? 'Saved' : 'Save' }}</button>
            <button class="btn" @click="testPrint">Test print</button>
          </div>
          <div v-if="testResult" class="muted" style="font-size: 13px">{{ testResult }}</div>
          <div class="muted" style="font-size: 13px">Model {{ session.boutique?.printer_model || 'TM-m30' }}. When the printer is unreachable, receipts open in the browser print dialog.</div>
        </div>

        <div class="card block">
          <div class="section-title">Display &amp; scanning</div>
          <div class="field">
            <label class="label">Product photos on tiles</label>
            <select v-model="imagesMode" class="input">
              <option value="boutique">Boutique default ({{ catalog.settings.show_product_images ? 'on' : 'off' }})</option>
              <option value="on">Always on this device</option>
              <option value="off">Always off this device</option>
            </select>
          </div>
          <div class="kv"><span class="label">Scanning</span><span>{{ catalog.settings.scan_enabled ? 'Keyboard wedge + camera' : 'Disabled' }}</span></div>
          <div class="kv"><span class="label">Last scan</span><span>{{ scan.last ? scan.last.code + ' → ' + scan.last.result : '—' }}</span></div>
          <div class="kv"><span class="label">Receipt QR</span><span>{{ catalog.settings.receipt_qr_enabled ? catalog.receiptQrBase + '/r/…' : 'Disabled' }}</span></div>
          <div class="kv"><span class="label">Client lookup</span><span>{{ catalog.settings.loyalty_lookup_enabled ? 'Client № / phone / QR' : 'Disabled' }}</span></div>
          <div class="kv"><span class="label">Queued photos</span><span>{{ sync.uploadsPending }}</span></div>
          <div class="row">
            <button class="btn" :disabled="!catalog.settings.scan_enabled" @click="scan.openSheet('any')">Open scanner</button>
          </div>
        </div>

        <div class="card block rec-block">
          <div class="between">
            <div class="section-title">Client recognition (camera)</div>
            <span class="pill" :class="recognition.boutiqueEnabled ? 'pill-accent' : ''">{{ recognition.boutiqueEnabled ? 'On for boutique' : 'Off by Head Office' }}</span>
          </div>
          <div class="muted small">
            On-device face matching for clients who gave written consent. Embeddings only — the POS never stores or uploads images. Recognition is off per boutique until Head Office switches it on; see README “Facial recognition: legal notice”.
          </div>
          <div class="field">
            <label class="label">This device</label>
            <select v-model="deviceMode" class="input" :disabled="!recognition.boutiqueEnabled" data-testid="recognition-device-mode">
              <option value="boutique">Follow boutique ({{ recognition.boutiqueEnabled ? 'on' : 'off' }})</option>
              <option value="on">On</option>
              <option value="off">Off on this device</option>
            </select>
          </div>
          <div class="field">
            <label class="label">Camera</label>
            <select class="input" :value="recognition.cameraId" :disabled="!recognition.boutiqueEnabled" @change="recognition.setCamera(($event.target as HTMLSelectElement).value)" @focus="listCameras">
              <option value="">Default (front)</option>
              <option v-for="c in cameras" :key="c.deviceId" :value="c.deviceId">{{ c.label }}</option>
            </select>
          </div>
          <label class="check">
            <input :checked="recognition.showPreview" type="checkbox" :disabled="!recognition.boutiqueEnabled" @change="recognition.setShowPreview(($event.target as HTMLInputElement).checked)" />
            <span>Show camera preview on the Sell screen <span class="dim">(off = blurred, detection still runs)</span></span>
          </label>
          <div v-if="session.isManager" class="field">
            <div class="between">
              <label class="label">Match threshold <span class="dim">(manager)</span></label>
              <span class="num accent">{{ recognition.threshold.toFixed(2) }}</span>
            </div>
            <input v-model.number="thresholdHundredths" class="range" type="range" min="20" :max="boutiqueThresholdHundredths" step="1" :disabled="!recognition.boutiqueEnabled" data-testid="recognition-threshold" />
            <div class="between small muted">
              <span>Max distance · boutique {{ catalog.settings.match_threshold.toFixed(2) }} · lower = stricter (device can only tighten)</span>
              <button v-if="recognition.thresholdOverride !== null" class="label link" @click="recognition.setThreshold(null)">Reset</button>
            </div>
          </div>
          <div class="kv"><span class="label">Model</span><span>{{ recognition.model }}{{ recognition.providerStatus.backend ? ' · ' + recognition.providerStatus.backend : '' }}</span></div>
          <div class="kv"><span class="label">Offline cache</span><span>{{ recognition.offlineCache ? recognition.cachedTemplates + ' templates' : 'Disabled' }}</span></div>
          <div class="kv"><span class="label">Queued enrolments</span><span>{{ recognition.pendingEnrolments }}</span></div>
          <div class="kv"><span class="label">Consent text</span><span>v{{ recognition.consentVersion }} · retention {{ catalog.settings.biometric_retention_months }} months</span></div>
          <div class="row">
            <button class="btn" :class="{ 'btn-primary': recognition.testMode }" :disabled="!recognition.boutiqueEnabled" data-testid="recognition-test" @click="recognition.setTestMode(!recognition.testMode)">
              {{ recognition.testMode ? 'Stop test' : 'Test recognition' }}
            </button>
            <button class="btn btn-ghost" :disabled="!sync.online || !recognition.offlineCache" @click="refreshTemplates">Refresh cache</button>
          </div>
          <div v-if="recognition.testMode" class="test" data-testid="recognition-test-panel">
            <RecognitionTile />
            <div class="test-status">
              <div class="kv"><span class="label">Phase</span><span>{{ recognition.providerStatus.phase }} · tracker {{ recognition.providerStatus.tracker }}</span></div>
              <div class="kv"><span class="label">Detection</span><span>{{ recognition.providerStatus.face ? 'face' : 'no face' }} · {{ recognition.providerStatus.lastMs }} ms · {{ recognition.providerStatus.fps }} fps</span></div>
              <div class="kv"><span class="label">Quality</span><span>{{ recognition.providerStatus.quality ? (recognition.providerStatus.quality.ok ? 'ok' : recognition.providerStatus.quality.reasons.join(', ')) + ' · q ' + recognition.providerStatus.quality.quality.toFixed(2) + ' · ' + Math.round(recognition.providerStatus.quality.faceWidth) + 'px' : '—' }}</span></div>
              <div class="kv"><span class="label">Hint</span><span>{{ recognition.providerStatus.hint || '—' }}</span></div>
            </div>
            <div class="test-log">
              <div class="label label-dim">Candidates (not attached to the sale in test mode)</div>
              <div v-if="!recognition.testLog.length" class="dim small">Waiting for a stable face with a blink or head motion…</div>
              <div v-for="(l, i) in recognition.testLog.slice(0, 8)" :key="i" class="small">{{ l }}</div>
            </div>
          </div>
        </div>

        <div class="card block">
          <div class="section-title">Payments</div>
          <div class="kv"><span class="label">Stripe</span><span>{{ hasStripeKey ? 'Terminal SDK' : 'Simulated reader' }}</span></div>
          <div class="kv"><span class="label">Location</span><span>{{ session.boutique?.stripe_location_id || '—' }}</span></div>
          <div class="kv"><span class="label">Currency</span><span>{{ session.currency }}</span></div>
        </div>

        <div class="card block">
          <div class="section-title">Sync</div>
          <div class="kv"><span class="label">Status</span><span :class="sync.online ? 'good' : 'crit'">{{ sync.online ? 'Online' : 'Offline' }}</span></div>
          <div class="kv"><span class="label">Last heartbeat</span><span>{{ sync.lastHeartbeat ? fmtDateTime(sync.lastHeartbeat) : '—' }}</span></div>
          <div class="kv"><span class="label">Queued</span><span>{{ sync.queued }}</span></div>
          <label v-if="IS_MOCK" class="check">
            <input v-model="mockOffline" type="checkbox" @change="toggleMockOffline" />
            <span>Simulate offline (mock API)</span>
          </label>
          <div class="row" style="margin-top: 6px">
            <button class="btn btn-crit" @click="resetDevice">Reset device</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
}
.block {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  font-size: 14px;
}
.kv span:last-child {
  text-align: right;
}
.check {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: var(--touch);
  font-size: 14px;
  cursor: pointer;
}
.check input {
  width: 20px;
  height: 20px;
  accent-color: var(--accent);
}
.small {
  font-size: 12px;
}
.range {
  width: 100%;
  accent-color: var(--accent);
  height: 32px;
}
.link {
  min-width: 0;
  min-height: 28px;
  padding: 0 4px;
  color: var(--accent);
}
.test {
  display: grid;
  grid-template-columns: 300px 1fr;
  gap: 16px;
  padding-top: 4px;
}
.test-status {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.test-log {
  grid-column: 1 / -1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: var(--line-w) solid var(--line);
  background: var(--ground);
  max-height: 180px;
  overflow: auto;
}
@media (max-width: 767px) {
  .test {
    grid-template-columns: 1fr;
  }
}
@media (max-width: 767px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>
