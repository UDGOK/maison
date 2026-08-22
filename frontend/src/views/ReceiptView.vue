<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { liveQuery } from 'dexie'
import { db, type QueueRow } from '@/db'
import { useSyncStore } from '@/stores/sync'
import { usePrinterStore } from '@/stores/printer'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { useLayoutStore } from '@/stores/layout'
import { receiptQrContent } from '@/printer/epos'
import { fmtMoney } from '@/utils/money'
import Receipt80 from '@/components/Receipt80.vue'
import Modal from '@/components/Modal.vue'

const props = defineProps<{ uuid: string }>()
const router = useRouter()
const sync = useSyncStore()
const printer = usePrinterStore()
const session = useSessionStore()
const catalog = useCatalogStore()
const layout = useLayoutStore()

const row = ref<QueueRow | null>(null)
const copied = ref(false)
const receiptLink = computed(() =>
  row.value
    ? receiptQrContent(
        { receipt_token: row.value.receipt_token, receipt_qr_enabled: catalog.settings.receipt_qr_enabled, receipt_qr_base_url: row.value.receipt.receipt_qr_base_url },
        catalog.receiptQrBase
      )
    : null
)
async function copyLink() {
  if (!receiptLink.value) return
  try {
    await navigator.clipboard.writeText(receiptLink.value)
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  } catch {
    /* clipboard unavailable */
  }
}
const printed = ref<'reader' | 'epos' | 'browser' | null>(null)
const emailOpen = ref(false)
const email = ref('')
const emailSent = ref(false)

let sub: { unsubscribe(): void } | null = null
function observe() {
  sub?.unsubscribe()
  sub = liveQuery(() => db.queue.get(props.uuid)).subscribe({ next: (r) => (row.value = r || null) })
}
onMounted(observe)
watch(() => props.uuid, observe)

const statusPill = computed(() => {
  const s = row.value?.status
  if (s === 'ok') return { cls: 'pill-good', text: 'Synced' }
  if (s === 'error') return { cls: 'pill-crit', text: 'Rejected' }
  if (s === 'sending') return { cls: 'pill-warn', text: 'Sending' }
  return { cls: 'pill-warn', text: sync.online ? 'Queued' : 'Queued offline' }
})

async function print() {
  if (!row.value) return
  printed.value = await printer.print(row.value)
}
function sendEmail() {
  // Email delivery is server-side (Frappe sends the Maison Receipt print format on sync).
  // Here we record the intent in notes so the backend can pick it up.
  if (!row.value) return
  void db.queue.update(row.value.offline_uuid, { invoice: { ...row.value.invoice, notes: `email:${email.value}` } })
  emailSent.value = true
  emailOpen.value = false
}
function done() {
  router.push({ name: 'sell' })
}
</script>

