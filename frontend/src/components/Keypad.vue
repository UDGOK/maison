<script setup lang="ts">
defineProps<{ decimal?: boolean }>()
const emit = defineEmits<{ key: [k: string] }>()
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
</script>

<template>
  <div class="keypad">
    <button v-for="k in keys" :key="k" class="key num" @click="emit('key', k)">{{ k }}</button>
    <button class="key num aux" @click="emit('key', decimal ? '.' : 'clear')">{{ decimal ? '.' : 'C' }}</button>
    <button class="key num" @click="emit('key', '0')">0</button>
    <button class="key num aux" @click="emit('key', 'back')" aria-label="Backspace">&larr;</button>
  </div>
</template>

<style scoped>
.keypad {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--line-w);
  background: var(--line);
  border: var(--line-w) solid var(--line);
}
.key {
  height: 64px;
  background: var(--surface);
  font-size: 22px;
  color: var(--text);
}
.key:active {
  background: var(--surface-2);
}
.aux {
  color: var(--muted);
  font-size: 18px;
}
</style>
