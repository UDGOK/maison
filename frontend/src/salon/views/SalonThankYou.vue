<script setup lang="ts">
/**
 * v0.5 K — thank-you: the client's name, points earned, new balance and tier progress, the receipt QR,
 * "Email my receipt", then the private feedback and the private-viewing invitation. Returns to ambient
 * after 20 s of quiet.
 */
import { computed, ref, watch } from 'vue'
import QRCode from 'qrcode'
import { useSalonStore } from '../store'
import { fmtInt, fmtMoney } from '@/utils/money'

const salon = useSalonStore()
const r = computed(() => salon.remote.receipt || {})
const url = computed(() => r.value.receipt_url || (r.value.receipt_token ? `${salon.settings?.receipt_qr_base_url || location.origin}/r/${r.value.receipt_token}` : null))
const qr = ref('')
watch(
  url,
  async (u) => {
    qr.value = u ? await QRCode.toDataURL(u, { errorCorrectionLevel: 'M', margin: 1, width: 320, color: { dark: '#0b0b0a', light: '#efe8da' } }) : ''
  },
  { immediate: true }
)
const balance = computed(() => (r.value.points_balance ?? (salon.client?.loyalty_points || 0) + (r.value.points_earned || 0)) as number)
const pct = computed(() => Math.round(((r.value.tier_progress ?? salon.client?.tier_progress ?? 0) as number) * 100))
const emailMode = ref(false)
const email = ref('')
const done = computed(() => salon.model.receiptStage === 'done')
const feedbackEnabled = computed(() => salon.settings?.feedback_enabled !== 0)

async function sendEmail() {
  if (await salon.emailReceipt(salon.client?.has_email && !email.value ? undefined : email.value)) emailMode.value = false
}
</script>

<template>
  <div class="salon-screen wide" data-testid="salon-thankyou">
    <div class="s-eyebrow">Thank you</div>
    <div class="s-title soft">
      <template v-if="salon.client">Until next time, <span class="gold">{{ salon.client.first_name }}</span></template>
      <template v-else>Thank you for your visit</template>
    </div>
    <div class="s-rule"></div>
    <div class="s-cols">
      <div class="left">
        <div v-if="salon.client" class="points">
          <div class="s-num xl" data-testid="thankyou-points">+{{ fmtInt(r.points_earned || salon.remote.points_earned || 0) }}</div>
          <div class="s-eyebrow s-dim">Points earned</div>
          <div class="balance s-muted">Balance <span class="s-num md">{{ fmtInt(balance) }}</span><span v-if="r.tier || salon.client.tier"> · {{ r.tier || salon.client.tier }}</span></div>
          <div v-if="r.next_tier || salon.client.next_tier" class="bar"><span :style="{ width: pct + '%' }"></span></div>
          <div v-if="r.next_tier || salon.client.next_tier" class="s-small s-dim">{{ pct }}% of the way to {{ r.next_tier || salon.client.next_tier }}</div>
          <!-- v0.6 Q: next reward + giveaway entries -->
          <div v-if="r.next_reward" class="s-small s-muted" data-testid="thankyou-next-reward">Next reward: <span class="gold">{{ fmtMoney(r.next_reward.amount, salon.currency) }} off</span> at {{ fmtInt(r.next_reward.points) }} points · {{ fmtInt(r.next_reward.points_needed) }} to go</div>
          <div v-if="r.giveaway_entries" class="s-small s-muted" data-testid="thankyou-giveaway">{{ fmtInt(r.giveaway_entries) }} giveaway {{ r.giveaway_entries === 1 ? 'entry' : 'entries' }}<template v-if="r.giveaway_title"> · {{ r.giveaway_title }}</template></div>
        </div>
        <div v-else class="s-num lg">{{ fmtMoney(r.grand_total || salon.remote.totals?.grand_total || 0, salon.currency) }}</div>
      </div>
      <div class="s-col-right right">
        <div class="qr-wrap">
          <img v-if="qr" :src="qr" alt="Receipt QR" class="qr" data-testid="thankyou-qr" />
          <div v-else class="qr pending s-small s-dim">Issuing your receipt…</div>
          <div class="s-small s-dim">Scan for your receipt</div>
        </div>
        <div class="email">
          <template v-if="salon.emailMasked">
            <div class="s-small s-gold" data-testid="thankyou-emailed">Receipt sent to {{ salon.emailMasked }}</div>
          </template>
          <template v-else-if="!emailMode">
            <button class="s-btn ghost" type="button" data-testid="thankyou-email" :disabled="!url" @click="salon.client?.has_email ? sendEmail() : (emailMode = true)">
              {{ salon.client?.has_email ? `Email my receipt to ${salon.client.email_masked}` : 'Email my receipt' }}
            </button>
          </template>
          <form v-else class="email-form" @submit.prevent="sendEmail">
            <input v-model="email" class="s-input" type="email" inputmode="email" autocapitalize="off" placeholder="name@example.com" data-testid="thankyou-email-input" />
            <div class="s-btn-row">
              <button class="s-btn ghost" type="button" @click="emailMode = false">Cancel</button>
              <button class="s-btn primary" type="submit" :disabled="!email.includes('@') || salon.busy">Send</button>
            </div>
          </form>
          <div class="s-error">{{ salon.error }}</div>
        </div>
      </div>
    </div>
    <div class="s-btn-row" style="margin-top: 8px">
      <button v-if="feedbackEnabled && !salon.feedbackDone && !done" class="s-btn" type="button" data-testid="thankyou-feedback" @click="salon.setReceiptStage('feedback')">How was your visit?</button>
      <button class="s-btn ghost" type="button" data-testid="thankyou-done" @click="salon.dismiss()">Done</button>
    </div>
    <div class="s-small s-dim" data-testid="thankyou-countdown">{{ salon.ambientCountdown ? `This screen clears in ${salon.ambientCountdown} s` : '' }}</div>
  </div>
</template>

<style scoped>
.salon-screen {
  max-height: 100%;
  overflow: hidden;
  gap: calc(var(--s-unit) * 1);
}
.gold {
  color: var(--s-gold-2);
}
.left,
.right {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.points {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.balance {
  margin-top: 6px;
}
.bar {
  width: 280px;
  height: 2px;
  background: var(--s-line-soft);
  position: relative;
  overflow: hidden;
  margin-top: 8px;
}
.bar span {
  position: absolute;
  inset: 0 auto 0 0;
  background: linear-gradient(90deg, var(--s-gold-deep), var(--s-gold-2));
  transition: width 1600ms var(--s-ease);
}
.qr-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.qr {
  width: clamp(140px, 22vmin, 220px);
  aspect-ratio: 1;
  border: 6px solid #efe8da;
  background: #efe8da;
  display: grid;
  place-items: center;
}
.qr.pending {
  border-color: var(--s-line-soft);
  background: rgba(20, 19, 17, 0.5);
}
.email {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.email-form {
  width: 100%;
  max-width: 460px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.s-gold {
  color: var(--s-gold-2);
}
@media (orientation: landscape) and (min-width: 900px) {
  .left {
    align-items: flex-start;
    text-align: left;
  }
  .points {
    align-items: flex-start;
  }
}
</style>
