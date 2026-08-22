<script setup lang="ts">
/** Manager "Edit tile" sheet: pick/take a photo, resize client-side (≤1200 px JPEG), upload or queue. */
import { computed, onBeforeUnmount, ref } from 'vue'
import type { Item } from '@/api'
import { api } from '@/api'
import { useCatalogStore } from '@/stores/catalog'
import { useSyncStore } from '@/stores/sync'
import { resizeImage } from '@/images/resize'
import { queueUpload } from '@/images/uploads'
import Modal from './Modal.vue'

const props = defineProps<{ item: Item }>()
const emit = defineEmits<{ close: [] }>()

const catalog = useCatalogStore()
const sync = useSyncStore()

const fileInput = ref<HTMLInputElement | null>(null)
const cameraInput = ref<HTMLInputElement | null>(null)
const blob = ref<Blob | null>(null)
const preview = ref<string>('')
const size = ref(0)
const busy = ref(false)
const error = ref('')

const current = computed(() => props.item.image || '')

async function onFile(e: Event) {
  const f = (e.target as HTMLInputElement).files?.[0]
  ;(e.target as HTMLInputElement).value = ''
  if (!f) return
  error.value = ''
  busy.value = true
  try {
    const out = await resizeImage(f)
    blob.value = out
    size.value = out.size
    if (preview.value) URL.revokeObjectURL(preview.value)
    preview.value = URL.createObjectURL(out)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function save() {
  if (!blob.value) return
  busy.value = true
  error.value = ''
  const filename = `${props.item.item_code}.jpg`
  try {
    if (sync.online && !window.__maisonOffline) {
      const { image: url } = await api.catalog.upload_item_image(props.item.item_code, blob.value, filename)
      catalog.setItemImage(props.item.item_code, url)
      sync.notify('good', 'Photo saved', props.item.item_name)
    } else {
      await queueUpload(props.item.item_code, blob.value, filename)
      await sync.countUploads()
      // Show the local image right away; the server URL replaces it after replay.
      catalog.setItemImage(props.item.item_code, await blobToDataUrl(blob.value))
      sync.notify('warn', 'Photo queued — uploads when back online', props.item.item_name)
    }
    emit('close')
  } catch (err) {
    const code = (err as { code?: string }).code
    if (code === 'NETWORK') {
      await queueUpload(props.item.item_code, blob.value, filename)
      await sync.countUploads()
      catalog.setItemImage(props.item.item_code, await blobToDataUrl(blob.value))
      sync.notify('warn', 'Photo queued — uploads when back online', props.item.item_name)
      emit('close')
    } else error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

function blobToDataUrl(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => resolve(String(fr.result))
    fr.onerror = () => reject(new Error('read failed'))
    fr.readAsDataURL(b)
  })
}

onBeforeUnmount(() => {
  if (preview.value) URL.revokeObjectURL(preview.value)
})
</script>

<template>
  <Modal :title="'Tile photo — ' + item.item_name" width="560px" @close="emit('close')">
    <div class="sheet">
      <div class="pics">
        <div class="pic">
          <div class="label">Current</div>
          <div class="frame">
            <img v-if="current" :src="current" alt="" />
            <div v-else class="label label-dim">No photo</div>
          </div>
        </div>
        <div class="pic">
          <div class="label">New</div>
          <div class="frame" :class="{ has: preview }">
            <img v-if="preview" :src="preview" alt="" />
            <div v-else class="label label-dim">{{ busy ? 'Resizing' : 'Pick a photo' }}</div>
          </div>
          <div v-if="blob" class="muted small">JPEG · {{ Math.round(size / 1024) }} KB · ≤ 1200 px</div>
        </div>
      </div>
      <div class="pickers">
        <button class="btn" :disabled="busy" @click="cameraInput?.click()">Take photo</button>
        <button class="btn" :disabled="busy" @click="fileInput?.click()">Choose file</button>
        <input ref="cameraInput" type="file" accept="image/*" capture="environment" hidden @change="onFile" />
        <input ref="fileInput" type="file" accept="image/*" hidden @change="onFile" />
      </div>
      <div v-if="!sync.online" class="warn small">Offline — the photo will be queued and uploaded on reconnect.</div>
      <div v-if="error" class="crit small">{{ error }}</div>
    </div>
    <template #footer>
      <button class="btn" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="!blob || busy" @click="save">{{ busy ? 'Saving' : sync.online ? 'Upload' : 'Queue upload' }}</button>
    </template>
  </Modal>
</template>

<style scoped>
.sheet {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.pics {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.pic {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.frame {
  aspect-ratio: 4 / 3;
  border: var(--line-w) solid var(--line);
  background: var(--ground);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}
.frame.has {
  border-color: var(--accent);
}
.frame img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.pickers {
  display: flex;
  gap: 10px;
}
.small {
  font-size: 13px;
}
@media (max-width: 767px) {
  .pickers .btn {
    flex: 1;
  }
}
</style>
