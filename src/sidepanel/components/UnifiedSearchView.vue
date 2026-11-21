<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ChromeGroupColor, SavedPanel, Settings } from '@/shared/types'
import { getChromeFaviconUrl, loadRecentBookmarkUrls, STORAGE_KEYS } from '@/shared/storage'
import { historyStartTime, rankSearchItems } from '@/shared/search'
import { searchNonTrashBookmarks, stripTrashFolders } from '@/shared/bookmarks'
import { UNGROUPED_ID } from '@/shared/groups'

const props = defineProps<{
  query: string
  activeIndex?: number
  tabs: chrome.tabs.Tab[]
  groups: chrome.tabGroups.TabGroup[]
  savedPanels: SavedPanel[]
  virtualGroupMap: Record<number, string>
  settings: Settings
}>()

const emit = defineEmits<{
  activateTab: [tabId: number, e: MouseEvent]
  openBookmarkUrl: [url: string, background: boolean]
  openHistoryUrl: [url: string, background: boolean]
  tabContextMenu: [tab: chrome.tabs.Tab, e: MouseEvent]
  bookmarkContextMenu: [node: chrome.bookmarks.BookmarkTreeNode, e: MouseEvent]
  historyContextMenu: [item: chrome.history.HistoryItem, e: MouseEvent]
}>()

const containerRef = ref<HTMLElement | null>(null)
const bookmarkResults = ref<chrome.bookmarks.BookmarkTreeNode[]>([])
const historyResults = ref<chrome.history.HistoryItem[]>([])
let loadSeq = 0

const groupById = computed(() => new Map(props.groups.map(g => [g.id, g])))
const savedById = computed(() => new Map(props.savedPanels.map(p => [p.id, p])))

const isSearching = computed(() => props.query.trim().length > 0)

const tabResults = computed<chrome.tabs.Tab[]>(() => {
  const q = props.query.trim()
  const pool = props.tabs.filter(t => t.id !== undefined)
  if (q) {
    if (!props.settings.unifiedSearchTabs) return []
    return rankSearchItems(pool, q, t => ({
      title: t.title,
      url: t.url || t.pendingUrl,
      tieBreaker: (t.active ? 1e12 : 0) + (t.lastAccessed ?? 0),
    })).slice(0, 25)
  }
  if (!props.settings.unifiedEmptyShowTabs) return []
  return [...pool]
    .sort(
      (a, b) =>
        (b.active ? 1 : 0) - (a.active ? 1 : 0) || (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0)
    )
    .slice(0, 15)
})

function flattenBookmarkLinks(
  nodes: chrome.bookmarks.BookmarkTreeNode[]
): chrome.bookmarks.BookmarkTreeNode[] {
  const out: chrome.bookmarks.BookmarkTreeNode[] = []
  for (const n of nodes) {
    if (n.url) out.push(n)
    if (n.children) out.push(...flattenBookmarkLinks(n.children))
  }
  return out
}

async function loadRecentBookmarks(): Promise<chrome.bookmarks.BookmarkTreeNode[]> {
  const [tree, mruUrls, hist] = await Promise.all([
    chrome.bookmarks.getTree().catch(() => []),
    loadRecentBookmarkUrls(),
    chrome.history.search({ text: '', maxResults: 200, startTime: 0 }).catch(() => []),
  ])
  const links = flattenBookmarkLinks(stripTrashFolders(tree))
  if (!links.length) return []

  const mruRank = new Map<string, number>()
  mruUrls.forEach((u, i) => {
    if (!mruRank.has(u)) mruRank.set(u, i)
  })
  const visitTime = new Map<string, number>()
  for (const h of hist) {
    if (h.url && h.lastVisitTime) {
      const cur = visitTime.get(h.url) ?? 0
      if (h.lastVisitTime > cur) visitTime.set(h.url, h.lastVisitTime)
    }
  }

  return [...links]
    .sort((a, b) => {
      const am = a.url !== undefined ? mruRank.get(a.url) : undefined
      const bm = b.url !== undefined ? mruRank.get(b.url) : undefined
      if (am !== undefined || bm !== undefined) {
        if (am === undefined) return 1
        if (bm === undefined) return -1
        return am - bm
      }
      const av = (a.url ? visitTime.get(a.url) : 0) ?? 0
      const bv = (b.url ? visitTime.get(b.url) : 0) ?? 0
      if (av !== bv) return bv - av
      return (b.dateAdded ?? 0) - (a.dateAdded ?? 0)
    })
    .slice(0, 25)
}

