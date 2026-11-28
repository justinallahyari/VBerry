<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { getChromeFaviconUrl } from '@/shared/storage'
import { rankSearchItems } from '@/shared/search'
import {
  collectBookmarkFolders,
  computeBookmarkDropDestination,
  countFolderItems,
  findBookmarkNode,
  getBookmarkAncestorIds,
  isRootBookmarkFolder,
  searchNonTrashBookmarks,
  stripTrashFolders,
  type BookmarkDropPosition,
  type BookmarkFolderOption,
} from '@/shared/bookmarks'

const props = defineProps<{
  query: string
  activeIndex?: number
  canBookmarkActiveTab?: boolean
}>()

const emit = defineEmits<{
  openUrl: [url: string, background: boolean]
  contextMenu: [node: chrome.bookmarks.BookmarkTreeNode, e: MouseEvent]
  panelContextMenu: [e: MouseEvent]
  addBookmark: [parentId: string]
  addFolder: [parentId: string]
  bookmarkActiveTab: [parentId: string]
  editBookmark: [node: chrome.bookmarks.BookmarkTreeNode]
}>()

const containerRef = ref<HTMLElement | null>(null)

interface FlatBookmark {
  node: chrome.bookmarks.BookmarkTreeNode
  level: number
  isFolder: boolean
  isRoot: boolean
}

const tree = ref<chrome.bookmarks.BookmarkTreeNode[]>([])
const searchResults = ref<chrome.bookmarks.BookmarkTreeNode[]>([])
const expanded = ref<Set<string>>(new Set(['1', '2']))
const revealedId = ref<string | null>(null)

const draggingId = ref<string | null>(null)
const dragOverId = ref<string | null>(null)
const dragPosition = ref<BookmarkDropPosition | null>(null)
let hoverExpandTimer: ReturnType<typeof setTimeout> | undefined
let revealTimer: ReturnType<typeof setTimeout> | undefined
let searchSeq = 0

async function runSearch(q: string) {
  const seq = ++searchSeq
  const trimmed = q.trim()
  if (!trimmed) {
    searchResults.value = []
    return
  }
  const hits = await searchNonTrashBookmarks(trimmed)
  if (seq !== searchSeq) return
  const links = hits.filter(h => Boolean(h.url))
  searchResults.value = rankSearchItems(links, trimmed, h => ({
    title: h.title,
    url: h.url,
    tieBreaker: h.dateAdded ?? 0,
  }))
}

async function load() {
  tree.value = stripTrashFolders(await chrome.bookmarks.getTree())
  if (props.query.trim()) {
    await runSearch(props.query)
  }
}

function flatten(nodes: chrome.bookmarks.BookmarkTreeNode[], level = 0): FlatBookmark[] {
  const out: FlatBookmark[] = []
  for (const n of nodes) {
    if (n.id === '0') {
      if (n.children) out.push(...flatten(n.children, 0))
      continue
    }
    const isFolder = !n.url
    const isRoot = isRootBookmarkFolder(n)
    out.push({ node: n, level, isFolder, isRoot })
    if (isFolder && expanded.value.has(n.id) && n.children) {
      out.push(...flatten(n.children, level + 1))
    }
  }
  return out
}

const flatBookmarks = computed(() => flatten(tree.value))

const allFolderIds = computed(() => collectBookmarkFolders(tree.value).map(f => f.id))
const allExpanded = computed(
  () => allFolderIds.value.length > 0 && allFolderIds.value.every(id => expanded.value.has(id))
)

