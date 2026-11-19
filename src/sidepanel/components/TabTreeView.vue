<script setup lang="ts">
import { ref } from 'vue'
import type { TreeTabNode } from '@/shared/types'
import { getChromeFaviconUrl } from '@/shared/storage'

const props = defineProps<{
  nodes: TreeTabNode[]
  selectedIds: Set<number>
  groupTitle: string
  groupColor?: string
  isSavedEmpty?: boolean
}>()

const emit = defineEmits<{
  activate: [tabId: number, e: MouseEvent]
  close: [tabId: number]
  toggleFold: [tabId: number]
  toggleMute: [tab: chrome.tabs.Tab]
  newTab: []
  contextMenu: [tab: chrome.tabs.Tab, e: MouseEvent]
  panelContextMenu: [e: MouseEvent]
  dropTab: [draggedId: number, targetId: number, position: 'before' | 'into' | 'after']
}>()

const dragOverId = ref<number | null>(null)
const dragPosition = ref<'before' | 'into' | 'after' | null>(null)

function onDragStart(e: DragEvent, tabId: number) {
  e.dataTransfer?.setData('text/vberry-tab-id', String(tabId))
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, tabId: number) {
  if (!e.dataTransfer?.types.includes('text/vberry-tab-id')) return
  e.preventDefault()
  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const y = e.clientY - rect.top
  const ratio = y / rect.height
  dragOverId.value = tabId
  if (ratio < 0.28) dragPosition.value = 'before'
  else if (ratio > 0.72) dragPosition.value = 'after'
  else dragPosition.value = 'into'
}

function onDragLeave() {
  dragOverId.value = null
  dragPosition.value = null
}

function onDrop(e: DragEvent, targetId: number) {
  e.preventDefault()
  const raw = e.dataTransfer?.getData('text/vberry-tab-id')
  const pos = dragPosition.value ?? 'after'
  dragOverId.value = null
  dragPosition.value = null
  const draggedId = Number(raw)
  if (Number.isFinite(draggedId) && draggedId !== targetId) {
    emit('dropTab', draggedId, targetId, pos)
  }
}

function iconSrc(tab: chrome.tabs.Tab): string {
  return getChromeFaviconUrl(tab.url || tab.pendingUrl, 32) || tab.favIconUrl || ''
}

function onAuxClick(e: MouseEvent, tabId: number) {
  if (e.button === 1) {
    e.preventDefault()
    emit('close', tabId)
  }
}
</script>

<template>
  <div class="tab-tree" @contextmenu.self.prevent="emit('panelContextMenu', $event)">
    <div v-if="isSavedEmpty && nodes.length === 0" class="empty-state">
      <div class="empty-title">{{ groupTitle }}</div>
      <p class="empty-sub">No open tabs in this group yet.</p>
      <button class="primary-btn" @click="emit('newTab')">Open Tab in {{ groupTitle }}</button>
    </div>

    <div v-else-if="nodes.length === 0" class="empty-state">
      <p class="empty-sub">No matching tabs.</p>
      <button class="secondary-btn" @click="emit('newTab')">+ New Tab</button>
    </div>

    <template v-else>
      <div
        v-for="node in nodes"
        v-show="!node.hidden"
        :key="node.id"
        class="tab-row"
        :class="{
          active: node.tab.active,
          selected: selectedIds.has(node.id),
          discarded: node.tab.discarded,
          'drop-before': dragOverId === node.id && dragPosition === 'before',
          'drop-into': dragOverId === node.id && dragPosition === 'into',
          'drop-after': dragOverId === node.id && dragPosition === 'after',
        }"
        :style="{ paddingLeft: `${6 + node.level * 16}px` }"
        draggable="true"
        :title="`${node.tab.title || ''}\n${node.tab.url || ''}`"
        @click="emit('activate', node.id, $event)"
        @auxclick="onAuxClick($event, node.id)"
        @contextmenu.prevent="emit('contextMenu', node.tab, $event)"
        @dragstart="onDragStart($event, node.id)"
        @dragover="onDragOver($event, node.id)"
        @dragleave="onDragLeave"
        @drop="onDrop($event, node.id)"
      >
        <span
          v-if="node.level > 0"
          class="tree-guide"
          :style="{ left: `${node.level * 16 - 4}px` }"
        />

        <button
          v-if="node.hasChildren"
          class="fold-btn"
          :title="node.folded ? 'Expand branch' : 'Fold branch'"
          @click.stop="emit('toggleFold', node.id)"
        >
          <svg
            class="chevron"
            :class="{ folded: node.folded }"
            viewBox="0 0 16 16"
            aria-hidden="true"
          >
            <path
              d="M3.5 5.5 8 10.5l4.5-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <img
          v-if="iconSrc(node.tab)"
          class="favicon"
          :src="iconSrc(node.tab)"
          alt=""
          loading="lazy"
        />
        <span v-else class="favicon-fallback">●</span>

        <span class="tab-title">{{ node.tab.title || node.tab.url || 'New Tab' }}</span>

        <span v-if="node.folded && node.childCount > 0" class="branch-badge">
          +{{ node.childCount }}
        </span>

        <button
          v-if="node.tab.audible || node.tab.mutedInfo?.muted"
          class="icon-action"
          :title="node.tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab'"
          @click.stop="emit('toggleMute', node.tab)"
        >
          {{ node.tab.mutedInfo?.muted ? '🔇' : '🔊' }}
        </button>

        <button class="close-btn" title="Close tab" @click.stop="emit('close', node.id)">
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M3 3l10 10M13 3 3 13"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <button class="new-tab-row" @click="emit('newTab')">
        <svg class="plus-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 2.75v10.5M2.75 8h10.5"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <span>New Tab</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.tab-tree {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 16px;
}

