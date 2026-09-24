<script lang="ts">
/**
 * v1.6 — **Concierge mode for a perfumery** (the client display, started by the associate).
 *
 * A fragrance consultation, the way a perfumer would hold it while the client waits: who the
 * scent is for, the families they love and the ones they would rather not wear, how it should
 * wear (close to the skin → leaves a trail) and in what form (spray, alcohol-free oil, mist,
 * bakhoor), when they wear it and what they wear now, and anything coming up.
 *
 * Every step can be skipped. For the client themselves the answers become their fragrance
 * profile; **for a gift they describe somebody else** and stay with the associate — the server
 * keeps them off the client's own profile (`salon._perfume_preferences`). Either way the end of
 * the consultation names up to three things on this store's shelf to try, and the associate's
 * till is told the same, so the testers are on the counter by the time the client looks up.
 *
 * The jeweller's Concierge (ring sizer, wrist, metal) is `SalonConcierge.vue`, unchanged.
 */
export const PERFUME_STEPS = ['who', 'love', 'avoid', 'wear', 'moments', 'occasion', 'done'] as const
export type PerfumeStep = (typeof PERFUME_STEPS)[number]

/** Copy that follows who it is for: "you" for the client, "they" for a gift. */
export function voice(who: string): { you: string; your: string; gift: boolean } {
  const gift = who !== 'Myself'
  return { you: gift ? 'they' : 'you', your: gift ? 'their' : 'your', gift }
}
</script>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { useSalonStore } from '../store'
import { AVOID_NAMES, SCENT_FAMILIES, SCENT_FORMS, SCENT_INTENSITY, SCENT_MOMENTS, SCENT_OCCASIONS, SHOPPING_FOR, toggle, type Intensity, type ShoppingFor } from '@/perfume/profile'

const salon = useSalonStore()
const step = ref<PerfumeStep>('who')
const who = ref<ShoppingFor>('Myself')
/** the first screen shows no choice made until the client makes one */
const whoChosen = ref(false)
const loves = ref<string[]>([])
const avoid = ref<string[]>([])
const intensity = ref<Intensity | null>(null)
const forms = ref<string[]>([])
const moments = ref<string[]>([])
const signature = ref('')
const occasions = ref<string[]>([])
const birthday = ref('')
const anniversary = ref('')
const saved = ref(false)

const idx = computed(() => PERFUME_STEPS.indexOf(step.value))
const v = computed(() => voice(who.value))
const name = computed(() => salon.client?.first_name || '')

function go(to: PerfumeStep) {
  step.value = to
  if (to === 'done') void finish()
}
function next() {
  go(PERFUME_STEPS[Math.min(PERFUME_STEPS.length - 1, idx.value + 1)])
}
function back() {
  step.value = PERFUME_STEPS[Math.max(0, idx.value - 1)]
}
function chooseWho(k: ShoppingFor) {
  who.value = k
  whoChosen.value = true
  next()
}
async function finish() {
  saved.value = await salon.savePreferences({
    shopping_for: who.value,
    scent_families: loves.value,
    scent_avoid: avoid.value,
    scent_intensity: intensity.value,
    scent_forms: forms.value,
    scent_moments: moments.value,
    signature_scent: signature.value.trim() || null,
    occasions: occasions.value,
    birthday: !v.value.gift && birthday.value && occasions.value.includes('Birthday') ? birthday.value : undefined,
    anniversary: anniversary.value && occasions.value.includes('Anniversary') ? anniversary.value : undefined
  })
}
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
</script>

