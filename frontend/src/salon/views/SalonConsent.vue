<script setup lang="ts">
/**
 * v0.5 K — the v0.3 consent screen, shown on the Salon. Agreeing (hold-to-agree / signature) hands
 * the consent to the POS, which owns the camera and completes the three captures; this screen then
 * mirrors the POS's capture / saving / done steps from the remote state.
 */
import { computed, reactive } from 'vue'
import ConsentScreen, { type ConsentController } from '@/components/ConsentScreen.vue'
import { DEFAULT_CONSENT_TEXT } from '@/api/types'
import { useSalonStore } from '../store'

const props = defineProps<{ local?: boolean }>()
const emit = defineEmits<{ done: [agreed: boolean] }>()
const salon = useSalonStore()
const remoteStep = computed(() => salon.remote.screen === 'consent' ? (salon.remote.step as string) : null)
const step = computed<ConsentController['enrolStep']>(() => {
  if (props.local && !remoteStep.value) return 'consent'
  if (remoteStep.value === 'capture') return 'capture'
  if (remoteStep.value === 'done' || remoteStep.value === 'unavailable') return 'saving'
  return 'consent'
})
const captured = computed(() => Number((salon.remote as { captured?: number }).captured || 0))

const controller = reactive<ConsentController>({
  get enrolStep() {
    return step.value
  },
  get captureSamples() {
    return { length: captured.value }
  },
  captureTarget: 3,
  get clientName() {
    return salon.client?.first_name || ''
  },
  get consentText() {
    return salon.settings?.consent_text || DEFAULT_CONSENT_TEXT
  },
  get consentVersion() {
    return salon.settings?.consent_text_version || '2026-08-1'
  },
  get enrolError() {
    return salon.error
  },
  async agree(consent) {
    const ok = await salon.consent(consent.method, consent.signature_data_url)
    if (ok) emit('done', true)
    return ok
  },
  async decline() {
    await salon.declineConsent()
    emit('done', false)
  },
  closeEnrol() {
    emit('done', false)
  }
})
</script>

<template>
  <div class="salon-screen" data-testid="salon-consent" :data-step="step">
    <template v-if="remoteStep === 'unavailable'">
      <div class="s-eyebrow">Thank you</div>
      <div class="s-title soft">We will finish this at the counter</div>
      <p class="s-lead">The camera is not available on this device right now. Your consent has been recorded; an associate will complete the enrolment with you.</p>
    </template>
    <template v-else-if="remoteStep === 'done'">
      <div class="s-eyebrow">Thank you</div>
      <div class="s-title soft">The house will recognise you</div>
      <p class="s-lead">You can withdraw this at any time by asking any associate.</p>
    </template>
    <ConsentScreen v-else :controller="controller" />
  </div>
</template>
