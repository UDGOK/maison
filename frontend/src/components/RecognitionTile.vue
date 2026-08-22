<script setup lang="ts">
/**
 * Recognition tile (Sell client panel): camera preview with a gold viewfinder, a state chip
 * (Looking / Recognised / New client / Off) and the "New client? Enrol" prompt. Owns the
 * getUserMedia stream; detection runs in the provider (see src/recognition/provider.ts).
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRecognitionStore } from '@/stores/recognition'
import { useSyncStore } from '@/stores/sync'

const props = defineProps<{ compact?: boolean }>()
const recognition = useRecognitionStore()
const sync = useSyncStore()
const video = ref<HTMLVideoElement | null>(null)
const stage = ref<HTMLDivElement | null>(null)
let stream: MediaStream | null = null
let starting = false

const chipClass = computed(() => {
  switch (recognition.tile) {
    case 'recognised':
      return 'pill-accent-fill'
    case 'new':
      return 'pill-accent'
    case 'looking':
    case 'starting':
      return 'pill-live'
    case 'error':
    case 'nocamera':
      return 'pill-crit'
    default:
      return ''
  }
})

const hint = computed(() => {
  const s = recognition.providerStatus
  if (recognition.tile === 'recognised') return recognition.recognised?.customer_name || ''
  if (recognition.tile === 'new') return 'Not recognised'
  if (recognition.tile === 'starting') return s.phase === 'loading' ? 'Loading model' : 'Starting camera'
  if (recognition.tile === 'error' || recognition.tile === 'nocamera') return recognition.cameraError || 'Camera unavailable'
  if (recognition.tile === 'off') return recognition.deviceEnabled === false ? 'Off on this device' : 'Off'
  if (recognition.matching) return 'Matching'
  if (!s.face) return 'Looking for a face'
  return s.hint || 'Hold still'
})

/** Detection box → preview coordinates (object-fit: cover, mirrored). */
const boxStyle = computed(() => {
  const s = recognition.providerStatus
  const v = video.value
  const el = stage.value
  if (!s.bbox || !v || !el || !v.videoWidth) return null
  const sw = el.clientWidth
  const sh = el.clientHeight
  const scale = Math.max(sw / v.videoWidth, sh / v.videoHeight)
  const ox = (sw - v.videoWidth * scale) / 2
  const oy = (sh - v.videoHeight * scale) / 2
  const left = ox + s.bbox.x * scale
  const top = oy + s.bbox.y * scale
  const w = s.bbox.width * scale
  const h = s.bbox.height * scale
  // the preview is mirrored, so flip x
  return { left: `${sw - left - w}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` }
})

function cameraSupported() {
  return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia
}

async function start() {
  if (starting || stream) return
  if (!cameraSupported()) {
    recognition.setCameraState('nocamera', 'No camera on this device')
    return
  }
  starting = true
  recognition.tile = 'starting'
  try {
    const constraints: MediaStreamConstraints = {
      audio: false,
      video: recognition.cameraId ? { deviceId: { exact: recognition.cameraId }, width: { ideal: 640 }, height: { ideal: 480 } } : { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } }
    }
    stream = await navigator.mediaDevices.getUserMedia(constraints)
    const v = video.value
    if (!v) throw new Error('No preview element')
    v.srcObject = stream
    await v.play().catch(() => undefined)
    if (!v.videoWidth) await new Promise<void>((r) => v.addEventListener('loadeddata', () => r(), { once: true }))
    await recognition.attach(v)
  } catch (e) {
    const err = e as DOMException
    const msg = err.name === 'NotAllowedError' ? 'Camera permission denied' : err.name === 'NotFoundError' ? 'No camera found' : err.message || 'Camera unavailable'
    stop()
    recognition.setCameraState(err.name === 'NotFoundError' ? 'nocamera' : 'error', msg)
  } finally {
    starting = false
  }
}

function stop() {
  recognition.stop()
  if (stream) {
    for (const t of stream.getTracks()) t.stop()
    stream = null
  }
  if (video.value) video.value.srcObject = null
}

function onVisibility() {
  recognition.pause(document.visibilityState !== 'visible')
}

const shouldRun = computed(() => recognition.active || recognition.testMode)

onMounted(() => {
  document.addEventListener('visibilitychange', onVisibility)
  if (shouldRun.value) void start()
})
onBeforeUnmount(() => {
  document.removeEventListener('visibilitychange', onVisibility)
  stop()
})
watch(
  () => [shouldRun.value, recognition.cameraId] as const,
  ([run]) => {
    stop()
    if (run) void start()
  }
)

function retry() {
  stop()
  void start()
}
</script>

