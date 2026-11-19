<script setup lang="ts">
import { onMounted, ref } from 'vue'
import type { SnapshotGroup, SnapshotTab, SnapshotWindow, VBerrySnapshot } from '@/shared/types'
import { downloadTextFile, loadSnapshots, saveSnapshots } from '@/shared/storage'
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
    await captureSnapshot()
    await load()
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

async function restoreAll(snap: VBerrySnapshot, newWindow: boolean) {
  // Run new-window restores in the background service worker so focus changes
  // or side panel closing can never interrupt tree restoration.
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

onMounted(load)
</script>

<template>
  <div class="snap-view">
    <div class="snap-toolbar">
      <button class="primary-btn" :disabled="busy" @click="takeSnapshot">
        {{ busy ? 'Saving…' : '+ Take Snapshot' }}
      </button>
      <button class="secondary-btn" @click="openOptions">Import Sidebery</button>
    </div>

    <div v-if="snapshots.length === 0" class="empty">
      No snapshots yet. Take a snapshot or import a Sidebery backup in Settings.
    </div>

    <div v-for="snap in snapshots" :key="snap.id" class="snap-card">
      <div
        class="snap-header"
        @click="expandedId = expandedId === snap.id ? null : snap.id"
        @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot', snapshot: snap }, $event)"
      >
        <div class="snap-meta">
          <div class="snap-date">{{ new Date(snap.time).toLocaleString() }}</div>
          <div class="snap-info">
            {{ snap.windows.length }} win · {{ countTabs(snap) }} tabs
            <span v-if="snap.source === 'sidebery'" class="tag">Sidebery</span>
          </div>
        </div>
        <span class="chev">{{ expandedId === snap.id ? '▾' : '▸' }}</span>
      </div>

      <div v-if="expandedId === snap.id" class="snap-body">
        <div class="snap-actions">
          <button class="mini-btn" @click="restoreAll(snap, true)">Restore in New Window</button>
          <button class="mini-btn" @click="restoreAll(snap, false)">Restore Here</button>
          <button class="mini-btn" @click="exportMd(snap)">Markdown</button>
          <button class="mini-btn danger" @click="removeSnapshot(snap.id)">Delete</button>
        </div>

        <div v-for="(win, wi) in snap.windows" :key="wi" class="snap-win">
          <div
            class="win-head"
            @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot-window', window: win }, $event)"
          >
            <span class="win-title">Window {{ wi + 1 }} ({{ countWindowTabs(win) }})</span>
            <button class="link-btn" @click="restoreWindow(win, true)">Restore Window</button>
          </div>
          <div v-if="win.pinned.length" class="snap-group">
            <div class="snap-group-head">
              <span class="g-name">📌 Pinned ({{ win.pinned.length }})</span>
            </div>
            <div
              v-for="(pt, pti) in win.pinned"
              :key="`p_${pti}`"
              class="snap-tab"
              style="padding-left: 10px"
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
              <span class="dot" :style="{ background: `var(--grp-${g.color})` }" />
              <span class="g-name">{{ g.title }} ({{ g.tabs.length }})</span>
              <button class="link-btn" @click="restoreGroup(g)">Restore Group</button>
            </div>
            <div
              v-for="(t, ti) in g.tabs"
              :key="ti"
              class="snap-tab"
              :style="{ paddingLeft: `${10 + t.level * 12}px` }"
              :title="t.url"
              @contextmenu.prevent="emit('contextMenu', { kind: 'snapshot-tab', tab: t }, $event)"
            >
              <span v-if="t.level > 0" class="tree-prefix">↳ </span>{{ t.title || t.url }}
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
  padding: 8px;
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
  flex: 1;
  padding: 6px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
  font-weight: 500;
}

.primary-btn {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.secondary-btn {
  background: var(--bg-subtle);
}

.snap-card {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--bg-subtle);
  overflow: hidden;
}

.snap-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 10px;
  cursor: pointer;
}

.snap-header:hover {
  background: var(--bg-hover);
}

.snap-date {
  font-weight: 500;
  font-size: 12.5px;
}

.snap-info {
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 6px;
}

.tag {
  padding: 0 5px;
  border-radius: 4px;
  background: var(--bg-active);
  color: var(--text);
  font-size: 10px;
}

.snap-body {
  border-top: 1px solid var(--border);
  padding: 8px 10px;
  background: var(--bg);
}

.snap-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 8px;
}

.mini-btn {
  padding: 3px 7px;
  font-size: 11px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  cursor: pointer;
}

.mini-btn.danger {
  color: var(--danger);
}

.snap-group {
  margin-bottom: 6px;
}

.snap-group-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 2px;
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.g-name {
  flex: 1;
}

.link-btn {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 11px;
  cursor: pointer;
}

.snap-tab {
  font-size: 11.5px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 1px 0;
}

.win-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  margin: 6px 0 4px;
  padding-bottom: 2px;
  border-bottom: 1px solid var(--border);
}

.win-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
}

.empty {
  padding: 24px 12px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12px;
}
</style>
