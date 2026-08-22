<script setup lang="ts">
defineProps<{ title: string; width?: string }>()
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <div class="backdrop" @click.self="emit('close')">
      <div class="modal" :style="{ width: width || '520px' }" role="dialog" :aria-label="title">
        <div class="modal-head">
          <div class="section-title">{{ title }}</div>
          <button class="close label" @click="emit('close')">Close</button>
        </div>
        <div class="modal-body">
          <slot />
        </div>
        <div v-if="$slots.footer" class="modal-foot">
          <slot name="footer" />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(10, 20, 16, 0.82);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 50;
}
.modal {
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 48px);
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: var(--line-w) solid var(--line-strong);
}
.modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 8px 0 20px;
  height: 56px;
  border-bottom: var(--line-w) solid var(--line);
}
.close {
  padding: 0 12px;
}
.modal-body {
  padding: 20px;
  overflow: auto;
  min-height: 0;
}
.modal-foot {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  padding: 16px 20px;
  border-top: var(--line-w) solid var(--line);
}
</style>