<template>
  <div class="rec" :class="[recognition.tile, { compact: props.compact, nopreview: !recognition.showPreview }]" data-testid="recognition-tile">
    <div ref="stage" class="stage">
      <video ref="video" class="video" muted playsinline autoplay></video>
      <div class="finder" :class="{ live: recognition.tile === 'looking' || recognition.tile === 'starting', hit: recognition.tile === 'recognised' }">
        <span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span>
      </div>
      <div v-if="boxStyle && recognition.tile !== 'off'" class="box" :style="boxStyle"></div>
      <div v-if="recognition.tile === 'off'" class="veil">
        <div class="label label-dim">Camera off</div>
        <button v-if="recognition.boutiqueEnabled && recognition.deviceEnabled === false" class="label link" @click="recognition.setDeviceEnabled(null)">Turn on</button>
      </div>
      <div v-else-if="recognition.tile === 'error' || recognition.tile === 'nocamera'" class="veil">
        <div class="crit small">{{ recognition.cameraError || 'Camera unavailable' }}</div>
        <button class="label link" @click="retry">Retry</button>
      </div>
      <div class="chip-row">
        <span class="pill state-chip" :class="chipClass" data-testid="recognition-state">
          <span v-if="recognition.tile === 'looking'" class="dot pulse"></span>
          {{ recognition.stateLabel }}
        </span>
        <span v-if="recognition.providerStatus.backend && recognition.testMode" class="pill dbg">{{ recognition.providerStatus.backend }} · {{ recognition.providerStatus.fps }} fps</span>
      </div>
    </div>
    <div class="foot">
      <div class="hint ellipsis" :class="{ accent: recognition.tile === 'recognised' }">{{ hint }}</div>
      <button v-if="recognition.tile === 'recognised' && recognition.canUndo && !recognition.testMode" class="act label" data-testid="recognition-undo" @click="recognition.undo()">Undo</button>
      <span v-else-if="recognition.testMode" class="act label label-dim">Test mode</span>
      <button v-else-if="recognition.tile === 'new'" class="act label accent" data-testid="recognition-enrol" @click="recognition.openEnrol()">New client? Enrol</button>
      <button v-else-if="recognition.tile === 'looking' && !sync.online && !recognition.cachedTemplates" class="act label label-dim" disabled>Offline · no cache</button>
      <button v-else-if="recognition.tile === 'looking'" class="act label" data-testid="recognition-enrol-manual" @click="recognition.openEnrol()">Enrol</button>
    </div>
  </div>
</template>

<style scoped>
.rec {
  display: flex;
  flex-direction: column;
  border: var(--line-w) solid var(--line-strong);
  background: var(--ground);
}
.stage {
  position: relative;
  height: 160px;
  overflow: hidden;
  background: #000;
}
.compact .stage {
  height: 132px;
}
.video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transform: scaleX(-1);
  display: block;
  filter: saturate(0.85) contrast(1.05);
}
.nopreview .video {
  filter: blur(18px) brightness(0.35) saturate(0.4);
}
.finder {
  position: absolute;
  inset: 14px 22% 14px 22%;
  pointer-events: none;
  opacity: 0.55;
  transition: opacity var(--t-base), inset var(--t-base);
}
.finder.live {
  opacity: 0.9;
}
.finder.hit {
  opacity: 1;
  inset: 10px 18% 10px 18%;
}
.c {
  position: absolute;
  width: 16px;
  height: 16px;
  border: 2px solid var(--accent);
}
.c.tl {
  top: 0;
  left: 0;
  border-right: 0;
  border-bottom: 0;
}
.c.tr {
  top: 0;
  right: 0;
  border-left: 0;
  border-bottom: 0;
}
.c.bl {
  bottom: 0;
  left: 0;
  border-right: 0;
  border-top: 0;
}
.c.br {
  bottom: 0;
  right: 0;
  border-left: 0;
  border-top: 0;
}
.box {
  position: absolute;
  border: 1px solid rgba(201, 169, 110, 0.7);
  pointer-events: none;
  transition: all 120ms linear;
}
.recognised .box {
  border-color: var(--accent);
  box-shadow: 0 0 0 1px rgba(201, 169, 110, 0.35);
}
.veil {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  background: rgba(11, 11, 10, 0.72);
  text-align: center;
  padding: 0 16px;
}
.veil .link {
  color: var(--accent);
  min-height: 36px;
}
.chip-row {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: flex;
  gap: 6px;
}
.state-chip {
  height: 22px;
  background: rgba(11, 11, 10, 0.78);
  backdrop-filter: blur(4px);
}
.state-chip.pill-accent-fill {
  background: var(--accent);
  color: var(--ink-on-accent);
}
.state-chip.pill-accent {
  color: var(--accent);
  border-color: var(--accent);
}
.pill-live {
  color: var(--text);
  border-color: rgba(239, 232, 218, 0.35);
}
.dbg {
  height: 22px;
  background: rgba(11, 11, 10, 0.78);
  letter-spacing: 0.08em;
  text-transform: none;
}
.dot.pulse {
  background: var(--accent);
  animation: pulse 1.4s ease-in-out infinite;
}
@keyframes pulse {
  0%,
  100% {
    opacity: 0.25;
  }
  50% {
    opacity: 1;
  }
}
.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-height: 36px;
  padding: 0 4px 0 10px;
  border-top: var(--line-w) solid var(--line);
}
.hint {
  font-size: 12px;
  color: var(--muted);
  min-width: 0;
}
span.act {
  display: inline-flex;
  align-items: center;
}
.act {
  min-height: 34px;
  min-width: 0;
  padding: 0 8px;
  color: var(--muted);
  white-space: nowrap;
}
.act:hover {
  color: var(--text);
}
.act.accent {
  color: var(--accent);
}
.small {
  font-size: 12px;
}
@media (max-width: 767px) {
  .foot {
    min-height: 48px;
  }
  .act {
    min-height: 48px;
  }
}
</style>
