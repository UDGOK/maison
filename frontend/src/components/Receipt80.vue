<script setup lang="ts">
/** 80 mm receipt — used for on-screen preview and for window.print() fallback. */
import { ref, watch } from 'vue'
import QRCode from 'qrcode'
import type { QueueRow } from '@/db'
import { fmtAmount } from '@/utils/money'
import { fmtDateTime } from '@/utils/device'
import { receiptQrContent } from '@/printer/epos'
import { useCatalogStore } from '@/stores/catalog'

const props = defineProps<{ row: QueueRow }>()
const catalog = useCatalogStore()
const qrSrc = ref('')
const qrUrl = ref('')

watch(
  () => [props.row.receipt_token, props.row.receipt.receipt_qr_base_url, catalog.settings.receipt_qr_enabled],
  async () => {
    const url = receiptQrContent(
      { receipt_token: props.row.receipt_token, receipt_qr_enabled: catalog.settings.receipt_qr_enabled, receipt_qr_base_url: props.row.receipt.receipt_qr_base_url },
      catalog.receiptQrBase
    )
    qrUrl.value = url || ''
    if (!url) {
      qrSrc.value = ''
      return
    }
    try {
      qrSrc.value = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 0, width: 240, color: { dark: '#000000', light: '#ffffff' } })
    } catch {
      qrSrc.value = ''
    }
  },
  { immediate: true }
)
</script>

<template>
  <div class="receipt">
    <div class="r-wordmark">MAISON</div>
    <div class="r-center r-caps">{{ row.receipt.boutique_name }}</div>
    <div class="r-center">{{ row.receipt.address_line }}</div>
    <div class="r-center">{{ row.receipt.city }}</div>
    <div class="r-center">{{ row.receipt.phone }}</div>
    <div class="r-rule double"></div>
    <div class="r-kv"><span>Invoice</span><span>{{ row.invoice_name || 'PENDING ' + row.offline_uuid.slice(0, 8).toUpperCase() }}</span></div>
    <div class="r-kv"><span>Date</span><span>{{ fmtDateTime(row.invoice.posting_datetime) }}</span></div>
    <div class="r-kv"><span>Associate</span><span>{{ row.receipt.associate_name }}</span></div>
    <div v-if="row.receipt.customer_name" class="r-kv">
      <span>Client</span><span>{{ row.receipt.customer_name }}<template v-if="row.receipt.customer_tier"> / {{ row.receipt.customer_tier }}</template></span>
    </div>
    <div v-if="row.receipt.customer_client_number" class="r-kv"><span>Client No</span><span>{{ row.receipt.customer_client_number }}</span></div>
    <div class="r-rule"></div>
    <div v-for="(l, i) in row.receipt.lines" :key="i" class="r-line">
      <div class="r-item">{{ l.item_name }}</div>
      <div v-if="l.serial_no" class="r-sub">Serial {{ l.serial_no }}</div>
      <div v-if="l.certificate_no" class="r-sub">Cert {{ l.certificate_no }}</div>
      <div class="r-kv r-sub"><span>{{ l.qty }} x {{ fmtAmount(l.rate) }}</span><span>{{ fmtAmount(l.amount) }}</span></div>
      <div v-if="l.discount_amount" class="r-kv r-sub"><span>Discount</span><span>-{{ fmtAmount(l.discount_amount) }}</span></div>
    </div>
    <div class="r-rule"></div>
    <div class="r-kv"><span>Subtotal</span><span>{{ fmtAmount(row.receipt.net_total + row.receipt.discount) }}</span></div>
    <div v-if="row.receipt.discount" class="r-kv"><span>Discount</span><span>-{{ fmtAmount(row.receipt.discount) }}</span></div>
    <div class="r-kv"><span>Tax {{ row.receipt.tax_rate }}%</span><span>{{ fmtAmount(row.receipt.total_taxes) }}</span></div>
    <div v-if="row.receipt.loyalty_amount" class="r-kv"><span>Loyalty ({{ row.receipt.loyalty_points_redeemed }} pts)</span><span>-{{ fmtAmount(row.receipt.loyalty_amount) }}</span></div>
    <div class="r-kv r-total"><span>Total {{ row.receipt.currency }}</span><span>{{ fmtAmount(row.receipt.grand_total) }}</span></div>
    <div class="r-rule"></div>
    <template v-for="(p, i) in row.receipt.payments" :key="i">
      <template v-if="p.mode_of_payment === 'Card'">
        <div class="r-kv"><span>Card {{ p.card_brand }} <template v-if="p.last4">**** {{ p.last4 }}</template></span><span>{{ fmtAmount(p.amount) }}</span></div>
        <div v-if="p.approval" class="r-kv r-sub"><span>Approval</span><span>{{ p.approval }}</span></div>
      </template>
      <template v-else>
        <div class="r-kv"><span>Cash</span><span>{{ fmtAmount(p.amount) }}</span></div>
        <div v-if="p.tendered !== undefined" class="r-kv r-sub"><span>Tendered</span><span>{{ fmtAmount(p.tendered) }}</span></div>
        <div v-if="p.change" class="r-kv r-sub"><span>Change</span><span>{{ fmtAmount(p.change) }}</span></div>
      </template>
    </template>
    <template v-if="row.receipt.customer_name">
      <div class="r-rule"></div>
      <div class="r-kv"><span>Points earned</span><span>{{ row.receipt.points_earned }}</span></div>
      <div v-if="row.receipt.points_balance !== undefined" class="r-kv"><span>Points balance</span><span>{{ row.receipt.points_balance }}</span></div>
    </template>
    <div v-if="row.receipt.grand_total >= 10000" class="r-sig">
      <div class="r-sig-line"></div>
      <div class="r-sub">Signature</div>
    </div>
    <div class="r-foot">
      <div class="r-center r-caps">Thank you for visiting Maison</div>
      <div class="r-center">Exchanges within 30 days with receipt.</div>
      <div v-if="qrSrc" class="r-qr">
        <img :src="qrSrc" alt="Receipt QR" width="96" height="96" />
        <div class="r-center r-caps">Scan for your digital receipt</div>
      </div>
      <div class="r-center r-uuid">{{ row.offline_uuid }}</div>
    </div>
  </div>
