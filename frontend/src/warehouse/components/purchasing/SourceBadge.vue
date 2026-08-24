<script lang="ts">
/**
 * v1.0 "Procurement" — why an item is on the buying list (`purchasing/demand.py`):
 * **Low stock** (at or below its reorder level at HOU-WH) · **Store demand** (a replenishment the
 * warehouse cannot fill) · **Trending** (velocity up, cover under the horizon).
 *
 * The label, the tone and the `+N` for a row that came from more than one source all come from
 * `buying.ts::sourceBadge`; this component only paints them. Tones resolve to the Monolith Gold
 * tokens in `styles/tokens.css` — nothing here is a hard-coded colour.
 */
import type { BadgeTone } from '../../buying'

/** Tone → the token it paints with. Exported so a screen can label a legend the same way. */
export const TONE_TOKEN: Record<BadgeTone, string> = {
  crit: '--crit',
  warn: '--warn',
  good: '--good',
  accent: '--accent',
  muted: '--dim'
}
</script>

<script setup lang="ts">
import { computed } from 'vue'
import { sourceBadge } from '../../buying'

const props = defineProps<{ source?: string | null; sources?: string[] | null }>()

const badge = computed(() => sourceBadge(props.sources?.length ? props.sources : props.source || ''))
</script>

<template>
  <span class="src-badge" :class="`tone-${badge.tone}`" :title="badge.title || badge.label" data-testid="source-badge">
    <i class="dot" aria-hidden="true"></i><span class="txt">{{ badge.label }}</span>
  </span>
</template>

<style scoped>
.src-badge {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  height: 24px;
  padding: 0 9px;
  border: var(--line-w) solid var(--line-strong);
  font-family: var(--font-body);
  font-weight: 600;
  font-size: 10px;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--muted);
  white-space: nowrap;
}
.dot {
  flex: 0 0 6px;
  width: 6px;
  height: 6px;
  background: currentColor;
}
.tone-crit {
  color: var(--crit);
  border-color: var(--crit);
}
.tone-warn {
  color: var(--warn);
  border-color: var(--warn);
}
.tone-good {
  color: var(--good);
  border-color: var(--good);
}
.tone-accent {
  color: var(--accent);
  border-color: var(--accent);
}
.tone-muted {
  color: var(--dim);
  border-color: var(--line);
}
</style>
