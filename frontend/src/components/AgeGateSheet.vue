<script setup lang="ts">
/**
 * v0.6 N — "Check ID" sheet. Opens when an age-restricted item is added and no check has passed
 * this transaction. Scan: the wedge scanner types the PDF417 payload into the capture field
 * (multi-line, ends on a quiet gap); the camera sheet can be opened as well. Manual: DOB (+ expiry).
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAgeStore } from '@/stores/age'
import { useScanStore } from '@/stores/scan'
import { useCatalogStore } from '@/stores/catalog'
import { useBrand } from '@/stores/brand'
import { useLayoutStore } from '@/stores/layout'
import { looksLikeAamva } from '@/scan/aamva'

const age = useAgeStore()
const scan = useScanStore()
const catalog = useCatalogStore()
const layout = useLayoutStore()
const { wordmark } = useBrand()

const capture = ref('')
const captureEl = ref<HTMLTextAreaElement | null>(null)
const dob = ref('')
const expiry = ref('')
const initials = ref('')
let timer = 0
let uncapture: (() => void) | null = null

const blocked = computed(() => !!age.last && !age.last.ok && (age.last.outcome === 'Underage' || age.last.outcome === 'Expired'))
const title = computed(() => (blocked.value ? 'Sale refused' : `Check ID · ${age.minimumAge}+`))

function focusCapture() {
  void nextTick(() => captureEl.value?.focus())
}

function flush() {
  const raw = capture.value
  if (!raw.trim()) return
  if (!looksLikeAamva(raw)) return // still arriving (or a product barcode)
  capture.value = ''
  void age.scan(raw)
}

watch(capture, () => {
  window.clearTimeout(timer)
  timer = window.setTimeout(flush, 250)
})

function submitCapture() {
  window.clearTimeout(timer)
  const raw = capture.value
  capture.value = ''
  if (raw.trim()) void age.scan(raw)
}

function submitManual() {
  void age.manual(dob.value, expiry.value || undefined, initials.value || undefined)
}

function openCamera() {
  scan.openSheet('raw')
}

onMounted(() => {
  // the camera sheet (raw mode) and a wedge burst outside the field both land here
  uncapture = scan.captureRaw((code) => {
    capture.value = capture.value ? `${capture.value}\n${code}` : code
  })
  if (age.mode === 'scan') focusCapture()
})
onBeforeUnmount(() => {
  window.clearTimeout(timer)
  uncapture?.()
})
watch(
  () => age.mode,
  (m) => {
    if (m === 'scan') focusCapture()
  }
)
</script>

<template>
  <Teleport to="body">
    <div class="age-backdrop" data-testid="age-gate" :class="{ phone: layout.phone }">
      <div class="age" role="dialog" :aria-label="title">
        <div class="head">
          <div class="wordmark display-900">{{ wordmark }}</div>
          <div class="section-title" data-testid="age-title">{{ title }}</div>
          <button class="close label" data-testid="age-close" @click="age.decline()">{{ blocked ? 'Close' : 'No ID' }}</button>
        </div>

        <div class="body">
          <p class="lead">
            <template v-if="blocked"><span class="crit">{{ age.error }}</span></template>
            <template v-else><b>{{ age.trigger || 'This item' }}</b> is age-restricted. Ask for a government ID and verify the client is <b>{{ age.minimumAge }} or older</b>.</template>
          </p>

          <template v-if="!blocked">
            <div class="tabs">
              <button class="tab display" :class="{ active: age.mode === 'scan' }" :disabled="!catalog.age.id_scan_enabled" data-testid="age-tab-scan" @click="age.mode = 'scan'">Scan ID</button>
              <button class="tab display" :class="{ active: age.mode === 'manual' }" data-testid="age-tab-manual" @click="age.mode = 'manual'">Enter DOB</button>
            </div>

            <div v-if="age.mode === 'scan'" class="pane">
              <!-- v0.6 R: the pair never breaks — "ID" alone on a second line read as a stray word -->
              <div class="label label-dim">Scan the PDF417 barcode on the back of the driver’s licence / state&nbsp;ID</div>
              <form class="capture-form" @submit.prevent="submitCapture">
                <textarea ref="captureEl" v-model="capture" class="input capture" rows="3" data-testid="age-capture" placeholder="Point the scanner at the ID — the code lands here" autocomplete="off" spellcheck="false"></textarea>
                <div class="row">
                  <button class="btn btn-ghost" type="button" :disabled="!catalog.settings.scan_enabled" @click="openCamera">Use camera</button>
                  <span class="spacer"></span>
                  <button class="btn btn-primary" type="submit" :disabled="age.busy || !capture.trim()" data-testid="age-scan-submit">{{ age.busy ? 'Checking…' : 'Verify' }}</button>
                </div>
              </form>
              <div class="muted small">Only the outcome is kept (21+ yes / no, ID expired yes / no, initials, issuing state). The barcode, name, licence number and address are never stored.</div>
            </div>

            <form v-else class="pane" @submit.prevent="submitManual">
              <div class="grid">
                <label class="field">
                  <span class="label">Date of birth</span>
                  <input v-model="dob" class="input" type="date" required data-testid="age-dob" />
                </label>
                <label class="field">
                  <span class="label">ID expiry <span class="label-dim">(optional)</span></span>
                  <input v-model="expiry" class="input" type="date" data-testid="age-expiry" />
                </label>
                <label class="field">
                  <span class="label">Initials <span class="label-dim">(optional)</span></span>
                  <input v-model="initials" class="input" maxlength="2" style="text-transform: uppercase" data-testid="age-initials" />
                </label>
              </div>
              <div class="row">
                <span class="muted small">You looked at the ID and read the date of birth.</span>
                <span class="spacer"></span>
                <button class="btn btn-primary" type="submit" :disabled="age.busy || !dob" data-testid="age-manual-submit">{{ age.busy ? 'Checking…' : 'ID checked' }}</button>
              </div>
            </form>

            <div v-if="age.error" class="err crit" data-testid="age-error">{{ age.error }}</div>
          </template>
          <template v-else>
            <div class="muted">Age-restricted items were not added to the basket. Non-restricted items can still be sold.</div>
            <div class="row" style="margin-top: 16px">
              <button class="btn btn-ghost" data-testid="age-retry" @click="age.last = null; age.error = ''">Try another ID</button>
              <span class="spacer"></span>
              <button class="btn btn-primary" data-testid="age-blocked-close" @click="age.close()">Continue without</button>
            </div>
          </template>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.age-backdrop {
  position: fixed;
  inset: 0;
  z-index: 55;
  background: rgba(11, 11, 10, 0.86);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.age {
  width: 640px;
  max-width: 100%;
  max-height: calc(100dvh - 48px);
  overflow: auto;
  background: var(--ground);
  border: var(--line-w) solid var(--line);
  display: flex;
  flex-direction: column;
}
.head {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 16px 14px 20px;
  border-bottom: var(--line-w) solid var(--line);
}
.head .section-title {
  flex: 1;
}
.wordmark {
  font-size: 13px;
  letter-spacing: 0.3em;
  color: var(--accent);
}
.close {
  color: var(--accent);
}
.body {
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.lead {
  margin: 0;
  font-size: 16px;
  line-height: 1.45;
}
.tabs {
  display: flex;
  border: var(--line-w) solid var(--line);
}
.tab {
  flex: 1;
  height: 44px;
  background: transparent;
  color: var(--text-dim);
  border: 0;
  font-size: 13px;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  cursor: pointer;
}
.tab.active {
  background: var(--accent);
  color: var(--ground);
}
.pane {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.capture-form {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.capture {
  width: 100%;
  resize: none;
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  min-height: 84px;
}
.row {
  display: flex;
  align-items: center;
  gap: 12px;
}
.spacer {
  flex: 1;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr 100px;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.small {
  font-size: 12px;
  line-height: 1.4;
}
.err {
  font-size: 14px;
}
.phone .age {
  width: 100%;
}
.phone .grid {
  grid-template-columns: 1fr;
}
</style>
