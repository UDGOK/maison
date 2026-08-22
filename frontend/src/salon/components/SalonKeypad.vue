<script setup lang="ts">
/** v0.5 K — large round keypad for the client (digits, optional @ / . for e-mail-free flows). */
defineProps<{ aux?: string; auxLabel?: string }>()
const emit = defineEmits<{ key: [k: string] }>()
const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9']
</script>

<template>
  <div class="s-keypad" data-testid="salon-keypad">
    <button v-for="k in keys" :key="k" class="s-key" type="button" @click="emit('key', k)">{{ k }}</button>
    <button class="s-key aux" type="button" @click="emit('key', aux || 'clear')">{{ auxLabel || 'Clear' }}</button>
    <button class="s-key" type="button" @click="emit('key', '0')">0</button>
    <button class="s-key aux" type="button" aria-label="Delete" @click="emit('key', 'back')">⌫</button>
  </div>
</template>
