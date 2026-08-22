<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useCatalogStore } from '@/stores/catalog'
import { useSyncStore } from '@/stores/sync'
import { IS_MOCK } from '@/api'
import Keypad from '@/components/Keypad.vue'

const session = useSessionStore()
const catalog = useCatalogStore()
const sync = useSyncStore()
const router = useRouter()
const route = useRoute()

const selectedBoutique = ref<string>(session.boutique?.name || '')
const selectedAssociate = ref<string>('')
const pin = ref('')
const error = ref('')
const busy = ref(false)
const shake = ref(false)

const needsBootstrap = computed(() => !session.boutique || session.boutique.name !== selectedBoutique.value || !catalog.loaded)

onMounted(async () => {
  await session.loadBoutiques()
  if (!selectedBoutique.value && session.boutiqueList.length) selectedBoutique.value = session.boutiqueList[0].name
  if (session.associates.length) selectedAssociate.value = session.associates[0].name
})

async function chooseBoutique() {
  error.value = ''
  busy.value = true
  const ok = await catalog.bootstrap(selectedBoutique.value)
  busy.value = false
  if (!ok) {
    error.value = catalog.error || 'Could not load boutique'
    return
  }
  selectedAssociate.value = session.associates[0]?.name || ''
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
        <div class="wordmark display-900">MAISON</div>
        <div class="label">Point of sale</div>
      </div>
      <div class="left-foot">
        <div class="label label-dim">{{ sync.browserOnline ? 'Network available' : 'No network' }}</div>
        <div v-if="IS_MOCK" class="label label-dim">Mock data &middot; PIN 1234 (manager) / 1111 (associate)</div>
      </div>
    </div>

    <div class="right">
      <div class="panel">
        <div class="field">
          <label class="label">Boutique</label>
          <div class="row">
            <select v-model="selectedBoutique" class="input" :disabled="busy">
              <option v-for="b in session.boutiqueList" :key="b.name" :value="b.name">{{ b.boutique_name }} &mdash; {{ b.city }}</option>
              <option v-if="!session.boutiqueList.length && session.boutique" :value="session.boutique.name">{{ session.boutique.boutique_name }}</option>
            </select>
            <button v-if="needsBootstrap" class="btn btn-primary" :disabled="busy || !selectedBoutique" @click="chooseBoutique">
              {{ busy ? 'Loading' : 'Load' }}
            </button>
          </div>
        </div>

        <template v-if="!needsBootstrap">
          <div class="field">
            <label class="label">Associate</label>
            <select v-model="selectedAssociate" class="input">
              <option v-for="a in session.associates" :key="a.name" :value="a.name">{{ a.full_name }} &middot; {{ a.role }}</option>
            </select>
          </div>

          <div class="field">
            <label class="label">PIN</label>
            <div class="pin" :class="{ shake }">
              <span v-for="i in 6" :key="i" class="pin-dot" :class="{ on: i <= pin.length, idle: i > 4 && pin.length < 4 }"></span>
            </div>
          </div>
          <Keypad @key="key" />
          <div class="msg crit" :class="{ hidden: !error }">{{ error || 'placeholder' }}</div>
        </template>
        <div v-else class="hint muted">Load the boutique catalog to unlock. Once loaded, unlock works offline.</div>
        <div v-if="error && needsBootstrap" class="msg crit">{{ error }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.unlock {
  height: 100%;
  display: grid;
  grid-template-columns: 1fr 480px;
}
.left {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  padding: 48px 56px;
  border-right: var(--line-w) solid var(--line);
  background: var(--ground);
}
.brand .wordmark {
  font-size: 64px;
  letter-spacing: 0.3em;
  line-height: 1;
}
.brand .label {
  margin-top: 20px;
}
.left-foot {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.right {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  overflow: auto;
}
.panel {
  width: 100%;
  max-width: 380px;
  display: flex;
  flex-direction: column;
  gap: 20px;
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
    flex-direction: row;
    align-items: center;
    padding: calc(16px + var(--safe-top)) 20px 16px;
    border-right: 0;
    border-bottom: var(--line-w) solid var(--line);
  }
  .brand .wordmark {
    font-size: 28px;
  }
  .brand .label {
    margin-top: 6px;
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
  }
}
</style>
