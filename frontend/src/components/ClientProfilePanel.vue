<script setup lang="ts">
/**
 * v0.4 B — clienteling panel for the Client screen: profile (sizes, preferences, dates, contact
 * flags), tier progress, wishlist (add from catalog / remove), owned pieces (serials), follow-ups
 * and a quick "log interaction" form. Loads `crm.profile`, caches the last payload in Dexie so
 * the panel still renders offline (read-only).
 */
import { computed, onMounted, ref, watch } from 'vue'
import { v04, type ClientProfile, type ClientProfileFields, type InteractionType } from '@/api/v04'
import type { Customer } from '@/api'
import { getSetting, setSetting } from '@/db'
import { useCatalogStore } from '@/stores/catalog'
import { useSessionStore } from '@/stores/session'
import { useSyncStore } from '@/stores/sync'
import { useCartStore } from '@/stores/cart'
import { useLoyaltyStore } from '@/stores/loyalty'
import { fmtMoney } from '@/utils/money'
import { fmtDate } from '@/utils/device'
import TierProgress from './TierProgress.vue'
import Modal from './Modal.vue'

const props = defineProps<{ customer: Customer }>()
const emit = defineEmits<{ tier: [tier: string | null] }>()

const catalog = useCatalogStore()
const session = useSessionStore()
const sync = useSyncStore()
const cart = useCartStore()
const loyaltyStore = useLoyaltyStore()

const profile = ref<ClientProfile | null>(null)
const loading = ref(false)
const error = ref('')
const cached = ref(false)
const tab = ref<'profile' | 'wishlist' | 'owned' | 'followups'>('profile')
const editing = ref(false)
const form = ref<ClientProfileFields>({})
const saving = ref(false)

const wishOpen = ref(false)
const wishQuery = ref('')
const wishNotes = ref('')
const logOpen = ref(false)
const logType = ref<InteractionType>('Note')
const logNote = ref('')
const logDate = ref('')
const busy = ref(false)

const METALS = ['', 'Yellow Gold', 'White Gold', 'Rose Gold', 'Platinum', 'Mixed']
const TIERS = computed(() => ['', ...(profile.value?.loyalty.tiers.map((t) => t.tier) || catalog.loyalty?.tiers.map((t) => t.tier) || [])])
const INTERACTIONS: InteractionType[] = ['Note', 'Call', 'Email', 'SMS', 'Visit', 'Follow-up']

const wishCandidates = computed(() => {
  const q = wishQuery.value.trim().toLowerCase()
  if (!q) return []
  return catalog.items.filter((i) => i.item_name.toLowerCase().includes(q) || i.item_code.toLowerCase().includes(q)).slice(0, 8)
})
const openWishes = computed(() => (profile.value?.wishlist || []).filter((w) => !w.fulfilled))
const doneWishes = computed(() => (profile.value?.wishlist || []).filter((w) => w.fulfilled))
const contactFlags = computed(() => {
  const p = profile.value?.profile
  if (!p) return []
  return [p.do_not_email && 'no email', p.do_not_sms && 'no SMS', p.do_not_phone && 'no calls'].filter(Boolean) as string[]
})

async function load(force = false) {
  loading.value = true
  error.value = ''
  const key = `profile:${props.customer.name}`
  try {
    if (window.__maisonOffline) throw Object.assign(new Error('offline'), { code: 'NETWORK' })
    profile.value = await v04.crm.profile(props.customer.name)
    cached.value = false
    await setSetting(key, JSON.parse(JSON.stringify(profile.value)))
    if (profile.value.loyalty) loyaltyStore.byCustomer[props.customer.name] = profile.value.loyalty
    emit('tier', profile.value.customer.tier)
  } catch (e) {
    const c = await getSetting<ClientProfile | null>(key, null)
    if (c) {
      profile.value = c
      cached.value = true
    } else if (!force) error.value = (e as Error).message || 'Could not load profile'
  } finally {
    loading.value = false
  }
}
onMounted(() => void load())
watch(() => props.customer.name, () => void load())