</template>

<style scoped>
.receipt {
  width: 80mm;
  padding: 6mm 4mm 8mm;
  background: #fff;
  color: #000;
  font-family: 'Jost', 'Helvetica Neue', Arial, sans-serif;
  font-size: 11px;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
}
.r-wordmark {
  font-family: 'Unbounded', 'Arial Black', sans-serif;
  font-weight: 900;
  font-size: 20px;
  letter-spacing: 0.3em;
  text-align: center;
  margin-bottom: 6px;
  padding-left: 0.3em;
}
.r-center {
  text-align: center;
}
.r-caps {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 10px;
}
.r-rule {
  border-top: 1px solid #000;
  margin: 6px 0;
}
.r-rule.double {
  border-top: 3px double #000;
}
.r-kv {
  display: flex;
  justify-content: space-between;
  gap: 8px;
}
.r-kv > span:first-child {
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-size: 10px;
}
.r-kv > span:last-child {
  text-align: right;
  white-space: nowrap;
}
.r-line {
  margin: 4px 0;
}
.r-item {
  font-family: 'Unbounded', 'Arial Black', sans-serif;
  font-weight: 800;
  font-size: 10px;
  text-transform: uppercase;
}
.r-sub {
  font-size: 10px;
  color: #222;
}
.r-total {
  font-family: 'Unbounded', 'Arial Black', sans-serif;
  font-weight: 800;
  font-size: 15px;
  margin-top: 6px;
}
.r-total > span:first-child {
  font-family: 'Unbounded', 'Arial Black', sans-serif;
  font-size: 11px;
}
.r-sig {
  margin-top: 26px;
}
.r-sig-line {
  border-top: 1px solid #000;
  margin-bottom: 3px;
}
.r-foot {
  margin-top: 14px;
}
.r-uuid {
  font-size: 8px;
  color: #555;
  margin-top: 6px;
}
.r-qr {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}
.r-qr img {
  width: 26mm;
  height: 26mm;
  image-rendering: pixelated;
}
</style>
