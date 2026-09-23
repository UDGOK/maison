<script lang="ts">
/**
 * v1.5 — **Promotions** (the seventh section of the warehouse desk): the rewards programme and
 * its tiers, coupons, giveaways, sales the till applies by itself, and the monthly calendar —
 * all edited from the desk instead of the Frappe forms.
 *
 * Every tab edits what the chain already runs on (`maison_pos/api/promotions_admin.py`); there
 * is no second copy of a promotion anywhere. What the board says out loud:
 *  · a coupon's code never changes once it exists — it may be printed on something;
 *  · a giveaway is drawn by a seeded, auditable draw, never by hand;
 *  · a sale is switched off, never deleted — the receipts that carried it still name it.
 */
import type { Coupon, Giveaway, Promotion } from '@/api/promotions'

export type PromoTab = 'rewards' | 'coupons' | 'giveaways' | 'sales' | 'calendar'
export const PROMO_TABS: { key: PromoTab; label: string }[] = [
  { key: 'rewards', label: 'Rewards' },
  { key: 'coupons', label: 'Coupons' },
  { key: 'giveaways', label: 'Giveaways' },
  { key: 'sales', label: 'Sales' },
  { key: 'calendar', label: 'Calendar' }
]

/** Live first, then scheduled, then used-up / expired, off last; newest window first within. */
export function sortCoupons(rows: Coupon[]): Coupon[] {
  const rank: Record<Coupon['state'], number> = { live: 0, 'used up': 1, expired: 2, off: 3 }
  return [...rows].sort((a, b) => rank[a.state] - rank[b.state] || (b.valid_upto || '').localeCompare(a.valid_upto || '') || a.code.localeCompare(b.code))
}

export function sortGiveaways(rows: Giveaway[]): Giveaway[] {
  const rank: Record<Giveaway['status'], number> = { Open: 0, Draft: 1, Closed: 2, Drawn: 3 }
  return [...rows].sort((a, b) => rank[a.status] - rank[b.status] || (b.end_date || '').localeCompare(a.end_date || ''))
}

export function sortPromotions(rows: Promotion[]): Promotion[] {
  const rank: Record<Promotion['state'], number> = { live: 0, scheduled: 1, ended: 2, off: 3 }
  return [...rows].sort((a, b) => rank[a.state] - rank[b.state] || (b.valid_from || '').localeCompare(a.valid_from || '') || a.title.localeCompare(b.title))
}

/** "Sep 2026" for a calendar row's month. */
export function fmtMonth(iso: string): string {
  const d = new Date(iso.slice(0, 10) + 'T00:00:00')
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString('en-US', { month: 'short', year: 'numeric' })
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  promotionsApi,
  couponDraftOf,
  couponPayload,
  describePromotion,
  describeScope,
  emptyCouponDraft,
  emptyGiveawayDraft,
  emptyPromotionDraft,
  giveawayDraftOf,
  giveawayPayload,
  promotionDraftOf,
  promotionPayload,
  validateCouponDraft,
  validateGiveawayDraft,
  validatePromotionDraft,
  type CalendarMonth,
  type CouponDraft,
  type GiveawayDraft,
  type PromotionDraft,
  type PromotionsOverview,
  type RewardsSettings,
  type Tier
} from '@/api/promotions'
import { fmtMoney } from '@/utils/money'
import Modal from '@/components/Modal.vue'

const emit = defineEmits<{ (e: 'notice', msg: string): void }>()

const data = ref<PromotionsOverview | null>(null)
const tab = ref<PromoTab>('rewards')
const loading = ref(false)
const error = ref('')
const formError = ref('')
const busy = ref<string | null>(null)

// rewards
const settings = ref<RewardsSettings | null>(null)
const pointsPerDollar = ref<number | null>(null)
const tierEdit = ref<{ name: string | null; title: string; points: number | null; amount: number | null; enabled: boolean; description: string } | null>(null)

// coupons / giveaways / sales
const couponEdit = ref<{ draft: CouponDraft; creating: boolean } | null>(null)
const giveawayEdit = ref<GiveawayDraft | null>(null)
const drawing = ref<Giveaway | null>(null)
const promoEdit = ref<PromotionDraft | null>(null)

// calendar
const calEdit = ref<{ name: string | null; month: string; title: string; headline: string; body: string; coupon: string; status: CalendarMonth['status']; rules: string[]; items: string; notes: string } | null>(null)
const sending = ref<CalendarMonth | null>(null)

