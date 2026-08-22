<script setup lang="ts">
/**
 * v0.5 K — Concierge mode (started by the associate): a guided Q&A that turns waiting time into
 * clienteling data — ring size on the sizer, wrist size, metal, style cards, occasions → Client Profile.
 */
import { computed, ref } from 'vue'
import { useSalonStore } from '../store'
import RingSizer from '../components/RingSizer.vue'

const salon = useSalonStore()
const steps = ['ring', 'wrist', 'metal', 'style', 'occasion', 'done'] as const
const step = ref<(typeof steps)[number]>('ring')
const ring = ref('6.5')
const ringKnown = ref(false)
const wrist = ref('')
const metal = ref('')
const styles = ref<string[]>([])
const occasions = ref<string[]>([])
const when = ref('')
const saved = ref(false)

const WRISTS = ['14 cm', '15 cm', '16 cm', '17 cm', '18 cm', '19 cm']
const METALS = ['Yellow Gold', 'White Gold', 'Rose Gold', 'Platinum', 'Mixed']
const STYLES: [string, string][] = [
  ['Minimal', 'Clean lines, one piece a day'],
  ['Statement', 'Let it be seen'],
  ['Heritage', 'Classic, inherited, timeless'],
  ['Modern', 'Architecture on the hand'],
  ['Everyday', 'Worn, not kept'],
  ['Bridal', 'The lifelong pieces'],
  ['Colour', 'Sapphire, emerald, ruby'],
  ['Stacking', 'Collected over time']
]
const OCCASIONS = ['Anniversary', 'Birthday', 'Engagement', 'Wedding', 'Gift', 'Milestone', 'Just because']
const idx = computed(() => steps.indexOf(step.value))
function toggle(list: string[], v: string, max = 3) {
  const i = list.indexOf(v)
  if (i >= 0) list.splice(i, 1)
  else if (list.length < max) list.push(v)
}
function next() {
  step.value = steps[Math.min(steps.length - 1, idx.value + 1)]
  if (step.value === 'done') void finish()
}
function back() {
  step.value = steps[Math.max(0, idx.value - 1)]
}
async function finish() {
  saved.value = await salon.savePreferences({
    ring_size: ringKnown.value ? ring.value : undefined,
    wrist_size: wrist.value || undefined,
    metal_preference: metal.value || undefined,
    styles: styles.value,
    occasions: occasions.value,
    anniversary: when.value && occasions.value.includes('Anniversary') ? when.value : undefined,
    birthday: when.value && occasions.value.includes('Birthday') ? when.value : undefined
  })
}
</script>

