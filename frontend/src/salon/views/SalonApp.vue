<script setup lang="ts">
/**
 * v0.5 K — Salon root: the "light on metal" canvas sits behind every screen; the chrome (wordmark,
 * boutique, clock, link dot) stays put while screens cross-fade slowly in the middle.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import { useSalonStore } from '../store'
import { AmbientLight } from '../ambient'
import { codeFromScan } from '../pairing'
import SalonPair from './SalonPair.vue'
import SalonAmbient from './SalonAmbient.vue'
import SalonIdentify from './SalonIdentify.vue'
import SalonSignup from './SalonSignup.vue'
import SalonClient from './SalonClient.vue'
import SalonBasket from './SalonBasket.vue'
import SalonPay from './SalonPay.vue'
import SalonApproved from './SalonApproved.vue'
import SalonThankYou from './SalonThankYou.vue'
import SalonFeedback from './SalonFeedback.vue'
import SalonInvite from './SalonInvite.vue'
import SalonConsent from './SalonConsent.vue'
import SalonConcierge from './SalonConcierge.vue'
import SalonIdCheck from './SalonIdCheck.vue' // v0.6 N

const salon = useSalonStore()
const route = useRoute()
const canvas = ref<HTMLCanvasElement | null>(null)
let ambient: AmbientLight | null = null

const views = {
  pair: SalonPair,
  ambient: SalonAmbient,
  identify: SalonIdentify,
  signup: SalonSignup,
  client: SalonClient,
  basket: SalonBasket,
  pay: SalonPay,
  approved: SalonApproved,
  thankyou: SalonThankYou,
  feedback: SalonFeedback,
  invite: SalonInvite,
  idcheck: SalonIdCheck, // v0.6 N
  consent: SalonConsent,
  concierge: SalonConcierge,
  unpaired: SalonPair
} as const
const current = computed(() => views[salon.view])
const dimmed = computed(() => salon.view !== 'ambient' && salon.view !== 'pair')
const clock = computed(() => new Date(salon.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))

function onResize() {
  ambient?.resize()
}

onMounted(async () => {
  if (canvas.value) {
    ambient = new AmbientLight(canvas.value)
    ambient.start()
    window.addEventListener('resize', onResize)
  }
  await salon.restore()
  // deep link from the POS QR: /salon?code=123456
  const code = typeof route.query.code === 'string' ? codeFromScan(route.query.code) : null
  if (code && !salon.token) void salon.pair(code)
})
onBeforeUnmount(() => {
  ambient?.stop()
  window.removeEventListener('resize', onResize)
  salon.stop()
})
// expose for e2e / screenshots
watch(
  () => salon.view,
  (v) => {
    document.documentElement.dataset.salonView = v
  },
  { immediate: true }
)
</script>

<template>
  <div class="salon" :data-view="salon.view" data-testid="salon">
    <canvas ref="canvas" class="salon-bg" :class="{ dimmed }" aria-hidden="true"></canvas>
    <div class="salon-chrome">
      <div class="salon-top">
        <div class="salon-wordmark" data-testid="salon-wordmark">{{ salon.wordmark }}</div>
        <div class="salon-boutique">{{ salon.boutiqueName }}</div>
      </div>
      <div class="salon-bottom">
        <div class="salon-boutique"><span class="salon-dot" :class="{ off: !salon.token || salon.stale }"></span>{{ !salon.token ? 'Not paired' : salon.stale ? 'Reconnecting' : salon.connected ? 'Live' : 'Salon' }}</div>
        <div class="salon-clock" :class="{ hidden: salon.view === 'ambient' }" data-testid="salon-clock">{{ clock }}</div>
      </div>
    </div>
    <div class="salon-stage">
      <Transition name="salon-fade" mode="default">
        <component :is="current" :key="salon.view" />
      </Transition>
    </div>
  </div>
</template>

<style>
@import '../salon.css';
.salon-clock.hidden {
  opacity: 0;
}
</style>
