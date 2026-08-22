<script setup lang="ts">
/** v0.5 K — pairing: the 6-digit code shown in the POS Settings "Client display" card, or its QR. */
import { computed, ref } from 'vue'
import { useSalonStore } from '../store'
import { codeFromScan, formatCode, isCompleteCode, normalizeCode } from '../pairing'
import SalonKeypad from '../components/SalonKeypad.vue'
import ScanSheet from '../components/ScanSheet.vue'

const salon = useSalonStore()
const code = ref('')
const scanning = ref(false)
const display = computed(() => formatCode(code.value))
const ended = computed(() => salon.model.dismissedSeq === -1 && !salon.token && salon.session?.status && salon.session.status !== 'Paired')

async function key(k: string) {
  if (k === 'clear') code.value = ''
  else if (k === 'back') code.value = code.value.slice(0, -1)
  else code.value = normalizeCode(code.value + k)
  if (isCompleteCode(code.value)) {
    const ok = await salon.pair(code.value)
    if (!ok) code.value = ''
  }
}
async function scanned(v: string) {
  const c = codeFromScan(v)
  if (!c) return
  scanning.value = false
  code.value = c
  if (!(await salon.pair(c))) code.value = ''
}
</script>

<template>
  <div class="salon-screen" data-testid="salon-pair">
    <template v-if="scanning">
      <div class="s-eyebrow">Pair this display</div>
      <ScanSheet @result="scanned" @close="scanning = false" />
    </template>
    <template v-else>
      <div class="s-eyebrow">Client display</div>
      <div class="s-title">Pair with the point of sale</div>
      <p class="s-lead">Enter the six-digit code shown under <em>Settings · Client display</em> on the associate's iPad.</p>
      <div class="s-keypad-display" data-testid="pair-code">{{ display }}<span v-if="code.length < 6" class="caret"></span></div>
      <SalonKeypad @key="key" />
      <div class="s-error" data-testid="pair-error">{{ salon.error || (ended ? 'This display was unpaired.' : '') }}</div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="scanning = true">Scan the QR instead</button>
      </div>
    </template>
  </div>
</template>
