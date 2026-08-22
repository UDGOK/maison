<script setup lang="ts">
/** v0.5 K — "Would you like an invitation to our next private viewing?" → Client Profile flag. */
import { useSalonStore } from '../store'

const salon = useSalonStore()
</script>

<template>
  <div class="salon-screen" data-testid="salon-invite">
    <template v-if="salon.inviteAnswer === null">
      <div class="s-eyebrow">{{ salon.feedbackDone ? 'Thank you' : 'One last thing' }}</div>
      <div class="s-title soft">Would you like an invitation to our next private viewing?</div>
      <p class="s-lead">A small evening at the boutique, new pieces before anyone else, by invitation only.</p>
      <div class="s-btn-row">
        <button class="s-btn ghost" type="button" data-testid="invite-no" :disabled="!salon.client || salon.busy" @click="salon.client ? salon.invite(0) : salon.dismiss()">No, thank you</button>
        <button class="s-btn primary" type="button" data-testid="invite-yes" :disabled="!salon.client || salon.busy" @click="salon.invite(1)">Yes, please</button>
      </div>
      <div v-if="!salon.client" class="s-small s-dim">Join the house at your next visit to receive invitations.</div>
    </template>
    <template v-else>
      <div class="s-eyebrow">{{ salon.inviteAnswer ? 'We will be in touch' : 'Thank you' }}</div>
      <div class="s-title soft">{{ salon.inviteAnswer ? 'You are on the list' : 'Until next time' }}</div>
      <button class="s-btn ghost" type="button" data-testid="invite-done" @click="salon.dismiss()">Done</button>
    </template>
  </div>
</template>
