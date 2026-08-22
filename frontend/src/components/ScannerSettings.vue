<script setup lang="ts">
/**
 * v0.4 J — Settings → Scanner: prefix / suffix / terminator for Bluetooth HID scanners
 * (Socket Mobile S740, Zebra CS6080, Inateck…) plus a "Scanner test" field that shows what the
 * device actually sends: raw burst, characters, duration, terminator key and the decoded code
 * after prefix / suffix stripping. See docs/scanners.md.
 */
import { computed, ref } from 'vue'
import { useScanStore } from '@/stores/scan'
import { useCatalogStore } from '@/stores/catalog'
import { stripAffixes, type ScannerConfig } from '@/scan/affixes'
import { WedgeParser } from '@/scan/wedge'

const scan = useScanStore()
const catalog = useCatalogStore()

const prefix = ref(scan.scanner.prefix)
const suffix = ref(scan.scanner.suffix)
const terminator = ref<ScannerConfig['terminator']>(scan.scanner.terminator)
const saved = ref(false)
const dirty = computed(() => prefix.value !== scan.scanner.prefix || suffix.value !== scan.scanner.suffix || terminator.value !== scan.scanner.terminator)

async function save() {
  await scan.setScannerConfig({ prefix: prefix.value, suffix: suffix.value, terminator: terminator.value })
  saved.value = true
  setTimeout(() => (saved.value = false), 1500)
}

// ---- scanner test field: its own parser (the global wedge ignores text inputs)
interface TestResult {
  raw: string
  code: string
  chars: number
  durationMs: number
  terminator: string
  maxGapMs: number
  resolved: string
}
const testRaw = ref('')
const result = ref<TestResult | null>(null)
const parser = new WedgeParser({ minLength: 1, maxBurstMs: 5000, terminator: 'both' })
let start = 0
let last = 0
let maxGap = 0
let keys = ''

function onKey(e: KeyboardEvent) {
  const t = e.timeStamp || performance.now()
  if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    const raw = keys
    const dur = start ? Math.round(t - start) : 0
    const code = stripAffixes(raw, { prefix: prefix.value, suffix: suffix.value })
    const res = catalog.resolveCode(code)
    result.value = {
      raw: JSON.stringify(raw),
      code,
      chars: raw.length,
      durationMs: dur,
      terminator: e.key,
      maxGapMs: Math.round(maxGap),
      resolved: res ? `${res.item.item_name}${res.serial_no ? ' · ' + res.serial_no : ''}` : code.toUpperCase().startsWith('MC') ? 'client code' : 'not in catalogue'
    }
    parser.reset()
    keys = ''
    start = 0
    last = 0
    maxGap = 0
    testRaw.value = ''
    return
  }
  if (e.key.length !== 1) return
  if (!start) start = t
  else maxGap = Math.max(maxGap, t - last)
  last = t
  keys += e.key
  parser.feed({ key: e.key, time: t })
}
function clearTest() {
  result.value = null
  testRaw.value = ''
  keys = ''
  start = 0
}
</script>

<template>
  <div class="card block" data-testid="scanner-settings">
    <div class="between">
      <div class="section-title">Scanner</div>
      <span class="label label-dim">Bluetooth HID / USB wedge</span>
    </div>
    <div class="muted small">Socket Mobile S740, Zebra CS6080, Inateck and most HID scanners work as a keyboard. If yours is programmed with a prefix or suffix, or ends codes with Tab, set it here so the code is stripped before lookup.</div>
    <div class="row">
      <div class="field" style="flex: 1"><label class="label" for="scan-prefix">Prefix</label><input id="scan-prefix" v-model="prefix" class="input mono" placeholder="none" autocapitalize="off" autocomplete="off" spellcheck="false" data-testid="scanner-prefix" /></div>
      <div class="field" style="flex: 1"><label class="label" for="scan-suffix">Suffix</label><input id="scan-suffix" v-model="suffix" class="input mono" placeholder="none" autocapitalize="off" autocomplete="off" spellcheck="false" data-testid="scanner-suffix" /></div>
    </div>
    <div class="field">
      <label class="label" for="scan-term">Terminator</label>
      <select id="scan-term" v-model="terminator" class="input" data-testid="scanner-terminator">
        <option value="both">Enter or Tab (default)</option>
        <option value="enter">Enter only</option>
        <option value="tab">Tab only</option>
      </select>
    </div>
    <div class="dim small">Escapes: <code>\r</code> <code>\n</code> <code>\t</code> <code>&lt;CR&gt;</code> <code>&lt;LF&gt;</code> <code>&lt;TAB&gt;</code>. Trailing CR/LF are always ignored.</div>
    <div class="row">
      <button class="btn btn-primary" :disabled="!dirty" data-testid="scanner-save" @click="save">{{ saved ? 'Saved' : 'Save scanner settings' }}</button>
    </div>

    <div class="hr"></div>
    <div class="field">
      <label class="label" for="scan-test">Scanner test</label>
      <input id="scan-test" v-model="testRaw" class="input mono" placeholder="Tap here, then scan any label" autocapitalize="off" autocomplete="off" spellcheck="false" data-testid="scanner-test" @keydown="onKey" />
    </div>
    <div v-if="result" class="test-result" data-testid="scanner-test-result">
      <div class="kv"><span class="label">Decoded</span><span class="num accent">{{ result.code || '—' }}</span></div>
      <div class="kv"><span class="label">Resolves to</span><span>{{ result.resolved }}</span></div>
      <div class="kv"><span class="label">Raw</span><span class="num dim">{{ result.raw }}</span></div>
      <div class="kv"><span class="label">Characters</span><span class="num">{{ result.chars }}</span></div>
      <div class="kv"><span class="label">Burst</span><span class="num">{{ result.durationMs }} ms · max gap {{ result.maxGapMs }} ms</span></div>
      <div class="kv"><span class="label">Terminator</span><span>{{ result.terminator }}<span v-if="result.terminator === 'Tab' && terminator === 'enter'" class="crit"> — set terminator to Tab or both</span></span></div>
      <div v-if="result.maxGapMs > 50" class="warn small">Gaps above 50 ms look like typing — the wedge will ignore this scanner. Lower its inter-character delay or use the camera scanner.</div>
      <button class="label link" @click="clearTest">Clear</button>
    </div>
    <div v-else class="dim small">Nothing scanned yet. Keyboard-wedge scans elsewhere in the app are ignored while a text field has focus.</div>
  </div>
</template>

<style scoped>
.mono {
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.08em;
}
.small {
  font-size: 12px;
  line-height: 1.5;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 13px;
  min-height: 28px;
  align-items: center;
}
.test-result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  background: var(--surface-2);
}
code {
  color: var(--muted);
}
</style>