<template>
  <div class="receipt-view" :class="{ phone: layout.phone }">
    <div class="left no-print">
      <template v-if="row">
        <div class="head">
          <div class="label">Sale complete</div>
          <div class="big num">{{ fmtMoney(row.receipt.grand_total, row.receipt.currency) }}</div>
          <div class="row" style="margin-top: 14px">
            <span class="pill" :class="statusPill.cls"><span class="dot"></span>{{ statusPill.text }}</span>
            <span v-if="row.invoice_name" class="muted">{{ row.invoice_name }}</span>
            <span v-else class="dim">{{ row.offline_uuid.slice(0, 8).toUpperCase() }}</span>
          </div>
          <div v-if="row.status === 'error'" class="err card">
            <div class="label crit">Server rejected this sale</div>
            <div style="margin-top: 6px">{{ row.error }}</div>
            <button class="btn" style="margin-top: 12px" @click="router.push({ name: 'queue' })">Open queue</button>
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-big" :disabled="printer.printing" @click="print">
            {{ printer.printing ? 'Printing' : printed ? 'Print again' : 'Print receipt' }}
          </button>
          <button class="btn btn-big" @click="email = ''; emailOpen = true">{{ emailSent ? 'Email queued' : 'Email receipt' }}</button>
          <button class="btn btn-primary btn-big" @click="done">Done</button>
        </div>
        <div class="link-card card">
          <div class="label">Receipt link</div>
          <template v-if="receiptLink">
            <a class="link-url ellipsis" :href="receiptLink" target="_blank" rel="noopener">{{ receiptLink }}</a>
            <button class="btn" @click="copyLink">{{ copied ? 'Copied' : 'Copy link' }}</button>
          </template>
          <div v-else-if="!catalog.settings.receipt_qr_enabled" class="dim small">Receipt QR disabled in POS settings.</div>
          <div v-else class="dim small">Available once the sale has synced — the QR is added to the receipt automatically.</div>
        </div>
        <div class="print-meta muted">
          <div v-if="printer.effectiveIp">Printer {{ printer.effectiveIp }} ({{ session.boutique?.printer_model || 'ePOS' }})</div>
          <div v-else class="warn">No printer configured; Print uses the browser dialog.</div>
          <div v-if="printer.lastError" class="warn">{{ printer.lastError }}</div>
          <div v-if="printed === 'epos'" class="good">Sent to printer.</div>
          <div v-else-if="printed === 'reader'" class="good">Printed on {{ printer.reader?.label || 'reader' }}.</div>
        </div>
      </template>
      <div v-else class="label label-dim">Receipt not found</div>
    </div>

    <div class="preview">
      <div class="preview-inner">
        <Receipt80 v-if="row" :row="row" />
      </div>
    </div>

    <Modal v-if="emailOpen" title="Email receipt" width="420px" @close="emailOpen = false">
      <div class="field">
        <label class="label">Email address</label>
        <input v-model="email" class="input" inputmode="email" placeholder="client@example.com" />
      </div>
      <template #footer>
        <button class="btn btn-primary" :disabled="!email.includes('@')" @click="sendEmail">Send on sync</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.receipt-view {
  flex: 1;
  min-height: 0;
  display: flex;
}
.left {
  flex: 1;
  display: flex;
  flex-direction: column;
  padding: 36px 40px;
  gap: 28px;
  overflow: auto;
}
.big {
  font-size: 48px;
  margin-top: 8px;
  line-height: 1;
  color: var(--accent);
}
.err {
  margin-top: 18px;
  padding: 16px;
  border-color: var(--crit);
  max-width: 520px;
}
.actions {
  display: flex;
  gap: 12px;
  flex-wrap: wrap;
}
.print-meta {
  font-size: 13px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.link-card {
  padding: 14px 16px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-width: 520px;
}
.link-url {
  font-size: 14px;
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 3px;
}
.small {
  font-size: 13px;
}
.link-card .btn {
  align-self: flex-start;
}
.receipt-view.phone {
  flex-direction: column;
  overflow: auto;
}
.phone .left {
  flex: none;
  padding: 20px 16px;
  gap: 18px;
  overflow: visible;
}
.phone .big {
  font-size: 36px;
}
.phone .actions .btn {
  flex: 1 1 40%;
}
.phone .preview {
  width: auto;
  flex: none;
  border-left: 0;
  border-top: var(--line-w) solid var(--line);
  padding: 20px 12px calc(20px + var(--safe-bottom));
  overflow: visible;
}
.preview {
  width: 480px;
  flex: 0 0 480px;
  border-left: var(--line-w) solid var(--line);
  background: var(--surface);
  overflow: auto;
  display: flex;
  justify-content: center;
  padding: 32px;
}
.preview-inner {
  align-self: flex-start;
  box-shadow: 0 0 0 1px var(--line-strong);
}
@media print {
  .receipt-view {
    display: block;
  }
  .preview {
    width: auto;
    border: 0;
    padding: 0;
    background: #fff;
    display: block;
    overflow: visible;
  }
  .preview-inner {
    box-shadow: none;
  }
}
</style>
