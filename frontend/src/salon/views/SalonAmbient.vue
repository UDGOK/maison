<script setup lang="ts">
/**
 * v0.5 K — ambient: wordmark, the hour, a welcome line, and curated pieces that float in and out
 * (HQ-managed Maison Salon Playlist). Pieces rotate on their own `seconds`; reduced motion shows
 * them without drift.
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSalonStore } from '../store'
import PieceVisual from '../components/PieceVisual.vue'

const salon = useSalonStore()
const idx = ref(0)
let timer = 0
const piece = computed(() => salon.playlist[idx.value % Math.max(1, salon.playlist.length)] || null)
const date = computed(() => new Date(salon.now).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' }))
const time = computed(() => new Date(salon.now).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))

function schedule() {
  clearTimeout(timer)
  if (!salon.playlist.length) return
  timer = window.setTimeout(
    () => {
      idx.value = (idx.value + 1) % salon.playlist.length
      schedule()
    },
    (piece.value?.seconds || 12) * 1000
  )
}
onMounted(schedule)
onBeforeUnmount(() => clearTimeout(timer))
</script>

<template>
  <div class="salon-screen wide ambient" data-testid="salon-ambient">
    <div class="hour">
      <div class="s-num xl time">{{ time }}</div>
      <div class="s-eyebrow">{{ date }}</div>
    </div>
    <div class="s-rule"></div>
    <div class="welcome">{{ salon.welcomeLine }}</div>
    <div class="float">
      <Transition name="piece">
        <div v-if="piece" :key="piece.item_code" class="piece-card" data-testid="ambient-piece">
          <PieceVisual :image="piece.image" :name="piece.item_name" :code="piece.item_code" :metal="piece.metal" :stones="piece.stones" />
          <div class="piece-name">{{ piece.item_name }}</div>
          <div class="piece-caption">{{ piece.caption }}</div>
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
.ambient {
  gap: calc(var(--s-unit) * 1.2);
  height: 100%;
  justify-content: center;
}
.hour {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
}
.time {
  letter-spacing: 0.04em;
}
.welcome {
  font-size: clamp(20px, 2.8vmin, 34px);
  color: var(--s-muted);
  letter-spacing: 0.06em;
}
.float {
  position: relative;
  width: 100%;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.piece-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  animation: drift 14s ease-in-out infinite alternate;
}
.piece-card :deep(.piece) {
  width: min(46vmin, 420px);
}
.piece-name {
  font-family: var(--font-display);
  font-weight: 300;
  letter-spacing: 0.16em;
  text-transform: uppercase;
  font-size: clamp(14px, 1.8vmin, 22px);
  color: var(--s-gold-2);
}
.piece-caption {
  color: var(--s-muted);
  max-width: 34em;
  font-size: clamp(15px, 1.8vmin, 22px);
}
@keyframes drift {
  from {
    transform: translateY(-6px);
  }
  to {
    transform: translateY(6px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .piece-card {
    animation: none;
  }
}
@media (orientation: landscape) {
  .ambient {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: space-evenly;
    align-content: center;
  }
  .hour,
  .welcome {
    flex-basis: 100%;
  }
  .s-rule {
    display: none;
  }
  .float {
    flex: 0 0 auto;
    width: auto;
  }
  .piece-card :deep(.piece) {
    width: min(40vmin, 380px);
  }
}
</style>