function shortHost(rawUrl?: string): string {
  if (!rawUrl) return ''
  try {
    const u = new URL(rawUrl)
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

function getDefaultFolderId(): string {
  const folders = collectBookmarkFolders(tree.value)
  return folders[0]?.id ?? '1'
}

function getFolders(excludeSubtreeId?: string): BookmarkFolderOption[] {
  return collectBookmarkFolders(tree.value, excludeSubtreeId)
}

function expandFolder(id: string) {
  if (expanded.value.has(id)) return
  const next = new Set(expanded.value)
  next.add(id)
  expanded.value = next
}

function expandAll() {
  expanded.value = new Set(allFolderIds.value)
}

function collapseAll() {
  expanded.value = new Set()
}

function toggleFolder(id: string) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

async function revealBookmark(id: string) {
  const ancestors = getBookmarkAncestorIds(tree.value, id)
  if (ancestors) {
    const next = new Set(expanded.value)
    for (const aid of ancestors) next.add(aid)
    expanded.value = next
  }
  await nextTick()
  const el = containerRef.value?.querySelector(`[data-bm-id="${id}"]`) as HTMLElement | null
  el?.scrollIntoView({ block: 'center' })
  revealedId.value = id
  clearTimeout(revealTimer)
  revealTimer = setTimeout(() => {
    if (revealedId.value === id) revealedId.value = null
  }, 1500)
}

async function deleteBookmark(node: chrome.bookmarks.BookmarkTreeNode) {
  if (isRootBookmarkFolder(node)) return
  if (!node.url) {
    const count = countFolderItems(node)
    const msg =
      count > 0
        ? `Delete folder "${node.title}" and its ${count} item${count === 1 ? '' : 's'}?`
        : `Delete empty folder "${node.title}"?`
    if (!confirm(msg)) return
    await chrome.bookmarks.removeTree(node.id).catch(() => {})
  } else {
    await chrome.bookmarks.remove(node.id).catch(() => {})
  }
}

function clearDragState() {
  clearTimeout(hoverExpandTimer)
  draggingId.value = null
  dragOverId.value = null
  dragPosition.value = null
}

function onDragStart(e: DragEvent, item: FlatBookmark) {
  if (item.isRoot) {
    e.preventDefault()
    return
  }
  draggingId.value = item.node.id
  e.dataTransfer?.setData('text/vberry-bookmark-id', item.node.id)
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'
}

function onDragOver(e: DragEvent, target: FlatBookmark) {
  if (!e.dataTransfer?.types.includes('text/vberry-bookmark-id')) return
  const draggedNode = draggingId.value ? findBookmarkNode(tree.value, draggingId.value) : null
  if (!draggedNode || draggedNode.id === target.node.id) return

  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
  const ratio = (e.clientY - rect.top) / Math.max(1, rect.height)
  let pos: BookmarkDropPosition
  if (target.isRoot) {
    pos = 'into'
  } else if (target.isFolder) {
    if (ratio < 0.28) pos = 'before'
    else if (ratio > 0.72) pos = 'after'
    else pos = 'into'
  } else {
    pos = ratio < 0.5 ? 'before' : 'after'
  }

  const dest = computeBookmarkDropDestination(tree.value, draggedNode, target.node, pos)
  if (!dest) {
    if (dragOverId.value === target.node.id) {
      dragOverId.value = null
      dragPosition.value = null
    }
    return
  }

  e.preventDefault()
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'
  dragOverId.value = target.node.id
  dragPosition.value = pos

  if (pos === 'into' && target.isFolder && !expanded.value.has(target.node.id)) {
    const folderId = target.node.id
    clearTimeout(hoverExpandTimer)
    hoverExpandTimer = setTimeout(() => {
      if (dragOverId.value === folderId && dragPosition.value === 'into') {
        expandFolder(folderId)
      }
    }, 550)
  } else {
    clearTimeout(hoverExpandTimer)
  }
}

function onDragLeave(targetId: string) {
  if (dragOverId.value === targetId) {
    clearTimeout(hoverExpandTimer)
    dragOverId.value = null
    dragPosition.value = null
  }
}

async function onDrop(e: DragEvent, target: FlatBookmark) {
  e.preventDefault()
  const rawId = e.dataTransfer?.getData('text/vberry-bookmark-id') || draggingId.value
  const pos = dragPosition.value
  clearDragState()
  if (!rawId || !pos) return

  const draggedNode = findBookmarkNode(tree.value, rawId)
  if (!draggedNode) return
  const dest = computeBookmarkDropDestination(tree.value, draggedNode, target.node, pos)
  if (!dest) return

  await chrome.bookmarks.move(draggedNode.id, dest).catch(() => {})
  if (pos === 'into') expandFolder(target.node.id)
}

function getResultCount(): number {
  return props.query.trim() ? searchResults.value.length : flatBookmarks.value.length
}

function activateIndex(index: number): boolean {
  if (props.query.trim()) {
    const item = searchResults.value[index]
    if (item?.url) {
      emit('openUrl', item.url, false)
      return true
    }
    return false
  }
  const flat = flatBookmarks.value[index]
  if (!flat) return false
  if (flat.isFolder) {
    toggleFolder(flat.node.id)
    return true
  }
  if (flat.node.url) {
    emit('openUrl', flat.node.url, false)
    return true
  }
  return false
}

defineExpose({
  getResultCount,
  activateIndex,
  getFolders,
  getDefaultFolderId,
  expandFolder,
  expandAll,
  collapseAll,
  revealBookmark,
})

watch(
  () => props.activeIndex,
  async idx => {
    if (idx === undefined || idx < 0) return
    await nextTick()
    const el = containerRef.value?.querySelector(`[data-row-idx="${idx}"]`) as HTMLElement | null
    el?.scrollIntoView({ block: 'nearest' })
  }
)

watch(
  () => props.query,
  q => {
    void runSearch(q)
  },
  { immediate: true }
)

onMounted(() => {
  void load()
  chrome.bookmarks.onCreated.addListener(load)
  chrome.bookmarks.onRemoved.addListener(load)
  chrome.bookmarks.onChanged.addListener(load)
  chrome.bookmarks.onMoved.addListener(load)
  chrome.bookmarks.onChildrenReordered?.addListener(load)
})

onUnmounted(() => {
  clearDragState()
  clearTimeout(revealTimer)
  chrome.bookmarks.onCreated.removeListener(load)
  chrome.bookmarks.onRemoved.removeListener(load)
  chrome.bookmarks.onChanged.removeListener(load)
  chrome.bookmarks.onMoved.removeListener(load)
  chrome.bookmarks.onChildrenReordered?.removeListener(load)
})
</script>

<template>
  <div class="bm-shell">
    <div class="bm-toolbar">
      <button
        type="button"
        class="tb-btn"
        title="Add a new bookmark"
        @click="emit('addBookmark', getDefaultFolderId())"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M8 3v10M3 8h10"
            fill="none"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        <span>Bookmark</span>
      </button>
      <button
        v-if="canBookmarkActiveTab"
        type="button"
        class="tb-btn"
        title="Save the current tab to bookmarks"
        @click="emit('bookmarkActiveTab', getDefaultFolderId())"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4.5 2.5h7a1 1 0 0 1 1 1v10L8 11l-4.5 2.5v-10a1 1 0 0 1 1-1Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.45"
            stroke-linejoin="round"
          />
        </svg>
        <span>Save tab</span>
      </button>
      <button
        type="button"
        class="tb-btn"
        title="Create a new bookmark folder"
        @click="emit('addFolder', getDefaultFolderId())"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"
            fill="none"
            stroke="currentColor"
            stroke-width="1.45"
            stroke-linejoin="round"
          />
        </svg>
        <span>Folder</span>
      </button>
      <button
        type="button"
        class="tb-btn tb-icon"
        :title="allExpanded ? 'Collapse all folders' : 'Expand all folders'"
        @click="allExpanded ? collapseAll() : expandAll()"
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            v-if="allExpanded"
            d="m4.5 10.5 3.5-3.5 3.5 3.5M4.5 6h7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
          <path
            v-else
            d="m4.5 5.5 3.5 3.5 3.5-3.5M4.5 11.5h7"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </div>

    <div
      ref="containerRef"
      class="list-view"
      @contextmenu.self.prevent="emit('panelContextMenu', $event)"
    >
      <template v-if="query.trim()">
        <div v-if="searchResults.length === 0" class="empty">
          No bookmarks match “{{ query.trim() }}”.
        </div>
        <div
          v-for="(item, idx) in searchResults"
          :key="item.id"
          :data-row-idx="idx"
          :data-bm-id="item.id"
          class="row"
          :class="{ 'search-focus': activeIndex === idx }"
          :title="item.url"
          @click="item.url && emit('openUrl', item.url, false)"
          @auxclick.middle.prevent="item.url && emit('openUrl', item.url, true)"
          @contextmenu.prevent="emit('contextMenu', item, $event)"
        >
          <img class="fav" :src="getChromeFaviconUrl(item.url, 32)" alt="" />
          <span class="title">{{ item.title || item.url }}</span>
          <span v-if="shortHost(item.url)" class="host">{{ shortHost(item.url) }}</span>
          <button
            type="button"
            tabindex="-1"
            class="row-btn"
            title="Edit bookmark"
            @mousedown.stop
            @click.stop="emit('editBookmark', item)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M11.4 2.6a1.4 1.4 0 0 1 2 2L5.5 12.5 2.5 13.5l1-3Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.4"
                stroke-linejoin="round"
              />
            </svg>
          </button>
          <button
            type="button"
            tabindex="-1"
            class="row-btn del"
            title="Delete bookmark"
            @mousedown.stop
            @click.stop="deleteBookmark(item)"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4 4l8 8M12 4l-8 8"
                fill="none"
                stroke="currentColor"
                stroke-width="1.65"
                stroke-linecap="round"
              />
            </svg>
          </button>
        </div>
      </template>

      <template v-else>
        <div
          v-for="(item, idx) in flatBookmarks"
          :key="item.node.id"
          :data-row-idx="idx"
          :data-bm-id="item.node.id"
          class="row"
          :class="{
            'is-folder': item.isFolder,
            'search-focus': activeIndex === idx,
            revealed: revealedId === item.node.id,
            dragging: draggingId === item.node.id,
            'drop-before': dragOverId === item.node.id && dragPosition === 'before',
            'drop-into': dragOverId === item.node.id && dragPosition === 'into',
            'drop-after': dragOverId === item.node.id && dragPosition === 'after',
          }"
          :style="{ paddingLeft: `${8 + item.level * 15}px` }"
          :draggable="!item.isRoot"
          :title="item.node.url || item.node.title"
          @click="
            item.isFolder
              ? toggleFolder(item.node.id)
              : item.node.url && emit('openUrl', item.node.url, false)
          "
          @auxclick.middle.prevent="
            !item.isFolder && item.node.url && emit('openUrl', item.node.url, true)
          "
          @contextmenu.prevent="emit('contextMenu', item.node, $event)"
          @dragstart="onDragStart($event, item)"
          @dragover="onDragOver($event, item)"
          @dragleave="onDragLeave(item.node.id)"
          @drop="onDrop($event, item)"
          @dragend="clearDragState"
        >
          <span v-if="item.isFolder" class="folder-icon">
            <svg
              class="folder-chev"
              :class="{ open: expanded.has(item.node.id) }"
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
            <svg class="folder-glyph" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2 4.5a1 1 0 0 1 1-1h3.2l1.3 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1Z"
                fill="none"
                stroke="currentColor"
                stroke-width="1.45"
                stroke-linejoin="round"
              />
            </svg>
          </span>
          <img v-else class="fav" :src="getChromeFaviconUrl(item.node.url, 32)" alt="" />
          <span class="title">{{ item.node.title || item.node.url || 'Untitled' }}</span>
          <span v-if="!item.isFolder && shortHost(item.node.url)" class="host">
            {{ shortHost(item.node.url) }}
          </span>
          <template v-if="!item.isRoot">
            <button
              type="button"
              tabindex="-1"
              class="row-btn"
              :title="item.isFolder ? 'Edit or move folder' : 'Edit bookmark'"
              @mousedown.stop
              @click.stop="emit('editBookmark', item.node)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M11.4 2.6a1.4 1.4 0 0 1 2 2L5.5 12.5 2.5 13.5l1-3Z"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linejoin="round"
                />
              </svg>
            </button>
            <button
              type="button"
              tabindex="-1"
              class="row-btn del"
              :title="item.isFolder ? 'Delete folder' : 'Delete bookmark'"
              @mousedown.stop
              @click.stop="deleteBookmark(item.node)"
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path
                  d="M4 4l8 8M12 4l-8 8"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="1.65"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </template>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.bm-shell {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.bm-toolbar {
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
}

.tb-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  height: 25px;
  padding: 0 8px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface);
  color: var(--text);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.1s ease, border-color 0.1s ease;
}

