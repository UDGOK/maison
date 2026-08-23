<script setup lang="ts">
import { useBrand } from '@/stores/brand' // v0.6 N
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { useSyncStore } from '@/stores/sync'
import { IS_MOCK } from '@/api'
import Keypad from '@/components/Keypad.vue'
import { useShiftStore, fmtMinutes, type ClockAction } from '@/stores/shift'
import { fmtDateTime } from '@/utils/device'
import { storeShortName } from '@/utils/text' // v0.6 R

const session = useSessionStore()
const catalog = useCatalogStore()
const sync = useSyncStore()
const shift = useShiftStore()
const router = useRouter()
const route = useRoute()

const selectedBoutique = ref<string>(session.boutique?.name || '')
const selectedAssociate = ref<string>('')
const pin = ref('')
const error = ref('')
const busy = ref(false)
const shake = ref(false)

const needsBootstrap = computed(() => !session.boutique || session.boutique.name !== selectedBoutique.value || !catalog.loaded)

// ---- v0.4 C — clock-in / clock-out (HRMS Employee Checkin) from the Unlock screen
const action = ref<ClockAction>('unlock')
const clockMsg = ref('')
const currentShift = computed(() => shift.shiftFor(selectedAssociate.value))
const onShift = computed(() => shift.onShift(selectedAssociate.value))
watch(selectedAssociate, (a) => {
  clockMsg.value = ''
  shift.error = ''
  if (a) void shift.refresh(a)
  if (action.value === 'out' && !onShift.value) action.value = 'unlock'
})
watch(onShift, (v) => {
  if (!v && action.value === 'out') action.value = 'unlock'
  if (v && action.value === 'in') action.value = 'unlock'
})

onMounted(async () => {
  await shift.restore()
  await session.loadBoutiques()
  if (!selectedBoutique.value && session.boutiqueList.length) selectedBoutique.value = session.boutiqueList[0].name
  // default only when nothing was picked while the awaits above were pending (the cached catalogue
  // shows the keypad immediately; resetting here would undo an associate chosen in the meantime)
  if (!selectedAssociate.value && session.associates.length) selectedAssociate.value = session.associates[0].name
})

const brand = useBrand() // v0.6 N

/**
 * v0.6 D2 — the wordmark must shrink with its glyph count.
 *
 * The unlock screen is `minmax(0, 1fr) 480px`; the left column therefore gets
 * `100vw - 480px - 112px` (padding) of room. A display glyph at `letter-spacing: 0.3em`
 * measures ~1.35x the font size, so a 12-glyph wordmark ("CLOUDCHASERZ") needs ~1033px at the
 * old fixed 64px and pushed the panel 147px off a 1366x1024 till. The length goes to CSS as a
 * custom property so the media queries below still win on a phone.
 */
const wordmarkLen = computed(() => Math.max(1, (brand.wordmark || '').length))

/**
 * v0.6 R — one correct line under the wordmark.
 *
 * `product_name` already contains the sub-mark ("Maison POS" → "Maison POS by CloudChaserz"), so
 * `subMark · productName` printed it twice: "MAISON POS · MAISON POS BY CLOUDCHASERZ". Print the
 * product name alone when it already carries the sub-mark, otherwise join the two.
 */
const subline = computed(() => {
  const sub = (brand.subMark || '').trim()
  const product = (brand.productName || '').trim()
  if (!sub) return product
  if (!product) return sub
  return product.toLowerCase().includes(sub.toLowerCase()) ? product : `${sub} · ${product}`
})
async function chooseBoutique() {
  error.value = ''
  busy.value = true
  const ok = await catalog.bootstrap(selectedBoutique.value)
  busy.value = false
  if (!ok) {
    error.value = catalog.error || `Could not load ${brand.storeNoun.toLowerCase()}`
    return
  }
  // keep an associate picked while the catalogue was still loading; default only when the pick is not
  // part of this boutique's roster
  if (!session.associates.some((a) => a.name === selectedAssociate.value)) selectedAssociate.value = session.associates[0]?.name || ''
}