function startEdit() {
  form.value = { ...(profile.value?.profile || {}) }
  editing.value = true
}
async function saveProfile() {
  if (!profile.value) return
  saving.value = true
  error.value = ''
  try {
    const values: Partial<ClientProfileFields> = { ...form.value }
    delete values.preferred_associate_name
    if (!profile.value.can_edit_tier) delete values.vip_tier_override
    profile.value = { ...profile.value, ...(await v04.crm.update_profile(props.customer.name, values)) }
    await setSetting(`profile:${props.customer.name}`, JSON.parse(JSON.stringify(profile.value)))
    emit('tier', profile.value.customer.tier)
    editing.value = false
    sync.notify('good', 'Profile saved', props.customer.customer_name)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    saving.value = false
  }
}
async function addWish(item_code: string) {
  if (!profile.value) return
  busy.value = true
  try {
    const res = await v04.crm.wishlist_add(props.customer.name, item_code, wishNotes.value || undefined)
    profile.value.wishlist = res.wishlist
    wishOpen.value = false
    wishQuery.value = ''
    wishNotes.value = ''
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function removeWish(row: string) {
  if (!profile.value) return
  busy.value = true
  try {
    const res = await v04.crm.wishlist_remove(props.customer.name, undefined, row)
    profile.value.wishlist = res.wishlist
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
function addWishToBasket(item_code: string) {
  const item = catalog.byCode[item_code]
  if (!item) return
  if (item.has_serial_no) {
    const serial = (catalog.serials[item_code] || []).find((s) => !cart.usedSerials.has(s))
    if (!serial) {
      sync.notify('warn', 'No piece in stock here', item.item_name)
      return
    }
    cart.add(item, serial)
  } else cart.add(item)
  sync.notify('good', 'Added to basket', item.item_name)
}
async function logInteraction() {
  if (!profile.value || !logNote.value.trim()) return
  busy.value = true
  try {
    const row = await v04.crm.log_interaction({ customer: props.customer.name, type: logType.value, note: logNote.value.trim(), follow_up_date: logType.value === 'Follow-up' ? logDate.value || undefined : undefined })
    profile.value.interactions = [row, ...profile.value.interactions]
    if (row.follow_up_date && row.status === 'Open') profile.value.follow_ups = [...profile.value.follow_ups, row]
    logOpen.value = false
    logNote.value = ''
    logDate.value = ''
    sync.notify('good', row.follow_up_date ? 'Follow-up scheduled' : 'Logged', props.customer.customer_name)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
async function completeTask(name: string) {
  if (!profile.value) return
  busy.value = true
  try {
    await v04.crm.complete_task(name, 'Done')
    profile.value.follow_ups = profile.value.follow_ups.filter((t) => t.name !== name)
    profile.value.interactions = profile.value.interactions.map((i) => (i.name === name ? { ...i, status: 'Done' } : i))
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}
const dash = (v: unknown) => (v === null || v === undefined || v === '' ? '—' : String(v))
</script>

<template>
  <div class="cp" data-testid="client-profile">
    <div class="cp-tabs">
      <button v-for="t in ['profile', 'wishlist', 'owned', 'followups'] as const" :key="t" class="cp-tab label" :class="{ on: tab === t }" :data-testid="'cp-tab-' + t" @click="tab = t">
        {{ t === 'profile' ? 'Profile' : t === 'wishlist' ? `Wishlist${openWishes.length ? ' · ' + openWishes.length : ''}` : t === 'owned' ? `Pieces${profile?.owned_pieces.length ? ' · ' + profile.owned_pieces.length : ''}` : `Tasks${profile?.follow_ups.length ? ' · ' + profile.follow_ups.length : ''}` }}
      </button>
    </div>
    <div v-if="loading && !profile" class="label label-dim pad">Loading profile</div>
    <div v-else-if="error && !profile" class="crit small pad">{{ error }}</div>
    <template v-else-if="profile">
      <div v-if="cached" class="label label-dim pad-x">Cached · read-only offline</div>
      <div v-if="error" class="crit small pad-x">{{ error }}</div>

      <!-- PROFILE -->
      <div v-if="tab === 'profile'" class="cp-body scroll">
        <TierProgress :loyalty="profile.loyalty" :currency="session.currency" />
        <div v-if="profile.next_best_offer.length" class="nbo">
          <div class="label">Next best offer</div>
          <div v-for="o in profile.next_best_offer" :key="o.item_code" class="between small"><span>{{ o.item_name || o.item_code }}</span><span class="dim">{{ o.reason }}</span></div>
        </div>
        <template v-if="!editing">
          <dl class="facts">
            <dt>Ring</dt><dd>{{ dash(profile.profile.ring_size) }}</dd>
            <dt>Wrist</dt><dd>{{ profile.profile.wrist_size ? profile.profile.wrist_size + ' cm' : '—' }}</dd>
            <dt>Metal</dt><dd>{{ dash(profile.profile.metal_preference) }}</dd>
            <dt>Birthday</dt><dd>{{ profile.profile.birthday ? fmtDate(profile.profile.birthday) : '—' }}</dd>
            <dt>Anniversary</dt><dd>{{ profile.profile.anniversary ? fmtDate(profile.profile.anniversary) : '—' }}</dd>
            <dt>Partner</dt><dd>{{ dash(profile.profile.spouse_name) }}</dd>
            <dt>Associate</dt><dd>{{ dash(profile.profile.preferred_associate_name || profile.profile.preferred_associate) }}<span v-if="profile.profile.preferred_boutique" class="dim"> · {{ profile.profile.preferred_boutique }}</span></dd>
            <dt>Contact</dt><dd><span v-if="contactFlags.length" class="warn">{{ contactFlags.join(' · ') }}</span><span v-else class="dim">no restrictions</span></dd>
          </dl>
          <div v-if="profile.profile.style_notes" class="notes">{{ profile.profile.style_notes }}</div>
          <div class="row">
            <button class="btn" :disabled="cached" data-testid="cp-edit" @click="startEdit">Edit profile</button>
            <button class="btn" :disabled="cached" data-testid="cp-log" @click="logOpen = true">Log interaction</button>
          </div>
          <div v-if="profile.interactions.length" class="timeline">
            <div class="label">Recent</div>
            <div v-for="i in profile.interactions.slice(0, 6)" :key="i.name" class="trow-i">
              <span class="pill">{{ i.type }}</span>
              <span class="tnote ellipsis">{{ i.note }}</span>
              <span class="dim small">{{ i.ts ? fmtDate(i.ts) : '' }}</span>
            </div>
          </div>
        </template>
        <form v-else class="edit stack" @submit.prevent="saveProfile">
          <div class="row">
            <div class="field" style="flex: 1"><label class="label">Ring size</label><input v-model="form.ring_size" class="input" inputmode="decimal" /></div>
            <div class="field" style="flex: 1"><label class="label">Wrist (cm)</label><input v-model="form.wrist_size" class="input" inputmode="decimal" /></div>
          </div>
          <div class="field"><label class="label">Metal preference</label><select v-model="form.metal_preference" class="input"><option v-for="m in METALS" :key="m" :value="m">{{ m || '—' }}</option></select></div>
          <div class="row">
            <div class="field" style="flex: 1"><label class="label">Birthday</label><input v-model="form.birthday" class="input" type="date" /></div>
            <div class="field" style="flex: 1"><label class="label">Anniversary</label><input v-model="form.anniversary" class="input" type="date" /></div>
          </div>
          <div class="field"><label class="label">Partner</label><input v-model="form.spouse_name" class="input" /></div>
          <div class="field"><label class="label">Style notes</label><textarea v-model="form.style_notes" class="input" rows="3"></textarea></div>
          <div class="row flags">
            <label class="flag"><input v-model="form.do_not_email" type="checkbox" :true-value="1" :false-value="0" /> No email</label>
            <label class="flag"><input v-model="form.do_not_sms" type="checkbox" :true-value="1" :false-value="0" /> No SMS</label>
            <label class="flag"><input v-model="form.do_not_phone" type="checkbox" :true-value="1" :false-value="0" /> No calls</label>
          </div>
          <div v-if="profile.can_edit_tier" class="field"><label class="label">VIP tier override (manager)</label><select v-model="form.vip_tier_override" class="input"><option v-for="t in TIERS" :key="t" :value="t">{{ t || 'Use loyalty tier' }}</option></select></div>
          <div class="row">
            <button type="button" class="btn" @click="editing = false">Cancel</button>
            <button type="submit" class="btn btn-primary" :disabled="saving || !sync.online" data-testid="cp-save">{{ sync.online ? (saving ? 'Saving' : 'Save') : 'Online required' }}</button>
          </div>
        </form>
      </div>

      <!-- WISHLIST -->
      <div v-else-if="tab === 'wishlist'" class="cp-body scroll">
        <div v-if="!openWishes.length" class="label label-dim">Nothing on the wishlist</div>
        <div v-for="w in openWishes" :key="w.name" class="wrow" :data-testid="'wish-' + w.item_code">
          <div class="wmain">
            <div class="wname">{{ w.item_name }}</div>
            <div class="dim small">{{ w.item_code }}<span v-if="w.notes"> · {{ w.notes }}</span><span v-if="w.added_on"> · {{ fmtDate(w.added_on) }}</span></div>
            <div v-if="catalog.stock[w.item_code] || (catalog.serials[w.item_code] || []).length" class="good small">In stock here</div>
          </div>
          <div class="wacts">
            <button class="btn" :disabled="!catalog.byCode[w.item_code]" @click="addWishToBasket(w.item_code)">Basket</button>
            <button class="label crit rm" :disabled="cached || busy" @click="removeWish(w.name)">Remove</button>
          </div>
        </div>
        <div v-if="doneWishes.length" class="label label-dim" style="margin-top: 12px">Fulfilled</div>
        <div v-for="w in doneWishes" :key="w.name" class="wrow done">
          <div class="wmain"><div class="wname">{{ w.item_name }}</div><div class="dim small">{{ w.fulfilled_invoice }}<span v-if="w.fulfilled_on"> · {{ fmtDate(w.fulfilled_on) }}</span></div></div>
        </div>
        <button class="btn" :disabled="cached" data-testid="wish-add" @click="wishOpen = true">Add to wishlist</button>
      </div>

      <!-- OWNED PIECES -->
      <div v-else-if="tab === 'owned'" class="cp-body scroll">
        <div v-if="!profile.owned_pieces.length" class="label label-dim">No serialized pieces on record</div>
        <div v-for="o in profile.owned_pieces" :key="o.serial_no" class="wrow" :data-testid="'owned-' + o.serial_no">
          <div class="wmain">
            <div class="wname">{{ o.item_name }}</div>
            <div class="good small num">{{ o.serial_no }}</div>
            <div class="dim small">{{ o.date ? fmtDate(o.date) : '' }}<span v-if="o.boutique"> · {{ o.boutique }}</span><span v-if="o.metal"> · {{ o.metal }}</span><span v-if="o.certificate_no"> · {{ o.certificate_no }}</span></div>
          </div>
          <div class="num">{{ fmtMoney(o.rate, session.currency) }}</div>
        </div>
      </div>

      <!-- FOLLOW-UPS -->
      <div v-else class="cp-body scroll">
        <div v-if="!profile.follow_ups.length" class="label label-dim">No open follow-ups</div>
        <div v-for="t in profile.follow_ups" :key="t.name" class="wrow" :data-testid="'task-' + t.name">
          <div class="wmain">
            <div class="wname"><span class="pill pill-accent">{{ t.type }}</span> <span class="num" :class="{ warn: t.follow_up_date && t.follow_up_date <= new Date().toISOString().slice(0, 10) }">{{ t.follow_up_date ? fmtDate(t.follow_up_date) : '' }}</span></div>
            <div class="small">{{ t.note }}</div>
            <div v-if="t.crm_task" class="dim small">CRM task {{ t.crm_task }}</div>
          </div>
          <button class="btn" :disabled="cached || busy" @click="completeTask(t.name)">Done</button>
        </div>
        <button class="btn" :disabled="cached" @click="logType = 'Follow-up'; logOpen = true">New follow-up</button>
      </div>
    </template>

    <Modal v-if="wishOpen" title="Add to wishlist" width="480px" @close="wishOpen = false">
      <div class="stack">
        <input v-model="wishQuery" class="input" type="search" placeholder="Search the catalogue" autofocus data-testid="wish-search" />
        <input v-model="wishNotes" class="input" placeholder="Notes (size, occasion…)" />
        <div class="cands">
          <button v-for="i in wishCandidates" :key="i.item_code" class="cand between" :data-testid="'wish-cand-' + i.item_code" :disabled="busy" @click="addWish(i.item_code)">
            <span><span class="wname">{{ i.item_name }}</span><span class="dim small"> · {{ i.item_code }}</span></span>
            <span class="num">{{ fmtMoney(catalog.rateFor(i.item_code), session.currency) }}</span>
          </button>
          <div v-if="wishQuery && !wishCandidates.length" class="dim small">No match.</div>
        </div>
      </div>
    </Modal>

    <Modal v-if="logOpen" title="Log interaction" width="460px" @close="logOpen = false">
      <div class="stack">
        <div class="row chips">
          <button v-for="t in INTERACTIONS" :key="t" class="chip" :class="{ active: logType === t }" @click="logType = t">{{ t }}</button>
        </div>
        <textarea v-model="logNote" class="input" rows="3" placeholder="What happened / what to do next" data-testid="log-note"></textarea>
        <div v-if="logType === 'Follow-up'" class="field"><label class="label">Follow-up date</label><input v-model="logDate" class="input" type="date" /></div>
      </div>
      <template #footer>
        <button class="btn" @click="logOpen = false">Cancel</button>
        <button class="btn btn-primary" :disabled="busy || !logNote.trim() || !sync.online" data-testid="log-save" @click="logInteraction">Save</button>
      </template>
    </Modal>
  </div>
</template>

<style scoped>
.cp {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.cp-tabs {
  display: flex;
  border-bottom: var(--line-w) solid var(--line);
  overflow-x: auto;
  scrollbar-width: none;
}
.cp-tab {
  flex: 1 0 auto;
  min-height: 44px;
  padding: 0 10px;
  color: var(--dim);
  border-bottom: 2px solid transparent;
  white-space: nowrap;
  letter-spacing: 0.14em;
  font-size: 10px;
}
.cp-tab.on {
  color: var(--accent);
  border-bottom-color: var(--accent);
}
.cp-body {
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-height: 0;
  flex: 1;
}
.pad {
  padding: 16px 20px;
}
.pad-x {
  padding: 8px 20px 0;
}
.facts {
  display: grid;
  grid-template-columns: 96px 1fr;
  gap: 6px 12px;
  margin: 0;
  font-size: 14px;
}
.facts dt {
  font-size: 11px;
  letter-spacing: 0.25em;
  text-transform: uppercase;
  color: var(--dim);
  align-self: center;
}
.facts dd {
  margin: 0;
}
.notes {
  font-size: 14px;
  color: var(--muted);
  border-left: 2px solid var(--accent);
  padding-left: 12px;
  line-height: 1.5;
}
.nbo {
  padding: 10px 12px;
  background: var(--accent-soft);
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.timeline {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.trow-i {
  display: flex;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.tnote {
  flex: 1;
  min-width: 0;
}
.wrow {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  padding: 10px 0;
  border-bottom: var(--line-w) solid var(--line);
}
.wrow.done {
  opacity: 0.55;
}
.wmain {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.wname {
  font-size: 14px;
  font-weight: 500;
}
.wacts {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
}
.rm {
  min-height: 32px;
}
.small {
  font-size: 12px;
}
.flags {
  flex-wrap: wrap;
  gap: 14px;
}
.flag {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  min-height: 44px;
}
.cands {
  display: flex;
  flex-direction: column;
}
.cand {
  width: 100%;
  padding: 12px 10px;
  border-bottom: var(--line-w) solid var(--line);
  color: var(--text);
  text-align: left;
}
.cand:hover {
  background: var(--surface-2);
}
.chips {
  flex-wrap: wrap;
  gap: 8px;
}
</style>
