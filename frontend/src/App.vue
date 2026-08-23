<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import TopBar from '@/components/TopBar.vue'
import NoticeStack from '@/components/NoticeStack.vue'
import ScannerSheet from '@/components/ScannerSheet.vue'
import EnrolSheet from '@/components/EnrolSheet.vue'
import { useRecognitionStore } from '@/stores/recognition'
import { useSessionStore } from '@/stores/session'
import { useScanStore } from '@/stores/scan'
import VirtualSalon from '@/components/VirtualSalon.vue' // v0.5 K
import { IS_MOCK } from '@/api'
import AgeGateSheet from '@/components/AgeGateSheet.vue' // v0.6 N
import { useAgeStore } from '@/stores/age' // v0.6 N

const route = useRoute()
const session = useSessionStore()
const scan = useScanStore()
const recognition = useRecognitionStore()
const age = useAgeStore() // v0.6 N
const isSalon = computed(() => !!route.meta.salon || !!route.meta.warehouse) // v0.5 K (+ v0.6 P warehouse screens: own chrome)
const showChrome = computed(() => session.unlocked && route.name !== 'unlock' && !isSalon.value)
</script>

<template>
  <div class="app">
    <TopBar v-if="showChrome" class="no-print" />
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
    <NoticeStack v-if="!isSalon" class="no-print" />
    <!-- v0.5 K: dev "virtual salon" pane (mock mode only) -->
    <VirtualSalon v-if="showChrome && IS_MOCK" class="no-print" />
    <ScannerSheet v-if="scan.sheetOpen && showChrome" class="no-print" />
    <EnrolSheet v-if="recognition.enrolOpen && showChrome" class="no-print" />
    <!-- v0.6 N: 21+ ID check for age-restricted items -->
    <AgeGateSheet v-if="age.open && showChrome" class="no-print" />
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--ground);
}
.app-main {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
@media print {
  .app,
  .app-main {
    height: auto;
    display: block;
  }
}
</style>
