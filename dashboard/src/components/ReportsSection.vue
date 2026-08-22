<script setup lang="ts">
import { computed } from 'vue'
import { reportCsvUrl, reportUrl } from '../api'
import type { ReportLink } from '../types'

/** v0.4 F — links to the Maison Script Reports (desk) + CSV export, grouped. */
const props = defineProps<{ reports: ReportLink[] }>()
const groups = computed(() => {
  const m = new Map<string, ReportLink[]>()
  for (const r of props.reports) m.set(r.group, [...(m.get(r.group) || []), r])
  return [...m.entries()]
})
const monthStart = new Date()
monthStart.setDate(1)
const iso = (d: Date) => d.toISOString().slice(0, 10)
const filters = { from_date: iso(monthStart), to_date: iso(new Date()) }
</script>

<template>
  <section class="reports">
    <header class="head">
      <span class="label">Reports</span>
      <span class="label">month to date · Frappe desk</span>
    </header>
    <div class="groups">
      <div v-for="[group, list] in groups" :key="group" class="group">
        <span class="display gname">{{ group }}</span>
        <ul class="list">
          <li v-for="r in list" :key="r.name" class="item" :title="r.description">
            <a class="name" :href="reportUrl(r.name, filters)" target="_blank" rel="noopener">{{ r.name.replace(/^Maison /, '') }}</a>
            <a class="label csv" :href="reportCsvUrl(r.name, filters)" title="Download CSV">CSV</a>
          </li>
        </ul>
      </div>
    </div>
    <p v-if="!reports.length" class="label dim">Loading report catalogue…</p>
  </section>
</template>

<style scoped>
.reports { padding: 14px 32px 16px; border-top: 1px solid var(--line); }
.head { display: flex; justify-content: space-between; margin-bottom: 10px; }
.groups { display: flex; flex-wrap: wrap; gap: 8px 32px; }
.group { display: flex; flex-direction: column; gap: 4px; min-width: 150px; }
.gname { font-size: 10px; font-weight: 800; letter-spacing: 0.1em; color: var(--accent); text-transform: uppercase; }
.list { list-style: none; display: flex; flex-direction: column; gap: 3px; }
.item { display: flex; justify-content: space-between; gap: 10px; font-size: 13px; }
.name { color: var(--text); text-decoration: none; }
.name:hover { color: var(--accent); }
.csv { color: var(--dim); text-decoration: none; }
.csv:hover { color: var(--accent); }
.dim { color: var(--dim); }
</style>
