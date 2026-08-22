<script setup lang="ts">
/**
 * Enrolment sheet (associate-facing): phone OR email (required), optional name, lookup of an
 * existing client to link to, then hands over to the client-facing ConsentScreen.
 */
import { computed, onMounted, ref, watch } from 'vue'
import { api, type Customer } from '@/api'
import { db } from '@/db'
import { useRecognitionStore } from '@/stores/recognition'
import { useSyncStore } from '@/stores/sync'
import Modal from './Modal.vue'
import ConsentScreen from './ConsentScreen.vue'

const recognition = useRecognitionStore()
const sync = useSyncStore()
const draft = computed(() => recognition.enrolDraft)
const matches = ref<Customer[]>([])
const searching = ref(false)
let timer: number | undefined

const hasContact = computed(() => draft.value.phone.trim().replace(/\D/g, '').length >= 7 || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(draft.value.email.trim()))
const canContinue = computed(() => !!draft.value.customer || hasContact.value)

async function lookup() {
  const phone = draft.value.phone.trim().replace(/\D/g, '')
  const email = draft.value.email.trim().toLowerCase()
  if (draft.value.customer || (phone.length < 4 && email.length < 3)) {
    matches.value = []
    return
  }
  searching.value = true
  try {
    const q = email.length >= 3 ? email : phone
    let rows: Customer[] = []
    if (sync.online) {
      try {
        rows = await api.customers.search(q, 5)
      } catch {
        rows = []
      }
    }
    if (!rows.length) {
      const all = await db.customers.toArray()
      rows = all.filter((c) => (phone.length >= 4 && (c.mobile_no || '').replace(/\D/g, '').includes(phone)) || (email.length >= 3 && (c.email_id || '').toLowerCase().includes(email))).slice(0, 5)
    }
    matches.value = rows.filter((c) => !c.name.startsWith('PENDING-'))
  } finally {
    searching.value = false
  }
}

watch(() => [draft.value.phone, draft.value.email], () => {
  clearTimeout(timer)
  timer = window.setTimeout(lookup, 250)
})
onMounted(() => void lookup())

function link(c: Customer) {
  recognition.enrolDraft.customer = c
  recognition.enrolDraft.name = c.customer_name
  recognition.enrolDraft.phone = c.mobile_no || recognition.enrolDraft.phone
  recognition.enrolDraft.email = c.email_id || recognition.enrolDraft.email
  matches.value = []
}
function unlink() {
  recognition.enrolDraft.customer = null
  void lookup()
}
</script>

<template>
  <ConsentScreen v-if="recognition.enrolStep !== 'details'" />
  <Modal v-else title="Enrol client" width="520px" @close="recognition.closeEnrol()">
    <div class="stack" data-testid="enrol-sheet">
      <div class="muted intro">Phone or email finds an existing client or creates a new one. The client then reads and agrees to the consent on the next screen.</div>

      <div v-if="draft.customer" class="linked card">
        <div>
          <div class="linked-name">{{ draft.customer.customer_name }}</div>
          <div class="muted small"><span class="accent">{{ draft.customer.client_number }}</span> · {{ draft.customer.mobile_no || draft.customer.email_id || '—' }} · {{ draft.customer.tier }}</div>
          <div v-if="draft.customer.maison_face_consent" class="warn small">Already enrolled — continuing replaces the stored templates.</div>
        </div>
        <button class="label link" @click="unlink">Change</button>
      </div>
      <template v-else>
        <div class="row two">
          <div class="field" style="flex: 1">
            <label class="label" for="enrol-phone">Mobile</label>
            <input id="enrol-phone" v-model="draft.phone" class="input" inputmode="tel" autocomplete="off" placeholder="+1 312 555 0100" />
          </div>
          <div class="field" style="flex: 1">
            <label class="label" for="enrol-email">Email</label>
            <input id="enrol-email" v-model="draft.email" class="input" inputmode="email" autocomplete="off" placeholder="name@example.com" />
          </div>
        </div>
        <div class="field">
          <label class="label" for="enrol-name">Name <span class="dim">(optional)</span></label>
          <input id="enrol-name" v-model="draft.name" class="input" autocomplete="off" />
        </div>
        <div v-if="matches.length" class="matches">
          <div class="label label-dim">Existing client?</div>
          <button v-for="c in matches" :key="c.name" class="match" @click="link(c)">
            <span class="match-name">{{ c.customer_name }}</span>
            <span class="muted small">{{ c.client_number }} · {{ c.mobile_no || c.email_id }}</span>
            <span class="label accent">Link</span>
          </button>
        </div>
        <div v-else-if="searching" class="label label-dim">Searching</div>
      </template>

      <div v-if="!sync.online" class="warn small">Offline — the enrolment is saved on this device and synced with the next heartbeat.</div>
      <div v-if="recognition.enrolError" class="crit small">{{ recognition.enrolError }}</div>
    </div>
    <template #footer>
      <button class="btn" @click="recognition.closeEnrol()">Cancel</button>
      <button class="btn btn-primary" :disabled="!canContinue" data-testid="enrol-continue" @click="recognition.toConsent()">Continue to consent</button>
    </template>
  </Modal>
</template>

<style scoped>
.intro {
  font-size: 13px;
}
.small {
  font-size: 12px;
}
.two {
  align-items: flex-start;
}
.linked {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
}
.linked-name {
  font-size: 15px;
  font-weight: 500;
}
.link {
  min-width: 0;
  padding: 0 6px;
  color: var(--accent);
}
.matches {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.match {
  display: grid;
  grid-template-columns: 1fr auto;
  grid-template-rows: auto auto;
  column-gap: 12px;
  align-items: center;
  text-align: left;
  padding: 8px 12px;
  border: var(--line-w) solid var(--line);
  color: var(--text);
}
.match:hover {
  border-color: var(--accent);
}
.match-name {
  font-size: 14px;
  font-weight: 500;
}
.match .label {
  grid-row: 1 / span 2;
  grid-column: 2;
}
@media (max-width: 767px) {
  .two {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
