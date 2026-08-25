<script lang="ts">
/**
 * v1.2 §C + §D — **Prices**, the sixth section of the warehouse desk.
 *
 *   Approvals — head office's queue of shelf-price changes (§D). The default board, because it is
 *               the daily job: a store asks, somebody decides, and until they do the shop is still
 *               selling at the old price.
 *   Statement — what each store owes for a period (§C). Month end.
 *   Wholesale — the chain-wide markup and the per-item overrides that beat it (§A).
 *
 * Every board here is **warehouse admin / head office**. There is no store-facing view of any of
 * it, by design: it all shows or derives from what Houston paid for its stock.
 *
 * The two ways into an item's price board (§D) both land on `PriceBoardSheet`: from Stock → an
 * item → *Prices*, and from a queued request or a wholesale row here.
 */
export type PricesTab = 'approvals' | 'statement' | 'wholesale'

export const PRICES_TABS: { key: PricesTab; label: string }[] = [
  { key: 'approvals', label: 'Approvals' },
  { key: 'statement', label: 'Statement' },
  { key: 'wholesale', label: 'Wholesale' }
]
</script>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import ApprovalsBoard from './ApprovalsBoard.vue'
import StatementBoard from './StatementBoard.vue'
import WholesaleBoard from './WholesaleBoard.vue'
import PriceBoardSheet from './PriceBoardSheet.vue'
import { usePricingStore } from '@/stores/pricing'

const props = withDefaults(defineProps<{ sub?: PricesTab }>(), { sub: 'approvals' })
const emit = defineEmits<{ notice: [msg: string] }>()

const pricing = usePricingStore()

const tab = ref<PricesTab>(props.sub)
/** the item whose shelf-price board is open */
const pricingItem = ref<string | null>(null)

const waiting = computed(() => pricing.pendingCount)

watch(() => props.sub, (s) => (tab.value = s))

function say(msg: string) {
  if (msg) emit('notice', msg)
}
/** The board raised a request; the queue underneath it is now one longer. */
async function onChanged() {
  await pricing.loadRequests({ status: 'Pending Approval' })
}

onMounted(async () => {
  await pricing.loadSettings()
  if (tab.value !== 'approvals') await pricing.loadRequests({ status: 'Pending Approval' })
})
</script>

<template>
  <div class="prices" data-testid="prices-board">
    <nav class="subnav" aria-label="Prices boards">
      <button v-for="t in PRICES_TABS" :key="t.key" class="chip" :class="{ active: tab === t.key }" :data-testid="`prices-tab-${t.key}`" @click="tab = t.key">
        {{ t.label }}
        <span v-if="t.key === 'approvals' && waiting" class="count">{{ waiting }}</span>
      </button>
      <div class="spacer"></div>
      <span class="label label-dim">Head office and the warehouse only — none of this is shop-floor information.</span>
    </nav>

    <ApprovalsBoard v-if="tab === 'approvals'" @notice="say" @open-item="pricingItem = $event" />
    <StatementBoard v-else-if="tab === 'statement'" @notice="say" />
    <WholesaleBoard v-else @notice="say" @open-item="pricingItem = $event" />

    <PriceBoardSheet v-if="pricingItem" :item-code="pricingItem" @close="pricingItem = null" @notice="say" @changed="onChanged" />
  </div>
</template>

<style scoped>
.prices {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.subnav {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.count {
  margin-left: 8px;
  opacity: 0.75;
}
.spacer {
  flex: 1;
}
.subnav .label {
  text-transform: none;
  letter-spacing: 0.03em;
  font-size: 12px;
}
@media (max-width: 767px) {
  .subnav .label {
    flex: 1 1 100%;
  }
}
</style>