async function key(k: string) {
  error.value = ''
  if (k === 'clear') pin.value = ''
  else if (k === 'back') pin.value = pin.value.slice(0, -1)
  else if (pin.value.length < 6) pin.value += k
  if (pin.value.length >= 4) await tryUnlock()
}

async function tryUnlock() {
  if (!selectedAssociate.value || pin.value.length < 4) return
  const ok = await session.unlock(selectedAssociate.value, pin.value)
  if (ok) {
    pin.value = ''
    void sync.heartbeat()
    const a = selectedAssociate.value
    if (action.value === 'in') {
      const done = await shift.clockIn(a, session.boutique!.name, session.device_id)
      if (!done) {
        session.lock()
        clockMsg.value = shift.error || 'Could not clock in'
        return
      }
      clockMsg.value = `Clocked in · ${fmtDateTime(shift.shiftFor(a)?.clock_in || new Date().toISOString())}`
      action.value = 'unlock'
    } else if (action.value === 'out') {
      const worked = shift.shiftFor(a)?.worked_minutes || 0
      const done = await shift.clockOut(a, session.device_id)
      session.lock() // clocking out never opens the till
      clockMsg.value = done ? `Clocked out · ${fmtMinutes(worked)} worked` : shift.error || 'Could not clock out'
      action.value = 'unlock'
      return
    }
    router.replace((route.query.next as string) || { name: 'sell' })
  } else if (pin.value.length === 6) {
    fail()
  } else {
    // PINs are 4–6 digits: give the associate a moment to type more before rejecting.
    const snapshot = pin.value
    setTimeout(() => {
      if (pin.value === snapshot) fail()
    }, 700)
  }
}

function fail() {
  error.value = 'Incorrect PIN'
  shake.value = true
  pin.value = ''
  setTimeout(() => (shake.value = false), 400)
}
</script>

