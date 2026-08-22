<script setup lang="ts">
/**
 * v0.4 I — "Promotions" chip for the basket: shows how many promos apply today (and the coupon
 * on the basket). Tapping opens a sheet with the active promotions, what is currently applied
 * to the basket, and the coupon entry (typed or scanned).
 */
import { computed, ref, watch } from 'vue'
import { usePromosStore } from '@/stores/promos'
import { useCartStore } from '@/stores/cart'
import { useSessionStore } from '@/stores/session'
import { useScanStore } from '@/stores/scan'
import { useCatalogStore } from '@/stores/catalog'
import { fmtMoney } from '@/utils/money'
import { promoLabel } from '@/utils/promos'
import Modal from './Modal.vue'

const promos = usePromosStore()
const cart = useCartStore()
const session = useSessionStore()
const scan = useScanStore()
const catalog = useCatalogStore()

const code = ref('')
const applying = ref(false)
const scanning = ref(false)

const chipText = computed(() => {
  const parts: string[] = []
  if (promos.liveCount) parts.push(`${promos.liveCount} promo${promos.liveCount === 1 ? '' : 's'}`)
  if (promos.coupon) parts.push(promos.coupon.code)
  return parts.length ? parts.join(' · ') : 'Promotions'
})
const totalSaved = computed(() => promos.promoTotal + promos.couponTotal)
const today = new Date().toISOString().slice(0, 10)
const visible = computed(() => promos.promotions.filter((p) => (!p.valid_from || p.valid_from <= today) && (!p.valid_upto || p.valid_upto >= today)))
const tier = computed(() => cart.customer?.tier || null)

async function apply() {
  applying.value = true
  try {
    const ok = await promos.applyCoupon(code.value)
    if (ok) code.value = ''
  } finally {
    applying.value = false
  }
}
async function scanCoupon() {
  if (!catalog.settings.scan_enabled || scanning.value) return
  scanning.value = true
  try {
    const raw = await new Promise<string | null>((resolve) => {
      scan.openSheet('any')
      const stop = scan.captureRaw((c) => {
        stop()
        resolve(c)
      })
      const un = watch(
        () => scan.sheetOpen,
        (open) => {
          if (!open) {
            un()
            stop()
            resolve(null)
          }
        }
      )
    })
    if (raw) {
      code.value = raw.replace(/^CPN:/i, '')
      scan.closeSheet()
      await apply()
    }
  } finally {
    scanning.value = false
  }
}
watch(
  () => session.boutique?.name,
  (b) => {
    if (b) void promos.load(b)
  },
  { immediate: true }
)
</script>