async function loadExternalSources() {
  const seq = ++loadSeq
  const q = props.query.trim()
  const wantBookmarks = q
    ? props.settings.unifiedSearchBookmarks
    : props.settings.unifiedEmptyShowBookmarks
  const wantHistory = q
    ? props.settings.unifiedSearchHistory
    : props.settings.unifiedEmptyShowHistory
  const startTime = historyStartTime(props.settings.historyDays)

  const [bms, hist] = await Promise.all([
    wantBookmarks
      ? q
        ? searchNonTrashBookmarks(q)
            .then(hits =>
              rankSearchItems(
                hits.filter(h => Boolean(h.url)),
                q,
                h => ({ title: h.title, url: h.url, tieBreaker: h.dateAdded ?? 0 })
              ).slice(0, 25)
            )
            .catch(() => [])
        : loadRecentBookmarks()
      : Promise.resolve([]),
    wantHistory
      ? chrome.history
          .search({ text: q, maxResults: q ? 60 : 20, startTime })
          .then(hits => {
            const withUrl = hits.filter(h => Boolean(h.url))
            return q
              ? rankSearchItems(withUrl, q, h => ({
                  title: h.title,
                  url: h.url,
                  tieBreaker: (h.visitCount ?? 0) * 1000 + (h.lastVisitTime ?? 0) / 1e9,
                })).slice(0, 25)
              : withUrl.slice(0, 20)
          })
          .catch(() => [])
      : Promise.resolve([]),
  ])

  if (seq !== loadSeq) return
  bookmarkResults.value = bms
  historyResults.value = hist
}

type FlatRow =
  | { kind: 'tab'; tab: chrome.tabs.Tab; idx: number }
  | { kind: 'bookmark'; node: chrome.bookmarks.BookmarkTreeNode; idx: number }
  | { kind: 'history'; item: chrome.history.HistoryItem; idx: number }

const flatRows = computed<FlatRow[]>(() => {
  const out: FlatRow[] = []
  let idx = 0
  for (const tab of tabResults.value) out.push({ kind: 'tab', tab, idx: idx++ })
  for (const node of bookmarkResults.value) out.push({ kind: 'bookmark', node, idx: idx++ })
  for (const item of historyResults.value) out.push({ kind: 'history', item, idx: idx++ })
  return out
})

const bookmarkOffset = computed(() => tabResults.value.length)
const historyOffset = computed(() => tabResults.value.length + bookmarkResults.value.length)

function tabGroupBadge(tab: chrome.tabs.Tab): { title: string; color?: ChromeGroupColor } | null {
  if (tab.groupId !== UNGROUPED_ID) {
    const g = groupById.value.get(tab.groupId)
    if (g) return { title: g.title?.trim() || 'Group', color: g.color }
  }
  if (tab.id !== undefined && props.virtualGroupMap[tab.id]) {
    const sp = savedById.value.get(props.virtualGroupMap[tab.id])
    if (sp) return { title: sp.title, color: sp.color }
  }
  return null
}

function getResultCount(): number {
  return flatRows.value.length
}

function activateIndex(index: number): { kind: 'tab'; tabId: number } | { kind: 'url'; url: string } | null {
  const row = flatRows.value[index]
  if (!row) return null
  if (row.kind === 'tab' && row.tab.id !== undefined) {
    return { kind: 'tab', tabId: row.tab.id }
  }
  if (row.kind === 'bookmark' && row.node.url) {
    emit('openBookmarkUrl', row.node.url, false)
    return { kind: 'url', url: row.node.url }
  }
  if (row.kind === 'history' && row.item.url) {
    emit('openHistoryUrl', row.item.url, false)
    return { kind: 'url', url: row.item.url }
  }
  return null
}

defineExpose({ getResultCount, activateIndex, reload: loadExternalSources })

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
  () => [
    props.query,
    props.settings.unifiedSearchBookmarks,
    props.settings.unifiedSearchHistory,
    props.settings.unifiedEmptyShowBookmarks,
    props.settings.unifiedEmptyShowHistory,
    props.settings.historyDays,
  ],
  () => void loadExternalSources(),
  { immediate: true }
)

function onBookmarkChanged() {
  void loadExternalSources()
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area === 'local' && changes[STORAGE_KEYS.recentBookmarks]) {
    void loadExternalSources()
  }
}

onMounted(() => {
  chrome.bookmarks.onCreated.addListener(onBookmarkChanged)
  chrome.bookmarks.onRemoved.addListener(onBookmarkChanged)
  chrome.bookmarks.onChanged.addListener(onBookmarkChanged)
  chrome.storage.onChanged.addListener(onStorageChanged)
})

onUnmounted(() => {
  chrome.bookmarks.onCreated.removeListener(onBookmarkChanged)
  chrome.bookmarks.onRemoved.removeListener(onBookmarkChanged)
  chrome.bookmarks.onChanged.removeListener(onBookmarkChanged)
  chrome.storage.onChanged.removeListener(onStorageChanged)
})

