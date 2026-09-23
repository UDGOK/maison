<script lang="ts">
/**
 * v1.4 — **Staff** (the eighth section of the warehouse desk): everyone who works the chain,
 * by store, and the one sheet that adds a person, moves them, changes their role, resets a PIN or
 * a password, suspends or restores them.
 *
 * Three things this screen says out loud:
 *  · a generated password or PIN is shown **once**, right after the call that made it, in a box
 *    the operator copies from — the app never keeps it;
 *  · a login is **suspended, never deleted** — the sales and shifts that name the person stay;
 *  · a role above the operator's own rank is not offered (the server refuses it too).
 */
import type { Person } from '@/api/staff'

/** Store staff by store (warehouse first), chain roles at the end; seniors before juniors. */
export function groupStaff(people: Person[]): { title: string; people: Person[] }[] {
  const groups = new Map<string, Person[]>()
  for (const p of people) {
    const key = p.boutique_name || (p.role === 'HeadOffice' || p.role === 'Regional' ? 'Head office' : 'Unassigned')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(p)
  }
  const order = (title: string) => (title === 'Head office' ? 0 : title === 'Unassigned' ? 2 : 1)
  return [...groups.entries()].sort((a, b) => order(a[0]) - order(b[0]) || a[0].localeCompare(b[0])).map(([title, people]) => ({ title, people }))
}

export function lastSeen(p: Person): string {
  const t = p.last_active || p.last_login
  if (!t) return 'never signed in'
  return t.slice(0, 16).replace('T', ' ')
}
</script>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { staffApi, emptyStaffDraft, roleNeedsStore, validateStaffDraft, type StaffDraft, type StaffList, type StaffRole } from '@/api/staff'
import Modal from '@/components/Modal.vue'

const emit = defineEmits<{ (e: 'notice', msg: string): void }>()

const data = ref<StaffList | null>(null)
const loading = ref(false)
const error = ref('')
const q = ref('')
const storeFilter = ref('')
const includeSuspended = ref(true)

const adding = ref<StaffDraft | null>(null)
const editing = ref<Person | null>(null)
const edit = ref<{ first_name: string; last_name: string; role: StaffRole; boutique: string } | null>(null)
const formError = ref('')
const busy = ref<string | null>(null)
const suspending = ref<Person | null>(null)
const suspendReason = ref('')
/** Secrets shown once — cleared the moment the sheet closes. */
const reveal = ref<{ title: string; lines: { label: string; value: string }[]; note: string } | null>(null)

const people = computed(() => {
  const all = data.value?.staff || []
  const needle = q.value.trim().toLowerCase()
  return all.filter((p) => (includeSuspended.value || p.login_enabled) && (!storeFilter.value || p.boutique === storeFilter.value) && (!needle || `${p.full_name} ${p.user} ${p.boutique_name || ''} ${p.role_label}`.toLowerCase().includes(needle)))
})
const groups = computed(() => groupStaff(people.value))
const grantableRoles = computed(() => (data.value?.roles || []).filter((r) => r.grantable))
const storeOptions = computed(() => data.value?.stores || [])

async function load() {
  loading.value = true
  error.value = ''
  try {
    data.value = await staffApi.list(undefined, true)
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    loading.value = false
  }
}
onMounted(load)

function startAdd() {
  adding.value = emptyStaffDraft(storeFilter.value || '')
  formError.value = ''
}
function startEdit(p: Person) {
  editing.value = p
  edit.value = { first_name: p.first_name, last_name: p.last_name, role: (p.role || 'Associate') as StaffRole, boutique: p.boutique || '' }
  formError.value = ''
}
function closeSheets() {
  adding.value = null
  editing.value = null
  edit.value = null
  reveal.value = null
}

