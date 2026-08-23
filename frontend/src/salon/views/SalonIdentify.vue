<script setup lang="ts">
/** v0.5 K — "Are you a client of the house?": phone / client № on the keypad, e-mail, client QR, or Join. */
import { computed, ref } from 'vue'
import { useSalonStore } from '../store'
import { maskTyping } from '../mask'
import SalonKeypad from '../components/SalonKeypad.vue'
import ScanSheet from '../components/ScanSheet.vue'
import { fmtMoney } from '@/utils/money'

const salon = useSalonStore()
const mode = computed(() => salon.model.identify)
const typed = ref('')
const email = ref('')
const display = computed(() => maskTyping(typed.value))
const prepared = computed(() => {
  const lines = salon.remote.lines || []
  return lines.find((l) => l.id === salon.remote.focus_line) || lines[lines.length - 1] || null
})

function key(k: string) {
  if (k === 'clear') typed.value = ''
  else if (k === 'back') typed.value = typed.value.slice(0, -1)
  else if (typed.value.length < 16) typed.value += k
}
async function go() {
  const code = mode.value === 'email' ? email.value.trim() : typed.value
  if (!code) return
  if (await salon.identify(code)) {
    typed.value = ''
    email.value = ''
  }
}
async function scanned(v: string) {
  await salon.identify(v)
}
function back() {
  salon.setIdentifyMode('menu')
  typed.value = ''
}
</script>

<template>
  <div class="salon-screen" data-testid="salon-identify" :data-mode="mode">
    <template v-if="mode === 'menu'">
      <div class="s-eyebrow">Good {{ new Date(salon.now).getHours() < 12 ? 'morning' : new Date(salon.now).getHours() < 18 ? 'afternoon' : 'evening' }}</div>
      <div class="s-title soft">Are you a client of the house?</div>
      <p class="s-lead">Let us know who you are and your points and preferences follow you to the counter.</p>
      <div class="s-rule"></div>
      <div class="menu">
        <button class="s-btn" type="button" data-testid="identify-phone" @click="salon.setIdentifyMode('keypad')">Phone or client №</button>
        <button class="s-btn" type="button" data-testid="identify-email" @click="salon.setIdentifyMode('email')">E-mail</button>
        <button class="s-btn" type="button" data-testid="identify-scan" @click="salon.setIdentifyMode('scan')">Scan client card</button>
        <button class="s-btn primary" type="button" data-testid="identify-join" @click="salon.setIdentifyMode('signup')">Join {{ salon.programName }}</button>
      </div>
      <div class="s-small s-dim">Or simply tell the associate — nothing is required.</div>
      <div v-if="prepared" class="prepared">
        <div class="s-small s-muted">Meanwhile, your associate has set aside <span class="s-gold">{{ prepared.item_name }}</span> · {{ fmtMoney(prepared.rate * prepared.qty, salon.currency) }}</div>
        <button class="s-btn ghost" type="button" data-testid="identify-not-now" @click="salon.setIdentifyMode('dismissed')">Not now — show my pieces</button>
      </div>
    </template>

    <template v-else-if="mode === 'keypad'">
      <div class="s-eyebrow">Welcome back</div>
      <div class="s-title soft">Your phone number or client №</div>
      <div class="s-keypad-display" data-testid="identify-display">{{ display || ' ' }}<span class="caret"></span></div>
      <SalonKeypad @key="key" />
      <div class="s-error" data-testid="identify-error">{{ salon.error }}</div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="identify-go" :disabled="typed.length < 4 || salon.busy" @click="go">{{ salon.busy ? 'One moment' : 'Find me' }}</button>
      </div>
      <div class="s-small s-dim">Only the last four digits are shown on this screen.</div>
    </template>

    <template v-else-if="mode === 'email'">
      <div class="s-eyebrow">Welcome back</div>
      <div class="s-title soft">Your e-mail</div>
      <div class="s-field">
        <input v-model="email" class="s-input" type="email" inputmode="email" autocapitalize="off" autocomplete="off" placeholder="name@example.com" data-testid="identify-email-input" @keyup.enter="go" />
      </div>
      <div class="s-error">{{ salon.error }}</div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" :disabled="!email.includes('@') || salon.busy" @click="go">Find me</button>
      </div>
    </template>

    <template v-else-if="mode === 'scan'">
      <div class="s-eyebrow">Welcome back</div>
      <div class="s-title soft">Hold your client card to the camera</div>
      <ScanSheet @result="scanned" @close="back" />
      <div class="s-error">{{ salon.error }}</div>
    </template>
  </div>
</template>

<style scoped>
.prepared {
  margin-top: calc(var(--s-unit) * 1.5);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}
.s-gold {
  color: var(--s-gold-2);
}
.menu {
  display: grid;
  grid-template-columns: repeat(2, minmax(220px, 1fr));
  gap: 14px;
  width: 100%;
  max-width: 640px;
}
.menu .s-btn {
  width: 100%;
}
@media (max-width: 560px) {
  .menu {
    grid-template-columns: 1fr;
  }
}
</style>