function formatTime(ms?: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <div ref="containerRef" class="list-view">
    <template v-if="tabResults.length">
      <div class="section-label">{{ isSearching ? 'Tabs' : 'Recent Tabs' }}</div>
      <div
        v-for="(tab, i) in tabResults"
        :key="`t_${tab.id}`"
        :data-row-idx="i"
        class="row"
        :class="{
          active: tab.active,
          discarded: tab.discarded,
          'search-focus': activeIndex === i,
        }"
        :title="`${tab.title || ''}\n${tab.url || ''}`"
        @mousedown.left="tab.id !== undefined && emit('activateTab', tab.id, $event)"
        @contextmenu.prevent="emit('tabContextMenu', tab, $event)"
      >
        <img
          v-if="getChromeFaviconUrl(tab.url || tab.pendingUrl, 32) || tab.favIconUrl"
          class="fav"
          :src="getChromeFaviconUrl(tab.url || tab.pendingUrl, 32) || tab.favIconUrl"
          alt=""
        />
        <span v-else class="fav-fallback">•</span>
        <span class="title">{{ tab.title || tab.url || 'New Tab' }}</span>
        <span v-if="tabGroupBadge(tab)" class="group-chip">
          <span
            v-if="tabGroupBadge(tab)?.color"
            class="chip-dot"
            :style="{ background: `var(--grp-${tabGroupBadge(tab)?.color})` }"
          />
          {{ tabGroupBadge(tab)?.title }}
        </span>
      </div>
    </template>

    <template v-if="bookmarkResults.length">
      <div class="section-label">{{ isSearching ? 'Bookmarks' : 'Recent Bookmarks' }}</div>
      <div
        v-for="(node, i) in bookmarkResults"
        :key="`b_${node.id}`"
        :data-row-idx="bookmarkOffset + i"
        class="row"
        :class="{ 'search-focus': activeIndex === bookmarkOffset + i }"
        :title="node.url"
        @click="node.url && emit('openBookmarkUrl', node.url, false)"
        @auxclick.middle.prevent="node.url && emit('openBookmarkUrl', node.url, true)"
        @contextmenu.prevent="emit('bookmarkContextMenu', node, $event)"
      >
        <img class="fav" :src="getChromeFaviconUrl(node.url, 32)" alt="" />
        <span class="title">{{ node.title || node.url }}</span>
      </div>
    </template>

    <template v-if="historyResults.length">
      <div class="section-label">{{ isSearching ? 'History' : 'Recent History' }}</div>
      <div
        v-for="(item, i) in historyResults"
        :key="`h_${item.id}`"
        :data-row-idx="historyOffset + i"
        class="row"
        :class="{ 'search-focus': activeIndex === historyOffset + i }"
        :title="item.url"
        @click="item.url && emit('openHistoryUrl', item.url, false)"
        @auxclick.middle.prevent="item.url && emit('openHistoryUrl', item.url, true)"
        @contextmenu.prevent="emit('historyContextMenu', item, $event)"
      >
        <img class="fav" :src="getChromeFaviconUrl(item.url, 32)" alt="" />
        <span class="title">{{ item.title || item.url }}</span>
        <span class="time">{{ formatTime(item.lastVisitTime) }}</span>
      </div>
    </template>

    <div v-if="flatRows.length === 0" class="empty">
      {{ isSearching ? 'No matching results.' : 'Type to search…' }}
    </div>
  </div>
</template>

<style scoped>
.list-view {
  flex: 1;
  overflow-y: auto;
  padding: 4px 0 12px;
}

.section-label {
  padding: 8px 10px 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}

.row {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--tab-h);
  padding: 0 8px;
  margin: 1px 4px;
  border-radius: 6px;
  cursor: pointer;
  user-select: none;
}

.row:hover {
  background: var(--bg-hover);
}

.row.active {
  background: var(--bg-active);
  font-weight: 500;
}

.row.discarded {
  opacity: 0.58;
}

.row.search-focus {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
  background: var(--bg-selected);
}

.row.active.search-focus {
  background: var(--bg-active);
}

.fav {
  width: var(--icon-size);
  height: var(--icon-size);
  border-radius: 3px;
  flex-shrink: 0;
  object-fit: contain;
}

.fav-fallback {
  width: var(--icon-size);
  height: var(--icon-size);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  flex-shrink: 0;
}

.title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.group-chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 11px;
  padding: 0 6px;
  height: 18px;
  border-radius: 99px;
  background: var(--bg-subtle);
  color: var(--text-muted);
  max-width: 110px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.chip-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}

.time {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.empty {
  padding: 28px 16px;
  text-align: center;
  color: var(--text-muted);
}
</style>