async function create() {
  if (!adding.value || !data.value) return
  const problem = validateStaffDraft(adding.value, data.value.roles, true)
  if (problem) {
    formError.value = problem
    return
  }
  busy.value = 'create'
  formError.value = ''
  try {
    const d = adding.value
    const out = await staffApi.create({
      first_name: d.first_name.trim(),
      last_name: d.last_name.trim(),
      email: d.email.trim().toLowerCase(),
      role: d.role,
      boutique: roleNeedsStore(d.role, data.value.roles) ? d.boutique : '',
      pin: d.pin.trim() || undefined,
      password: d.password.trim() || undefined
    })
    adding.value = null
    const lines = [{ label: 'Login', value: out.person.user }]
    if (out.initial_password) lines.push({ label: 'Temporary password', value: out.initial_password })
    if (out.pin) lines.push({ label: 'Till PIN', value: out.pin })
    reveal.value = {
      title: `${out.person.full_name} is on the team`,
      lines,
      note: `${out.person.role_label}${out.person.boutique_name ? ' at ' + out.person.boutique_name : ''}. ${out.initial_password || out.pin ? 'Hand these over now — they are shown once and kept nowhere.' : 'They sign in with the password you set.'}`
    }
    emit('notice', `${out.person.full_name} added`)
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}

async function save() {
  if (!editing.value || !edit.value || !data.value) return
  const draft: StaffDraft = { ...emptyStaffDraft(), ...edit.value, email: editing.value.user }
  const problem = validateStaffDraft(draft, data.value.roles, false)
  if (problem) {
    formError.value = problem
    return
  }
  busy.value = 'save'
  formError.value = ''
  try {
    const out = await staffApi.update(editing.value.user, {
      first_name: edit.value.first_name.trim(),
      last_name: edit.value.last_name.trim(),
      role: edit.value.role,
      boutique: roleNeedsStore(edit.value.role, data.value.roles) ? edit.value.boutique : ''
    })
    emit('notice', out.changed.length ? `${out.person.full_name} updated (${out.changed.join(', ')})` : `${out.person.full_name}: nothing changed`)
    closeSheets()
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}

async function resetPin() {
  if (!editing.value) return
  busy.value = 'pin'
  try {
    const out = await staffApi.resetPin(editing.value.user)
    reveal.value = { title: `New till PIN for ${out.person.full_name}`, lines: [{ label: 'Till PIN', value: out.pin || '' }], note: 'Shown once. The old PIN stops working now; any lockout is cleared.' }
    editing.value = null
    edit.value = null
    await load()
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function resetPassword() {
  if (!editing.value) return
  busy.value = 'password'
  try {
    const out = await staffApi.resetPassword(editing.value.user)
    reveal.value = { title: `Temporary password for ${out.person.full_name}`, lines: [{ label: 'Login', value: out.person.user }, { label: 'Temporary password', value: out.initial_password }], note: 'Shown once. Their open sessions are signed out; they change it after signing in.' }
    editing.value = null
    edit.value = null
  } catch (e) {
    formError.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function confirmSuspend() {
  if (!suspending.value) return
  busy.value = 'suspend'
  try {
    const out = await staffApi.suspend(suspending.value.user, suspendReason.value.trim() || undefined)
    emit('notice', `${out.person.full_name} is suspended — signed out everywhere, till locked`)
    suspending.value = null
    suspendReason.value = ''
    closeSheets()
    await load()
  } catch (e) {
    error.value = (e as Error).message
    suspending.value = null
  } finally {
    busy.value = null
  }
}
async function restore(p: Person) {
  busy.value = 'restore'
  try {
    const out = await staffApi.restore(p.user)
    emit('notice', `${out.person.full_name} is back`)
    closeSheets()
    await load()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = null
  }
}
async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    emit('notice', 'Copied')
  } catch {
    /* clipboard unavailable — the value is on screen */
  }
}
</script>

<template>
  <div class="board" data-testid="staff-board">
    <div class="bar">
      <input v-model="q" class="input search" placeholder="Search name, e-mail, store or role" data-testid="staff-search" />
      <select v-model="storeFilter" class="input store-filter" data-testid="staff-store-filter">
        <option value="">All stores</option>
        <option v-for="s in storeOptions" :key="s.code" :value="s.code">{{ s.name }}</option>
      </select>
      <div class="seg">
        <button class="chip" :class="{ active: !includeSuspended }" @click="includeSuspended = false">Active</button>
        <button class="chip" :class="{ active: includeSuspended }" @click="includeSuspended = true">All</button>
      </div>
      <div class="spacer"></div>
      <span v-if="data" class="label label-dim">{{ people.length }} of {{ data.count }}</span>
      <button class="btn btn-primary" data-testid="staff-add" @click="startAdd">Add staff</button>
    </div>

    <div v-if="error" class="banner crit-banner" data-testid="staff-error">
      <span>{{ error }}</span>
      <div class="row">
        <button class="btn btn-ghost" @click="load">Try again</button>
        <button class="btn btn-ghost" @click="error = ''">Dismiss</button>
      </div>
    </div>

    <div v-if="loading && !people.length" class="empty"><div class="label label-dim">Loading staff…</div></div>
    <div v-else-if="!people.length" class="empty" data-testid="staff-empty">
      <div class="display" style="font-size: 18px">{{ q || storeFilter ? 'Nobody matches that' : 'No staff yet' }}</div>
      <div class="muted">Add a person to a store — their login and till PIN are created with them.</div>
    </div>

    <div v-for="g in groups" v-else :key="g.title" class="group">
      <div class="group-title label">{{ g.title }} <span class="label-dim">· {{ g.people.length }}</span></div>
      <div class="tablewrap">
        <table class="table staff">
          <thead>
            <tr>
              <th>Name</th>
              <th>Login</th>
              <th>Role</th>
              <th>Till</th>
              <th>Last seen</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in g.people" :key="p.user" class="prow" :class="{ off: !p.login_enabled }" :data-testid="`staff-${p.user}`">
              <td>
                <div class="row" style="gap: 8px">
                  <button class="link" :data-testid="`open-staff-${p.user}`" @click="startEdit(p)">{{ p.full_name }}</button>
                  <span v-if="p.is_owner" class="pill">Owner</span>
                  <span v-if="!p.login_enabled" class="pill pill-crit">Suspended</span>
                </div>
              </td>
              <td><span class="mono">{{ p.user }}</span></td>
              <td>{{ p.role_label }}</td>
              <td>
                <span v-if="!p.pin_set" class="label label-dim">no PIN</span>
                <span v-else-if="p.pin_locked" class="pill pill-crit">Locked</span>
                <span v-else-if="p.till_enabled" class="pill pill-good">Ready</span>
                <span v-else class="label label-dim">off</span>
              </td>
              <td class="label label-dim">{{ lastSeen(p) }}</td>
              <td class="num">
                <div class="row" style="gap: 6px; justify-content: flex-end">
                  <button v-if="p.editable && !p.is_owner" class="btn btn-ghost small" @click="startEdit(p)">Manage</button>
                  <button v-if="!p.login_enabled && p.editable" class="btn btn-ghost small" :disabled="busy === 'restore'" :data-testid="`restore-${p.user}`" @click="restore(p)">Restore</button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Add -->
    <Modal v-if="adding && data" title="Add staff" width="640px" @close="adding = null">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="staff-form-error">{{ formError }}</div>
      <div class="form">
        <div class="field">
          <label class="label" for="sf-first">First name</label>
          <input id="sf-first" v-model="adding.first_name" class="input" data-testid="staff-first" />
        </div>
        <div class="field">
          <label class="label" for="sf-last">Last name</label>
          <input id="sf-last" v-model="adding.last_name" class="input" />
        </div>
        <div class="field span">
          <label class="label" for="sf-email">E-mail (this is their login)</label>
          <input id="sf-email" v-model="adding.email" class="input" inputmode="email" placeholder="name@example.com" data-testid="staff-email" />
        </div>
        <div class="field">
          <label class="label" for="sf-role">Role</label>
          <select id="sf-role" v-model="adding.role" class="input" data-testid="staff-role">
            <option v-for="r in grantableRoles" :key="r.key" :value="r.key">{{ r.label }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="sf-store">Store</label>
          <select id="sf-store" v-model="adding.boutique" class="input" :disabled="!roleNeedsStore(adding.role, data.roles)" data-testid="staff-store">
            <option value="">{{ roleNeedsStore(adding.role, data.roles) ? 'Choose a store' : 'Every store' }}</option>
            <option v-for="s in storeOptions" :key="s.code" :value="s.code">{{ s.name }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="sf-pin">Till PIN (4–6 digits, or blank to generate)</label>
          <input id="sf-pin" v-model="adding.pin" class="input mono" inputmode="numeric" maxlength="6" />
        </div>
        <div class="field">
          <label class="label" for="sf-pw">Password (blank to generate one)</label>
          <input id="sf-pw" v-model="adding.password" class="input" type="password" autocomplete="new-password" />
        </div>
      </div>
      <p class="muted note">A generated password and PIN are shown once after saving so you can hand them over; the person changes the password on first sign-in. Store staff see only their own store.</p>
      <template #footer>
        <button class="btn btn-ghost" @click="adding = null">Cancel</button>
        <button class="btn btn-primary" :disabled="busy === 'create'" data-testid="staff-save" @click="create">{{ busy === 'create' ? 'Adding…' : 'Add staff' }}</button>
      </template>
    </Modal>

    <!-- Manage -->
    <Modal v-if="editing && edit && data" :title="editing.full_name" width="640px" @close="closeSheets">
      <div v-if="formError" class="crit" style="margin-bottom: 12px" data-testid="staff-edit-error">{{ formError }}</div>
      <div class="label label-dim" style="margin-bottom: 12px">{{ editing.user }} · {{ editing.login_enabled ? 'login active' : 'suspended' }} · last seen {{ lastSeen(editing) }}</div>
      <div class="form">
        <div class="field">
          <label class="label" for="se-first">First name</label>
          <input id="se-first" v-model="edit.first_name" class="input" />
        </div>
        <div class="field">
          <label class="label" for="se-last">Last name</label>
          <input id="se-last" v-model="edit.last_name" class="input" />
        </div>
        <div class="field">
          <label class="label" for="se-role">Role</label>
          <select id="se-role" v-model="edit.role" class="input" data-testid="staff-edit-role">
            <option v-for="r in grantableRoles" :key="r.key" :value="r.key">{{ r.label }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label" for="se-store">Store</label>
          <select id="se-store" v-model="edit.boutique" class="input" :disabled="!roleNeedsStore(edit.role, data.roles)" data-testid="staff-edit-store">
            <option value="">{{ roleNeedsStore(edit.role, data.roles) ? 'Choose a store' : 'Every store' }}</option>
            <option v-for="s in storeOptions" :key="s.code" :value="s.code">{{ s.name }}</option>
          </select>
        </div>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" :disabled="busy !== null" data-testid="staff-reset-pin" @click="resetPin">{{ busy === 'pin' ? 'Working…' : 'New till PIN' }}</button>
        <button class="btn btn-ghost" :disabled="busy !== null" data-testid="staff-reset-password" @click="resetPassword">{{ busy === 'password' ? 'Working…' : 'Reset password' }}</button>
        <button v-if="editing.login_enabled" class="btn btn-ghost danger" :disabled="busy !== null" data-testid="staff-suspend" @click="suspending = editing">Suspend login</button>
        <button v-else class="btn btn-ghost" :disabled="busy !== null" @click="restore(editing)">Restore login</button>
      </div>
      <template #footer>
        <button class="btn btn-ghost" @click="closeSheets">Close</button>
        <button class="btn btn-primary" :disabled="busy === 'save'" data-testid="staff-edit-save" @click="save">{{ busy === 'save' ? 'Saving…' : 'Save changes' }}</button>
      </template>
    </Modal>

    <!-- Suspend -->
    <Modal v-if="suspending" :title="`Suspend ${suspending.full_name}?`" width="480px" @close="suspending = null">
      <p>They are signed out everywhere and the till stops accepting their PIN. Nothing is deleted — their sales and shifts stay, and you can restore them here.</p>
      <div class="field"><label class="label" for="se-reason">Reason (kept on their record)</label><input id="se-reason" v-model="suspendReason" class="input" /></div>
      <template #footer>
        <button class="btn btn-ghost" @click="suspending = null">Keep active</button>
        <button class="btn btn-primary" :disabled="busy === 'suspend'" data-testid="staff-suspend-confirm" @click="confirmSuspend">{{ busy === 'suspend' ? 'Suspending…' : 'Suspend' }}</button>
      </template>
    </Modal>

    <!-- Secrets, once -->
    <Modal v-if="reveal" :title="reveal.title" width="520px" @close="reveal = null">
      <div v-for="l in reveal.lines" :key="l.label" class="secret" :data-testid="`secret-${l.label.toLowerCase().replace(/\s+/g, '-')}`">
        <div class="label label-dim">{{ l.label }}</div>
        <div class="row" style="gap: 10px; align-items: center">
          <code class="secret-value">{{ l.value }}</code>
          <button class="btn btn-ghost small" @click="copy(l.value)">Copy</button>
        </div>
      </div>
      <p class="muted note">{{ reveal.note }}</p>
      <template #footer>
        <button class="btn btn-primary" data-testid="secret-done" @click="reveal = null">Done — I have handed these over</button>
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
.bar {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.search {
  max-width: 320px;
}
.store-filter {
  max-width: 240px;
}
.seg {
  display: flex;
  gap: 4px;
}
.spacer {
  flex: 1;
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
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 40px 0;
}
.group-title {
  margin-bottom: 8px;
}
.tablewrap {
  overflow-x: auto;
}
.prow.off td {
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
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 18px;
  padding-top: 14px;
  border-top: var(--line-w) solid var(--line);
}
.danger {
  color: var(--crit);
}
.btn.small {
  padding: 4px 10px;
  font-size: 12px;
}
.note {
  margin-top: 14px;
}
.secret {
  margin-bottom: 14px;
}
.secret-value {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 20px;
  letter-spacing: 0.08em;
  padding: 8px 12px;
  border: var(--line-w) solid var(--line-strong);
  color: var(--accent);
}
@media (max-width: 640px) {
  .form {
    grid-template-columns: 1fr;
  }
}
</style>