<template>
  <div class="promo-wrap">
    <button class="chip promo-chip" :class="{ active: !!promos.coupon || promos.promoTotal > 0 }" data-testid="promotions-chip" :title="'Promotions & coupons'" @click="promos.sheetOpen = true">
      <span class="star" aria-hidden="true">✦</span>
      <span>{{ chipText }}</span>
      <span v-if="totalSaved" class="saved num">−{{ fmtMoney(totalSaved, session.currency) }}</span>
    </button>

    <Modal v-if="promos.sheetOpen" title="Promotions & coupons" width="480px" @close="promos.sheetOpen = false">
      <div class="stack">
        <!-- coupon -->
        <div class="field">
          <label class="label" for="coupon-code">Coupon code</label>
          <div class="row">
            <input id="coupon-code" v-model="code" class="input mono" placeholder="WELCOME10" autocapitalize="characters" autocomplete="off" spellcheck="false" :disabled="!!promos.coupon || applying" data-testid="coupon-input" @keydown.enter.prevent="apply" />
            <button v-if="catalog.settings.scan_enabled && !promos.coupon" class="icon-btn" title="Scan coupon" aria-label="Scan coupon" @click="scanCoupon">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M3 8V4h4M17 4h4v4M21 16v4h-4M7 20H3v-4" /><rect x="8" y="8" width="8" height="8" /></svg>
            </button>
            <button v-if="!promos.coupon" class="btn btn-primary" :disabled="!code.trim() || applying || promos.couponBusy" data-testid="coupon-apply" @click="apply">{{ applying ? '…' : 'Apply' }}</button>
            <button v-else class="btn" data-testid="coupon-remove" @click="promos.removeCoupon()">Remove</button>
          </div>
          <div v-if="promos.couponError" class="crit small" data-testid="coupon-error">{{ promos.couponError }}</div>
          <div v-else-if="promos.coupon" class="good small" data-testid="coupon-ok">
            {{ promos.coupon.title }} · −{{ fmtMoney(promos.couponTotal, session.currency) }}
            <span v-if="promos.coupon.item_group" class="dim"> · {{ promos.coupon.item_group }} only</span>
            <span v-if="promos.coupon.uses_left !== null" class="dim"> · {{ promos.coupon.uses_left }} use{{ promos.coupon.uses_left === 1 ? '' : 's' }} left</span>
          </div>
          <div v-else-if="!cart.lines.length" class="dim small">Add items to the basket to apply a coupon.</div>
        </div>

        <!-- applied now -->
        <div v-if="promos.applied.length" class="applied">
          <div class="label">Applied to this basket</div>
          <div v-for="a in promos.applied" :key="a.name" class="between prow">
            <span class="ellipsis">{{ a.title }}</span>
            <span class="good num">−{{ fmtMoney(a.discount, session.currency) }}</span>
          </div>
        </div>

        <!-- active promotions -->
        <div>
          <div class="label">Active today<span v-if="promos.boutique"> · {{ promos.boutique }}</span></div>
          <div v-if="!visible.length" class="dim small" style="margin-top: 6px">No promotions running.</div>
          <div v-for="p in visible" :key="p.name" class="prow between" :class="{ off: p.tier && p.tier !== tier }" :data-testid="'promo-' + p.name">
            <span class="pmain">
              <span class="ptitle ellipsis">{{ p.title }}</span>
              <span class="dim small">
                {{ p.apply_on === 'Transaction' ? 'whole basket' : p.targets.join(', ') }}
                <span v-if="p.min_amt"> · from {{ fmtMoney(p.min_amt, session.currency) }}</span>
                <span v-if="p.min_qty"> · min {{ p.min_qty }}</span>
                <span v-if="p.valid_upto"> · until {{ p.valid_upto }}</span>
              </span>
              <span v-if="p.tier" class="pill" :class="p.tier === tier ? 'pill-accent' : ''">{{ p.tier }} only</span>
            </span>
            <span class="plabel num accent">{{ promoLabel(p) }}</span>
          </div>
        </div>
        <div class="dim small">Promotions apply automatically. One promotion per line; coupons apply after promotions.</div>
      </div>
    </Modal>
  </div>
</template>

<style scoped>
.promo-chip {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  justify-content: center;
  /* touch target (iPhone sheet controls must be ≥ 48 px, see e2e v0.2) */
  min-height: 48px;
}
.star {
  color: var(--accent);
}
.promo-chip.active .star {
  color: inherit;
}
.saved {
  font-size: 12px;
  letter-spacing: 0;
  text-transform: none;
}
.mono {
  font-family: 'Jost', sans-serif;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  flex: 1;
}
.prow {
  padding: 10px 0;
  border-bottom: var(--line-w) solid var(--line);
  gap: 12px;
  align-items: center;
}
.prow:last-child {
  border-bottom: 0;
}
.prow.off {
  opacity: 0.5;
}
.pmain {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.ptitle {
  font-size: 14px;
  font-weight: 500;
}
.plabel {
  flex: 0 0 auto;
  font-size: 15px;
}
.applied {
  padding: 10px 12px;
  background: var(--accent-soft);
}
.small {
  font-size: 12px;
}
.pill {
  align-self: flex-start;
  margin-top: 2px;
}
</style>
