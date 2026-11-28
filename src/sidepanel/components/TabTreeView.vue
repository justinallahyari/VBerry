<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { TreeTabNode } from '@/shared/types'
import { getChromeFaviconUrl } from '@/shared/storage'

const props = defineProps<{
  nodes: TreeTabNode[]
  selectedIds: Set<number>
  highlightedId?: number | null
  groupTitle: string
  isSavedEmpty?: boolean
  isFiltering?: boolean
}>()

const visibleNodes = computed(() => props.nodes.filter(n => !n.hidden))

/**
 * For each visible node and depth `d` (1..node.level), determine whether another node
 * continues the branch at depth `d` below this row (`continues: true` -> ├─ / │, `false` -> └─ / blank).
 */
const guideMap = computed(() => {
  const list = visibleNodes.value
  const map = new Map<number, Array<{ depth: number; isLeafElbow: boolean; continues: boolean }>>()
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]
    if (cur.level <= 0) continue
    const guides: Array<{ depth: number; isLeafElbow: boolean; continues: boolean }> = []
    for (let d = 1; d <= cur.level; d++) {
      let continues = false
      for (let j = i + 1; j < list.length; j++) {
        if (list[j].level < d) break
        if (list[j].level === d) {
          continues = true
          break
        }
      }
      guides.push({ depth: d, isLeafElbow: d === cur.level, continues })
    }
    map.set(cur.id, guides)
  }
  return map
})

const containerRef = ref<HTMLElement | null>(null)

