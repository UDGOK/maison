<script setup lang="ts">
/**
 * v0.6 P — one wall card: store code + name, items/units, live age timer (warn 4 h / crit 24 h),
 * carrier/service once chosen, ⚑ for low-stock / urgent, one primary tap action per column.
 */
import { computed } from 'vue'
import type { WallColumn } from '@/api/warehouse'
import { ageTier, fmtAge, isFlagged, liveAge, primaryAction, type WallCard } from '../wall'

const props = defineProps<{ card: WallCard; column: WallColumn; fetchedAt: number; now: number; warn: number; crit: number; flash?: boolean; busy?: boolean; compact?: boolean }>()
const emit = defineEmits<{ open: [card: WallCard]; action: [card: WallCard, action: ReturnType<typeof primaryAction>['action']] }>()

const age = computed(() => liveAge(props.card, props.fetchedAt, props.now))
const tier = computed(() => ageTier(age.value, props.warn, props.crit))
const action = computed(() => primaryAction(props.column))
const carrier = computed(() => ('carrier' in props.card && props.card.carrier ? `${props.card.carrier} ${props.card.service || ''}`.trim() : ''))
const tracking = computed(() => ('tracking_no' in props.card ? props.card.tracking_no : null))
</script>

<template>
  <div class="wcard" :class="[tier, { flash, flagged: isFlagged(card.priority), compact }]" :data-testid="`wall-card-${card.name}`" :data-tier="tier" role="button" tabindex="0" @click="emit('open', card)" @keydown.enter="emit('open', card)">
    <div class="top">
      <div class="code display">{{ card.boutique }}<span v-if="isFlagged(card.priority)" class="flag" :title="String(card.priority)">⚑</span></div>
      <div class="age num" :class="tier" :data-testid="`age-${card.name}`">{{ fmtAge(age) }}</div>
    </div>
    <div class="store ellipsis">{{ card.boutique_name || card.boutique }}</div>
    <div class="meta">
      <!-- v0.6 R: "1 items" / "1 units" read as a bug on a 55" board -->
      <span class="num">{{ card.items }} <span class="label label-dim">{{ card.items === 1 ? 'item' : 'items' }}</span></span>
      <span class="num">{{ card.units }} <span class="label label-dim">{{ card.units === 1 ? 'unit' : 'units' }}</span></span>
      <span v-if="carrier" class="carrier ellipsis">{{ carrier }}</span>
      <span v-else-if="card.kind === 'shipment'" class="label label-dim">{{ card.status }}</span>
    </div>
    <div class="bottom">
      <span class="label label-dim ellipsis">{{ card.name }}<span v-if="tracking"> · {{ tracking }}</span></span>
      <button v-if="action.action !== 'none'" class="btn act" :class="{ 'btn-primary': column !== 'pending_approval' }" :disabled="busy" :data-testid="`act-${card.name}`" @click.stop="emit('action', card, action.action)">
        {{ action.label }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.wcard {
  height: 100%;
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 14px 16px;
  background: var(--surface);
  border: var(--line-w) solid var(--line);
  border-left: 5px solid var(--line-strong);
  cursor: pointer;
  transition: border-color var(--t-base), background var(--t-base);
  user-select: none;
}
.wcard.warn {
  border-left-color: var(--warn);
}
.wcard.crit {
  border-left-color: var(--crit);
  background: rgba(196, 115, 106, 0.08);
}
.wcard.flagged .code {
  color: var(--accent);
}
.wcard.flash {
  animation: flash 0.6s ease-in-out 5;
}
@keyframes flash {
  0%,
  100% {
    background: var(--surface);
  }
  50% {
    background: var(--accent-soft);
    border-color: var(--accent);
  }
}
.top {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
}
.code {
  font-size: 26px;
  font-weight: 900;
  letter-spacing: 0.02em;
}
.flag {
  color: var(--accent);
  margin-left: 8px;
  font-size: 20px;
}
.age {
  font-size: 22px;
  font-weight: 500;
  color: var(--muted);
}
.age.warn {
  color: var(--warn);
}
.age.crit {
  color: var(--crit);
}
.store {
  font-size: 16px;
  color: var(--muted);
  /* The card is a fixed-height column flex box, so a text row with the default `flex-shrink: 1`
     gets squeezed below its own line box and `.ellipsis`'s `overflow: hidden` then cuts the
     descenders off ("CloudChaserz Sapulpa"). Never shrink the name row. */
  flex: 0 0 auto;
  line-height: 1.4;
  padding-bottom: 1px;
}
.meta {
  display: flex;
  gap: 16px;
  align-items: baseline;
  font-size: 20px;
  min-width: 0;
}
.carrier {
  font-size: 15px;
  color: var(--accent);
  min-width: 0;
}
.bottom {
  margin-top: auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
}
.act {
  min-height: 44px;
  padding: 0 18px;
  font-size: 15px;
}
.compact .code {
  font-size: 18px;
}
.compact .age {
  font-size: 15px;
}
.compact .meta {
  font-size: 15px;
  gap: 10px;
}
.compact .store {
  font-size: 13px;
}
.compact .act {
  min-height: 36px;
  font-size: 13px;
}
</style>