<template>
  <div class="salon-screen wide" data-testid="salon-concierge" :data-step="step">
    <div class="progress" aria-hidden="true"><span v-for="(s, i) in steps.slice(0, -1)" :key="s" :class="{ on: i <= idx }"></span></div>

    <template v-if="step === 'ring'">
      <div class="s-eyebrow">{{ salon.client ? salon.client.first_name : 'Concierge' }}</div>
      <div class="s-title soft">Shall we note your ring size?</div>
      <p class="s-lead">Lay a ring you wear on the circle and adjust until the inner edge meets the band.</p>
      <RingSizer v-model="ring" @update:model-value="ringKnown = true" />
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="ringKnown = false; next()">Skip</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="ringKnown = true; next()">That's my size</button>
      </div>
    </template>

    <template v-else-if="step === 'wrist'">
      <div class="s-eyebrow">Bracelets and watches</div>
      <div class="s-title soft">Your wrist</div>
      <div class="s-chips">
        <button v-for="w in WRISTS" :key="w" class="s-chip" :class="{ on: wrist === w }" type="button" @click="wrist = wrist === w ? '' : w">{{ w }}</button>
      </div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="next">{{ wrist ? 'Next' : 'Skip' }}</button>
      </div>
    </template>

    <template v-else-if="step === 'metal'">
      <div class="s-eyebrow">Preference</div>
      <div class="s-title soft">Which metal feels like you?</div>
      <div class="metals">
        <button v-for="m in METALS" :key="m" class="metal" :class="[m.toLowerCase().replace(/\s+/g, '-'), { on: metal === m }]" type="button" :data-testid="`metal-${m.toLowerCase().replace(/\s+/g, '-')}`" @click="metal = metal === m ? '' : m">
          <span class="swatch"></span><span class="s-eyebrow">{{ m }}</span>
        </button>
      </div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="next">{{ metal ? 'Next' : 'Skip' }}</button>
      </div>
    </template>

    <template v-else-if="step === 'style'">
      <div class="s-eyebrow">Up to three</div>
      <div class="s-title soft">Your style</div>
      <div class="cards">
        <button v-for="[s, d] in STYLES" :key="s" class="card" :class="{ on: styles.includes(s) }" type="button" :data-testid="`style-${s.toLowerCase()}`" @click="toggle(styles, s)">
          <span class="card-title">{{ s }}</span><span class="card-desc">{{ d }}</span>
        </button>
      </div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="next">{{ styles.length ? 'Next' : 'Skip' }}</button>
      </div>
    </template>

    <template v-else-if="step === 'occasion'">
      <div class="s-eyebrow">Coming up</div>
      <div class="s-title soft">Any occasion we should know about?</div>
      <div class="s-chips">
        <button v-for="o in OCCASIONS" :key="o" class="s-chip" :class="{ on: occasions.includes(o) }" type="button" :data-testid="`occasion-${o.toLowerCase().replace(/\s+/g, '-')}`" @click="toggle(occasions, o, 4)">{{ o }}</button>
      </div>
      <label v-if="occasions.includes('Anniversary') || occasions.includes('Birthday')" class="s-field" style="max-width: 360px">
        <span class="s-eyebrow">The date (optional)</span>
        <input v-model="when" class="s-input" type="date" data-testid="occasion-date" />
      </label>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-finish" :disabled="salon.busy" @click="next">Finish</button>
      </div>
    </template>

    <template v-else>
      <div class="s-eyebrow">Thank you</div>
      <div class="s-title soft">{{ saved ? 'The house has made a note' : salon.error ? 'Something went wrong' : 'Saving…' }}</div>
      <p v-if="saved" class="s-lead" data-testid="concierge-saved">Your associate will keep these in mind for you.</p>
      <div class="s-error">{{ salon.error }}</div>
    </template>
  </div>
</template>

<style scoped>
.progress {
  display: flex;
  gap: 10px;
}
.progress span {
  width: 28px;
  height: 2px;
  background: var(--s-line-soft);
  transition: background 600ms var(--s-ease);
}
.progress span.on {
  background: var(--s-gold);
}
.metals {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  justify-content: center;
}
.metal {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  background: transparent;
  border: 1px solid transparent;
  padding: 16px 18px;
  cursor: pointer;
  color: var(--s-muted);
  transition: all 500ms var(--s-ease);
}
.metal.on {
  border-color: var(--s-gold);
  background: rgba(201, 169, 110, 0.1);
}
.metal .s-eyebrow {
  color: inherit;
}
.swatch {
  width: clamp(64px, 9vmin, 96px);
  aspect-ratio: 1;
  border-radius: 50%;
  box-shadow: inset -10px -14px 24px rgba(0, 0, 0, 0.55), inset 8px 10px 18px rgba(255, 255, 255, 0.25);
}
.yellow-gold .swatch {
  background: linear-gradient(135deg, #f1d58a, #b4882f);
}
.white-gold .swatch {
  background: linear-gradient(135deg, #f4f2ea, #9d9b93);
}
.rose-gold .swatch {
  background: linear-gradient(135deg, #f3c7b0, #b27355);
}
.platinum .swatch {
  background: linear-gradient(135deg, #e8e9ea, #8c9093);
}
.mixed .swatch {
  background: conic-gradient(#f1d58a, #f4f2ea, #f3c7b0, #e8e9ea, #f1d58a);
}
.cards {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  width: 100%;
  max-width: 980px;
}
.card {
  border: 1px solid var(--s-line-soft);
  background: var(--s-glass);
  color: var(--s-muted);
  padding: 22px 16px;
  min-height: 120px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 500ms var(--s-ease);
}
.card.on {
  border-color: var(--s-gold);
  background: rgba(201, 169, 110, 0.12);
  color: var(--s-ink);
}
.card-title {
  font-family: var(--font-display);
  font-weight: 300;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-size: clamp(13px, 1.6vmin, 18px);
  color: var(--s-gold-2);
}
.card-desc {
  font-size: clamp(13px, 1.5vmin, 17px);
}
@media (max-width: 800px) {
  .cards {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
</style>