const today = () => new Date().toISOString().slice(0, 10)
const stores = computed(() => (data.value?.stores || []).filter((s) => !s.is_warehouse))
const coupons = computed(() => sortCoupons(data.value?.coupons || []))
const giveaways = computed(() => sortGiveaways(data.value?.giveaways || []))
const promotions = computed(() => sortPromotions(data.value?.promotions || []))
const liveSales = computed(() => promotions.value.filter((p) => p.state === 'live'))
const dirtySettings = computed(() => {
  if (!data.value || !settings.value) return false
  const keys = Object.keys(settings.value) as (keyof RewardsSettings)[]
  return keys.some((k) => String(settings.value![k]) !== String(data.value!.settings[k])) || (data.value.program !== null && pointsPerDollar.value !== data.value.program.points_per_dollar)
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await promotionsApi.overview()
    settings.value = { ...data.value.settings }
    pointsPerDollar.value = data.value.program?.points_per_dollar ?? null
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

// ---------------------------------------------------------------- rewards
async function saveSettings() {
  if (!settings.value) return
  busy.value = 'settings'
  formError.value = ''
  try {
    const payload: Record<string, unknown> = { ...settings.value }
    if (data.value?.program && pointsPerDollar.value !== null) payload.points_per_dollar = pointsPerDollar.value
    const out = await promotionsApi.saveRewardsSettings(payload)
    emit('notice', out.changed.length ? `Rewards saved — ${out.changed.length} setting${out.changed.length === 1 ? '' : 's'} changed` : 'Nothing changed')
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
function startTier(t?: Tier) {
  formError.value = ''
  tierEdit.value = t ? { name: t.name, title: t.title, points: t.points, amount: t.amount, enabled: !!t.enabled, description: t.description || '' } : { name: null, title: '', points: null, amount: null, enabled: true, description: '' }
}
async function saveTier() {
  if (!tierEdit.value) return
  const t = tierEdit.value
  if (!(Number(t.points) > 0)) return void (formError.value = 'A tier needs a points figure above zero.')
  if (!(Number(t.amount) > 0)) return void (formError.value = 'A tier needs a dollar value above zero.')
  busy.value = 'tier'
  formError.value = ''
  try {
    const out = await promotionsApi.saveTier({ name: t.name || undefined, title: t.title, points: Number(t.points), amount: Number(t.amount), enabled: t.enabled ? 1 : 0, description: t.description })
    emit('notice', `${out.tier.title} — ${t.name ? 'updated' : 'added'}`)
    tierEdit.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------- coupons
function startCoupon(c?: Coupon) {
  formError.value = ''
  couponEdit.value = c ? { draft: couponDraftOf(c), creating: false } : { draft: emptyCouponDraft(), creating: true }
}
async function saveCoupon() {
  if (!couponEdit.value) return
  const { draft, creating } = couponEdit.value
  const problem = validateCouponDraft(draft, creating)
  if (problem) return void (formError.value = problem)
  busy.value = 'coupon'
  formError.value = ''
  try {
    const out = await promotionsApi.saveCoupon(couponPayload(draft))
    emit('notice', `${out.coupon.code} — ${out.created ? 'created' : 'updated'}`)
    couponEdit.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function toggleCoupon(c: Coupon) {
  busy.value = c.code
  try {
    const out = await promotionsApi.setCouponEnabled(c.code, !c.enabled)
    emit('notice', `${out.coupon.code} is ${out.coupon.enabled ? 'on' : 'off'}`)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------- giveaways
function startGiveaway(g?: Giveaway) {
  formError.value = ''
  giveawayEdit.value = g ? giveawayDraftOf(g) : emptyGiveawayDraft(data.value?.settings.giveaway_entries_per_amount || 25)
}
async function saveGiveaway() {
  if (!giveawayEdit.value) return
  const problem = validateGiveawayDraft(giveawayEdit.value)
  if (problem) return void (formError.value = problem)
  busy.value = 'giveaway'
  formError.value = ''
  try {
    const out = await promotionsApi.saveGiveaway(giveawayPayload(giveawayEdit.value))
    emit('notice', `${out.giveaway.title} — ${out.created ? 'created' : 'updated'}${out.giveaway.status === 'Open' ? ', open for entries' : ''}`)
    giveawayEdit.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function confirmDraw() {
  if (!drawing.value) return
  busy.value = 'draw'
  try {
    const out = await promotionsApi.drawGiveaway(drawing.value.name)
    emit('notice', `${out.giveaway.title}: the winner is ${out.draw.winner_name || out.draw.winner} — they have been notified`)
    drawing.value = null
    await load()
  } catch (e) {
    error.value = (e as Error).message
    drawing.value = null
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------- sales
function startPromotion(p?: Promotion) {
  formError.value = ''
  promoEdit.value = p ? promotionDraftOf(p) : emptyPromotionDraft(today())
}
async function savePromotion() {
  if (!promoEdit.value) return
  const problem = validatePromotionDraft(promoEdit.value)
  if (problem) return void (formError.value = problem)
  busy.value = 'promotion'
  formError.value = ''
  try {
    const out = await promotionsApi.savePromotion(promotionPayload(promoEdit.value))
    emit('notice', `${out.promotion.title} — ${out.created ? 'created' : 'updated'} · ${out.promotion.state}`)
    promoEdit.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function togglePromotion(p: Promotion) {
  busy.value = p.name
  try {
    const out = await promotionsApi.setPromotionEnabled(p.name, !p.enabled)
    emit('notice', `${out.promotion.title} is ${out.promotion.enabled ? 'on' : 'off'}`)
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = null
  }
}

// ---------------------------------------------------------------- calendar
function nextMonthIso(): string {
  const d = new Date()
  d.setDate(1)
  d.setMonth(d.getMonth() + 1)
  return d.toISOString().slice(0, 7)
}
function startCalendar(c?: CalendarMonth) {
  formError.value = ''
  calEdit.value = c
    ? { name: c.name, month: c.month.slice(0, 7), title: c.title, headline: c.headline || '', body: c.body || '', coupon: c.coupon || '', status: c.status, rules: c.pricing_rules.map((r) => r.name), items: c.featured_items.map((r) => r.item_code).join(', '), notes: c.notes || '' }
    : { name: null, month: nextMonthIso(), title: '', headline: '', body: '', coupon: '', status: 'Planned', rules: [], items: '', notes: '' }
}
async function saveCalendar() {
  if (!calEdit.value) return
  const c = calEdit.value
  if (!/^\d{4}-\d{2}$/.test(c.month)) return void (formError.value = 'Pick a month.')
  busy.value = 'calendar'
  formError.value = ''
  try {
    const out = await promotionsApi.saveCalendar({
      month: `${c.month}-01`,
      title: c.title,
      headline: c.headline,
      body: c.body,
      coupon: c.coupon || null,
      status: c.status,
      pricing_rules: c.rules,
      featured_items: c.items
        .split(/[,\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((item_code) => ({ item_code })),
      notes: c.notes
    })
    emit('notice', `${fmtMonth(out.calendar.month)} — ${out.created ? 'planned' : 'updated'}`)
    calEdit.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function confirmSend() {
  if (!sending.value) return
  busy.value = 'send'
  try {
    const out = await promotionsApi.sendCalendar(sending.value.name)
    emit('notice', `${fmtMonth(out.calendar.month)} sent to ${out.calendar.audience_size} member${out.calendar.audience_size === 1 ? '' : 's'}`)
    sending.value = null
    await load()
  } catch (e) {
    error.value = (e as Error).message
    sending.value = null
  } finally {
    busy.value = null
  }
}
function toggleRule(name: string) {
  if (!calEdit.value) return
  const i = calEdit.value.rules.indexOf(name)
  if (i >= 0) calEdit.value.rules.splice(i, 1)
  else calEdit.value.rules.push(name)
}
</script>

<template>
  <div class="board" data-testid="promotions-board">
    <nav class="subnav" aria-label="Promotions">
      <button v-for="t in PROMO_TABS" :key="t.key" class="chip" :class="{ active: tab === t.key }" :data-testid="`promo-tab-${t.key}`" :aria-current="tab === t.key ? 'page' : undefined" @click="tab = t.key">
        {{ t.label }}
        <span v-if="t.key === 'sales' && liveSales.length" class="badge">{{ liveSales.length }}</span>
        <span v-if="t.key === 'giveaways' && giveaways.some((g) => g.status === 'Open')" class="badge">{{ giveaways.filter((g) => g.status === 'Open').length }}</span>
      </button>
      <div class="spacer"></div>
      <span v-if="data" class="label label-dim">{{ data.program ? `${data.program.members} members` : 'no loyalty programme yet' }}</span>
      <button class="btn" :disabled="loading" @click="load">Refresh</button>
    </nav>

    <div v-if="error" class="banner crit-banner" data-testid="promo-error">
      <span>{{ error }}</span>
      <div class="row">
        <button class="btn btn-ghost" @click="load">Try again</button>
        <button class="btn btn-ghost" @click="error = ''">Dismiss</button>
      </div>
    </div>

    <div v-if="loading && !data" class="empty"><div class="label label-dim">Loading promotions…</div></div>

    <!-- ============================================================ Rewards -->
    <template v-else-if="data && settings && tab === 'rewards'">
      <section class="card block">
        <div class="between">
          <div>
            <div class="section-title">The programme</div>
            <div class="muted">Printed on every receipt and on /rewards. Points are earned on net spend; a tier is what they buy.</div>
          </div>
          <button class="btn btn-primary" :disabled="!dirtySettings || busy === 'settings'" data-testid="rewards-save" @click="saveSettings">{{ busy === 'settings' ? 'Saving…' : 'Save rewards' }}</button>
        </div>
        <div class="form" style="margin-top: 14px">
          <div class="field">
            <label class="label" for="rw-name">Programme name</label>
            <input id="rw-name" v-model="settings.rewards_program_name" class="input" data-testid="rewards-name" />
          </div>
          <div class="field">
            <label class="label" for="rw-ppd">Points per dollar</label>
            <input id="rw-ppd" v-model.number="pointsPerDollar" class="input" type="number" min="0.01" max="100" step="0.01" :disabled="!data.program" data-testid="rewards-ppd" />
            <div class="label label-dim">{{ data.program ? `${pointsPerDollar || 0} point${pointsPerDollar === 1 ? '' : 's'} for every $1 of net spend` : 'No loyalty programme exists yet' }}</div>
          </div>
          <div class="field">
            <label class="label"><input v-model="settings.promotions_enabled" type="checkbox" :true-value="1" :false-value="0" /> Promotions &amp; coupons on the till</label>
          </div>
          <div class="field">
            <label class="label"><input v-model="settings.reward_allow_stacking" type="checkbox" :true-value="1" :false-value="0" /> More than one tier per receipt</label>
          </div>
          <div class="field">
            <label class="label" for="rw-gpe">Giveaways: $ per entry (default)</label>
            <input id="rw-gpe" v-model.number="settings.giveaway_entries_per_amount" class="input" type="number" min="1" step="1" />
          </div>
          <div class="field">
            <label class="label" for="rw-new">New arrivals window (days)</label>
            <input id="rw-new" v-model.number="settings.new_arrivals_days" class="input" type="number" min="1" step="1" />
          </div>
        </div>
        <div class="section-title" style="margin-top: 20px">Birthday coupon</div>
        <div class="form" style="margin-top: 10px">
          <div class="field">
            <label class="label"><input v-model="settings.birthday_coupon_enabled" type="checkbox" :true-value="1" :false-value="0" /> Send a birthday coupon</label>
          </div>
          <div class="field">
            <label class="label" for="rw-bpts">Birthday bonus points (0 = none)</label>
            <input id="rw-bpts" v-model.number="settings.birthday_bonus_points" class="input" type="number" min="0" step="1" />
          </div>
          <div class="field">
            <label class="label" for="rw-btype">Discount</label>
            <div class="row" style="gap: 8px">
              <select id="rw-btype" v-model="settings.birthday_coupon_type" class="input" style="max-width: 140px">
                <option>Percent</option>
                <option>Amount</option>
              </select>
              <input v-model.number="settings.birthday_coupon_value" class="input" type="number" min="0" :max="settings.birthday_coupon_type === 'Percent' ? 100 : undefined" step="1" data-testid="rewards-bday-value" />
            </div>
          </div>
          <div class="field">
            <label class="label" for="rw-blead">Issue N days before · valid N days</label>
            <div class="row" style="gap: 8px">
              <input id="rw-blead" v-model.number="settings.birthday_coupon_lead_days" class="input" type="number" min="0" step="1" />
              <input v-model.number="settings.birthday_coupon_valid_days" class="input" type="number" min="1" step="1" />
            </div>
          </div>
        </div>
      </section>

      <section class="card block">
        <div class="between">
          <div>
            <div class="section-title">Reward tiers</div>
            <div class="muted">What points buy at the till. A tier that is off stays on old receipts but is not offered.</div>
          </div>
          <button class="btn btn-primary" :disabled="!data.program" data-testid="tier-add" @click="startTier()">Add tier</button>
        </div>
        <div v-if="!data.tiers.length" class="label label-dim" style="padding: 12px 0">No tiers yet — add one.</div>
        <table v-else class="table" style="margin-top: 10px">
          <thead>
            <tr><th>Tier</th><th class="num">Points</th><th class="num">Worth</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="t in data.tiers" :key="t.name" :class="{ off: !t.enabled }" :data-testid="`tier-${t.points}`">
              <td><div>{{ t.title }}</div><div v-if="t.description" class="label label-dim">{{ t.description }}</div></td>
              <td class="num">{{ t.points }}</td>
              <td class="num">{{ fmtMoney(t.amount) }}</td>
              <td><span class="pill" :class="t.enabled ? 'pill-good' : ''">{{ t.enabled ? 'On' : 'Off' }}</span></td>
              <td class="num"><button class="btn btn-ghost small" @click="startTier(t)">Edit</button></td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- ============================================================ Coupons -->
    <template v-else-if="data && tab === 'coupons'">
      <section class="card block">
        <div class="between">
          <div>
            <div class="section-title">Coupons</div>
            <div class="muted">A code the customer gives at the till or online. Birthday coupons are issued by the programme and are not listed here.</div>
          </div>
          <button class="btn btn-primary" data-testid="coupon-add" @click="startCoupon()">New coupon</button>
        </div>
        <div v-if="!coupons.length" class="label label-dim" style="padding: 12px 0">No coupons yet.</div>
        <table v-else class="table" style="margin-top: 10px">
          <thead>
            <tr><th>Code</th><th>Title</th><th>Discount</th><th>Where</th><th>Valid</th><th class="num">Used</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="c in coupons" :key="c.code" :class="{ off: c.state !== 'live' }" :data-testid="`coupon-${c.code}`">
              <td><button class="link mono" @click="startCoupon(c)">{{ c.code }}</button></td>
              <td>{{ c.title }}</td>
              <td>{{ c.discount_type === 'Percent' ? `${c.value}% off` : `${fmtMoney(c.value)} off` }}<span v-if="c.min_basket" class="muted"> over {{ fmtMoney(c.min_basket) }}</span><span v-if="c.item_group" class="muted"> · {{ c.item_group }}</span></td>
              <td>{{ c.boutique_name || 'Every store' }}</td>
              <td class="label label-dim">{{ c.valid_from || c.valid_upto ? `${c.valid_from || '…'} → ${c.valid_upto || '…'}` : 'always' }}</td>
              <td class="num">{{ c.used_count }}<span v-if="c.max_uses" class="muted"> / {{ c.max_uses }}</span></td>
              <td><span class="pill" :class="c.state === 'live' ? 'pill-good' : c.state === 'off' ? '' : 'pill-warn'">{{ c.state }}</span></td>
              <td class="num">
                <div class="row" style="gap: 6px; justify-content: flex-end">
                  <button class="btn btn-ghost small" @click="startCoupon(c)">Edit</button>
                  <button class="btn btn-ghost small" :disabled="busy === c.code" :data-testid="`coupon-toggle-${c.code}`" @click="toggleCoupon(c)">{{ c.enabled ? 'Switch off' : 'Switch on' }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- ============================================================ Giveaways -->
    <template v-else-if="data && tab === 'giveaways'">
      <section class="card block">
        <div class="between">
          <div>
            <div class="section-title">Giveaways</div>
            <div class="muted">Members earn entries on receipts while a giveaway is open. The draw is seeded and audited; the winner is notified.</div>
          </div>
          <button class="btn btn-primary" data-testid="giveaway-add" @click="startGiveaway()">New giveaway</button>
        </div>
        <div v-if="!giveaways.length" class="label label-dim" style="padding: 12px 0">No giveaways yet.</div>
        <table v-else class="table" style="margin-top: 10px">
          <thead>
            <tr><th>Giveaway</th><th>Prize</th><th>Runs</th><th>Where</th><th>Entries</th><th class="num">Entries · people</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="g in giveaways" :key="g.name" :class="{ off: g.status === 'Closed' }" :data-testid="`giveaway-${g.name}`">
              <td><button class="link" @click="startGiveaway(g)">{{ g.title }}</button><div class="label label-dim">{{ g.name }}</div></td>
              <td>{{ g.prize_description || g.prize_item || '—' }}</td>
              <td class="label label-dim">{{ g.start_date }} → {{ g.end_date }}</td>
              <td>{{ g.boutique_name || 'Every store' }}</td>
              <td class="label label-dim">{{ g.entry_rule === 'Per visit' ? '1 per visit' : `1 per ${fmtMoney(g.amount_per_entry)}` }}<span v-if="g.max_entries_per_invoice"> · max {{ g.max_entries_per_invoice }}</span></td>
              <td class="num">{{ g.entries }} · {{ g.participants }}</td>
              <td>
                <span class="pill" :class="g.status === 'Open' ? 'pill-good' : g.status === 'Drawn' ? 'pill-accent' : ''">{{ g.status }}</span>
                <div v-if="g.winner" class="label label-dim">{{ g.winner_name || g.winner }}</div>
              </td>
              <td class="num">
                <div class="row" style="gap: 6px; justify-content: flex-end">
                  <button v-if="g.status !== 'Drawn'" class="btn btn-ghost small" @click="startGiveaway(g)">Edit</button>
                  <button v-if="g.status !== 'Drawn' && g.entries" class="btn btn-primary small" :data-testid="`giveaway-draw-${g.name}`" @click="drawing = g">Draw</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- ============================================================ Sales -->
    <template v-else-if="data && tab === 'sales'">
      <section class="card block">
        <div class="between">
          <div>
            <div class="section-title">Sales</div>
            <div class="muted">Applied by the till on its own — no code needed. A sale is switched off, never deleted. Store shelf prices live under Prices.</div>
          </div>
          <button class="btn btn-primary" data-testid="promo-add" @click="startPromotion()">New sale</button>
        </div>
        <div v-if="!promotions.length" class="label label-dim" style="padding: 12px 0">No sales yet.</div>
        <table v-else class="table" style="margin-top: 10px">
          <thead>
            <tr><th>Sale</th><th>Deal</th><th>Applies to</th><th>Where</th><th>Runs</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="p in promotions" :key="p.name" :class="{ off: p.state === 'off' || p.state === 'ended' }" :data-testid="`promo-${p.name}`">
              <td><button class="link" @click="startPromotion(p)">{{ p.title }}</button></td>
              <td>{{ describePromotion(p, fmtMoney) }}<span v-if="p.min_qty" class="muted"> · from {{ p.min_qty }}</span><span v-if="p.min_amt" class="muted"> · over {{ fmtMoney(p.min_amt) }}</span></td>
              <td class="ellipsis" style="max-width: 260px">{{ describeScope(p) }}</td>
              <td>{{ p.boutique_name || 'Every store' }}</td>
              <td class="label label-dim">{{ p.valid_from || '…' }} → {{ p.valid_upto || 'open' }}</td>
              <td><span class="pill" :class="p.state === 'live' ? 'pill-good' : p.state === 'scheduled' ? 'pill-accent' : ''">{{ p.state }}</span></td>
              <td class="num">
                <div class="row" style="gap: 6px; justify-content: flex-end">
                  <button class="btn btn-ghost small" @click="startPromotion(p)">Edit</button>
                  <button class="btn btn-ghost small" :disabled="busy === p.name" :data-testid="`promo-toggle-${p.name}`" @click="togglePromotion(p)">{{ p.enabled ? 'Switch off' : 'Switch on' }}</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- ============================================================ Calendar -->
    <template v-else-if="data && tab === 'calendar'">
      <section class="card block">
        <div class="between">
          <div>
            <div class="section-title">Monthly calendar</div>
            <div class="muted">One plan per month: a headline, the coupon, the sales to switch on, featured items. It goes to members by e-mail on the 1st — or now.</div>
          </div>
          <button class="btn btn-primary" data-testid="calendar-add" @click="startCalendar()">Plan a month</button>
        </div>
        <div v-if="!data.calendar.length" class="label label-dim" style="padding: 12px 0">Nothing planned yet.</div>
        <table v-else class="table" style="margin-top: 10px">
          <thead>
            <tr><th>Month</th><th>Headline</th><th>Coupon</th><th>Sales</th><th>Featured</th><th>Status</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="c in data.calendar" :key="c.name" :class="{ off: c.status === 'Closed' }" :data-testid="`calendar-${c.name}`">
              <td><button class="link" @click="startCalendar(c)">{{ fmtMonth(c.month) }}</button><div class="label label-dim">{{ c.title }}</div></td>
              <td>{{ c.headline || '—' }}</td>
              <td class="mono">{{ c.coupon || '—' }}</td>
              <td class="label label-dim">{{ c.pricing_rules.map((r) => r.title || r.name).join(', ') || '—' }}</td>
              <td class="label label-dim">{{ c.featured_items.length ? `${c.featured_items.length} item${c.featured_items.length === 1 ? '' : 's'}` : '—' }}</td>
              <td>
                <span class="pill" :class="c.status === 'Sent' ? 'pill-good' : c.status === 'Active' ? 'pill-accent' : ''">{{ c.status }}</span>
                <div v-if="c.sent_on" class="label label-dim">{{ c.audience_size }} members · {{ c.sent_on.slice(0, 16) }}</div>
              </td>
              <td class="num">
                <div class="row" style="gap: 6px; justify-content: flex-end">
                  <button class="btn btn-ghost small" @click="startCalendar(c)">Edit</button>
                  <button v-if="c.status === 'Planned' || c.status === 'Active'" class="btn btn-primary small" :data-testid="`calendar-send-${c.name}`" @click="sending = c">Send now</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </section>
    </template>

    <!-- ============================================================ sheets -->
    <Modal v-if="tierEdit" :title="tierEdit.name ? 'Edit tier' : 'Add tier'" width="520px" @close="tierEdit = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="promo-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field"><label class="label" for="tr-points">Points</label><input id="tr-points" v-model.number="tierEdit.points" class="input" type="number" min="1" step="1" data-testid="tier-points" /></div>
        <div class="field"><label class="label" for="tr-amount">Worth ($ off)</label><input id="tr-amount" v-model.number="tierEdit.amount" class="input" type="number" min="0.01" step="0.01" data-testid="tier-amount" /></div>
        <div class="field span"><label class="label" for="tr-title">Title (blank = "$X off at N points")</label><input id="tr-title" v-model="tierEdit.title" class="input" /></div>
        <div class="field span"><label class="label" for="tr-desc">Description (optional)</label><input id="tr-desc" v-model="tierEdit.description" class="input" /></div>
        <div class="field span"><label class="label"><input v-model="tierEdit.enabled" type="checkbox" /> Offered at the till</label></div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="tierEdit = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy === 'tier'" data-testid="tier-save" @click="saveTier">{{ busy === 'tier' ? 'Saving…' : 'Save tier' }}</button>
      </template>
    </Modal>

    <Modal v-if="couponEdit" :title="couponEdit.creating ? 'New coupon' : `Coupon ${couponEdit.draft.code}`" width="640px" @close="couponEdit = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="promo-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field">
          <label class="label" for="cp-code">Code</label>
          <input id="cp-code" v-model="couponEdit.draft.code" class="input mono" :disabled="!couponEdit.creating" placeholder="OUD20" data-testid="coupon-code" />
          <div v-if="!couponEdit.creating" class="label label-dim">A code never changes — make a new coupon instead.</div>
        </div>
        <div class="field"><label class="label" for="cp-title">Title (on the receipt)</label><input id="cp-title" v-model="couponEdit.draft.title" class="input" data-testid="coupon-title" /></div>
        <div class="field">
          <label class="label" for="cp-type">Discount</label>
          <div class="row" style="gap: 8px">
            <select id="cp-type" v-model="couponEdit.draft.discount_type" class="input" style="max-width: 140px">
              <option>Percent</option>
              <option>Amount</option>
            </select>
            <input v-model.number="couponEdit.draft.value" class="input" type="number" min="0" step="0.01" data-testid="coupon-value" />
          </div>
        </div>
        <div class="field"><label class="label" for="cp-min">Minimum basket ($, blank = none)</label><input id="cp-min" v-model.number="couponEdit.draft.min_basket" class="input" type="number" min="0" step="1" /></div>
        <div class="field">
          <label class="label" for="cp-usage">Usage</label>
          <select id="cp-usage" v-model="couponEdit.draft.usage" class="input">
            <option>Multi-use</option>
            <option>Single-use</option>
          </select>
        </div>
        <div class="field"><label class="label" for="cp-max">Maximum uses (blank = unlimited)</label><input id="cp-max" v-model.number="couponEdit.draft.max_uses" class="input" type="number" min="0" step="1" :disabled="couponEdit.draft.usage === 'Single-use'" /></div>
        <div class="field">
          <label class="label" for="cp-store">Store</label>
          <select id="cp-store" v-model="couponEdit.draft.boutique" class="input">
            <option value="">Every store</option>
            <option v-for="s in stores" :key="s.code" :value="s.code">{{ s.boutique_name }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="cp-group">Only on (item group)</label>
          <select id="cp-group" v-model="couponEdit.draft.item_group" class="input">
            <option value="">Anything</option>
            <option v-for="g in data?.item_groups || []" :key="g" :value="g">{{ g }}</option>
          </select>
        </div>
        <div class="field"><label class="label" for="cp-from">Valid from</label><input id="cp-from" v-model="couponEdit.draft.valid_from" class="input" type="date" /></div>
        <div class="field"><label class="label" for="cp-upto">Valid until</label><input id="cp-upto" v-model="couponEdit.draft.valid_upto" class="input" type="date" /></div>
        <div class="field span"><label class="label"><input v-model="couponEdit.draft.enabled" type="checkbox" /> Switched on</label></div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="couponEdit = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy === 'coupon'" data-testid="coupon-save" @click="saveCoupon">{{ busy === 'coupon' ? 'Saving…' : couponEdit.creating ? 'Create coupon' : 'Save coupon' }}</button>
      </template>
    </Modal>

    <Modal v-if="giveawayEdit" :title="giveawayEdit.name ? 'Edit giveaway' : 'New giveaway'" width="640px" @close="giveawayEdit = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="promo-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field span"><label class="label" for="gv-title">Title</label><input id="gv-title" v-model="giveawayEdit.title" class="input" placeholder="Win a 100 ml Royal Oud" data-testid="giveaway-title" /></div>
        <div class="field span"><label class="label" for="gv-prize">Prize</label><input id="gv-prize" v-model="giveawayEdit.prize_description" class="input" data-testid="giveaway-prize" /></div>
        <div class="field"><label class="label" for="gv-start">Starts</label><input id="gv-start" v-model="giveawayEdit.start_date" class="input" type="date" data-testid="giveaway-start" /></div>
        <div class="field"><label class="label" for="gv-end">Ends</label><input id="gv-end" v-model="giveawayEdit.end_date" class="input" type="date" data-testid="giveaway-end" /></div>
        <div class="field">
          <label class="label" for="gv-store">Store</label>
          <select id="gv-store" v-model="giveawayEdit.boutique" class="input">
            <option value="">Every store</option>
            <option v-for="s in stores" :key="s.code" :value="s.code">{{ s.boutique_name }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="gv-status">Status</label>
          <select id="gv-status" v-model="giveawayEdit.status" class="input" data-testid="giveaway-status">
            <option value="Draft">Draft — not yet collecting entries</option>
            <option value="Open">Open — receipts earn entries</option>
            <option value="Closed">Closed — no more entries</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="gv-rule">Entries</label>
          <select id="gv-rule" v-model="giveawayEdit.entry_rule" class="input">
            <option>Per amount</option>
            <option>Per visit</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="gv-per">$ per entry · max per receipt</label>
          <div class="row" style="gap: 8px">
            <input id="gv-per" v-model.number="giveawayEdit.amount_per_entry" class="input" type="number" min="1" step="1" :disabled="giveawayEdit.entry_rule === 'Per visit'" />
            <input v-model.number="giveawayEdit.max_entries_per_invoice" class="input" type="number" min="0" step="1" />
          </div>
        </div>
        <div class="field span"><label class="label"><input v-model="giveawayEdit.requires_member" type="checkbox" /> Members only (a receipt without a member earns nothing)</label></div>
        <div class="field span"><label class="label" for="gv-desc">Description (shown on /rewards)</label><input id="gv-desc" v-model="giveawayEdit.description" class="input" /></div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="giveawayEdit = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy === 'giveaway'" data-testid="giveaway-save" @click="saveGiveaway">{{ busy === 'giveaway' ? 'Saving…' : 'Save giveaway' }}</button>
      </template>
    </Modal>

    <Modal v-if="drawing" :title="`Draw ${drawing.title}?`" width="480px" @close="drawing = null">
      <p class="muted">{{ drawing.entries }} entries from {{ drawing.participants }} people. The draw is seeded and recorded; it cannot be re-run. The winner is notified by e-mail.</p>
      <template #footer>
        <button class="btn btn-ghost" @click="drawing = null">Not yet</button>
        <button class="btn btn-primary" :disabled="busy === 'draw'" data-testid="giveaway-draw-confirm" @click="confirmDraw">{{ busy === 'draw' ? 'Drawing…' : 'Draw the winner' }}</button>
      </template>
    </Modal>

    <Modal v-if="promoEdit" :title="promoEdit.name ? 'Edit sale' : 'New sale'" width="640px" @close="promoEdit = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="promo-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field span"><label class="label" for="pr-title">Name (the till shows it on the line)</label><input id="pr-title" v-model="promoEdit.title" class="input" placeholder="Gift sets 15% off" data-testid="promo-title" /></div>
        <div class="field">
          <label class="label" for="pr-kind">Deal</label>
          <div class="row" style="gap: 8px">
            <select id="pr-kind" v-model="promoEdit.kind" class="input" style="max-width: 150px" data-testid="promo-kind">
              <option value="percent">% off</option>
              <option value="amount">$ off</option>
              <option value="rate">Fixed price</option>
            </select>
            <input v-model.number="promoEdit.value" class="input" type="number" min="0" step="0.01" data-testid="promo-value" />
          </div>
        </div>
        <div class="field">
          <label class="label" for="pr-on">Applies to</label>
          <select id="pr-on" v-model="promoEdit.apply_on" class="input" data-testid="promo-apply-on">
            <option value="Item Group">An item group</option>
            <option value="Item Code">Specific items</option>
            <option v-if="data?.brands.length" value="Brand">A brand</option>
            <option value="Transaction">The whole basket</option>
          </select>
        </div>
        <div v-if="promoEdit.apply_on === 'Item Group'" class="field span">
          <label class="label" for="pr-groups">Item groups (comma-separated)</label>
          <input id="pr-groups" v-model="promoEdit.targets" class="input" list="promo-groups" placeholder="Gift Sets, Body Sprays" data-testid="promo-targets" />
          <datalist id="promo-groups"><option v-for="g in data?.item_groups || []" :key="g" :value="g"></option></datalist>
        </div>
        <div v-else-if="promoEdit.apply_on === 'Item Code'" class="field span">
          <label class="label" for="pr-items">Item codes (comma-separated)</label>
          <input id="pr-items" v-model="promoEdit.targets" class="input mono" placeholder="SOA-0001, SOA-0002" data-testid="promo-targets" />
        </div>
        <div v-else-if="promoEdit.apply_on === 'Brand'" class="field span">
          <label class="label" for="pr-brands">Brands (comma-separated)</label>
          <input id="pr-brands" v-model="promoEdit.targets" class="input" list="promo-brands" data-testid="promo-targets" />
          <datalist id="promo-brands"><option v-for="b in data?.brands || []" :key="b" :value="b"></option></datalist>
        </div>
        <div class="field"><label class="label" for="pr-minq">From N units (blank = any)</label><input id="pr-minq" v-model.number="promoEdit.min_qty" class="input" type="number" min="0" step="1" :disabled="promoEdit.apply_on === 'Transaction'" /></div>
        <div class="field"><label class="label" for="pr-mina">Over $ (blank = any)</label><input id="pr-mina" v-model.number="promoEdit.min_amt" class="input" type="number" min="0" step="1" /></div>
        <div class="field"><label class="label" for="pr-from">Starts</label><input id="pr-from" v-model="promoEdit.valid_from" class="input" type="date" data-testid="promo-from" /></div>
        <div class="field"><label class="label" for="pr-upto">Ends (blank = until switched off)</label><input id="pr-upto" v-model="promoEdit.valid_upto" class="input" type="date" /></div>
        <div class="field">
          <label class="label" for="pr-store">Store</label>
          <select id="pr-store" v-model="promoEdit.boutique" class="input">
            <option value="">Every store</option>
            <option v-for="s in stores" :key="s.code" :value="s.code">{{ s.boutique_name }}</option>
          </select>
        </div>
        <div class="field"><label class="label"><input v-model="promoEdit.enabled" type="checkbox" /> Switched on</label></div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="promoEdit = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy === 'promotion'" data-testid="promo-save" @click="savePromotion">{{ busy === 'promotion' ? 'Saving…' : 'Save sale' }}</button>
      </template>
    </Modal>

    <Modal v-if="calEdit" :title="calEdit.name ? `Edit ${fmtMonth(calEdit.month + '-01')}` : 'Plan a month'" width="680px" @close="calEdit = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="promo-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field"><label class="label" for="cl-month">Month</label><input id="cl-month" v-model="calEdit.month" class="input" type="month" :disabled="!!calEdit.name" data-testid="calendar-month" /></div>
        <div class="field">
          <label class="label" for="cl-status">Status</label>
          <select id="cl-status" v-model="calEdit.status" class="input">
            <option value="Planned">Planned</option>
            <option value="Active">Active</option>
            <option v-if="calEdit.status === 'Sent'" value="Sent">Sent</option>
            <option value="Closed">Closed</option>
          </select>
        </div>
        <div class="field span"><label class="label" for="cl-title">Title</label><input id="cl-title" v-model="calEdit.title" class="input" placeholder="October 2026 promotions" /></div>
        <div class="field span"><label class="label" for="cl-head">Headline (the e-mail subject)</label><input id="cl-head" v-model="calEdit.headline" class="input" data-testid="calendar-headline" /></div>
        <div class="field span"><label class="label" for="cl-body">Body</label><textarea id="cl-body" v-model="calEdit.body" class="input" rows="4"></textarea></div>
        <div class="field">
          <label class="label" for="cl-coupon">Coupon</label>
          <select id="cl-coupon" v-model="calEdit.coupon" class="input">
            <option value="">None</option>
            <option v-for="c in coupons" :key="c.code" :value="c.code">{{ c.code }} — {{ c.title }}</option>
          </select>
        </div>
        <div class="field"><label class="label" for="cl-items">Featured item codes (comma-separated)</label><input id="cl-items" v-model="calEdit.items" class="input mono" /></div>
        <div class="field span">
          <div class="label">Sales switched on for the month</div>
          <div v-if="!promotions.length" class="label label-dim">No sales yet — make one under Sales first.</div>
          <div v-else class="checks">
            <label v-for="p in promotions" :key="p.name" class="label check"><input type="checkbox" :checked="calEdit.rules.includes(p.name)" @change="toggleRule(p.name)" /> {{ p.title }} <span class="label-dim">· {{ describePromotion(p, fmtMoney) }}</span></label>
          </div>
        </div>
        <div class="field span"><label class="label" for="cl-notes">Notes (internal)</label><input id="cl-notes" v-model="calEdit.notes" class="input" /></div>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="calEdit = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy === 'calendar'" data-testid="calendar-save" @click="saveCalendar">{{ busy === 'calendar' ? 'Saving…' : 'Save month' }}</button>
      </template>
    </Modal>

    <Modal v-if="sending" :title="`Send ${fmtMonth(sending.month)} now?`" width="480px" @close="sending = null">
      <p class="muted">Every member with an e-mail address gets it, the month's sales are switched on for the month, and it cannot be sent twice.</p>
      <template #footer>
        <button class="btn btn-ghost" @click="sending = null">Wait for the 1st</button>
        <button class="btn btn-primary" :disabled="busy === 'send'" data-testid="calendar-send-confirm" @click="confirmSend">{{ busy === 'send' ? 'Sending…' : 'Send to members' }}</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.board {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.subnav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.spacer {
  flex: 1;
}
.badge {
  margin-left: 6px;
  padding: 1px 7px;
  font-size: 11px;
  background: var(--accent);
  color: var(--ink-on-accent);
  border-radius: 10px;
}
.banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 16px;
  border: var(--line-w) solid var(--line);
}
.crit-banner {
  border-color: var(--crit);
  color: var(--crit);
}
.empty {
  padding: 40px 0;
}
.block {
  padding: 16px 20px;
}
tr.off td {
  color: var(--muted);
}
.link {
  background: none;
  border: 0;
  padding: 0;
  color: var(--text);
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}
.link:hover {
  color: var(--accent);
}
.mono {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 13px;
}
.form {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px 18px;
}
.form .span {
  grid-column: 1 / -1;
}
.checks {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 180px;
  overflow: auto;
}
.check {
  display: flex;
  gap: 8px;
  align-items: center;
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
textarea.input {
  resize: vertical;
}
@media (max-width: 640px) {
  .form {
    grid-template-columns: 1fr;
  }
}
</style>