<template>
  <div class="unlock">
    <div class="left">
      <div class="brand">
        <!-- v0.6 N: brand tokens -->
        <div class="wordmark display-900" data-testid="unlock-wordmark" :style="{ '--wm-len': wordmarkLen }">{{ brand.wordmark }}</div>
        <!-- v0.6 R: one line — `productName` already carries the sub-mark -->
        <div class="label subline" data-testid="unlock-subline">{{ subline }}</div>
        <div v-if="brand.brand.tagline" class="tagline">{{ brand.brand.tagline }}</div>
        <!-- end v0.6 N -->
        <div class="brand-foot">
          <span class="label label-dim">{{ session.boutique?.boutique_name || 'No ' + brand.storeNoun.toLowerCase() + ' loaded' }}</span>
          <span v-if="session.boutique?.name" class="label label-dim">&middot; {{ session.boutique.name }}</span>
        </div>
      </div>
      <div class="left-foot">
        <div class="label label-dim">{{ sync.browserOnline ? 'Network available' : 'No network' }}</div>
        <div v-if="IS_MOCK" class="label label-dim">Mock data &middot; PIN 1234 (manager) / 1111 (associate)</div>
      </div>
    </div>

    <div class="right">
      <div class="panel">
        <div class="field">
          <label class="label">{{ brand.storeNoun }}</label>
          <!-- v0.6 R: the picker owns the full panel width — beside a "Load" button the option text
               ("CloudChaserz Montrose — Houston, TX 77098") was cut off in the closed state -->
          <select v-model="selectedBoutique" class="input store-select" :disabled="busy">
            <option v-for="b in session.boutiqueList" :key="b.name" :value="b.name">{{ storeShortName(b.boutique_name, brand.name) }} &mdash; {{ b.city }}</option>
            <option v-if="!session.boutiqueList.length && session.boutique" :value="session.boutique.name">{{ storeShortName(session.boutique.boutique_name, brand.name) }}</option>
          </select>
          <button v-if="needsBootstrap" class="btn btn-primary load-btn" :disabled="busy || !selectedBoutique" @click="chooseBoutique">
            {{ busy ? 'Loading' : 'Load' }}
          </button>
        </div>

        <template v-if="!needsBootstrap">
          <div class="field">
            <label class="label">Associate</label>
            <select v-model="selectedAssociate" class="input">
              <option v-for="a in session.associates" :key="a.name" :value="a.name">{{ a.full_name }} &middot; {{ a.role }}</option>
            </select>
          </div>

          <div class="shift" data-testid="shift-status">
            <!-- v0.6 R: a real box, not a hairline glyph — the shift state has to be readable across a counter -->
            <span v-if="onShift && currentShift" class="shift-line">
              <span class="box on" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 8.5l3 3 6-7" /></svg></span>
              <span class="good">{{ currentShift.status === 'On break' ? 'On break' : 'On shift' }}</span>
              <span class="dim"> since {{ fmtDateTime(currentShift.clock_in) }}<span v-if="currentShift.worked_minutes"> · {{ fmtMinutes(currentShift.worked_minutes) }}</span></span>
            </span>
            <span v-else class="shift-line"><span class="box" aria-hidden="true"></span><span class="dim">Not clocked in</span></span>
            <span v-if="shift.hrms" class="label label-dim">HR</span>
          </div>
          <div class="seg" role="radiogroup" aria-label="Action">
            <button class="seg-btn label" :class="{ on: action === 'unlock' }" data-testid="action-unlock" @click="action = 'unlock'">Unlock</button>
            <button class="seg-btn label" :class="{ on: action === 'in' }" :disabled="onShift" data-testid="action-clock-in" @click="action = 'in'">Clock in</button>
            <button class="seg-btn label" :class="{ on: action === 'out' }" :disabled="!onShift" data-testid="action-clock-out" @click="action = 'out'">Clock out</button>
          </div>
          <div class="field">
            <label class="label">{{ action === 'in' ? 'PIN to clock in' : action === 'out' ? 'PIN to clock out' : 'PIN' }}</label>
            <div class="pin" :class="{ shake }">
              <span v-for="i in 6" :key="i" class="pin-dot" :class="{ on: i <= pin.length, idle: i > 4 && pin.length < 4 }"></span>
            </div>
          </div>
          <Keypad @key="key" />
          <div class="msg" :class="{ crit: !!error || (!!clockMsg && !!shift.error), good: !!clockMsg && !shift.error, hidden: !error && !clockMsg }" data-testid="clock-msg">{{ error || clockMsg || 'placeholder' }}</div>
        </template>
        <div v-else class="hint muted">Load the {{ brand.storeNoun.toLowerCase() }} catalog to unlock. Once loaded, unlock works offline.</div>
        <div v-if="error && needsBootstrap" class="msg crit">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unlock {
  height: 100%;
  display: grid;
  /* v0.6 D2: a bare `1fr` track has `min-width: auto`, so the left column could not shrink below
     the min-content width of the wordmark and pushed the PIN panel off a 1366px till. */
  grid-template-columns: minmax(0, 1fr) 480px;
  overflow-x: hidden;
}
.left {
  /* v0.6 R: the wordmark used to sit in the top-left corner of an otherwise empty half-screen
     (~65% of a 1366×1024 till was blank). The lockup is centred on the column's optical middle and
     carries the store it will unlock, so the two halves read as one composed screen. */
  min-width: 0;
  display: grid;
  grid-template-rows: 1fr auto;
  align-content: stretch;
  padding: 48px 56px;
  border-right: var(--line-w) solid var(--line);
  background: var(--ground);
}
.brand {
  align-self: center;
  min-width: 0;
}
.brand .subline {
  margin-top: 18px;
}
.brand .tagline {
  margin-top: 10px;
  font-size: 15px;
  font-weight: 300;
  color: var(--muted);
}
.brand-foot {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 28px;
  padding-top: 18px;
  border-top: var(--line-w) solid var(--line);
}
.brand .wordmark {
  /* clamped by wordmark length: 64px for MAISON (6), ~46px for CLOUDCHASERZ (12) at 1366px */
  font-size: clamp(20px, calc((100vw - 620px) / (var(--wm-len, 6) * 1.35)), 64px);
  letter-spacing: clamp(0.1em, calc(0.3em - (var(--wm-len, 6) - 8) * 0.02em), 0.3em);
  line-height: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}
