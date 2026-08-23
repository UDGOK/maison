<script setup lang="ts">
import { useBrand } from '@/stores/brand' // v0.6 N
const brand = useBrand() // v0.6 N
/** Full-screen camera scanner. BarcodeDetector when available, @zxing/browser otherwise. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useScanStore } from '@/stores/scan'
import { cameraAvailable, createCameraScanner, type CameraScanner } from '@/scan/camera'

const scan = useScanStore()
const video = ref<HTMLVideoElement | null>(null)
const engine = ref<string>('')
const status = ref<'starting' | 'live' | 'error' | 'nocamera'>('starting')
const error = ref('')
const manual = ref('')
const lastHit = ref('')
let scanner: CameraScanner | null = null

onMounted(async () => {
  if (!cameraAvailable()) {
    status.value = 'nocamera'
    return
  }
  try {
    scanner = await createCameraScanner()
    engine.value = scanner.kind === 'native' ? 'BarcodeDetector' : 'ZXing'
    await scanner.start(
      video.value!,
      (value) => {
        lastHit.value = value
        void scan.handle(value)
      },
      (e) => (error.value = e.message)
    )
    status.value = 'live'
  } catch (e) {
    status.value = 'error'
    error.value = (e as Error).message || 'Camera unavailable'
  }
})
onBeforeUnmount(() => scanner?.stop())

function submitManual() {
  const v = manual.value.trim()
  if (!v) return
  manual.value = ''
  void scan.handle(v)
}
</script>

<template>
  <Teleport to="body">
    <div class="scanner" role="dialog" aria-label="Scanner">
      <div class="top">
        <div class="wordmark display-900">{{ brand.wordmark }}</div>
        <div class="label">{{ scan.mode === 'client' ? 'Scan client card' : 'Scan product · client · invoice' }}</div>
        <button class="close label" @click="scan.closeSheet()">Close</button>
      </div>

      <div class="stage">
        <video ref="video" class="video" muted playsinline autoplay></video>
        <div class="finder" :class="{ hit: lastHit }">
          <span class="c tl"></span><span class="c tr"></span><span class="c bl"></span><span class="c br"></span>
          <div class="beam"></div>
        </div>
        <div v-if="status !== 'live'" class="overlay">
          <div v-if="status === 'starting'" class="label">Starting camera</div>
          <template v-else-if="status === 'nocamera'">
            <div class="section-title">No camera on this device</div>
            <div class="muted small">Use a USB / Bluetooth scanner, or type the code below.</div>
          </template>
          <template v-else>
            <div class="section-title crit">Camera blocked</div>
            <div class="muted small">{{ error }}</div>
          </template>
        </div>
      </div>

      <div class="bottom">
        <div class="hint">
          <span v-if="lastHit" class="accent ellipsis">{{ lastHit }}</span>
          <span v-else class="label label-dim">Hold the code inside the frame</span>
          <span v-if="engine" class="label label-dim eng">{{ engine }}</span>
        </div>
        <form class="manual" @submit.prevent="submitManual">
          <input v-model="manual" class="input" :placeholder="scan.mode === 'client' ? 'Client № or phone' : 'Type a barcode, serial or client №'" autocomplete="off" :inputmode="scan.mode === 'client' ? 'numeric' : 'text'" />
          <button class="btn btn-primary" type="submit" :disabled="!manual.trim()">Go</button>
        </form>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scanner {
  position: fixed;
  inset: 0;
  z-index: 60;
  display: flex;
  flex-direction: column;
  background: var(--ground);
  padding-top: var(--safe-top);
  padding-bottom: var(--safe-bottom);
}
.top {
  display: flex;
  align-items: center;
  gap: 16px;
  height: var(--topbar-h);
  padding: 0 8px 0 20px;
  border-bottom: var(--line-w) solid var(--line);
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
  padding: 0 14px;
}
.stage {
  position: relative;
  flex: 1;
  min-height: 0;
  background: #000;
  overflow: hidden;
}
.video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.finder {
  position: absolute;
  left: 50%;
  top: 50%;
  width: min(72vw, 360px);
  aspect-ratio: 1;
  transform: translate(-50%, -50%);
  box-shadow: 0 0 0 100vmax rgba(11, 11, 10, 0.55);
  transition: box-shadow var(--t-base);
}
.finder .c {
  position: absolute;
  width: 28px;
  height: 28px;
  border: 3px solid var(--accent);
}
.c.tl {
  left: 0;
  top: 0;
  border-right: 0;
  border-bottom: 0;
}
.c.tr {
  right: 0;
  top: 0;
  border-left: 0;
  border-bottom: 0;
}
.c.bl {
  left: 0;
  bottom: 0;
  border-right: 0;
  border-top: 0;
}
.c.br {
  right: 0;
  bottom: 0;
  border-left: 0;
  border-top: 0;
}
.beam {
  position: absolute;
  left: 10%;
  right: 10%;
  height: 1px;
  background: var(--accent);
  opacity: 0.8;
  animation: beam 2.2s ease-in-out infinite alternate;
}
.finder.hit .c {
  border-color: var(--good);
}
@keyframes beam {
  from {
    top: 12%;
  }
  to {
    top: 88%;
  }
}
.overlay {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  text-align: center;
  padding: 24px;
  background: rgba(11, 11, 10, 0.75);
}
.small {
  font-size: 13px;
  max-width: 360px;
}
.bottom {
  padding: 12px 16px 16px;
  border-top: var(--line-w) solid var(--line);
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.hint {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  min-height: 20px;
  font-size: 14px;
}
.hint .eng {
  flex: 0 0 auto;
}
.manual {
  display: flex;
  gap: 10px;
}
.manual .input {
  flex: 1;
}
</style>