.tb-btn svg {
  width: 12.5px;
  height: 12.5px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.tb-btn:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.tb-btn:hover svg {
  color: var(--accent);
}

.tb-btn:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.tb-icon {
  margin-left: auto;
  padding: 0 6px;
}

.list-view {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 16px;
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--tab-h);
  padding-right: 6px;
  margin: 1px 6px;
  border-radius: 7px;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.1s ease;
}

.row.is-folder .title {
  font-weight: 500;
}

.row:hover {
  background: var(--bg-hover);
}

.row.search-focus,
.row.revealed {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--bg-selected);
}

.row.dragging {
  opacity: 0.45;
}

.row.drop-before {
  box-shadow: inset 0 2px 0 var(--accent);
}

.row.drop-after {
  box-shadow: inset 0 -2px 0 var(--accent);
}

.row.drop-into {
  outline: 1.5px solid var(--accent);
  background: var(--bg-selected);
}

.folder-icon {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.folder-chev {
  width: 11px;
  height: 11px;
  transition: transform 0.12s ease;
}

.folder-chev.open {
  transform: rotate(90deg);
}

.folder-glyph {
  width: var(--icon-size);
  height: var(--icon-size);
  color: var(--accent);
}

.fav {
  width: var(--icon-size);
  height: var(--icon-size);
  border-radius: 3px;
  flex-shrink: 0;
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.host {
  font-size: 11px;
  color: var(--text-muted);
  max-width: 100px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 0;
}

.row:hover .host,
.row.search-focus .host {
  display: none;
}

.row-btn {
  display: none;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  width: 22px;
  height: 22px;
  border-radius: 5px;
  align-items: center;
  justify-content: center;
  padding: 0;
  flex-shrink: 0;
}

.row-btn svg {
  width: 12px;
  height: 12px;
}

.row:hover .row-btn,
.row.search-focus .row-btn {
  display: inline-flex;
}

.row-btn:hover {
  background: var(--surface);
  border-color: var(--border-strong);
  color: var(--text);
}

.row-btn.del:hover {
  color: var(--danger);
  border-color: var(--danger-soft);
  background: var(--danger-soft);
}

.empty {
  padding: 32px 16px;
  text-align: center;
  color: var(--text-muted);
  font-size: 12.5px;
}
</style>
