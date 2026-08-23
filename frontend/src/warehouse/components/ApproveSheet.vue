<script setup lang="ts">
/**
 * v0.6 P — replenishment request: approve (optionally with edited quantities) or reject with a reason.
 */
import { onMounted, ref, watch } from 'vue'
import Modal from '@/components/Modal.vue'
import { warehouseApi, type ReplenishmentRequest } from '@/api/warehouse'
import { useWarehouseStore } from '@/stores/warehouse'
import { fmtDateTime } from '@/utils/device'

const props = defineProps<{ name: string; large?: boolean }>()
const emit = defineEmits<{ close: []; changed: [shipment?: string] }>()
const wh = useWarehouseStore()

const req = ref<ReplenishmentRequest | null>(null)
const qty = ref<Record<string, number>>({})
const notes = ref('')
const reason = ref('')
const rejecting = ref(false)
const busy = ref(false)
const error = ref('')

async function load() {
  try {
    req.value = await warehouseApi.admin.request_detail(props.name)
    qty.value = Object.fromEntries(req.value.lines.map((l) => [l.item_code, l.approved_qty ?? l.qty]))
  } catch (e) {
    error.value = (e as Error).message
  }
}
onMounted(load)
watch(() => props.name, load)

async function approve() {
  if (!req.value) return
  busy.value = true
  error.value = ''
  try {
    const out = await wh.approve(props.name, req.value.lines.map((l) => ({ item_code: l.item_code, approved_qty: Number(qty.value[l.item_code] || 0) })), notes.value || undefined)
    emit('changed', out.shipment.name)
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function reject() {
  if (!reason.value.trim()) {
    error.value = 'A rejection reason is required'
    return
  }
  busy.value = true
  error.value = ''
  try {
    await wh.reject(props.name, reason.value.trim())
    emit('changed')
    emit('close')
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <Modal :title="name" :width="large ? '980px' : '760px'" @close="emit('close')">
    <div v-if="error" class="crit" style="margin-bottom: 12px" data-testid="approve-error">{{ error }}</div>
    <div v-if="!req" class="muted">Loading…</div>
    <div v-else data-testid="approve-sheet">
      <div class="between" style="margin-bottom: 14px">
        <div>
          <div class="display" style="font-size: 22px">{{ req.boutique }} <span class="muted">{{ req.boutique_name }}</span></div>
          <div class="label label-dim" style="margin-top: 4px">
            {{ req.requested_by }} · {{ req.requested_at ? fmtDateTime(req.requested_at) : '' }} · {{ req.from_warehouse }} → {{ req.to_warehouse }}
          </div>
        </div>
        <div class="row">
          <span v-if="req.priority !== 'Normal'" class="pill pill-warn">⚑ {{ req.priority }}</span>
          <span class="pill" :class="req.status === 'Pending Approval' ? 'pill-accent' : req.status === 'Rejected' ? 'pill-crit' : 'pill-good'">{{ req.status }}</span>
        </div>
      </div>
      <div v-if="req.reason" class="muted" style="font-size: 14px; margin-bottom: 12px; white-space: pre-line">{{ req.reason }}</div>
      <table class="table">
        <thead>
          <tr><th>Item</th><th class="num">Store</th><th class="num">Warehouse</th><th class="num">Requested</th><th class="num">Approve</th></tr>
        </thead>
        <tbody>
          <tr v-for="l in req.lines" :key="l.item_code">
            <td><div class="ellipsis" style="max-width: 360px">{{ l.item_name || l.item_code }}</div><div class="label label-dim">{{ l.item_code }}<span v-if="l.stock_alert"> · low stock</span></div></td>
            <td class="num" :class="{ crit: (l.on_hand_store || 0) <= 0 }">{{ l.on_hand_store ?? '—' }}</td>
            <td class="num" :class="{ warn: (l.on_hand_warehouse || 0) < l.qty }">{{ l.on_hand_warehouse ?? '—' }}</td>
            <td class="num">{{ l.qty }}</td>
            <td class="num"><input v-model.number="qty[l.item_code]" class="input qty" inputmode="numeric" :disabled="req.status !== 'Pending Approval'" :data-testid="`approve-qty-${l.item_code}`" /></td>
          </tr>
        </tbody>
      </table>
      <template v-if="req.status === 'Pending Approval'">
        <div v-if="!rejecting" class="field" style="margin-top: 14px">
          <label class="label">Note to the store (optional)</label>
          <input v-model="notes" class="input" placeholder="e.g. only 4 on hand, rest next week" />
        </div>
        <div v-else class="field" style="margin-top: 14px">
          <label class="label crit">Rejection reason (the manager is notified)</label>
          <input v-model="reason" class="input" placeholder="e.g. item discontinued — order the 20K instead" data-testid="reject-reason" />
        </div>
      </template>
      <div v-else-if="req.rejection_reason" class="crit" style="margin-top: 12px">Rejected: {{ req.rejection_reason }}</div>
      <div v-else-if="req.shipment" class="good" style="margin-top: 12px">Shipment {{ req.shipment }}</div>
    </div>
    <template #footer>
      <div v-if="req?.status === 'Pending Approval'" class="between" style="width: 100%">
        <button v-if="!rejecting" class="btn btn-ghost" :disabled="busy" data-testid="action-reject" @click="rejecting = true">Reject…</button>
        <button v-else class="btn btn-crit" :disabled="busy" data-testid="action-reject-confirm" @click="reject">Reject request</button>
        <div class="row">
          <button v-if="rejecting" class="btn" :disabled="busy" @click="rejecting = false">Back</button>
          <button v-else class="btn btn-primary btn-big" :disabled="busy" data-testid="action-approve" @click="approve">{{ busy ? 'Approving…' : 'Approve & create shipment' }}</button>
        </div>
      </div>
    </template>
  </Modal>
</template>

<style scoped>
.qty {
  width: 92px;
  text-align: right;
  min-height: 44px;
}
</style>
