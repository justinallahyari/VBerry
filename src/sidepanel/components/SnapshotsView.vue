<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
import type { SnapshotGroup, SnapshotTab, SnapshotWindow, VBerrySnapshot } from '@/shared/types'
import {
  downloadTextFile,
  loadSnapshots,
  saveSnapshots,
  STORAGE_KEYS,
  toArray,
} from '@/shared/storage'
import { getTargetWindowId } from '@/shared/env'
import { captureSnapshot, restoreSnapshot, restoreSnapshotGroup } from '@/shared/groups'
import { snapshotToMarkdown } from '@/shared/sidebery-import'

export type SnapshotContextTarget =
  | { kind: 'snapshot'; snapshot: VBerrySnapshot }
  | { kind: 'snapshot-window'; window: SnapshotWindow }
  | { kind: 'snapshot-group'; group: SnapshotGroup }
  | { kind: 'snapshot-tab'; tab: SnapshotTab }

const emit = defineEmits<{
  contextMenu: [target: SnapshotContextTarget, e: MouseEvent]
}>()

const snapshots = ref<VBerrySnapshot[]>([])
const expandedId = ref<string | null>(null)
const busy = ref(false)

defineExpose({ reload: load })

async function load() {
  snapshots.value = await loadSnapshots()
}

async function takeSnapshot() {
  busy.value = true
  try {
    const snap = await captureSnapshot()
    await load()
    expandedId.value = snap.id
  } finally {
    busy.value = false
  }
}

function countTabs(snap: VBerrySnapshot): number {
  let n = 0
  for (const w of snap.windows) {
    n += w.pinned.length
    for (const g of w.groups) n += g.tabs.length
  }
  return n
}