.left-foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-self: end;
}
.right {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  overflow: auto;
}
.panel {
  /* v0.6 R: a bordered console rather than controls floating in the dark */
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 20px;
  padding: 28px 26px;
  border: var(--line-w) solid var(--line);
  background: var(--surface);
}
.store-select {
  width: 100%;
}
.load-btn {
  width: 100%;
  margin-top: 10px;
}
.pin {
  display: flex;
  gap: 14px;
  justify-content: center;
  height: 48px;
  align-items: center;
}
.pin-dot {
  width: 14px;
  height: 14px;
  border: var(--line-w) solid var(--muted);
  transition: background var(--t-fast);
}
.pin-dot.on {
  background: var(--platinum);
  border-color: var(--platinum);
}
.pin-dot.idle {
  border-color: var(--line-strong);
}
.shake {
  animation: shake 0.35s;
}
@keyframes shake {
  20% {
    transform: translateX(-8px);
  }
  40% {
    transform: translateX(8px);
  }
  60% {
    transform: translateX(-5px);
  }
  80% {
    transform: translateX(5px);
  }
}
.shift {
  display: flex;
  justify-content: space-between;
  align-items: center;
  font-size: 13px;
  min-height: 24px;
}
.shift-line {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
/* v0.6 R — the shift marker is a real 18px box in the gold system (it was an 8px hairline square
   that read as a rendering artefact on the till). */
.box {
  width: 18px;
  height: 18px;
  flex: 0 0 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1.5px solid var(--line-strong);
  background: var(--ground);
}
.box.on {
  border-color: var(--accent);
  background: var(--accent);
}
.box svg {
  width: 14px;
  height: 14px;
  fill: none;
  stroke: var(--ground);
  stroke-width: 2.2;
  stroke-linecap: square;
}
.seg {
  display: flex;
  border: var(--line-w) solid var(--line);
}
.seg-btn {
  flex: 1;
  min-height: 44px;
  color: var(--dim);
}
.seg-btn + .seg-btn {
  border-left: var(--line-w) solid var(--line);
}
.seg-btn.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.seg-btn:disabled {
  opacity: 0.35;
}
.msg {
  text-align: center;
  font-size: 13px;
  min-height: 18px;
}
.msg.hidden {
  visibility: hidden;
}
.hint {
  font-size: 14px;
}
.brand .wordmark {
  color: var(--accent);
}
@media (max-width: 767px) {
  .unlock {
    grid-template-columns: 1fr;
    grid-template-rows: auto 1fr;
    overflow: auto;
  }
  .left {
    /* phone: one band across the top — the lockup shrinks, the status stays on the right */
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: calc(16px + var(--safe-top)) 20px 16px;
    border-right: 0;
    border-bottom: var(--line-w) solid var(--line);
  }
  .brand {
    align-self: auto;
    flex: 1 1 auto;
  }
  .brand .wordmark {
    /* tracking is 0.12em here, so a glyph measures ~0.78x the font size; the status block on the
       right keeps ~190px, and the mark shrinks rather than breaking "CLOUDCHASERZ" across lines */
    font-size: min(24px, calc((100vw - 200px) / (var(--wm-len, 6) * 0.78)));
    letter-spacing: 0.12em;
    white-space: nowrap;
    overflow-wrap: normal;
  }
  .brand .subline {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .brand .subline {
    margin-top: 6px;
  }
  .brand .tagline,
  .brand-foot {
    display: none;
  }
  .left-foot {
    text-align: right;
    gap: 4px;
  }
  .left-foot .label {
    font-size: 9px;
  }
  .right {
    align-items: flex-start;
    padding: 20px 16px calc(20px + var(--safe-bottom));
  }
  .panel {
    max-width: none;
    gap: 16px;
    padding: 0;
    border: 0;
    background: transparent;
  }
}
</style>