<template>
  <div class="salon-screen wide" data-testid="salon-concierge" data-vertical="perfume" :data-step="step">
    <div class="progress" aria-hidden="true"><span v-for="(s, i) in PERFUME_STEPS.slice(0, -1)" :key="s" :class="{ on: i <= idx }"></span></div>

    <!-- who -->
    <template v-if="step === 'who'">
      <div class="s-eyebrow">{{ name || 'Concierge' }}</div>
      <div class="s-title soft">Who are we finding a scent for today?</div>
      <p class="s-lead">A few quick questions while we prepare — skip anything you like.</p>
      <div class="cards four">
        <button v-for="o in SHOPPING_FOR" :key="o.key" class="card" :class="{ on: whoChosen && who === o.key }" type="button" :data-testid="`who-${slug(o.key)}`" @click="chooseWho(o.key)">
          <span class="card-title">{{ o.title }}</span><span class="card-desc">{{ o.line }}</span>
        </button>
      </div>
    </template>

    <!-- love -->
    <template v-else-if="step === 'love'">
      <div class="s-eyebrow">Up to three</div>
      <div class="s-title soft">{{ v.gift ? 'Which scents might they love?' : 'Which scents draw you in?' }}</div>
      <div class="cards four">
        <button v-for="[f, line, , swatch] in SCENT_FAMILIES" :key="f" class="card family" :class="{ on: loves.includes(f) }" type="button" :data-testid="`family-${slug(f)}`" @click="loves = toggle(loves, f, 3)">
          <span class="swatch" :style="{ background: swatch }"></span>
          <span class="card-title">{{ f }}</span><span class="card-desc">{{ line }}</span>
        </button>
      </div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="next">{{ loves.length ? 'Next' : 'Skip' }}</button>
      </div>
    </template>

    <!-- avoid -->
    <template v-else-if="step === 'avoid'">
      <div class="s-eyebrow">Optional</div>
      <div class="s-title soft">Anything {{ v.you }}'d rather not wear?</div>
      <div class="s-chips">
        <button v-for="a in AVOID_NAMES" :key="a" class="s-chip" :class="{ on: avoid.includes(a) }" type="button" :data-testid="`avoid-${slug(a)}`" @click="avoid = toggle(avoid, a, 4)">{{ a }}</button>
      </div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="next">{{ avoid.length ? 'Next' : 'Nothing — next' }}</button>
      </div>
    </template>

    <!-- wear -->
    <template v-else-if="step === 'wear'">
      <div class="s-eyebrow">How it wears</div>
      <div class="s-title soft">{{ v.gift ? 'How should it wear on them?' : 'How should it wear on you?' }}</div>
      <div class="cards three">
        <button v-for="([i, line], n) in SCENT_INTENSITY" :key="i" class="card" :class="{ on: intensity === i }" type="button" :data-testid="`intensity-${slug(i)}`" @click="intensity = intensity === i ? null : i">
          <span class="sillage" :class="`s${n + 1}`" aria-hidden="true"><i></i><i></i><i></i></span>
          <span class="card-title">{{ i }}</span><span class="card-desc">{{ line }}</span>
        </button>
      </div>
      <div class="s-eyebrow sub">In what form?</div>
      <div class="s-chips">
        <button v-for="[f, line] in SCENT_FORMS" :key="f" class="s-chip form" :class="{ on: forms.includes(f) }" type="button" :data-testid="`form-${slug(f)}`" @click="forms = toggle(forms, f, 3)">
          <span>{{ f }}</span><small>{{ line }}</small>
        </button>
      </div>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="next">{{ intensity || forms.length ? 'Next' : 'Skip' }}</button>
      </div>
    </template>

    <!-- moments -->
    <template v-else-if="step === 'moments'">
      <div class="s-eyebrow">Up to four</div>
      <div class="s-title soft">{{ v.gift ? 'When will they wear it?' : 'When do you wear fragrance?' }}</div>
      <div class="s-chips">
        <button v-for="m in SCENT_MOMENTS" :key="m" class="s-chip" :class="{ on: moments.includes(m) }" type="button" :data-testid="`moment-${slug(m)}`" @click="moments = toggle(moments, m, 4)">{{ m }}</button>
      </div>
      <label class="s-field signature">
        <span class="s-eyebrow">{{ v.gift ? 'Do they have a favourite? (optional)' : 'What do you wear now? (optional)' }}</span>
        <input v-model="signature" class="s-input" type="text" maxlength="80" placeholder="e.g. Baccarat Rouge 540, Oud Wood, Khamrah" data-testid="signature-scent" />
      </label>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-next" @click="next">{{ moments.length || signature ? 'Next' : 'Skip' }}</button>
      </div>
    </template>

    <!-- occasion -->
    <template v-else-if="step === 'occasion'">
      <div class="s-eyebrow">Coming up</div>
      <div class="s-title soft">Anything we should remember?</div>
      <div class="s-chips">
        <button v-for="o in SCENT_OCCASIONS" :key="o" class="s-chip" :class="{ on: occasions.includes(o) }" type="button" :data-testid="`occasion-${slug(o)}`" @click="occasions = toggle(occasions, o, 4)">{{ o }}</button>
      </div>
      <div class="dates">
        <label v-if="!v.gift && occasions.includes('Birthday')" class="s-field">
          <span class="s-eyebrow">Your birthday (optional)</span>
          <input v-model="birthday" class="s-input" type="date" data-testid="occasion-birthday" />
        </label>
        <label v-if="occasions.includes('Anniversary')" class="s-field">
          <span class="s-eyebrow">The anniversary (optional)</span>
          <input v-model="anniversary" class="s-input" type="date" data-testid="occasion-anniversary" />
        </label>
      </div>
      <p v-if="!v.gift && occasions.includes('Birthday')" class="s-small s-muted">So we can remember you on your birthday.</p>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" @click="back">Back</button>
        <button class="s-btn primary" type="button" data-testid="concierge-finish" :disabled="salon.busy" @click="next">Finish</button>
      </div>
    </template>

    <!-- done -->
    <template v-else>
      <div class="s-eyebrow">Thank you{{ name ? `, ${name}` : '' }}</div>
      <div class="s-title soft">{{ saved ? (salon.prefsSuggestions.length ? 'A few to try' : 'We have made a note') : salon.error ? 'Something went wrong' : 'One moment…' }}</div>
      <template v-if="saved">
        <p class="s-lead" data-testid="concierge-saved">
          {{ salon.prefsSuggestions.length ? (v.gift ? 'Your associate is bringing these to the counter — ideas for them.' : 'Your associate is bringing these to the counter for you to try.') : 'Your associate has your notes and will guide you.' }}
        </p>
        <div v-if="salon.prefsSuggestions.length" class="tries" data-testid="concierge-suggestions">
          <div v-for="s in salon.prefsSuggestions" :key="s.item_code" class="try" :data-testid="`try-${s.item_code}`">
            <div class="try-img"><img v-if="s.image" :src="s.image" :alt="s.item_name" draggable="false" /><span v-else class="try-ini">{{ s.item_name.slice(0, 1) }}</span></div>
            <div class="try-name">{{ s.item_name }}</div>
            <div class="try-meta">
              <span v-for="(m, i) in [s.family, s.concentration, s.size].filter(Boolean)" :key="i">{{ m }}</span>
            </div>
          </div>
        </div>
      </template>
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
.cards {
  display: grid;
  gap: 12px;
  width: 100%;
  max-width: 1080px;
}
.cards.four {
  grid-template-columns: repeat(4, minmax(0, 1fr));
}
.cards.three {
  grid-template-columns: repeat(3, minmax(0, 1fr));
  max-width: 900px;
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
  letter-spacing: 0.14em;
  text-transform: uppercase;
  font-size: clamp(13px, 1.55vmin, 18px);
  color: var(--s-gold-2);
}
.card-desc {
  font-size: clamp(13px, 1.5vmin, 17px);
}
/* a family's colour, the way the metals were swatched on a jeweller's screen */
.swatch {
  width: clamp(44px, 6vmin, 64px);
  aspect-ratio: 1;
  border-radius: 50%;
  box-shadow: inset -8px -10px 18px rgba(0, 0, 0, 0.45), inset 6px 8px 14px rgba(255, 255, 255, 0.22);
  margin-bottom: 4px;
}
/* swatches line up across a row even when a family's name wraps */
.card.family {
  justify-content: flex-start;
}
.card.family.on .swatch {
  box-shadow: inset -8px -10px 18px rgba(0, 0, 0, 0.45), inset 6px 8px 14px rgba(255, 255, 255, 0.22), 0 0 0 2px var(--s-gold);
}
/* sillage: one ring close in, three rings trailing out */
.sillage {
  position: relative;
  width: clamp(56px, 7.5vmin, 80px);
  aspect-ratio: 1;
  display: grid;
  place-items: center;
  margin-bottom: 4px;
}
.sillage i {
  position: absolute;
  border-radius: 50%;
  border: 1px solid var(--s-gold);
  opacity: 0;
}
.sillage i:nth-child(1) {
  inset: 38%;
  opacity: 0.9;
  background: rgba(201, 169, 110, 0.35);
}
.sillage i:nth-child(2) {
  inset: 20%;
}
.sillage i:nth-child(3) {
  inset: 0;
}
.sillage.s2 i:nth-child(2),
.sillage.s3 i:nth-child(2) {
  opacity: 0.55;
}
.sillage.s3 i:nth-child(3) {
  opacity: 0.3;
}
.s-eyebrow.sub {
  margin-top: 6px;
}
.s-chip.form {
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 2px;
  padding: 8px 22px;
}
.s-chip.form small {
  font-size: clamp(11px, 1.25vmin, 14px);
  letter-spacing: 0.04em;
  text-transform: none;
  color: var(--s-dim);
}
.s-chip.form.on small {
  color: var(--s-muted);
}
.signature {
  width: 100%;
  max-width: 560px;
}
.dates {
  display: flex;
  gap: 18px;
  flex-wrap: wrap;
  justify-content: center;
}
.dates .s-field {
  width: 280px;
}
.tries {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 18px;
  width: 100%;
  max-width: 980px;
}
.try {
  border: 1px solid var(--s-line-soft);
  background: var(--s-glass);
  padding: 18px 14px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}
.try-img {
  width: 100%;
  aspect-ratio: 4 / 3;
  display: grid;
  place-items: center;
  background: radial-gradient(closest-side, rgba(201, 169, 110, 0.14), rgba(201, 169, 110, 0) 72%);
}
.try-img img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  mix-blend-mode: lighten;
}
.try-ini {
  font-family: var(--font-display);
  font-size: clamp(36px, 6vmin, 64px);
  color: var(--s-gold);
  opacity: 0.6;
}
.try-name {
  font-size: clamp(15px, 1.8vmin, 21px);
  color: var(--s-ink);
}
.try-meta {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 4px 14px;
  font-size: clamp(11px, 1.3vmin, 15px);
  letter-spacing: 0.1em;
  text-transform: uppercase;
  color: var(--s-dim);
}
.try-meta span {
  white-space: nowrap;
}
@media (max-width: 900px) {
  .cards.four {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
  .cards.three,
  .tries {
    grid-template-columns: 1fr;
  }
}
</style>
