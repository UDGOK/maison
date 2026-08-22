<script setup lang="ts">
/** v0.5 K — camera QR reader (client QR `MC:…` or the POS pairing QR `MS:…`). */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { cameraAvailable, createCameraScanner, type CameraScanner } from '@/scan/camera'

const emit = defineEmits<{ result: [value: string]; close: [] }>()
const video = ref<HTMLVideoElement | null>(null)
const error = ref('')
let scanner: CameraScanner | null = null

onMounted(async () => {
  if (!cameraAvailable()) {
    error.value = 'No camera on this device'
    return
  }
  try {
    scanner = await createCameraScanner()
    await scanner.start(video.value!, (v) => emit('result', v), (e) => (error.value = e.message))
  } catch (e) {
    error.value = (e as Error).message
  }
})
onBeforeUnmount(() => scanner?.stop())
</script>

<template>
  <div class="scan">
    <div class="frame">
      <video ref="video" playsinline muted autoplay></video>
      <div class="corner tl"></div>
      <div class="corner tr"></div>
      <div class="corner bl"></div>
      <div class="corner br"></div>
    </div>
    <div class="s-error">{{ error }}</div>
    <button class="s-btn ghost" type="button" @click="emit('close')">Back</button>
  </div>
</template>

<style scoped>
.scan {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}
.frame {
  position: relative;
  width: min(70vw, 420px);
  aspect-ratio: 1;
  overflow: hidden;
  background: #000;
  border: 1px solid var(--s-line-soft);
}
video {
  width: 100%;
  height: 100%;
  object-fit: cover;
  opacity: 0.9;
}
.corner {
  position: absolute;
  width: 48px;
  height: 48px;
  border: 2px solid var(--s-gold);
}
.tl {
  top: 14px;
  left: 14px;
  border-right: 0;
  border-bottom: 0;
}
.tr {
  top: 14px;
  right: 14px;
  border-left: 0;
  border-bottom: 0;
}
.bl {
  bottom: 14px;
  left: 14px;
  border-right: 0;
  border-top: 0;
}
.br {
  bottom: 14px;
  right: 14px;
  border-left: 0;
  border-top: 0;
}
</style>