.tab-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--tab-h);
  padding-right: 4px;
  margin: 1px 8px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
  transition: background 0.1s;
}

.tab-row:hover {
  background: var(--bg-hover);
}

.tab-row.selected {
  background: var(--bg-selected);
}

.tab-row.active {
  background: var(--bg-active);
  font-weight: 500;
}

.tab-row.discarded {
  opacity: 0.58;
}

.tab-row.drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}

.tab-row.drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
}

.tab-row.drop-into {
  outline: 1.5px solid var(--accent);
  background: var(--bg-selected);
}

.tree-guide {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 1px;
  background: var(--border);
  pointer-events: none;
}

.fold-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 4px;
  flex-shrink: 0;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}

.fold-btn:hover {
  background: var(--bg-subtle);
  border-color: var(--border);
  color: var(--text);
}

.chevron {
  width: 12px;
  height: 12px;
  transition: transform 0.12s;
}

.chevron.folded {
  transform: rotate(-90deg);
}

.favicon {
  width: var(--icon-size);
  height: var(--icon-size);
  border-radius: 3px;
  flex-shrink: 0;
  object-fit: contain;
}

.favicon-fallback {
  width: var(--icon-size);
  height: var(--icon-size);
  font-size: calc(var(--icon-size) * 0.5);
  color: var(--text-muted);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.branch-badge {
  font-size: 11px;
  padding: 0 5px;
  border-radius: 99px;
  background: var(--bg-subtle);
  color: var(--text-muted);
  flex-shrink: 0;
}

.icon-action,
.close-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  transition: background 0.1s, border-color 0.1s, color 0.1s;
}

.close-btn {
  opacity: 0;
}

.close-btn svg {
  width: 12px;
  height: 12px;
}

.tab-row:hover .close-btn,
.tab-row.active .close-btn {
  opacity: 1;
}

.close-btn:hover,
.icon-action:hover {
  background: var(--bg-subtle);
  border-color: var(--border);
  color: var(--text);
}

.new-tab-row {
  display: flex;
  align-items: center;
  gap: 6px;
  width: calc(100% - 16px);
  height: var(--tab-h);
  margin: 4px 8px 0;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
}

.plus-svg {
  width: var(--icon-size);
  height: var(--icon-size);
  flex-shrink: 0;
}

.new-tab-row:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.empty-state {
  padding: 32px 16px;
  text-align: center;
  color: var(--text-muted);
}

.empty-title {
  font-weight: 600;
  color: var(--text);
  margin-bottom: 4px;
}

.empty-sub {
  margin: 0 0 12px;
  font-size: 12px;
}

.primary-btn,
.secondary-btn {
  padding: 6px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
}

.primary-btn {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.secondary-btn {
  background: var(--bg-subtle);
}
</style>