watch(
  () => props.highlightedId,
  async id => {
    if (id === null || id === undefined) return
    await nextTick()
    const el = containerRef.value?.querySelector(`[data-tab-id="${id}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }
)

const emit = defineEmits<{
  activate: [tabId: number, e: MouseEvent]
  close: [tabId: number]
  toggleFold: [tabId: number]
  toggleMute: [tab: chrome.tabs.Tab]
  newTab: []
  clearSearch: []
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
  <div
    ref="containerRef"
    class="tab-tree"
    @contextmenu.self.prevent="emit('panelContextMenu', $event)"
  >
    <div v-if="isSavedEmpty && nodes.length === 0" class="empty-state">
      <div class="empty-title">{{ groupTitle }} is empty</div>
      <p class="empty-sub">Open a tab here or drag existing tabs onto the {{ groupTitle }} pill above.</p>
      <button type="button" class="primary-btn" @click="emit('newTab')">
        Open tab in {{ groupTitle }}
      </button>
    </div>

    <div v-else-if="nodes.length === 0" class="empty-state">
      <div class="empty-title">
        {{ isFiltering ? 'No matching tabs' : 'No open tabs here' }}
      </div>
      <p class="empty-sub">
        {{
          isFiltering
            ? 'Try a shorter search term or switch to Unified Search.'
            : 'Start a fresh tab in this workspace.'
        }}
      </p>
      <div class="empty-actions">
        <button v-if="isFiltering" type="button" class="secondary-btn" @click="emit('clearSearch')">
          Clear search
        </button>
        <button type="button" class="primary-btn" @click="emit('newTab')">Open new tab</button>
      </div>
    </div>

    <template v-else>
      <div
        v-for="node in visibleNodes"
        :key="node.id"
        :data-tab-id="node.id"
        class="tab-row"
        :class="{
          active: node.tab.active,
          selected: selectedIds.has(node.id),
          'search-focus': highlightedId === node.id,
          discarded: node.tab.discarded,
          'is-folded': node.folded,
          'drop-before': dragOverId === node.id && dragPosition === 'before',
          'drop-into': dragOverId === node.id && dragPosition === 'into',
          'drop-after': dragOverId === node.id && dragPosition === 'after',
        }"
        :style="{ paddingLeft: `${6 + node.level * 16}px` }"
        draggable="true"
        :title="`${node.tab.title || ''}\n${node.tab.url || ''}`"
        @mousedown.left="emit('activate', node.id, $event)"
        @auxclick="onAuxClick($event, node.id)"
        @contextmenu.prevent="emit('contextMenu', node.tab, $event)"
        @dragstart="onDragStart($event, node.id)"
        @dragover="onDragOver($event, node.id)"
        @dragleave="onDragLeave"
        @drop="onDrop($event, node.id)"
      >
        <template v-if="node.level > 0">
          <span
            v-for="g in guideMap.get(node.id)"
            :key="g.depth"
            v-show="g.continues || g.isLeafElbow"
            class="tree-guide"
            :class="{
              'tree-elbow': g.isLeafElbow && g.continues,
              'tree-corner': g.isLeafElbow && !g.continues,
            }"
            :style="{ left: `${(g.depth - 1) * 16 + 15}px` }"
          />
        </template>

        <div
          class="tab-icon-slot"
          :class="{ 'has-children': node.hasChildren, folded: node.folded }"
        >
          <img
            v-if="iconSrc(node.tab)"
            class="favicon"
            :src="iconSrc(node.tab)"
            alt=""
            loading="lazy"
          />
          <svg v-else class="favicon-fallback" viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="2.5"
              y="2.5"
              width="11"
              height="11"
              rx="2.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
            />
            <path d="M2.5 6h11" fill="none" stroke="currentColor" stroke-width="1.3" />
          </svg>

          <button
            v-if="node.hasChildren"
            type="button"
            tabindex="-1"
            class="fold-btn"
            :title="node.folded ? 'Expand branch' : 'Fold branch'"
            @mousedown.stop
            @click.stop="emit('toggleFold', node.id)"
          >
            <svg
              class="chevron"
              :class="{ folded: node.folded }"
              viewBox="0 0 16 16"
              aria-hidden="true"
            >
              <path
                d="M4 6l4 4 4-4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.9"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>

        <span class="tab-title">{{ node.tab.title || node.tab.url || 'New tab' }}</span>

        <span
          v-if="node.folded && node.childCount > 0"
          class="branch-badge"
          :title="`${node.childCount} nested tab${node.childCount === 1 ? '' : 's'} hidden — click to expand`"
          @mousedown.stop
          @click.stop="emit('toggleFold', node.id)"
        >
          +{{ node.childCount }}
        </span>

        <button
          v-if="node.tab.audible || node.tab.mutedInfo?.muted"
          type="button"
          tabindex="-1"
          class="icon-action"
          :class="{ muted: node.tab.mutedInfo?.muted }"
          :title="node.tab.mutedInfo?.muted ? 'Unmute tab' : 'Mute tab'"
          @mousedown.stop
          @click.stop="emit('toggleMute', node.tab)"
        >
          <svg v-if="node.tab.mutedInfo?.muted" viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 6.2h2.4L8.5 3v10L4.9 9.8H2.5Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <path
              d="m11 6 3 4m0-4-3 4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M2.5 6.2h2.4L8.5 3v10L4.9 9.8H2.5Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <path
              d="M11 5.5a3.6 3.6 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </button>

        <button
          type="button"
          tabindex="-1"
          class="close-btn"
          title="Close tab"
          @mousedown.stop
          @click.stop="emit('close', node.id)"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4 4l8 8M12 4l-8 8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.75"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <button type="button" class="new-tab-row" @click="emit('newTab')">
        <svg class="plus-svg" viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 3v10M3 8h10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <span>New tab</span>
      </button>
    </template>
  </div>
</template>

<style scoped>
.tab-tree {
  flex: 1;
  overflow-y: auto;
  padding: 5px 0 18px;
}

.tab-row {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--tab-h);
  padding-right: 5px;
  margin: 1px 6px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.1s ease;
}

.tab-row:hover {
  background: var(--bg-hover);
}

.tab-row.selected {
  background: var(--bg-selected);
}

.tab-row.active {
  background: var(--bg-active);
}

.tab-row.active::before {
  content: '';
  position: absolute;
  left: 0;
  top: 5px;
  bottom: 5px;
  width: 3px;
  border-radius: 0 3px 3px 0;
  background: var(--accent);
}

.tab-row.search-focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--bg-selected);
}

.tab-row.discarded .tab-title,
.tab-row.discarded .favicon,
.tab-row.discarded .favicon-fallback {
  opacity: 0.56;
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
  top: -1px;
  bottom: -1px;
  width: 1px;
  background: var(--border-strong);
  pointer-events: none;
}

.tree-guide.tree-elbow::after {
  content: '';
  position: absolute;
  top: 50%;
  left: 0;
  width: 6px;
  height: 1px;
  background: var(--border-strong);
}

.tree-guide.tree-corner {
  bottom: 50%;
  width: 7px;
  background: transparent;
  border-left: 1px solid var(--border-strong);
  border-bottom: 1px solid var(--border-strong);
  border-bottom-left-radius: 4px;
}

.tab-icon-slot {
  position: relative;
  width: max(24px, var(--icon-size), calc(var(--tab-ctrl-icon-size) + 12px));
  height: max(24px, var(--icon-size), calc(var(--tab-ctrl-icon-size) + 12px));
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.fold-btn {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 5px;
  opacity: 0;
  pointer-events: none;
  box-shadow: var(--shadow-sm);
  transition: opacity 0.1s ease, background-color 0.1s ease;
}

.tab-row:hover .tab-icon-slot.has-children .fold-btn,
.tab-icon-slot.has-children.folded .fold-btn {
  opacity: 1;
  pointer-events: auto;
}

.tab-icon-slot.has-children.folded .fold-btn {
  background: var(--bg-subtle);
  border-color: var(--border);
}

.tab-row:hover .tab-icon-slot.has-children .favicon,
.tab-row:hover .tab-icon-slot.has-children .favicon-fallback,
.tab-icon-slot.has-children.folded .favicon,
.tab-icon-slot.has-children.folded .favicon-fallback {
  opacity: 0;
}

.fold-btn:hover {
  background: var(--bg-hover);
  border-color: var(--accent);
  color: var(--accent);
}

.chevron {
  width: var(--tab-ctrl-icon-size);
  height: var(--tab-ctrl-icon-size);
  transition: transform 0.12s ease;
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
  transition: opacity 0.1s ease;
}

.favicon-fallback {
  width: var(--icon-size);
  height: var(--icon-size);
  color: var(--text-muted);
  flex-shrink: 0;
  transition: opacity 0.1s ease;
}

.tab-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  letter-spacing: -0.005em;
}

.tab-row.active .tab-title {
  color: var(--text);
}

.branch-badge {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 1px 6px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--accent);
  flex-shrink: 0;
  cursor: pointer;
}

.branch-badge:hover {
  border-color: var(--accent);
  background: var(--accent-soft);
}

.icon-action,
.close-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: max(23px, calc(var(--tab-ctrl-icon-size) + 11px));
  height: max(23px, calc(var(--tab-ctrl-icon-size) + 11px));
  border-radius: 5px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  padding: 0;
  transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease;
}

.icon-action {
  color: var(--accent);
}

.icon-action.muted {
  color: var(--text-muted);
}

.icon-action svg,
.close-btn svg {
  width: var(--tab-ctrl-icon-size);
  height: var(--tab-ctrl-icon-size);
}

.close-btn {
  opacity: 0;
}

.tab-row:hover .close-btn,
.tab-row.active .close-btn,
.tab-row.search-focus .close-btn {
  opacity: 1;
}

.close-btn:hover,
.icon-action:hover {
  background: var(--surface);
  border-color: var(--border-strong);
  color: var(--text);
}

.close-btn:hover {
  color: var(--danger);
  border-color: var(--danger-soft);
  background: var(--danger-soft);
}

.new-tab-row {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 12px);
  height: var(--tab-h);
  margin: 4px 6px 0;
  padding: 0 8px;
  border: 1px dashed transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  text-align: left;
  transition: background-color 0.1s ease, color 0.1s ease, border-color 0.1s ease;
}

.plus-svg {
  width: calc(var(--icon-size) - 1px);
  height: calc(var(--icon-size) - 1px);
  flex-shrink: 0;
}

.new-tab-row:hover {
  background: var(--bg-subtle);
  border-color: var(--border);
  color: var(--text);
}

.new-tab-row:focus-visible,
.primary-btn:focus-visible,
.secondary-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.empty-state {
  padding: 36px 20px;
  text-align: center;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
}

.empty-title {
  font-weight: 600;
  font-size: 13.5px;
  color: var(--text);
}

.empty-sub {
  margin: 0 0 8px;
  max-width: 240px;
  font-size: 12px;
  line-height: 1.45;
}

.empty-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
}

.primary-btn,
.secondary-btn {
  padding: 6px 13px;
  border-radius: 7px;
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

.primary-btn:hover {
  background: var(--accent-hover);
}

.secondary-btn {
  background: var(--surface);
  color: var(--text);
}

.secondary-btn:hover {
  background: var(--bg-hover);
}
</style>