function formatSnapDate(ts: number): string {
  const d = new Date(ts)
  const now = new Date()
  const timeStr = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (d.toDateString() === now.toDateString()) return `Today, ${timeStr}`
  const yest = new Date(now)
  yest.setDate(now.getDate() - 1)
  if (d.toDateString() === yest.toDateString()) return `Yesterday, ${timeStr}`
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() !== now.getFullYear() ? 'numeric' : undefined })}, ${timeStr}`
}

async function restoreAll(snap: VBerrySnapshot, newWindow: boolean) {
  if (newWindow) {
    try {
      const res = await chrome.runtime.sendMessage<{ ok?: boolean }>({
        type: 'vberry:restore-snapshot',
        snapshot: JSON.parse(JSON.stringify(snap)),
        inNewWindow: true,
      })
      if (res?.ok) return
    } catch {
      // Fall back to direct restore below
    }
  }
  await restoreSnapshot(snap, newWindow)
}

async function restoreWindow(win: SnapshotWindow, newWindow = true) {
  const singleWinSnap: VBerrySnapshot = {
    id: `win_${Date.now()}`,
    time: Date.now(),
    windows: [win],
  }
  await restoreAll(singleWinSnap, newWindow)
}

function countWindowTabs(win: SnapshotWindow): number {
  let n = win.pinned.length
  for (const g of win.groups) n += g.tabs.length
  return n
}

async function restoreGroup(group: SnapshotGroup) {
  const winId = await getTargetWindowId()
  if (winId >= 0) {
    await restoreSnapshotGroup(group, winId)
  }
}

function exportMd(snap: VBerrySnapshot) {
  downloadTextFile(`vberry-snapshot-${snap.id}.md`, snapshotToMarkdown(snap), 'text/markdown')
}

async function removeSnapshot(id: string) {
  const next = snapshots.value.filter(s => s.id !== id)
  await saveSnapshots(next)
  snapshots.value = next
}

function openOptions() {
  void chrome.runtime.openOptionsPage()
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area === 'local' && changes[STORAGE_KEYS.snapshots]) {
    snapshots.value = toArray<VBerrySnapshot>(changes[STORAGE_KEYS.snapshots].newValue)
  }
}

onMounted(() => {
  void load()
  chrome.storage?.onChanged?.addListener(onStorageChanged)
})

onUnmounted(() => {
  chrome.storage?.onChanged?.removeListener(onStorageChanged)
})
</script>

<template>
  <div class="snap-view">
    <div class="snap-toolbar">
      <button type="button" class="primary-btn" :disabled="busy" @click="takeSnapshot">
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 3v10M3 8h10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
          />
        </svg>
        <span>{{ busy ? 'Saving…' : 'Save snapshot' }}</span>
      </button>
      <button type="button" class="secondary-btn" @click="openOptions">Import backup</button>
    </div>

    <div v-if="snapshots.length === 0" class="empty">
      <div class="empty-title">No snapshots saved yet</div>
      <p class="empty-sub">
        Save your open windows, groups, and nested tab trees anytime — or import an existing
        Sidebery backup.
      </p>
    </div>

    <div
      v-for="snap in snapshots"
      :key="snap.id"
      class="snap-card"
      :class="{ expanded: expandedId === snap.id }"
    >
      <button
        type="button"
        class="snap-header"
        @click="expandedId = expandedId === snap.id ? null : snap.id"
        @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot', snapshot: snap }, $event)"
      >
        <div class="snap-meta">
          <div class="snap-date">{{ formatSnapDate(snap.time) }}</div>
          <div class="snap-info">
            <span>{{ snap.windows.length }} win · {{ countTabs(snap) }} tabs</span>
            <span v-if="snap.source === 'sidebery'" class="tag">Sidebery</span>
          </div>
        </div>
        <svg
          class="chev"
          :class="{ open: expandedId === snap.id }"
          viewBox="0 0 16 16"
          aria-hidden="true"
        >
          <path
            d="m6 4 4 4-4 4"
            fill="none"
            stroke="currentColor"
            stroke-width="1.7"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <div v-if="expandedId === snap.id" class="snap-body">
        <div class="snap-actions">
          <button type="button" class="mini-btn accent-mini" @click="restoreAll(snap, true)">
            Restore in new window
          </button>
          <button type="button" class="mini-btn" @click="restoreAll(snap, false)">
            Restore here
          </button>
          <button type="button" class="mini-btn" @click="exportMd(snap)">Export Markdown</button>
          <button type="button" class="mini-btn danger" @click="removeSnapshot(snap.id)">
            Delete
          </button>
        </div>

        <div v-for="(win, wi) in snap.windows" :key="wi" class="snap-win">
          <div
            class="win-head"
            @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot-window', window: win }, $event)"
          >
            <span class="win-title">Window {{ wi + 1 }} ({{ countWindowTabs(win) }})</span>
            <button type="button" class="link-btn" @click="restoreWindow(win, true)">
              Restore window
            </button>
          </div>
          <div v-if="win.pinned.length" class="snap-group">
            <div class="snap-group-head">
              <span class="g-pill" style="--pill-color: var(--accent)">
                Pinned ({{ win.pinned.length }})
              </span>
            </div>
            <div
              v-for="(pt, pti) in win.pinned"
              :key="`p_${pti}`"
              class="snap-tab"
              style="padding-left: 12px"
              :title="pt.url"
              @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot-tab', tab: pt }, $event)"
            >
              {{ pt.title || pt.url }}
            </div>
          </div>
          <div v-for="g in win.groups" :key="g.id" class="snap-group">
            <div
              class="snap-group-head"
              @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot-group', group: g }, $event)"
            >
              <span
                class="g-pill"
                :style="{
                  '--pill-color': g.ungrouped ? 'var(--accent)' : `var(--grp-${g.color})`,
                }"
              >
                {{ g.title }} ({{ g.tabs.length }})
              </span>
              <button type="button" class="link-btn" @click="restoreGroup(g)">
                Restore group
              </button>
            </div>
            <div
              v-for="(t, ti) in g.tabs"
              :key="ti"
              class="snap-tab"
              :class="{ nested: t.level > 0 }"
              :style="{ paddingLeft: `${12 + t.level * 12}px` }"
              :title="t.url"
              @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot-tab', tab: t }, $event)"
            >
              {{ t.title || t.url }}
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.snap-view {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.snap-toolbar {
  display: flex;
  gap: 6px;
}

.primary-btn,
.secondary-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 7px 11px;
  border-radius: 7px;
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
  transition: background-color 0.1s ease, border-color 0.1s ease;
}

.primary-btn {
  flex: 1.3;
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.primary-btn svg {
  width: 13px;
  height: 13px;
}

.primary-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.primary-btn:disabled {
  opacity: 0.65;
  cursor: default;
}

.secondary-btn {
  flex: 1;
  background: var(--surface);
  color: var(--text);
}

.secondary-btn:hover {
  background: var(--bg-hover);
}

.snap-card {
  border: 1px solid var(--border);
  border-radius: 9px;
  background: var(--surface);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.snap-card.expanded {
  border-color: var(--border-strong);
}

.snap-header {
  width: 100%;
  border: none;
  background: transparent;
  text-align: left;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 9px 11px;
  cursor: pointer;
}

.snap-header:hover {
  background: var(--bg-hover);
}

.snap-header:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.snap-date {
  font-weight: 600;
  font-size: 12.5px;
  color: var(--text);
}

.snap-info {
  margin-top: 1px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.chev {
  width: 14px;
  height: 14px;
  color: var(--text-muted);
  flex-shrink: 0;
  transition: transform 0.12s ease;
}

.chev.open {
  transform: rotate(90deg);
  color: var(--accent);
}

.tag {
  padding: 1px 6px;
  border-radius: 99px;
  background: var(--accent-soft);
  color: var(--accent);
  font-size: 10px;
  font-weight: 600;
}

.snap-body {
  border-top: 1px solid var(--border);
  padding: 9px 11px;
  background: var(--bg);
}

.snap-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-bottom: 8px;
}

.mini-btn {
  padding: 4px 8px;
  font-size: 11px;
  font-weight: 500;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
}

.mini-btn:hover {
  background: var(--bg-hover);
}

.mini-btn.accent-mini {
  border-color: var(--accent);
  color: var(--accent);
}

.mini-btn.accent-mini:hover {
  background: var(--accent-soft);
}

.mini-btn.danger {
  color: var(--danger);
}

.mini-btn.danger:hover {
  background: var(--danger-soft);
  border-color: var(--danger-soft);
}

.snap-group {
  margin-bottom: 7px;
}

.snap-group-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 3px;
}

.g-pill {
  --pill-color: var(--accent);
  display: inline-flex;
  align-items: center;
  min-width: 0;
  max-width: 100%;
  padding: 1px 7px;
  border-radius: 6px;
  border: 1px solid color-mix(in srgb, var(--pill-color) 70%, var(--border));
  background: color-mix(in srgb, var(--pill-color) 11%, var(--surface));
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  padding: 1px 4px;
  border-radius: 4px;
}

.link-btn:hover {
  background: var(--accent-soft);
}

.snap-tab {
  position: relative;
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 2px 0;
}

.snap-tab.nested::before {
  content: '';
  position: absolute;
  left: 6px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border-strong);
}

.win-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 6px 0 5px;
  padding-bottom: 3px;
  border-bottom: 1px solid var(--border);
}

.win-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--text-muted);
}

.empty-title {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--text);
  margin-bottom: 4px;
}

.empty-sub {
  margin: 0 auto;
  max-width: 240px;
  font-size: 12px;
  line-height: 1.45;
}
</style>
