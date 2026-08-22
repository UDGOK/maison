<script setup lang="ts">
import { computed, ref } from 'vue'
import Modal from '@/components/Modal.vue'
import Keypad from '@/components/Keypad.vue'
import { useSessionStore } from '@/stores/session'

/** v0.4 E — manager approval for refunds over the threshold / outside the policy window. */
const props = defineProps<{ reason: string; busy?: boolean; error?: string }>()
const emit = defineEmits<{ close: []; approve: [manager: string, pin: string] }>()
const session = useSessionStore()
const managers = computed(() => session.associates.filter((a) => a.role !== 'Associate'))
const manager = ref(managers.value[0]?.name || '')
const pin = ref('')
function key(k: string) {
  if (k === 'clear') pin.value = ''
  else if (k === 'back') pin.value = pin.value.slice(0, -1)
  else if (pin.value.length < 6) pin.value += k
}
function approve() {
  if (!manager.value || pin.value.length < 4) return
  emit('approve', manager.value, pin.value)
  pin.value = ''
}
</script>

<template>
  <Modal title="Manager approval" width="420px" @close="emit('close')">
    <div class="stack" style="gap: 14px">
      <div class="muted" style="font-size: 13px">{{ props.reason }}</div>
      <div class="field">
        <label class="label">Manager</label>
        <select v-model="manager" class="input">
          <option v-for="m in managers" :key="m.name" :value="m.name">
            {{ m.full_name }} · {{ m.role }}
          </option>
        </select>
      </div>
      <div class="pin display" aria-label="PIN">
        <span v-for="i in 6" :key="i" class="dot" :class="{ on: i <= pin.length }"></span>
      </div>
      <Keypad @key="key" />
      <div v-if="props.error" class="crit" style="font-size: 13px">{{ props.error }}</div>
    </div>
    <template #footer>
      <button class="btn btn-ghost" @click="emit('close')">Cancel</button>
      <button class="btn btn-primary" :disabled="props.busy || pin.length < 4 || !manager" @click="approve">
        {{ props.busy ? 'Checking' : 'Approve' }}
      </button>
    </template>
  </Modal>
</template>

<style scoped>
.pin {
  display: flex;
  justify-content: center;
  gap: 14px;
  padding: 6px 0;
}
.dot {
  width: 12px;
  height: 12px;
  border: var(--line-w) solid var(--line-strong);
}
.dot.on {
  background: var(--accent);
  border-color: var(--accent);
}
</style>
