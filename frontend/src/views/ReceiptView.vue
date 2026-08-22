<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { liveQuery } from 'dexie'
import { db, type QueueRow } from '@/db'
import { useSyncStore } from '@/stores/sync'
import { usePrinterStore } from '@/stores/printer'
import { useSessionStore } from '@/stores/session'
import { fmtMoney } from '@/utils/money'
import Receipt80 from '@/components/Receipt80.vue'
import Modal from '@/components/Modal.vue'

const props = defineProps<{ uuid: string }>()
const router = useRouter()
const sync = useSyncStore()
const printer = usePrinterStore()
const session = useSessionStore()

const row = ref<QueueRow | null>(null)
const printed = ref<'epos' | 'browser' | null>(null)
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
  <div class="receipt-view">
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
        <div class="print-meta muted">
          <div v-if="printer.effectiveIp">Printer {{ printer.effectiveIp }} ({{ session.boutique?.printer_model || 'ePOS' }})</div>
          <div v-else class="warn">No printer configured; Print uses the browser dialog.</div>
          <div v-if="printer.lastError" class="warn">{{ printer.lastError }}</div>
          <div v-if="printed === 'epos'" class="good">Sent to printer.</div>
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
