<script setup lang="ts">
import { useRouter } from 'vue-router'
import { useSyncStore } from '@/stores/sync'
import { useScanStore } from '@/stores/scan'
import { useRecognitionStore } from '@/stores/recognition'

const sync = useSyncStore()
const scan = useScanStore()
const recognition = useRecognitionStore()
const router = useRouter()

function act(n: { id: number; action?: { action: string } }) {
  if (n.action?.action === 'search') scan.searchPending()
  else if (n.action?.action === 'queue') router.push({ name: 'queue' })
  else if (n.action?.action === 'undo-recognition') void recognition.undo()
  // v0.8 POS D5 — the till is signed out; the queued sales replay by themselves once it is back in
  else if (n.action?.action === 'sign-in' && typeof window !== 'undefined')
    window.location.assign('/login?redirect-to=' + encodeURIComponent(window.location.pathname + window.location.search))
  sync.dismiss(n.id)
}
</script>

<template>
  <div class="notices">
    <div v-for="n in sync.notices" :key="n.id" class="notice" :class="n.kind">
      <div class="notice-body">
        <div class="notice-title">{{ n.title }}</div>
        <div v-if="n.detail" class="notice-detail">{{ n.detail }}</div>
      </div>
      <button v-if="n.action" class="notice-btn label accent" @click="act(n)">{{ n.action.label }}</button>
      <button v-else-if="n.kind === 'crit'" class="notice-btn label" @click="router.push({ name: 'queue' }); sync.dismiss(n.id)">Queue</button>
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
  margin-bottom: var(--safe-bottom);
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
.notice-btn.accent {
  color: var(--accent);
}
@media (max-width: 767px) {
  .notices {
    right: 12px;
    left: 12px;
    top: calc(var(--topbar-h) + var(--safe-top) + 8px);
    bottom: auto;
    width: auto;
  }
}
</style>
