<script setup lang="ts">
/**
 * v0.5 K — Settings → "Client display": pair a Salon iPad (6-digit code + QR, 10 min), see the
 * paired device and what it shows, unpair, Concierge toggle, and (mock) the virtual salon pane.
 */
import { computed, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { useSalonPosStore } from '@/stores/salon'
import { IS_MOCK } from '@/api'
import { formatCode, formatRemaining } from '@/salon/pairing'
import { fmtDateTime } from '@/utils/device'

const salon = useSalonPosStore()
const qr = ref('')
watch(
  () => salon.pairing?.qr,
  async (v) => {
    qr.value = v ? await QRCode.toDataURL(v, { errorCorrectionLevel: 'M', margin: 1, width: 220, color: { dark: '#0b0b0a', light: '#efe8da' } }) : ''
  },
  { immediate: true }
)
const labels: Record<string, string> = { idle: 'Ambient', identify: 'Identify', client: 'Welcome', basket: 'Basket', pay: 'Payment', approved: 'Approved', receipt: 'Thank you', consent: 'Consent', feedback: 'Feedback', concierge: 'Concierge' }
const screen = computed(() => labels[salon.lastScreen] || salon.lastScreen)
const salonUrl = computed(() => (typeof location !== 'undefined' ? `${location.origin}/salon` : '/salon'))
</script>

<template>
  <div class="card block" data-testid="salon-settings">
    <div class="section-title">Client display</div>
    <template v-if="salon.paired">
      <div class="kv"><span class="label">Status</span><span class="good" data-testid="salon-status">Paired</span></div>
      <div class="kv"><span class="label">Salon device</span><span>{{ salon.session?.salon_device_id || '—' }}</span></div>
      <div class="kv"><span class="label">Since</span><span>{{ salon.session?.paired_at ? fmtDateTime(salon.session.paired_at.replace(' ', 'T')) : '—' }}</span></div>
      <div class="kv"><span class="label">Link</span><span>{{ salon.connected ? 'Realtime' : 'Polling · 2 s' }}</span></div>
      <div class="kv"><span class="label">Showing</span><span class="accent" data-testid="salon-showing">{{ screen }}</span></div>
      <label class="check">
        <input type="checkbox" :checked="salon.concierge" data-testid="salon-concierge-toggle" @change="salon.setConcierge(($event.target as HTMLInputElement).checked)" />
        <span>Concierge mode (guided preferences while the client waits — needs a client attached)</span>
      </label>
      <div class="row" style="margin-top: 6px">
        <button class="btn btn-ghost" data-testid="salon-unpair" @click="salon.unpair()">Unpair</button>
        <button v-if="IS_MOCK" class="btn" data-testid="salon-virtual" @click="salon.setVirtual(!salon.virtualOpen)">{{ salon.virtualOpen ? 'Hide virtual salon' : 'Show virtual salon' }}</button>
      </div>
    </template>
    <template v-else-if="salon.pairingActive && salon.pairing">
      <div class="pair">
        <div class="pair-left">
          <div class="label label-dim">Enter this code on the Salon iPad</div>
          <div class="code display" data-testid="salon-pair-code">{{ formatCode(salon.pairing.code) }}</div>
          <div class="small dim">Expires in <span class="num" data-testid="salon-pair-ttl">{{ formatRemaining(salon.pairingRemainingMs) }}</span> · open <span class="accent">{{ salonUrl }}</span> on the client-facing iPad</div>
          <div class="small dim">Waiting for the Salon{{ salon.connected ? '' : '' }}…</div>
          <div class="row" style="margin-top: 8px">
            <button class="btn btn-ghost" @click="salon.cancelCode()">Cancel</button>
            <button class="btn" @click="salon.requestCode()">New code</button>
            <button v-if="IS_MOCK" class="btn" data-testid="salon-virtual" @click="salon.setVirtual(true)">Open virtual salon</button>
          </div>
        </div>
        <img v-if="qr" :src="qr" alt="Pairing QR" class="qr" data-testid="salon-pair-qr" />
      </div>
    </template>
    <template v-else>
      <div class="kv"><span class="label">Status</span><span class="dim" data-testid="salon-status">Not paired</span></div>
      <div class="small dim">A second iPad facing the client shows an ambient screen, lets the client identify or join Maison, mirrors the basket, the payment and the thank-you with points and feedback.</div>
      <div v-if="salon.error" class="crit small">{{ salon.error }}</div>
      <div class="row" style="margin-top: 6px">
        <button class="btn btn-primary" data-testid="salon-pair" :disabled="salon.busy" @click="salon.requestCode()">Pair a client display</button>
        <button v-if="IS_MOCK" class="btn" data-testid="salon-virtual" @click="salon.setVirtual(!salon.virtualOpen)">{{ salon.virtualOpen ? 'Hide virtual salon' : 'Show virtual salon' }}</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
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
.pair {
  display: flex;
  gap: 20px;
  align-items: flex-start;
}
.pair-left {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.code {
  font-size: 44px;
  letter-spacing: 0.18em;
  color: var(--accent);
  font-variant-numeric: tabular-nums;
}
.qr {
  width: 132px;
  height: 132px;
  border: var(--line-w) solid var(--line);
}
</style>
