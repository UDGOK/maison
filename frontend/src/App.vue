<script setup lang="ts">
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import TopBar from '@/components/TopBar.vue'
import NoticeStack from '@/components/NoticeStack.vue'
import { useSessionStore } from '@/stores/session'

const route = useRoute()
const session = useSessionStore()
const showChrome = computed(() => session.unlocked && route.name !== 'unlock')
</script>

<template>
  <div class="app">
    <TopBar v-if="showChrome" class="no-print" />
    <main class="app-main">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
    <NoticeStack class="no-print" />
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
