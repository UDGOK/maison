<script setup lang="ts">
/** v0.5 K — "Join <Rewards program>": name, phone or e-mail, optional birthday, marketing consent; then the optional recognition consent. */
import { computed, ref } from 'vue'
import { useSalonStore } from '../store'
import SalonConsent from './SalonConsent.vue'

const salon = useSalonStore()
const copy = computed(() => salon.settings?.rewards_copy || null) // v0.6 Q
const name = ref('')
const phone = ref('')
const email = ref('')
const birthday = ref('')
const mEmail = ref(true)
const mSms = ref(false)
const offer = ref<false | 'ask' | 'consent'>(false)
const valid = computed(() => name.value.trim().length >= 2 && (phone.value.replace(/\D/g, '').length >= 7 || email.value.includes('@')))

async function join() {
  if (!valid.value) return
  const r = await salon.signup({ name: name.value.trim(), phone: phone.value.trim() || undefined, email: email.value.trim() || undefined, birthday: birthday.value || undefined, marketing_email: mEmail.value ? 1 : 0, marketing_sms: mSms.value ? 1 : 0 })
  if (r.ok && r.offerRecognition) offer.value = 'ask'
}
</script>

<template>
  <div class="salon-screen" data-testid="salon-signup">
    <template v-if="!offer && !salon.model.offer">
      <div class="s-eyebrow" data-testid="signup-eyebrow">Join {{ salon.programName }}</div>
      <div class="s-title soft">{{ copy ? copy.earn : 'A few details, and the house will know you' }}</div>
      <!-- v0.6 Q: the client's exact program copy (same as /rewards) -->
      <div v-if="copy" class="program" data-testid="signup-program">
        <div class="tiers"><span v-for="t in copy.redeem" :key="t" class="tier">{{ t }}</span></div>
        <div class="perks"><span v-for="p in copy.perks" :key="p.title" class="perk">{{ p.title }}</span></div>
      </div>
      <form class="form" @submit.prevent="join">
        <label class="s-field">
          <span class="s-eyebrow">Name</span>
          <input v-model="name" class="s-input" type="text" autocomplete="off" autocapitalize="words" placeholder="First and last name" data-testid="signup-name" />
        </label>
        <div class="two">
          <label class="s-field">
            <span class="s-eyebrow">Mobile</span>
            <input v-model="phone" class="s-input" type="tel" inputmode="tel" autocomplete="off" placeholder="+1 …" data-testid="signup-phone" />
          </label>
          <label class="s-field">
            <span class="s-eyebrow">E-mail</span>
            <input v-model="email" class="s-input" type="email" inputmode="email" autocomplete="off" autocapitalize="off" placeholder="name@example.com" data-testid="signup-email" />
          </label>
        </div>
        <label class="s-field">
          <span class="s-eyebrow">Birthday (optional)</span>
          <input v-model="birthday" class="s-input" type="date" data-testid="signup-birthday" />
        </label>
        <div class="consents">
          <label class="s-check"><input v-model="mEmail" type="checkbox" data-testid="signup-marketing-email" /><span>E-mail me promotions, new arrivals, giveaways and event invites</span></label>
          <label class="s-check"><input v-model="mSms" type="checkbox" data-testid="signup-marketing-sms" /><span>Text me (SMS) about promotions and my rewards</span></label>
        </div>
        <div class="s-error" data-testid="signup-error">{{ salon.error }}</div>
        <div class="s-btn-row">
          <button class="s-btn ghost" type="button" @click="salon.setIdentifyMode('menu')">Back</button>
          <button class="s-btn primary" type="submit" data-testid="signup-submit" :disabled="!valid || salon.busy">{{ salon.busy ? 'One moment' : 'Join' }}</button>
        </div>
      </form>
      <div class="s-small s-dim">{{ salon.brandName }} keeps your name, contact details and purchase history to run the program. We never sell or share them.</div>
    </template>
    <SalonConsent v-else-if="offer === 'consent'" local @done="offer = false; salon.offerDone()" />
    <template v-else-if="offer === 'ask' || salon.model.offer">
      <div class="s-eyebrow">Welcome, {{ salon.client?.first_name }}</div>
      <div class="s-title soft">Shall we recognise you next time?</div>
      <p class="s-lead">With your consent, this {{ salon.storeNoun.toLowerCase() }} can recognise you by camera on your next visit, so your profile and points are ready before you reach the counter. It is entirely optional.</p>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" data-testid="signup-skip-recognition" @click="offer = false; salon.offerDone()">Not today</button>
        <button class="s-btn primary" type="button" data-testid="signup-offer-recognition" @click="offer = 'consent'">Read the consent</button>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* v0.6 Q — program copy */
.program {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 6px;
}
.tiers {
  display: flex;
  gap: 10px;
  justify-content: center;
  flex-wrap: wrap;
}
.tier {
  font-family: var(--s-display, inherit);
  font-size: 15px;
  letter-spacing: 0.04em;
  color: var(--s-gold, #c9a24d);
}
.perks {
  display: flex;
  gap: 14px;
  justify-content: center;
  flex-wrap: wrap;
  font-size: 12px;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  opacity: 0.65;
}
.form {
  width: 100%;
  max-width: 640px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  align-items: stretch;
}
.two {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
.consents {
  display: flex;
  flex-direction: column;
  text-align: left;
}
@media (max-width: 600px) {
  .two {
    grid-template-columns: 1fr;
  }
}
</style>
