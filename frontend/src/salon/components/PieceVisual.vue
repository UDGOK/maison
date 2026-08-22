<script setup lang="ts">
/**
 * v0.5 K — a piece shown large: the product image when there is one, otherwise a generated visual
 * (concentric gold rings with the metal/stone line) so the Salon never shows a broken image.
 */
import { computed } from 'vue'

const props = defineProps<{ image?: string | null; name: string; code?: string; metal?: string | null; stones?: string | null; size?: 'lg' | 'xl' }>()
const initials = computed(() =>
  props.name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase()
)
</script>

<template>
  <div class="piece" :class="size || 'lg'">
    <img v-if="image" :src="image" :alt="name" draggable="false" />
    <div v-else class="gen" aria-hidden="true">
      <div class="ring r1"></div>
      <div class="ring r2"></div>
      <div class="ring r3"></div>
      <div class="ini">{{ initials }}</div>
    </div>
    <div class="halo"></div>
  </div>
</template>

<style scoped>
.piece {
  position: relative;
  width: min(62vmin, 520px);
  aspect-ratio: 4 / 3;
  display: grid;
  place-items: center;
  overflow: visible;
}
.piece.xl {
  width: min(70vmin, 640px);
}
img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  position: relative;
  z-index: 1;
  /* product visuals often sit on their own dark plate: lighten-blend + feathered edges so the piece floats */
  mix-blend-mode: lighten;
  -webkit-mask-image: radial-gradient(ellipse at center, #000 52%, rgba(0, 0, 0, 0.85) 64%, transparent 82%);
  mask-image: radial-gradient(ellipse at center, #000 52%, rgba(0, 0, 0, 0.85) 64%, transparent 82%);
}
.halo {
  position: absolute;
  inset: -10%;
  background: radial-gradient(closest-side, rgba(201, 169, 110, 0.16), rgba(201, 169, 110, 0) 70%);
  z-index: 0;
}
.gen {
  position: relative;
  z-index: 1;
  width: 64%;
  aspect-ratio: 1;
  display: grid;
  place-items: center;
}
.ring {
  position: absolute;
  inset: 0;
  border-radius: 50%;
  border: 1px solid var(--s-gold);
}
.r1 {
  opacity: 0.7;
}
.r2 {
  inset: 16%;
  opacity: 0.45;
  border-width: 1px;
}
.r3 {
  inset: 34%;
  opacity: 0.25;
}
.ini {
  font-family: var(--font-display);
  font-weight: 300;
  letter-spacing: 0.1em;
  font-size: clamp(34px, 6vmin, 72px);
  color: var(--s-gold-2);
}
</style>
