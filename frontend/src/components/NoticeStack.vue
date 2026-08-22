<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useSyncStore } from '@/stores/sync'

const sync = useSyncStore()
const router = useRouter()
</script>

<template>
  <div class="notices">
    <div v-for="n in sync.notices" :key="n.id" class="notice" :class="n.kind">
      <div class="notice-body">
        <div class="notice-title">{{ n.title }}</div>
        <div v-if="n.detail" class="notice-detail">{{ n.detail }}</div>
      </div>
      <button v-if="n.kind === 'crit'" class="notice-btn label" @click="router.push({ name: 'queue' }); sync.dismiss(n.id)">Queue</button>
      <button class="notice-btn label" @click="sync.dismiss(n.id)">Close</button>
    </div>
  </div>
</template>

<style scoped>
.notices {
  position: fixed;
  right: 16px;
  bottom: 16px;
  width: 420px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 100;
}
.notice {
  display: flex;
  align-items: center;
  gap: 8px;
  background: var(--surface);
  border: var(--line-w) solid var(--line-strong);
  border-left-width: 3px;
  padding: 10px 8px 10px 14px;
}
.notice.good {
  border-left-color: var(--good);
}
.notice.warn {
  border-left-color: var(--warn);
}
.notice.crit {
  border-left-color: var(--crit);
}
.notice-body {
  flex: 1;
  min-width: 0;
}
.notice-title {
  font-weight: 500;
  font-size: 14px;
}
.notice-detail {
  color: var(--muted);
  font-size: 13px;
  margin-top: 2px;
}
.notice-btn {
  min-width: 0;
  padding: 0 10px;
  color: var(--muted);
}
.notice-btn:hover {
  color: var(--text);
}
</style>
