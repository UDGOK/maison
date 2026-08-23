<script setup lang="ts">
/** v0.5 K — private feedback 1–5 (+ optional note) → Maison Feedback, HQ only. */
import { ref } from 'vue'
import { useSalonStore } from '../store'

const salon = useSalonStore()
const rating = ref(0)
const comment = ref('')
const labels = ['', 'Disappointing', 'Could be better', 'Good', 'Very good', 'Exceptional']

async function send() {
  if (!rating.value) return
  await salon.feedback(rating.value, comment.value.trim() || undefined)
}
</script>

<template>
  <div class="salon-screen" data-testid="salon-feedback">
    <div class="s-eyebrow">Private to the house</div>
    <div class="s-title soft">How was your visit today?</div>
    <p class="s-lead">Your answer goes only to {{ salon.brandName }}'s head office — never to the {{ salon.storeNoun.toLowerCase() }} floor, never published.</p>
    <div class="s-stars" role="radiogroup" aria-label="Rating">
      <button v-for="i in 5" :key="i" class="s-star" :class="{ on: i <= rating }" type="button" role="radio" :aria-checked="rating === i" :data-testid="`feedback-star-${i}`" @click="rating = i">★</button>
    </div>
    <div class="s-small s-gold label" data-testid="feedback-label">{{ labels[rating] || ' ' }}</div>
    <div class="s-field">
      <input v-model="comment" class="s-input" type="text" autocomplete="off" placeholder="Anything you would like us to know? (optional)" data-testid="feedback-comment" />
    </div>
    <div class="s-error">{{ salon.error }}</div>
    <div class="s-btn-row">
      <button class="s-btn ghost" type="button" @click="salon.setReceiptStage('invite')">Skip</button>
      <button class="s-btn primary" type="button" data-testid="feedback-send" :disabled="!rating || salon.busy" @click="send">Send</button>
    </div>
  </div>
</template>

<style scoped>
.label {
  min-height: 1.6em;
}
.s-gold {
  color: var(--s-gold-2);
}
</style>
