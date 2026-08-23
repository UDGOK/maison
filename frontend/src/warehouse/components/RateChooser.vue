<script setup lang="ts">
/**
 * v0.6 P — rate shopping: cheapest pre-selected, "fastest" toggle, admin can tap any row to override.
 */
import { computed, ref, watch } from 'vue'
import type { Rate } from '@/api/warehouse'
import { rateRows, selectRate, type Prefer } from '../wall'
import { fmtMoney } from '@/utils/money'

const props = defineProps<{ rates: Rate[]; prefer: Prefer; provider?: string; testMode?: boolean; disabled?: boolean }>()
const emit = defineEmits<{ 'update:prefer': [p: Prefer]; select: [r: Rate | null] }>()

const selected = ref<string | null>(null)
const rows = computed(() => rateRows(props.rates))
const auto = computed(() => selectRate(props.rates, props.prefer))

function resetToAuto() {
  selected.value = auto.value?.provider_rate_id || null
  emit('select', auto.value)
}
watch(() => [props.rates, props.prefer], resetToAuto, { immediate: true, deep: true })

function choose(r: Rate) {
  selected.value = r.provider_rate_id
  emit('select', r)
}
</script>

<template>
  <div class="rates" data-testid="rate-chooser">
    <div class="between" style="margin-bottom: 10px">
      <div class="label label-dim">
        {{ rates.length }} rates · {{ provider || 'simulated' }}<span v-if="testMode"> · test mode</span>
      </div>
      <div class="seg">
        <button class="chip" :class="{ active: prefer === 'cheapest' }" :disabled="disabled" data-testid="prefer-cheapest" @click="emit('update:prefer', 'cheapest')">Cheapest</button>
        <button class="chip" :class="{ active: prefer === 'fastest' }" :disabled="disabled" data-testid="prefer-fastest" @click="emit('update:prefer', 'fastest')">Fastest</button>
      </div>
    </div>
    <div v-if="!rows.length" class="muted" style="padding: 12px 0">No rates yet.</div>
    <button
      v-for="r in rows"
      :key="r.provider_rate_id"
      class="rate"
      :class="{ selected: r.provider_rate_id === selected }"
      :disabled="disabled"
      :data-testid="`rate-${r.provider_rate_id}`"
      :data-selected="r.provider_rate_id === selected ? '1' : '0'"
      @click="choose(r)"
    >
      <span class="radio" aria-hidden="true"></span>
      <span class="carrier">
        <span class="name">{{ r.carrier }} <span class="muted">{{ r.service }}</span></span>
        <span class="meta label label-dim">{{ r.days != null ? `${r.days} business day${r.days === 1 ? '' : 's'}` : 'transit n/a' }}<span v-for="b in r.badges" :key="b" class="badge-txt"> · {{ b }}</span></span>
      </span>
      <span class="amount num">{{ fmtMoney(r.amount, r.currency || 'USD') }}</span>
    </button>
  </div>
</template>

<style scoped>
.seg {
  display: flex;
  gap: 4px;
}
.rate {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  border: var(--line-w) solid var(--line);
  background: var(--surface-2);
  text-align: left;
  margin-bottom: 6px;
  min-height: 56px;
}
.rate.selected {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.radio {
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 2px solid var(--line-strong);
  flex: 0 0 auto;
}
.rate.selected .radio {
  border-color: var(--accent);
  background: var(--accent);
  box-shadow: inset 0 0 0 3px var(--surface-2);
}
.carrier {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.name {
  font-weight: 500;
  font-size: 16px;
}
.amount {
  font-size: 20px;
  font-weight: 500;
}
.badge-txt {
  color: var(--accent);
}
</style>
