<script setup lang="ts">
import { useBrand } from '@/stores/brand' // v0.6 N
const brand = useBrand() // v0.6 N
/**
 * Client-facing consent screen (full screen, large type). Agreement needs a deliberate act:
 * hold "Agree" for 600 ms (gold ring fills) or draw a signature and tap Agree. "No thanks"
 * still creates / links the client — without any biometrics.
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRecognitionStore, type EnrolStep } from '@/stores/recognition'
import { HoldToAgree, HOLD_MS, signatureValid, type StrokePoint } from '@/recognition/consent'
import type { ConsentPayload } from '@/api'

// --- v0.5 K: the Salon reuses this screen with its own controller (no recognition store on a guest device) ---
export interface ConsentController {
  enrolStep: EnrolStep
  captureSamples: { length: number }
  captureTarget: number
  clientName: string
  consentText: string
  consentVersion: string
  enrolError: string
  agree(consent: ConsentPayload): Promise<boolean>
  decline(): Promise<unknown>
  closeEnrol(): void
}
const props = defineProps<{ controller?: ConsentController }>()
const store = props.controller ? null : useRecognitionStore()
const recognition = (props.controller ||
  reactive({
    get enrolStep() {
      return store!.enrolStep
    },
    get captureSamples() {
      return store!.captureSamples
    },
    get captureTarget() {
      return store!.captureTarget
    },
    get clientName() {
      return store!.enrolDraft.customer?.customer_name || store!.enrolDraft.name || ''
    },
    get consentText() {
      return store!.consentText
    },
    get consentVersion() {
      return store!.consentVersion
    },
    get enrolError() {
      return store!.enrolError
    },
    agree: (c: ConsentPayload) => store!.agree(c),
    decline: () => store!.decline(),
    closeEnrol: () => store!.closeEnrol()
  })) as ConsentController
// --- end v0.5 K ---
const hold = new HoldToAgree(HOLD_MS)
const progress = ref(0)
const holding = ref(false)
const signMode = ref(false)
const strokes = ref<StrokePoint[][]>([])
const pad = ref<HTMLCanvasElement | null>(null)
const submitting = ref(false)
let raf = 0
let drawing = false

const RING_R = 54
const RING_C = 2 * Math.PI * RING_R
const dash = computed(() => RING_C * (1 - progress.value))
const signed = computed(() => signatureValid(strokes.value))
const step = computed(() => recognition.enrolStep)
const captured = computed(() => recognition.captureSamples.length)
const target = computed(() => recognition.captureTarget)
const clientName = computed(() => recognition.clientName)

function now() {
  return performance.now()
}
function tick() {
  progress.value = hold.progress(now())
  if (hold.done) {
    holding.value = false
    void submit('Hold-to-agree')
    return
  }
  if (hold.holding) raf = requestAnimationFrame(tick)
}
function press(e: Event) {
  if (submitting.value || step.value !== 'consent') return
  if (signMode.value) return // tap agrees when signed (handled by click)
  e.preventDefault()
  hold.press(now())
  holding.value = true
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(tick)
}
function release() {
  if (!hold.holding) return
  const ok = hold.release(now())
  holding.value = false
  cancelAnimationFrame(raf)
  if (ok) void submit('Hold-to-agree')
  else progress.value = 0
}
function tapAgree() {
  if (signMode.value && signed.value && !submitting.value) void submit('Signature')
}

async function submit(method: ConsentPayload['method']) {
  if (submitting.value) return
  submitting.value = true
  const consent: ConsentPayload = { method, text_version: recognition.consentVersion }
  if (method === 'Signature' && pad.value) consent.signature_data_url = pad.value.toDataURL('image/png')
  try {
    const ok = await recognition.agree(consent)
    if (!ok) {
      hold.reset()
      progress.value = 0
    }
  } finally {
    submitting.value = false
  }
}
async function decline() {
  if (submitting.value) return
  submitting.value = true
  try {
    await recognition.decline()
  } finally {
    submitting.value = false
  }
}

// ---- signature pad
function padPoint(e: PointerEvent): StrokePoint {
  const c = pad.value!
  const r = c.getBoundingClientRect()
  return { x: ((e.clientX - r.left) / r.width) * c.width, y: ((e.clientY - r.top) / r.height) * c.height }
}
function padDown(e: PointerEvent) {
  drawing = true
  pad.value?.setPointerCapture(e.pointerId)
  strokes.value.push([padPoint(e)])
}
function padMove(e: PointerEvent) {
  if (!drawing) return
  const s = strokes.value[strokes.value.length - 1]
  s.push(padPoint(e))
  const ctx = pad.value!.getContext('2d')!
  ctx.strokeStyle = '#C9A96E'
  ctx.lineWidth = 3
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(s[s.length - 2].x, s[s.length - 2].y)
  ctx.lineTo(s[s.length - 1].x, s[s.length - 1].y)
  ctx.stroke()
}
function padUp() {
  drawing = false
}
function clearPad() {
  strokes.value = []
  pad.value?.getContext('2d')?.clearRect(0, 0, pad.value.width, pad.value.height)
}
function sizePad() {
  const c = pad.value
  if (!c) return
  const r = c.getBoundingClientRect()
  c.width = Math.max(300, Math.round(r.width * 2))
  c.height = Math.round(r.height * 2)
  clearPad()
}
watch(signMode, (v) => v && requestAnimationFrame(sizePad))
onMounted(() => window.addEventListener('resize', sizePad))
onBeforeUnmount(() => {
  window.removeEventListener('resize', sizePad)
  cancelAnimationFrame(raf)
})
</script>

<template>
  <Teleport to="body">
    <div class="consent" :class="{ signing: signMode }" role="dialog" aria-label="Biometric consent" data-testid="consent-screen">
      <div class="top">
        <div class="wordmark display-900">{{ brand.wordmark }}</div>
        <div class="label">Client recognition · consent {{ recognition.consentVersion }}</div>
        <button class="close label" :disabled="submitting" @click="recognition.closeEnrol()">Cancel</button>
      </div>

      <div v-if="step === 'consent'" class="body scroll">
        <div class="greeting display">{{ clientName ? `${clientName},` : 'Welcome,' }}</div>
        <div class="title">May we recognise you next time?</div>
        <p class="text">{{ recognition.consentText }}</p>
        <p class="text small muted">Version {{ recognition.consentVersion }} · You can withdraw consent at any time by asking any associate; your face data is then deleted. This {{ brand.storeNoun.toLowerCase() }} displays a notice at its entrance and point of sale.</p>
        <div v-if="recognition.enrolError" class="crit">{{ recognition.enrolError }}</div>

        <div v-if="signMode" class="sign">
          <div class="label">Sign below to agree</div>
          <canvas ref="pad" class="pad" @pointerdown="padDown" @pointermove="padMove" @pointerup="padUp" @pointercancel="padUp" @pointerleave="padUp"></canvas>
          <div class="between">
            <button class="label link" @click="clearPad">Clear</button>
            <button class="label link" @click="signMode = false; clearPad()">Hold to agree instead</button>
          </div>
        </div>

        <div class="actions">
          <button class="btn btn-ghost decline" :disabled="submitting" data-testid="consent-decline" @click="decline">No thanks</button>

          <div class="agree-wrap">
            <button
              class="agree"
              :class="{ holding, signed: signMode && signed, ready: !signMode }"
              :disabled="submitting || (signMode && !signed)"
              data-testid="consent-agree"
              @pointerdown="press"
              @pointerup="release"
              @pointerleave="release"
              @pointercancel="release"
              @contextmenu.prevent
              @click="tapAgree"
            >
              <svg class="ring" viewBox="0 0 120 120" aria-hidden="true">
                <circle class="track" cx="60" cy="60" :r="RING_R" />
                <circle class="fill" cx="60" cy="60" :r="RING_R" :stroke-dasharray="RING_C" :stroke-dashoffset="dash" />
              </svg>
              <span class="agree-txt display">{{ submitting ? '…' : 'Agree' }}</span>
            </button>
            <div class="agree-hint label label-dim">{{ signMode ? (signed ? 'Tap to confirm' : 'Sign above') : 'Press and hold' }}</div>
          </div>

          <button v-if="!signMode" class="btn sign-btn" :disabled="submitting" @click="signMode = true">Sign instead</button>
          <span v-else class="sign-btn"></span>
        </div>
      </div>

      <div v-else class="body capture">
        <div class="title">{{ step === 'saving' ? 'Saving' : 'Please look at the camera' }}</div>
        <p class="text muted">{{ step === 'saving' ? 'Creating your client profile.' : 'Three quick captures, about two seconds. No photograph is stored — only a numeric template.' }}</p>
        <div class="dots" data-testid="capture-progress">
          <span v-for="i in target" :key="i" class="dotp" :class="{ on: i <= captured || step === 'saving' }"></span>
        </div>
        <div class="label label-dim">{{ step === 'saving' ? 'Almost done' : `${captured} of ${target}` }}</div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.consent {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  flex-direction: column;
  background: var(--ground);
  color: var(--text);
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
}
.top {
  display: flex;
  align-items: center;
  gap: 16px;
  height: var(--topbar-h);
  padding: 0 8px 0 24px;
  border-bottom: var(--line-w) solid var(--line);
  flex: 0 0 auto;
}
.top .label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wordmark {
  font-size: 15px;
  letter-spacing: 0.3em;
  color: var(--accent);
}
.close {
  padding: 0 16px;
}
.body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 18px;
  width: min(820px, 100%);
  margin: 0 auto;
  padding: 32px 32px 32px;
  overflow: auto;
}
.greeting {
  font-size: 14px;
  color: var(--accent);
}
.title {
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 30px;
  text-transform: uppercase;
  letter-spacing: -0.02em;
  line-height: 1.05;
}
.text {
  font-size: 20px;
  line-height: 1.5;
  font-weight: 300;
}
.text.small {
  font-size: 14px;
  font-weight: 400;
}
.sign {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.pad {
  width: 100%;
  height: 150px;
  background: var(--surface);
  border: var(--line-w) solid var(--line-strong);
  touch-action: none;
  cursor: crosshair;
}
.link {
  min-width: 0;
  min-height: 36px;
  padding: 0 4px;
  color: var(--accent);
}
.actions {
  margin-top: 24px;
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  align-items: center;
  gap: 16px;
  padding-top: 12px;
}
.decline {
  justify-self: start;
  color: var(--muted);
  border-color: var(--line-strong);
  min-height: 56px;
}
.sign-btn {
  justify-self: end;
  min-height: 56px;
  color: var(--muted);
}
.agree-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}
.agree {
  position: relative;
  width: 132px;
  height: 132px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--accent);
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  transition: background var(--t-fast);
}
.agree:disabled {
  opacity: 0.4;
}
.agree.holding {
  background: var(--accent-soft);
}
.agree.signed {
  background: var(--accent);
  color: var(--ink-on-accent);
}
.ring {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  transform: rotate(-90deg);
}
.ring circle {
  fill: none;
  stroke-width: 3;
}
.ring .track {
  stroke: var(--line-strong);
}
.ring .fill {
  stroke: var(--accent);
  stroke-linecap: butt;
}
.agree.signed .ring .fill,
.agree.signed .ring .track {
  stroke: var(--ink-on-accent);
}
.agree-txt {
  font-size: 15px;
  letter-spacing: 0.08em;
}
.capture {
  align-items: center;
  justify-content: center;
  text-align: center;
}
.dots {
  display: flex;
  gap: 14px;
  margin-top: 8px;
}
.dotp {
  width: 14px;
  height: 14px;
  border: 1px solid var(--accent);
  transition: background var(--t-base);
}
.dotp.on {
  background: var(--accent);
}
@media (max-width: 767px) {
  .body {
    padding: 18px 18px 16px;
    gap: 10px;
    justify-content: flex-start;
  }
  .title {
    font-size: 22px;
  }
  .text {
    font-size: 16px;
    line-height: 1.45;
  }
  .text.small {
    font-size: 12px;
  }
  .signing .text.small,
  .signing .greeting {
    display: none;
  }
  .pad {
    height: 88px;
  }
  .actions {
    margin-top: 12px;
    padding-top: 6px;
    grid-template-columns: 1fr 1fr;
    grid-template-areas:
      'agree agree'
      'decline sign';
    gap: 10px;
  }
  .agree-wrap {
    grid-area: agree;
    gap: 4px;
  }
  .agree {
    width: 108px;
    height: 108px;
  }
  .decline {
    grid-area: decline;
    justify-self: stretch;
    min-height: 52px;
  }
  .sign-btn {
    grid-area: sign;
    justify-self: stretch;
    min-height: 52px;
  }
}
</style>
