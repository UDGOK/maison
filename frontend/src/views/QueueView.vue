<script setup lang="ts">
import { computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useSyncStore } from '@/stores/sync'
import { useSessionStore } from '@/stores/session'
import { fmtMoney } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'
import type { QueueRow } from '@/db'

const sync = useSyncStore()
const session = useSessionStore()
const router = useRouter()

onMounted(() => void sync.loadQueue())

const rows = computed(() => sync.queue)
function pill(r: QueueRow) {
  if (r.status === 'ok') return { cls: 'pill-good', text: 'Synced' }
  if (r.status === 'error') return { cls: 'pill-crit', text: 'Rejected' }
  if (r.status === 'sending') return { cls: 'pill-warn', text: 'Sending' }
  return { cls: 'pill-warn', text: 'Pending' }
}
function nextTry(r: QueueRow) {
  if (r.status !== 'pending' || !r.next_attempt_at) return ''
  const s = Math.max(0, Math.round((r.next_attempt_at - Date.now()) / 1000))
  return s ? `retry in ${s}s` : 'retrying'
}
async function discard(r: QueueRow) {
  if (!session.isManager) return
  if (confirm(`Discard sale ${r.offline_uuid.slice(0, 8).toUpperCase()}? This cannot be undone.`)) await sync.discard(r.offline_uuid)
}
</script>

<template>
  <div class="page">
    <div class="page-body">
      <div class="between" style="margin-bottom: 20px">
        <div>
          <div class="page-title">Queue</div>
          <div class="muted" style="margin-top: 4px; font-size: 13px">
            {{ sync.queued }} pending &middot; {{ sync.errored }} rejected &middot; {{ sync.sentToday }} synced
            <span v-if="sync.lastHeartbeat"> &middot; heartbeat {{ fmtDateTime(sync.lastHeartbeat, { year: undefined, month: undefined, day: undefined }) }}</span>
          </div>
        </div>
        <div class="row">
          <span class="pill" :class="sync.online ? 'pill-good' : 'pill-crit'"><span class="dot"></span>{{ sync.online ? 'Online' : 'Offline' }}</span>
          <button class="btn" :disabled="sync.replaying || !sync.browserOnline" @click="sync.heartbeat().then(() => sync.replay())">
            {{ sync.replaying ? 'Syncing' : 'Sync now' }}
          </button>
        </div>
      </div>

      <div v-if="!rows.length" class="label label-dim" style="padding: 40px 0; text-align: center">Queue is empty</div>
      <table v-else class="table">
        <thead>
          <tr>
            <th>Status</th>
            <th>Sale</th>
            <th>Time</th>
            <th>Client</th>
            <th class="num">Total</th>
            <th>Detail</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="r in rows" :key="r.offline_uuid">
            <td><span class="pill" :class="pill(r).cls"><span class="dot"></span>{{ pill(r).text }}</span></td>
            <td>
              <div>{{ r.invoice_name || r.offline_uuid.slice(0, 8).toUpperCase() }}</div>
              <div class="dim" style="font-size: 12px">{{ r.invoice.items.length }} line{{ r.invoice.items.length === 1 ? '' : 's' }} &middot; {{ r.invoice.payments[0]?.mode_of_payment }}</div>
            </td>
            <td>{{ fmtDateTime(r.invoice.posting_datetime) }}</td>
            <td>{{ r.receipt.customer_name || 'Walk-in' }}</td>
            <td class="num">{{ fmtMoney(r.receipt.grand_total, r.receipt.currency) }}</td>
            <td class="detail">
              <span v-if="r.status === 'error'" class="crit">{{ r.error }} <span class="dim">({{ r.error_code }})</span></span>
              <span v-else-if="r.status === 'pending'" class="muted">{{ nextTry(r) }}<span v-if="r.attempts"> &middot; {{ r.attempts }} attempt{{ r.attempts === 1 ? '' : 's' }}</span></span>
              <span v-else-if="r.status === 'ok'" class="muted">{{ r.sent_at ? fmtDateTime(r.sent_at) : '' }}</span>
            </td>
            <td class="acts">
              <button class="btn btn-ghost" @click="router.push({ name: 'receipt', params: { uuid: r.offline_uuid } })">Receipt</button>
              <button v-if="r.status === 'error'" class="btn" @click="sync.retry(r.offline_uuid)">Retry</button>
              <button v-if="r.status === 'error' && session.isManager" class="btn btn-crit" @click="discard(r)">Discard</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<style scoped>
.detail {
  max-width: 360px;
  font-size: 13px;
}
.acts {
  text-align: right;
  white-space: nowrap;
}
.acts .btn {
  padding: 0 14px;
  margin-left: 6px;
}
</style>
