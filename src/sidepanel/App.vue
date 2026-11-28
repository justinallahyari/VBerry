<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { SavedPanel, TabTreeMap, VBerrySnapshot } from '@/shared/types'
import {
  downloadTextFile,
  getChromeFaviconUrl,
  loadSavedPanels,
  loadSnapshots,
  loadVirtualGroupMap,
  recordRecentBookmark,
  saveSavedPanels,
  saveSnapshots,
  saveTreeMeta,
} from '@/shared/storage'
import { createNewTab, getTargetWindowId } from '@/shared/env'
import { rankSearchItems } from '@/shared/search'
import {
  buildTabTree,
  computeTabDropIndex,
  getSubtreeIds,
  indentTab,
  outdentTab,
  toggleFold,
} from '@/shared/tree'
import {
  assignTabsToVirtualGroup,
  bookmarkGroupTabs,
  captureSnapshot,
  createGroupWithTab,
  discardTabs,
  materializeSavedPanel,
  moveTabsToGroup,
  moveTabsToSavedPanel,
  pickNextGroupColor,
  restoreSnapshot,
  restoreSnapshotGroup,
  UNGROUPED_ID,
} from '@/shared/groups'
import {
  countFolderItems,
  isRootBookmarkFolder,
  normalizeBookmarkUrl,
  sortFolderBookmarks,
  type BookmarkFolderOption,
} from '@/shared/bookmarks'
import { snapshotToMarkdown } from '@/shared/sidebery-import'
import { useChromeWindow } from './composables/useChromeWindow'
import TabTreeView from './components/TabTreeView.vue'
import UnifiedSearchView from './components/UnifiedSearchView.vue'
import BookmarksView from './components/BookmarksView.vue'
import HistoryView from './components/HistoryView.vue'
import SnapshotsView from './components/SnapshotsView.vue'
import GroupModal, { type GroupModalState } from './components/GroupModal.vue'
import BookmarkModal, { type BookmarkModalState } from './components/BookmarkModal.vue'
import SidePanelMenus, {
  type GroupMenuPayload,
  type GroupMenuState,
  type ItemMenuPayload,
  type ItemMenuState,
  type TabMenuState,
} from './components/SidePanelMenus.vue'
import { vAutofocus } from '@/popup/autofocus'

const props = withDefaults(
  defineProps<{
    mode?: 'sidepanel' | 'popup'
  }>(),
  { mode: 'sidepanel' }
)

const isPopup = props.mode === 'popup'

const searchQuery = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchCursor = ref<number>(-1)
const selectedIds = ref<Set<number>>(new Set())
const lastClickedId = ref<number | null>(null)
const dragOverPanelKey = ref<string | null>(null)

const unifiedSearchViewRef = ref<InstanceType<typeof UnifiedSearchView> | null>(null)
const bookmarksViewRef = ref<InstanceType<typeof BookmarksView> | null>(null)
const historyViewRef = ref<InstanceType<typeof HistoryView> | null>(null)
const snapshotsViewRef = ref<InstanceType<typeof SnapshotsView> | null>(null)

const groupModal = ref<GroupModalState | null>(null)
const bookmarkModal = ref<BookmarkModalState | null>(null)
const bookmarkModalFolders = ref<BookmarkFolderOption[]>([])
const tabMenu = ref<TabMenuState | null>(null)
const groupMenu = ref<GroupMenuState | null>(null)
const itemMenu = ref<ItemMenuState | null>(null)

async function focusSearchBox() {
  await nextTick()
  searchInputRef.value?.focus({ preventScroll: true })
}

function clearSearchBox() {
  searchQuery.value = ''
  searchCursor.value = -1
  void focusSearchBox()
}

const {
  windowId,
  tabs,
  groups,
  savedPanels,
  treeMeta,
  virtualGroupMap,
  settings,
  activeView,
  pinnedTabs,
  ungroupedTabs,
  tabsByGroupId,
  tabsBySavedId,
  unmaterializedSavedPanels,
  activeGroupTitle,
  refreshChromeState,
  scheduleActiveSyncAfterRemove,
  selectView,
  openNewTabInActiveView,
  openUrlInSpecificTarget,
} = useChromeWindow({
  mode: props.mode,
  onCommand(command) {
    if (!isPopup && command === 'new_tab_in_panel') {
      void openNewTabInActiveView()
    }
  },
  onTabActivatedReset(tabId) {
    lastClickedId.value = tabId
    selectedIds.value = new Set()
  },
  onViewChanged() {
    selectedIds.value = new Set()
    if (settings.value.clearSearchOnPanelSwitch) {
      searchQuery.value = ''
    }
    searchCursor.value =
      settings.value.autoHighlightSearchMatch && searchQuery.value.trim() ? 0 : -1
    if (isPopup && settings.value.focusSearchOnPanelSwitch) {
      void focusSearchBox()
    }
  },
})

const activeTabList = computed(() => {
  const q = searchQuery.value.trim()
  const view = activeView.value

  let panelList: chrome.tabs.Tab[] = []
  if (view.kind === 'ungrouped') {
    panelList = ungroupedTabs.value
  } else if (view.kind === 'group') {
    panelList = tabsByGroupId.value.get(view.groupId) ?? []
  } else if (view.kind === 'saved') {
    panelList = tabsBySavedId.value.get(view.savedId) ?? []
  }

  if (q) {
    const pool = settings.value.searchAllGroups
      ? tabs.value.filter(t => !t.pinned)
      : panelList
    const ranked = rankSearchItems(pool, q, t => ({
      title: t.title,
      url: t.url || t.pendingUrl,
      tieBreaker: (t.active ? 1e12 : 0) + (t.lastAccessed ?? 0),
    }))
    // Render search results flat in likelihood order (index 0 = most likely match)
    return buildTabTree(ranked, {})
  }

  return buildTabTree(panelList, treeMeta.value)
})

const visibleTabNodes = computed(() => activeTabList.value.filter(n => !n.hidden))

const isTabView = computed(() => {
  const kind = activeView.value.kind
  return kind === 'ungrouped' || kind === 'group' || kind === 'saved'
})

const highlightedTabId = computed<number | null>(() => {
  if (searchCursor.value < 0 || !isTabView.value) return null
  const list = visibleTabNodes.value
  if (!list.length) return null
  const idx = Math.min(searchCursor.value, list.length - 1)
  return list[idx]?.id ?? null
})

const searchPlaceholder = computed(() => {
  const kind = activeView.value.kind
  if (kind === 'search') {
    const parts: string[] = []
    if (settings.value.unifiedSearchTabs) parts.push('tabs')
    if (settings.value.unifiedSearchBookmarks) parts.push('bookmarks')
    if (settings.value.unifiedSearchHistory) parts.push('history')
    return parts.length ? `Search ${parts.join(', ')}…` : 'Search…'
  }
  if (kind === 'bookmarks') return 'Search bookmarks…'
  if (kind === 'history') return 'Search history…'
  return 'Search tabs…'
})

watch(searchQuery, q => {
  searchCursor.value = settings.value.autoHighlightSearchMatch && q.trim() ? 0 : -1
})

watch(
  () => visibleTabNodes.value.length,
  len => {
    if (isTabView.value && searchCursor.value >= len) {
      searchCursor.value = len - 1
    }
  }
)

function getSearchableCount(): number {
  const view = activeView.value
  if (view.kind === 'search') return unifiedSearchViewRef.value?.getResultCount() ?? 0
  if (view.kind === 'bookmarks') return bookmarksViewRef.value?.getResultCount() ?? 0
  if (view.kind === 'history') return historyViewRef.value?.getResultCount() ?? 0
  if (view.kind === 'snapshots') return 0
  return visibleTabNodes.value.length
}

function moveSearchCursor(delta: 1 | -1) {
  const count = getSearchableCount()
  if (count <= 0) {
    searchCursor.value = -1
    return
  }
  if (searchCursor.value < 0) {
    searchCursor.value = delta > 0 ? 0 : count - 1
    return
  }
  searchCursor.value = (searchCursor.value + delta + count) % count
}

async function openUrlFromSearchView(url: string, background: boolean) {
  await openNewTabInActiveView(url, background)
  if (isPopup && !background) window.close()
}

async function openBookmarkUrl(url: string, background: boolean) {
  await recordRecentBookmark(url)
  await openUrlFromSearchView(url, background)
}

async function activateSearchSelection() {
  const count = getSearchableCount()
  if (count <= 0) return
  const idx = searchCursor.value < 0 ? 0 : Math.min(searchCursor.value, count - 1)
  const view = activeView.value
  const clearAfter = () => {
    if (settings.value.clearSearchOnSelect) {
      searchQuery.value = ''
      searchCursor.value = -1
    }
  }

  if (view.kind === 'search') {
    const activated = unifiedSearchViewRef.value?.activateIndex(idx)
    if (!activated) return
    clearAfter()
    if (activated.kind === 'tab') {
      await chrome.tabs.update(activated.tabId, { active: true }).catch(() => {})
      if (isPopup) window.close()
    }
    return
  }

  if (view.kind === 'bookmarks') {
    if (bookmarksViewRef.value?.activateIndex(idx)) clearAfter()
    return
  }

  if (view.kind === 'history') {
    if (historyViewRef.value?.activateIndex(idx)) clearAfter()
    return
  }

  if (view.kind !== 'snapshots') {
    const node = visibleTabNodes.value[idx]
    if (node) {
      clearAfter()
      await chrome.tabs.update(node.id, { active: true }).catch(() => {})
      if (isPopup) window.close()
    }
  }
}

function closeSelectedTabsByKey(e: KeyboardEvent): boolean {
  if (!isTabView.value || e.ctrlKey || e.metaKey || e.altKey) return false
  if (highlightedTabId.value !== null) {
    e.preventDefault()
    void closeTab(highlightedTabId.value)
    return true
  }
  if (selectedIds.value.size > 0) {
    e.preventDefault()
    void closeTab([...selectedIds.value][0])
    return true
  }
  return false
}

function onSearchKeyDown(e: KeyboardEvent) {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    moveSearchCursor(1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    moveSearchCursor(-1)
  } else if (e.key === 'Enter') {
    if (searchCursor.value >= 0 || searchQuery.value.trim()) {
      e.preventDefault()
      void activateSearchSelection()
    }
  } else if (isPopup && e.key === 'Backspace' && !searchQuery.value) {
    closeSelectedTabsByKey(e)
  } else if (e.key === 'Escape') {
    if (searchQuery.value) {
      e.preventDefault()
      searchQuery.value = ''
      searchCursor.value = -1
    } else if (isPopup) {
      e.preventDefault()
      window.close()
    }
  }
}

// Tab list interactions
async function activateTab(tabId: number, e?: MouseEvent) {
  if (e && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    const next = new Set(selectedIds.value)
    if (next.has(tabId)) next.delete(tabId)
    else next.add(tabId)
    selectedIds.value = next
    lastClickedId.value = tabId
    return
  }

  if (e && e.shiftKey) {
    e.preventDefault()
    const visible = activeTabList.value.filter(n => !n.hidden).map(n => n.id)
    const activeId = tabs.value.find(t => t.active)?.id ?? null
    const anchorId =
      selectedIds.value.size > 0
        ? (lastClickedId.value ?? activeId)
        : (activeId ?? lastClickedId.value)
    const a = anchorId !== null ? visible.indexOf(anchorId) : -1
    const b = visible.indexOf(tabId)
    if (a !== -1 && b !== -1) {
      const [start, end] = a < b ? [a, b] : [b, a]
      selectedIds.value = new Set(visible.slice(start, end + 1))
      lastClickedId.value = anchorId
    } else {
      selectedIds.value = new Set([tabId])
      lastClickedId.value = tabId
    }
    return
  }

  selectedIds.value = new Set()
  lastClickedId.value = tabId
  if (settings.value.clearSearchOnSelect && searchQuery.value) {
    searchQuery.value = ''
    searchCursor.value = -1
  }
  await chrome.tabs.update(tabId, { active: true }).catch(() => {})
  if (isPopup) window.close()
}

async function closeTab(tabId: number) {
  const ids = selectedIds.value.has(tabId) ? [...selectedIds.value] : [tabId]
  selectedIds.value = new Set()
  try {
    await chrome.tabs.remove(ids)
    const removed = new Set(ids)
    tabs.value = tabs.value.filter(t => t.id === undefined || !removed.has(t.id))
  } catch {
    // Ignore if tab was already closed
  }
  scheduleActiveSyncAfterRemove(ids)
}

async function handleToggleFold(tabId: number) {
  const next = toggleFold(tabId, treeMeta.value)
  treeMeta.value = next
  await saveTreeMeta(next)
}

async function handleToggleMute(tab: chrome.tabs.Tab) {
  if (tab.id === undefined) return
  await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted }).catch(() => {})
}

async function handleDropTab(
  draggedId: number,
  targetId: number,
  position: 'before' | 'into' | 'after'
) {
  const draggedTab = tabs.value.find(t => t.id === draggedId)
  const targetTab = tabs.value.find(t => t.id === targetId)
  if (!draggedTab || !targetTab || draggedId === targetId) return

  const subtreeIds = getSubtreeIds(draggedId, tabs.value, treeMeta.value)
  if (subtreeIds.includes(targetId)) return

  if (draggedTab.groupId !== targetTab.groupId) {
    await moveTabsToGroup(subtreeIds, targetTab.groupId).catch(() => {})
  }
  const targetVirtual = virtualGroupMap.value[targetId] ?? null
  if ((virtualGroupMap.value[draggedId] ?? null) !== targetVirtual) {
    virtualGroupMap.value = await assignTabsToVirtualGroup(subtreeIds, targetVirtual)
  }

  const targetIdx = computeTabDropIndex(
    tabs.value,
    treeMeta.value,
    subtreeIds,
    targetId,
    position
  )
  await chrome.tabs.move(subtreeIds, { index: targetIdx }).catch(() => {})

  const nextMeta: TabTreeMap = { ...treeMeta.value }
  if (position === 'into') {
    nextMeta[draggedId] = { ...nextMeta[draggedId], parentId: targetId }
    nextMeta[targetId] = { ...nextMeta[targetId], folded: false }
  } else {
    const targetParent = nextMeta[targetId]?.parentId
    if (targetParent !== undefined && targetParent !== draggedId) {
      nextMeta[draggedId] = { ...nextMeta[draggedId], parentId: targetParent }
    } else if (nextMeta[draggedId]) {
      const { parentId: _, ...rest } = nextMeta[draggedId]
      if (Object.keys(rest).length) nextMeta[draggedId] = rest
      else delete nextMeta[draggedId]
    }
  }
  treeMeta.value = nextMeta
  await saveTreeMeta(nextMeta)
}

async function handleDropOnPanel(e: DragEvent, targetGroupId: number | SavedPanel) {
  e.preventDefault()
  dragOverPanelKey.value = null
  const draggedId = Number(e.dataTransfer?.getData('text/vberry-tab-id'))
  if (!Number.isFinite(draggedId)) return

  const toMove = selectedIds.value.has(draggedId)
    ? [...selectedIds.value]
    : getSubtreeIds(draggedId, tabs.value, treeMeta.value)
  if (typeof targetGroupId === 'number') {
    await moveTabsToGroup(toMove, targetGroupId).catch(() => {})
    virtualGroupMap.value = await loadVirtualGroupMap()
  } else {
    if (windowId.value < 0) windowId.value = await getTargetWindowId()
    const groupId = await moveTabsToSavedPanel(windowId.value, toMove, targetGroupId)
    virtualGroupMap.value = await loadVirtualGroupMap()
    activeView.value =
      groupId !== null ? { kind: 'group', groupId } : { kind: 'saved', savedId: targetGroupId.id }
  }
  selectedIds.value = new Set()
}

// Group modal helpers
function openCreateGroupModal() {
  groupModal.value = {
    mode: 'create',
    title: '',
    color: pickNextGroupColor([
      ...groups.value.map(g => g.color),
      ...savedPanels.value.map(p => p.color),
    ]),
  }
}

async function submitGroupModal() {
  const m = groupModal.value
  if (!m) return
  const title = m.title.trim() || 'Group'
  groupModal.value = null

  if (m.mode === 'create') {
    if (windowId.value < 0) windowId.value = await getTargetWindowId()
    if (windowId.value < 0) return
    const res = await createGroupWithTab(windowId.value, title, m.color)
    if (res.groupId !== null) {
      activeView.value = { kind: 'group', groupId: res.groupId }
    } else if (res.savedPanelId) {
      savedPanels.value = await loadSavedPanels()
      virtualGroupMap.value = await loadVirtualGroupMap()
      activeView.value = { kind: 'saved', savedId: res.savedPanelId }
    }
    await refreshChromeState()
  } else if (m.mode === 'edit-native' && m.groupId !== undefined) {
    await chrome.tabGroups.update(m.groupId, { title, color: m.color }).catch(() => {})
    const oldGroup = groups.value.find(g => g.id === m.groupId)
    if (oldGroup) {
      const oldTitle = (oldGroup.title ?? '').trim().toLowerCase()
      const idx = savedPanels.value.findIndex(p => p.title.trim().toLowerCase() === oldTitle)
      if (idx !== -1) {
        savedPanels.value[idx] = { ...savedPanels.value[idx], title, color: m.color }
        await saveSavedPanels(savedPanels.value)
      }
    }
  } else if (m.mode === 'edit-saved' && m.savedId) {
    const next = savedPanels.value.map(p =>
      p.id === m.savedId ? { ...p, title, color: m.color } : p
    )
    savedPanels.value = next
    await saveSavedPanels(next)
  }
}

// Context menu helpers
function closeMenus() {
  tabMenu.value = null
  groupMenu.value = null
  itemMenu.value = null
}

function openTabContextMenu(tab: chrome.tabs.Tab, e: MouseEvent) {
  closeMenus()
  tabMenu.value = { tab, x: e.clientX, y: e.clientY }
}

function openGroupContextMenu(menu: GroupMenuPayload, e: MouseEvent) {
  closeMenus()
  groupMenu.value = { ...menu, x: e.clientX, y: e.clientY }
}

function openActivePanelContextMenu(e: MouseEvent) {
  const view = activeView.value
  if (view.kind === 'ungrouped') {
    openGroupContextMenu({ kind: 'ungrouped' }, e)
  } else if (view.kind === 'group') {
    const g = groups.value.find(x => x.id === view.groupId)
    if (g) openGroupContextMenu({ kind: 'native', group: g }, e)
  } else if (view.kind === 'saved') {
    const p = savedPanels.value.find(x => x.id === view.savedId)
    if (p) openGroupContextMenu({ kind: 'saved', panel: p }, e)
  }
}

function openItemContextMenu(payload: ItemMenuPayload, e: MouseEvent) {
  closeMenus()
  itemMenu.value = { ...payload, x: e.clientX, y: e.clientY }
}

const activeTabForBookmark = computed(() => {
  const t = tabs.value.find(tab => tab.active)
  const url = t?.url || t?.pendingUrl
  if (!t || !url) return null
  return { title: t.title || url, url }
})

function openAddBookmarkModal(parentId?: string, index?: number) {
  const folders = bookmarksViewRef.value?.getFolders() ?? []
  const resolvedParent = parentId || bookmarksViewRef.value?.getDefaultFolderId() || '1'
  bookmarkModalFolders.value = folders
  bookmarkModal.value = {
    mode: 'add-bookmark',
    title: '',
    url: '',
    parentId: resolvedParent,
    index,
    focusField: 'title',
  }
}

function openAddFolderModal(parentId?: string) {
  const folders = bookmarksViewRef.value?.getFolders() ?? []
  const resolvedParent = parentId || bookmarksViewRef.value?.getDefaultFolderId() || '1'
  bookmarkModalFolders.value = folders
  bookmarkModal.value = {
    mode: 'add-folder',
    title: '',
    url: '',
    parentId: resolvedParent,
    focusField: 'title',
  }
}

function openEditBookmarkModal(
  node: chrome.bookmarks.BookmarkTreeNode,
  focusField: 'title' | 'parent' = 'title'
) {
  if (isRootBookmarkFolder(node)) return
  const isFolder = !node.url
  const folders = bookmarksViewRef.value?.getFolders(isFolder ? node.id : undefined) ?? []
  const fallbackParent = bookmarksViewRef.value?.getDefaultFolderId() || '1'
  bookmarkModalFolders.value = folders
  bookmarkModal.value = {
    mode: isFolder ? 'edit-folder' : 'edit-bookmark',
    nodeId: node.id,
    originalParentId: node.parentId || fallbackParent,
    title: node.title || '',
    url: node.url || '',
    parentId: node.parentId || fallbackParent,
    focusField,
  }
}

async function bookmarkActiveTabInFolder(parentId?: string) {
  const active = activeTabForBookmark.value
  const resolvedParent = parentId || bookmarksViewRef.value?.getDefaultFolderId() || '1'
  if (!active?.url) {
    openAddBookmarkModal(resolvedParent)
    return
  }
  await chrome.bookmarks
    .create({
      parentId: resolvedParent,
      title: active.title || active.url,
      url: active.url,
    })
    .catch(() => {})
  bookmarksViewRef.value?.expandFolder(resolvedParent)
}

async function submitBookmarkModal() {
  const m = bookmarkModal.value
  if (!m) return
  const title = m.title.trim()
  if (!title) return

  if (m.mode === 'add-bookmark') {
    const url = normalizeBookmarkUrl(m.url)
    if (!url) return
    await chrome.bookmarks
      .create({
        parentId: m.parentId,
        title,
        url,
        ...(m.index !== undefined ? { index: m.index } : {}),
      })
      .catch(() => {})
    bookmarksViewRef.value?.expandFolder(m.parentId)
  } else if (m.mode === 'add-folder') {
    await chrome.bookmarks.create({ parentId: m.parentId, title }).catch(() => {})
    bookmarksViewRef.value?.expandFolder(m.parentId)
  } else if (m.mode === 'edit-bookmark' && m.nodeId) {
    const url = normalizeBookmarkUrl(m.url)
    if (!url) return
    await chrome.bookmarks.update(m.nodeId, { title, url }).catch(() => {})
    if (m.parentId && m.parentId !== m.originalParentId) {
      await chrome.bookmarks.move(m.nodeId, { parentId: m.parentId }).catch(() => {})
      bookmarksViewRef.value?.expandFolder(m.parentId)
    }
  } else if (m.mode === 'edit-folder' && m.nodeId) {
    await chrome.bookmarks.update(m.nodeId, { title }).catch(() => {})
    if (m.parentId && m.parentId !== m.originalParentId) {
      await chrome.bookmarks.move(m.nodeId, { parentId: m.parentId }).catch(() => {})
      bookmarksViewRef.value?.expandFolder(m.parentId)
    }
  }

  bookmarkModal.value = null
}

async function requestDiscardTabs(ids: number[]) {
  if (!ids.length) return
  const res = await chrome.runtime
    .sendMessage<{ ok?: boolean }>({
      type: 'vberry:discard-tabs',
      tabIds: ids,
      windowId: windowId.value,
    })
    .catch(() => null)
  if (!res?.ok) await discardTabs(ids, tabs.value, windowId.value)
}

async function requestRestoreSnapshot(snapshot: VBerrySnapshot, inNewWindow: boolean) {
  if (inNewWindow) {
    const res = await chrome.runtime
      .sendMessage<{ ok?: boolean }>({
        type: 'vberry:restore-snapshot',
        snapshot: JSON.parse(JSON.stringify(snapshot)),
        inNewWindow: true,
      })
      .catch(() => null)
    if (res?.ok) return
  }
  await restoreSnapshot(snapshot, inNewWindow)
}

function collectFolderUrls(node: chrome.bookmarks.BookmarkTreeNode): string[] {
  const urls: string[] = []
  if (node.url) urls.push(node.url)
  for (const child of node.children ?? []) urls.push(...collectFolderUrls(child))
  return urls
}

async function itemMenuAction(action: string, target?: number | SavedPanel) {
  const menu = itemMenu.value
  closeMenus()
  if (!menu) return

  const url =
    menu.kind === 'bookmark'
      ? menu.node.url
      : menu.kind === 'history'
        ? menu.item.url
        : menu.kind === 'session'
          ? menu.session.tab?.url
          : menu.kind === 'snapshot-tab'
            ? menu.tab.url
            : undefined

  switch (action) {
    case 'open':
      if (url) {
        if (menu.kind === 'bookmark') await recordRecentBookmark(url)
        await openNewTabInActiveView(url, false)
        if (isPopup) window.close()
      }
      return
    case 'open-bg':
      if (url) {
        if (menu.kind === 'bookmark') await recordRecentBookmark(url)
        await openNewTabInActiveView(url, true)
      }
      return
    case 'open-in-group':
      if (url && target !== undefined) {
        if (menu.kind === 'bookmark') await recordRecentBookmark(url)
        await openUrlInSpecificTarget(url, target, false)
        if (isPopup) window.close()
      }
      return
    case 'copy-url':
      if (url) await navigator.clipboard?.writeText(url).catch(() => {})
      return
    case 'open-folder-tabs':
      if (menu.kind === 'bookmark') {
        for (const u of collectFolderUrls(menu.node)) await openNewTabInActiveView(u, true)
      }
      return
    case 'open-folder-group':
      if (menu.kind === 'bookmark') {
        const urls = collectFolderUrls(menu.node)
        if (!urls.length) return
        if (windowId.value < 0) windowId.value = await getTargetWindowId()
        if (windowId.value < 0) return
        const color = pickNextGroupColor([
          ...groups.value.map(g => g.color),
          ...savedPanels.value.map(p => p.color),
        ])
        await restoreSnapshotGroup(
          {
            id: menu.node.id,
            title: menu.node.title || 'Bookmarks',
            color,
            tabs: urls.map(u => ({ url: u, title: u, level: 0 })),
          },
          windowId.value
        )
        savedPanels.value = await loadSavedPanels()
        virtualGroupMap.value = await loadVirtualGroupMap()
        await refreshChromeState()
      }
      return
    case 'edit-bookmark':
      if (menu.kind === 'bookmark') openEditBookmarkModal(menu.node, 'title')
      return
    case 'move-bookmark':
      if (menu.kind === 'bookmark') openEditBookmarkModal(menu.node, 'parent')
      return
    case 'add-bookmark-below':
      if (menu.kind === 'bookmark') {
        openAddBookmarkModal(
          menu.node.parentId,
          menu.node.index !== undefined ? menu.node.index + 1 : undefined
        )
      }
      return
    case 'reveal-bookmark':
      if (menu.kind === 'bookmark') {
        searchQuery.value = ''
        searchCursor.value = -1
        await nextTick()
        await bookmarksViewRef.value?.revealBookmark(menu.node.id)
      }
      return
    case 'add-bookmark-in-folder':
      if (menu.kind === 'bookmark') openAddBookmarkModal(menu.node.id)
      return
    case 'bookmark-active-in-folder':
      if (menu.kind === 'bookmark') await bookmarkActiveTabInFolder(menu.node.id)
      return
    case 'add-subfolder':
      if (menu.kind === 'bookmark') openAddFolderModal(menu.node.id)
      return
    case 'sort-folder-title':
      if (menu.kind === 'bookmark') await sortFolderBookmarks(menu.node.id, 'title')
      return
    case 'sort-folder-url':
      if (menu.kind === 'bookmark') await sortFolderBookmarks(menu.node.id, 'url')
      return
    case 'edit-folder':
      if (menu.kind === 'bookmark') openEditBookmarkModal(menu.node, 'title')
      return
    case 'add-bookmark-root':
      openAddBookmarkModal()
      return
    case 'bookmark-active-root':
      await bookmarkActiveTabInFolder()
      return
    case 'add-folder-root':
      openAddFolderModal()
      return
    case 'expand-all-folders':
      bookmarksViewRef.value?.expandAll()
      return
    case 'collapse-all-folders':
      bookmarksViewRef.value?.collapseAll()
      return
    case 'delete-bookmark':
      if (menu.kind === 'bookmark') {
        if (isRootBookmarkFolder(menu.node)) return
        if (!menu.node.url) {
          const count = countFolderItems(menu.node)
          const msg =
            count > 0
              ? `Delete folder "${menu.node.title}" and its ${count} item${count === 1 ? '' : 's'}?`
              : `Delete empty folder "${menu.node.title}"?`
          if (!confirm(msg)) return
          await chrome.bookmarks.removeTree(menu.node.id).catch(() => {})
        } else {
          await chrome.bookmarks.remove(menu.node.id).catch(() => {})
        }
      }
      return
    case 'delete-history':
      if (menu.kind === 'history' && menu.item.url) {
        await chrome.history.deleteUrl({ url: menu.item.url }).catch(() => {})
        await historyViewRef.value?.reload()
        await unifiedSearchViewRef.value?.reload()
      }
      return
    case 'restore-session':
      if (menu.kind === 'session') {
        const sid = menu.session.tab?.sessionId || menu.session.window?.sessionId
        if (sid) {
          await chrome.sessions.restore(sid).catch(() => {})
          await historyViewRef.value?.reload()
        }
      }
      return
    case 'snap-restore-new':
      if (menu.kind === 'snapshot') await requestRestoreSnapshot(menu.snapshot, true)
      return
    case 'snap-restore-here':
      if (menu.kind === 'snapshot') await requestRestoreSnapshot(menu.snapshot, false)
      return
    case 'snap-export-md':
      if (menu.kind === 'snapshot') {
        downloadTextFile(
          `vberry-snapshot-${menu.snapshot.id}.md`,
          snapshotToMarkdown(menu.snapshot),
          'text/markdown'
        )
      }
      return
    case 'snap-delete':
      if (menu.kind === 'snapshot') {
        const all = await loadSnapshots()
        await saveSnapshots(all.filter(s => s.id !== menu.snapshot.id))
        await snapshotsViewRef.value?.reload()
      }
      return
    case 'snap-restore-window-new':
    case 'snap-restore-window-here':
      if (menu.kind === 'snapshot-window') {
        await requestRestoreSnapshot(
          { id: `win_${Date.now()}`, time: Date.now(), windows: [menu.window] },
          action === 'snap-restore-window-new'
        )
      }
      return
    case 'snap-restore-group':
      if (menu.kind === 'snapshot-group') {
        if (windowId.value < 0) windowId.value = await getTargetWindowId()
        if (windowId.value >= 0) await restoreSnapshotGroup(menu.group, windowId.value)
      }
      return
  }
}

async function tabMenuAction(action: string, target?: number | SavedPanel) {
  const tab = tabMenu.value?.tab
  closeMenus()
  if (!tab || tab.id === undefined) return
  const ids = selectedIds.value.has(tab.id) ? [...selectedIds.value] : [tab.id]

  switch (action) {
    case 'new-child': {
      const created = await createNewTab({
        windowId: windowId.value,
        index: tab.index + 1,
        openerTabId: tab.id,
        active: true,
      })
      if (created.id !== undefined) {
        if (tab.groupId !== UNGROUPED_ID) {
          await chrome.tabs.group({ tabIds: created.id, groupId: tab.groupId }).catch(() => {})
        } else if (virtualGroupMap.value[tab.id]) {
          virtualGroupMap.value = await assignTabsToVirtualGroup(
            [created.id],
            virtualGroupMap.value[tab.id]
          )
        }
        const next: TabTreeMap = { ...treeMeta.value, [created.id]: { parentId: tab.id } }
        treeMeta.value = next
        await saveTreeMeta(next)
      }
      break
    }
    case 'duplicate':
      await chrome.tabs.duplicate(tab.id)
      break
    case 'pin':
      await Promise.allSettled(
        ids.map(id => {
          const t = tabs.value.find(x => x.id === id)
          return t ? chrome.tabs.update(id, { pinned: !t.pinned }) : Promise.resolve()
        })
      )
      break
    case 'mute':
      await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted }).catch(() => {})
      break
    case 'discard':
      await requestDiscardTabs(ids)
      break
    case 'indent': {
      const next = indentTab(tab.id, activeTabList.value, treeMeta.value)
      treeMeta.value = next
      await saveTreeMeta(next)
      break
    }
    case 'outdent': {
      const next = outdentTab(tab.id, treeMeta.value)
      treeMeta.value = next
      await saveTreeMeta(next)
      break
    }
    case 'move-group': {
      const allIds = ids.length > 1 ? ids : getSubtreeIds(tab.id, tabs.value, treeMeta.value)
      if (typeof target === 'number') {
        await moveTabsToGroup(allIds, target).catch(() => {})
        virtualGroupMap.value = await loadVirtualGroupMap()
      } else if (target) {
        await moveTabsToSavedPanel(windowId.value, allIds, target)
        virtualGroupMap.value = await loadVirtualGroupMap()
      }
      break
    }
    case 'close-branch': {
      const branch = getSubtreeIds(tab.id, tabs.value, treeMeta.value)
      await chrome.tabs.remove(branch).catch(() => {})
      scheduleActiveSyncAfterRemove(branch)
      break
    }
    case 'close':
      await chrome.tabs.remove(ids).catch(() => {})
      scheduleActiveSyncAfterRemove(ids)
      break
  }
  selectedIds.value = new Set()
}

async function groupMenuAction(action: string) {
  const menu = groupMenu.value
  closeMenus()
  if (!menu) return

  const panelTabs =
    menu.kind === 'ungrouped'
      ? ungroupedTabs.value
      : menu.kind === 'native'
        ? (tabsByGroupId.value.get(menu.group.id) ?? [])
        : (tabsBySavedId.value.get(menu.panel.id) ?? [])

  const panelTabIds = panelTabs.map(t => t.id).filter((id): id is number => id !== undefined)
  const panelTitle =
    menu.kind === 'ungrouped'
      ? 'Ungrouped'
      : menu.kind === 'native'
        ? menu.group.title || 'Group'
        : menu.panel.title

  switch (action) {
    case 'new-tab': {
      if (windowId.value < 0) windowId.value = await getTargetWindowId()
      if (windowId.value < 0) return
      if (menu.kind === 'native') {
        const tab = await createNewTab({ windowId: windowId.value, active: true })
        if (tab.id !== undefined) {
          await chrome.tabs.group({ tabIds: tab.id, groupId: menu.group.id }).catch(() => {})
        }
      } else if (menu.kind === 'saved') {
        const res = await materializeSavedPanel(windowId.value, menu.panel, undefined, true)
        if (res.groupId !== null) activeView.value = { kind: 'group', groupId: res.groupId }
        else {
          virtualGroupMap.value = await loadVirtualGroupMap()
          activeView.value = { kind: 'saved', savedId: res.savedPanelId }
        }
      } else {
        await createNewTab({ windowId: windowId.value, active: true })
      }
      return
    }
    case 'new-group':
      openCreateGroupModal()
      return
    case 'edit':
      if (menu.kind === 'native') {
        groupModal.value = {
          mode: 'edit-native',
          groupId: menu.group.id,
          title: menu.group.title ?? '',
          color: menu.group.color,
        }
      } else if (menu.kind === 'saved') {
        groupModal.value = {
          mode: 'edit-saved',
          savedId: menu.panel.id,
          title: menu.panel.title,
          color: menu.panel.color,
        }
      }
      return
    case 'toggle-collapse':
      if (menu.kind === 'native') {
        await chrome.tabGroups
          .update(menu.group.id, { collapsed: !menu.group.collapsed })
          .catch(() => {})
      }
      return
    case 'expand-all':
    case 'collapse-all': {
      const fold = action === 'collapse-all'
      const nodes = buildTabTree(panelTabs, treeMeta.value)
      const next: TabTreeMap = { ...treeMeta.value }
      for (const n of nodes) {
        if (n.hasChildren) next[n.id] = { ...next[n.id], folded: fold }
      }
      treeMeta.value = next
      await saveTreeMeta(next)
      return
    }
    case 'sort-title':
    case 'sort-url': {
      if (panelTabs.length < 2) return
      const startIndex = Math.min(...panelTabs.map(t => t.index))
      const sorted = [...panelTabs].sort((a, b) => {
        const av = (action === 'sort-title' ? a.title : a.url) || ''
        const bv = (action === 'sort-title' ? b.title : b.url) || ''
        return av.localeCompare(bv, undefined, { sensitivity: 'base' })
      })
      const ids = sorted.map(t => t.id).filter((id): id is number => id !== undefined)
      await chrome.tabs.move(ids, { index: startIndex }).catch(() => {})
      return
    }
    case 'dedupe': {
      const seen = new Set<string>()
      const dupes: number[] = []
      for (const t of panelTabs) {
        const url = t.url || t.pendingUrl
        if (!url || t.id === undefined) continue
        if (seen.has(url)) dupes.push(t.id)
        else seen.add(url)
      }
      if (dupes.length) await chrome.tabs.remove(dupes).catch(() => {})
      return
    }
    case 'mute-all': {
      const anyUnmuted = panelTabs.some(t => !t.mutedInfo?.muted)
      await Promise.allSettled(
        panelTabs
          .filter(t => t.id !== undefined)
          .map(t => chrome.tabs.update(t.id!, { muted: anyUnmuted }))
      )
      return
    }
    case 'discard': {
      const inactiveIds = panelTabs
        .filter(t => t.id !== undefined && !t.active && !t.discarded)
        .map(t => t.id!)
      await requestDiscardTabs(inactiveIds)
      return
    }
    case 'bookmark':
      if (panelTabs.length) await bookmarkGroupTabs(panelTitle, panelTabs)
      return
    case 'snapshot':
      await captureSnapshot()
      return
    case 'ungroup':
      if (menu.kind === 'native' && panelTabIds.length) {
        await chrome.tabs.ungroup(panelTabIds).catch(() => {})
      } else if (menu.kind === 'saved' && panelTabIds.length) {
        virtualGroupMap.value = await assignTabsToVirtualGroup(panelTabIds, null)
      }
      return
    case 'close-all':
      if (!panelTabIds.length) return
      if (settings.value.confirmCloseGroup && panelTabIds.length > 1) {
        if (!confirm(`Close all ${panelTabIds.length} tabs in "${panelTitle}"?`)) return
      }
      await chrome.tabs.remove(panelTabIds).catch(() => {})
      return
    case 'delete-panel': {
      if (menu.kind !== 'saved') return
      if (panelTabIds.length) {
        virtualGroupMap.value = await assignTabsToVirtualGroup(panelTabIds, null)
      }
      const next = savedPanels.value.filter(p => p.id !== menu.panel.id)
      savedPanels.value = next
      await saveSavedPanels(next)
      if (activeView.value.kind === 'saved' && activeView.value.savedId === menu.panel.id) {
        activeView.value = { kind: 'ungrouped' }
      }
      return
    }
  }
}

function openOptions() {
  void chrome.runtime.openOptionsPage()
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    const hadOverlay = Boolean(
      tabMenu.value || groupMenu.value || itemMenu.value || groupModal.value || bookmarkModal.value
    )
    closeMenus()
    if (bookmarkModal.value) bookmarkModal.value = null
    if (groupModal.value) groupModal.value = null
    if (isPopup && !hadOverlay && !searchQuery.value) {
      e.preventDefault()
      window.close()
    }
    return
  }

  if (!isPopup || groupModal.value || bookmarkModal.value) return

  // Native Tab / Shift+Tab moves between UI controls and Enter/Space activates focused buttons.
  // ArrowUp/ArrowDown always navigate search results; printable non-space keys focus search.
  const el = searchInputRef.value
  if (!el || document.activeElement === el) return

  const activeTag = document.activeElement?.tagName
  const isTextControl =
    activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT'
  const isButtonControl = activeTag === 'BUTTON' || activeTag === 'A'

  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    if (!isTextControl) {
      el.focus({ preventScroll: true })
      onSearchKeyDown(e)
    }
    return
  }

  if (e.key === 'Enter' && !isTextControl && !isButtonControl) {
    if (searchCursor.value >= 0 || searchQuery.value.trim()) {
      el.focus({ preventScroll: true })
      onSearchKeyDown(e)
    }
    return
  }

  if (e.key === 'Backspace' && !isTextControl) {
    closeSelectedTabsByKey(e)
    return
  }

  if (
    !isTextControl &&
    e.key.length === 1 &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !(isButtonControl && e.key === ' ')
  ) {
    el.focus({ preventScroll: true })
  }
}

onMounted(() => {
  window.addEventListener('click', closeMenus)
  window.addEventListener('blur', closeMenus)
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('visibilitychange', closeMenus)
})

onUnmounted(() => {
  window.removeEventListener('click', closeMenus)
  window.removeEventListener('blur', closeMenus)
  window.removeEventListener('keydown', onKeyDown)
  document.removeEventListener('visibilitychange', closeMenus)
})
</script>

<template>
  <div class="shell">
    <!-- Top Tab Group & Utility Panel Bar -->
    <header class="panel-bar">
      <div class="panel-strip">
        <button
          type="button"
          class="panel-pill"
          :class="{
            active: activeView.kind === 'ungrouped',
            'drag-over': dragOverPanelKey === 'ungrouped',
          }"
          style="--pill-color: var(--accent)"
          title="Ungrouped Tabs (Right-click for panel actions)"
          @click="selectView({ kind: 'ungrouped' })"
          @contextmenu.prevent="openGroupContextMenu({ kind: 'ungrouped' }, $event)"
          @dragover.prevent="dragOverPanelKey = 'ungrouped'"
          @dragleave="dragOverPanelKey = null"
          @drop="handleDropOnPanel($event, UNGROUPED_ID)"
        >
          <span class="pill-label">Tabs</span>
          <span v-if="settings.showTabCounts" class="pill-count">{{ ungroupedTabs.length }}</span>
        </button>

        <button
          v-for="g in groups"
          :key="g.id"
          type="button"
          class="panel-pill"
          :class="{
            active: activeView.kind === 'group' && activeView.groupId === g.id,
            'drag-over': dragOverPanelKey === `g_${g.id}`,
          }"
          :style="{ '--pill-color': `var(--grp-${g.color})` }"
          :title="`${g.title || 'Group'} (Right-click for group actions)`"
          @click="selectView({ kind: 'group', groupId: g.id })"
          @contextmenu.prevent="openGroupContextMenu({ kind: 'native', group: g }, $event)"
          @dragover.prevent="dragOverPanelKey = `g_${g.id}`"
          @dragleave="dragOverPanelKey = null"
          @drop="handleDropOnPanel($event, g.id)"
        >
          <span class="pill-label">{{ g.title || 'Group' }}</span>
          <span v-if="settings.showTabCounts" class="pill-count">
            {{ tabsByGroupId.get(g.id)?.length ?? 0 }}
          </span>
        </button>

        <button
          v-for="sp in unmaterializedSavedPanels"
          :key="sp.id"
          type="button"
          class="panel-pill"
          :class="{
            active: activeView.kind === 'saved' && activeView.savedId === sp.id,
            'saved-empty': (tabsBySavedId.get(sp.id)?.length ?? 0) === 0,
            'drag-over': dragOverPanelKey === `s_${sp.id}`,
          }"
          :style="{ '--pill-color': `var(--grp-${sp.color})` }"
          :title="`${sp.title} (Right-click for group actions)`"
          @click="selectView({ kind: 'saved', savedId: sp.id })"
          @contextmenu.prevent="openGroupContextMenu({ kind: 'saved', panel: sp }, $event)"
          @dragover.prevent="dragOverPanelKey = `s_${sp.id}`"
          @dragleave="dragOverPanelKey = null"
          @drop="handleDropOnPanel($event, sp)"
        >
          <span class="pill-label">{{ sp.title }}</span>
          <span
            v-if="settings.showTabCounts && (tabsBySavedId.get(sp.id)?.length ?? 0) > 0"
            class="pill-count"
          >
            {{ tabsBySavedId.get(sp.id)?.length }}
          </span>
        </button>

        <button
          type="button"
          class="icon-btn"
          title="New Tab Group"
          @click="openCreateGroupModal"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 2.75v10.5M2.75 8h10.5"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <div class="utility-strip">
        <button
          v-if="settings.unifiedSearch && (isPopup || !settings.hideUnifiedSearchInSidePanel)"
          type="button"
          class="icon-btn"
          :class="{ active: activeView.kind === 'search' }"
          title="Unified Search"
          @click="selectView({ kind: 'search' })"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="7" cy="7" r="4.8" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path
              d="m10.7 10.7 3.4 3.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
            />
          </svg>
        </button>
        <button
          v-if="settings.showBookmarksPanel"
          type="button"
          class="icon-btn"
          :class="{ active: activeView.kind === 'bookmarks' }"
          title="Bookmarks"
          @click="selectView({ kind: 'bookmarks' })"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4.2 2.2h7.6a1 1 0 0 1 1 1v10.6L8 11.1l-4.8 2.7V3.2a1 1 0 0 1 1-1Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          v-if="settings.showHistoryPanel"
          type="button"
          class="icon-btn"
          :class="{ active: activeView.kind === 'history' }"
          title="History & Recently Closed"
          @click="selectView({ kind: 'history' })"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" stroke-width="1.6" />
            <path
              d="M8 4.2v4l2.8 1.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.6"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          v-if="settings.showSnapshotsPanel"
          type="button"
          class="icon-btn"
          :class="{ active: activeView.kind === 'snapshots' }"
          title="Snapshots"
          @click="selectView({ kind: 'snapshots' })"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <rect
              x="1.5"
              y="3.5"
              width="13"
              height="10"
              rx="2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
            />
            <path
              d="M5.5 3.5 6.6 1.8h2.8l1.1 1.7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
            <circle cx="8" cy="8.5" r="2.4" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
        <button
          type="button"
          class="icon-btn"
          title="VBerry Settings & Sidebery Import"
          @click="openOptions"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M6.7 1.4h2.6l.4 1.8a5.2 5.2 0 0 1 1.3.7l1.7-.6 1.3 2.2-1.3 1.2c.1.4.1.9 0 1.4l1.3 1.2-1.3 2.2-1.7-.6a5.2 5.2 0 0 1-1.3.7l-.4 1.8H6.7l-.4-1.8a5.2 5.2 0 0 1-1.3-.7l-1.7.6L2 9.3l1.3-1.2a4.6 4.6 0 0 1 0-1.4L2 5.5l1.3-2.2 1.7.6a5.2 5.2 0 0 1 1.3-.7Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linejoin="round"
            />
            <circle cx="8" cy="7.4" r="2.1" fill="none" stroke="currentColor" stroke-width="1.5" />
          </svg>
        </button>
      </div>
    </header>

    <!-- Search Bar -->
    <form v-if="activeView.kind !== 'snapshots'" role="search" class="search-bar" @submit.prevent>
      <div class="search-field">
        <svg class="search-glyph" viewBox="0 0 16 16" aria-hidden="true">
          <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.5" />
          <path
            d="m10.5 10.5 3.2 3.2"
            fill="none"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <input
          id="vberry-search"
          ref="searchInputRef"
          v-model="searchQuery"
          v-autofocus="isPopup"
          class="search-input"
          type="search"
          name="searchText"
          autocomplete="off"
          :placeholder="searchPlaceholder"
          @keydown="onSearchKeyDown"
        />
        <button
          v-if="searchQuery"
          type="button"
          tabindex="-1"
          class="search-clear"
          title="Clear search"
          @mousedown.prevent
          @click="clearSearchBox"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4.5 4.5l7 7m0-7-7 7"
              fill="none"
              stroke="currentColor"
              stroke-width="1.65"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </form>

    <!-- Pinned Tabs Strip -->
    <div v-if="pinnedTabs.length && isTabView" class="pinned-strip">
      <button
        v-for="pt in pinnedTabs"
        :key="pt.id"
        type="button"
        class="pinned-tile"
        :class="{ active: pt.active, discarded: pt.discarded, audible: pt.audible }"
        :title="pt.title || pt.url"
        @mousedown.left="pt.id !== undefined && activateTab(pt.id, $event)"
        @keydown.enter.prevent="pt.id !== undefined && activateTab(pt.id)"
        @keydown.space.prevent="pt.id !== undefined && activateTab(pt.id)"
        @auxclick.middle.prevent="pt.id !== undefined && closeTab(pt.id)"
        @contextmenu.prevent="openTabContextMenu(pt, $event)"
      >
        <img
          v-if="getChromeFaviconUrl(pt.url || pt.pendingUrl, 32) || pt.favIconUrl"
          :src="getChromeFaviconUrl(pt.url || pt.pendingUrl, 32) || pt.favIconUrl"
          alt=""
        />
        <svg v-else class="pinned-fallback" viewBox="0 0 16 16" aria-hidden="true">
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
        <span v-if="pt.audible && !pt.mutedInfo?.muted" class="pinned-audio" />
      </button>
    </div>

    <!-- Main View -->
    <div class="view-body">
      <UnifiedSearchView
        v-if="activeView.kind === 'search'"
        ref="unifiedSearchViewRef"
        :query="searchQuery"
        :active-index="searchCursor"
        :tabs="tabs"
        :groups="groups"
        :saved-panels="savedPanels"
        :virtual-group-map="virtualGroupMap"
        :settings="settings"
        @activate-tab="activateTab"
        @open-bookmark-url="(url, bg) => openBookmarkUrl(url, bg)"
        @open-history-url="(url, bg) => openUrlFromSearchView(url, bg)"
        @tab-context-menu="openTabContextMenu"
        @bookmark-context-menu="
          (node, e) => openItemContextMenu({ kind: 'bookmark', node, fromSearch: false }, e)
        "
        @history-context-menu="(item, e) => openItemContextMenu({ kind: 'history', item }, e)"
      />
      <BookmarksView
        v-else-if="activeView.kind === 'bookmarks'"
        ref="bookmarksViewRef"
        :query="searchQuery"
        :active-index="searchCursor"
        :can-bookmark-active-tab="Boolean(activeTabForBookmark?.url)"
        @open-url="(url, bg) => openBookmarkUrl(url, bg)"
        @context-menu="
          (node, e) =>
            openItemContextMenu({ kind: 'bookmark', node, fromSearch: Boolean(searchQuery.trim()) }, e)
        "
        @panel-context-menu="e => openItemContextMenu({ kind: 'bookmark-panel' }, e)"
        @add-bookmark="parentId => openAddBookmarkModal(parentId)"
        @add-folder="parentId => openAddFolderModal(parentId)"
        @bookmark-active-tab="parentId => bookmarkActiveTabInFolder(parentId)"
        @edit-bookmark="node => openEditBookmarkModal(node)"
      />
      <HistoryView
        v-else-if="activeView.kind === 'history'"
        ref="historyViewRef"
        :query="searchQuery"
        :active-index="searchCursor"
        :history-days="settings.historyDays"
        @open-url="(url, bg) => openUrlFromSearchView(url, bg)"
        @context-menu="(item, e) => openItemContextMenu({ kind: 'history', item }, e)"
        @session-context-menu="(session, e) => openItemContextMenu({ kind: 'session', session }, e)"
      />
      <SnapshotsView
        v-else-if="activeView.kind === 'snapshots'"
        ref="snapshotsViewRef"
        @context-menu="(target, e) => openItemContextMenu(target, e)"
      />
      <TabTreeView
        v-else
        :nodes="activeTabList"
        :selected-ids="selectedIds"
        :highlighted-id="highlightedTabId"
        :group-title="activeGroupTitle"
        :is-saved-empty="activeView.kind === 'saved' && activeTabList.length === 0"
        :is-filtering="Boolean(searchQuery.trim())"
        @activate="activateTab"
        @close="closeTab"
        @toggle-fold="handleToggleFold"
        @toggle-mute="handleToggleMute"
        @new-tab="openNewTabInActiveView()"
        @clear-search="clearSearchBox"
        @context-menu="openTabContextMenu"
        @panel-context-menu="openActivePanelContextMenu"
        @drop-tab="handleDropTab"
      />
    </div>

    <GroupModal
      :modal="groupModal"
      @close="groupModal = null"
      @submit="submitGroupModal"
      @update:title="v => groupModal && (groupModal.title = v)"
      @update:color="v => groupModal && (groupModal.color = v)"
    />

    <BookmarkModal
      :modal="bookmarkModal"
      :folders="bookmarkModalFolders"
      :active-tab="activeTabForBookmark"
      @close="bookmarkModal = null"
      @submit="submitBookmarkModal"
      @update:title="v => bookmarkModal && (bookmarkModal.title = v)"
      @update:url="v => bookmarkModal && (bookmarkModal.url = v)"
      @update:parent-id="v => bookmarkModal && (bookmarkModal.parentId = v)"
    />

    <SidePanelMenus
      :tab-menu="tabMenu"
      :group-menu="groupMenu"
      :item-menu="itemMenu"
      :groups="groups"
      :unmaterialized-saved-panels="unmaterializedSavedPanels"
      @tab-action="tabMenuAction"
      @group-action="groupMenuAction"
      @item-action="itemMenuAction"
    />

    <footer v-if="isPopup" class="popup-tip">
      <span><kbd>Tab</kbd> navigate controls</span>
      <span><kbd>↑↓</kbd> {{ isTabView ? 'select tab' : 'select result' }}</span>
      <span><kbd>Enter</kbd> open</span>
      <span v-if="isTabView"><kbd>Backspace</kbd> close tab</span>
      <span><kbd>Esc</kbd> close</span>
    </footer>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg);
}

.panel-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 5px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-subtle);
}

.panel-strip {
  display: flex;
  align-items: center;
  gap: 4px;
  overflow-x: auto;
  flex: 1;
  scrollbar-width: none;
}

.panel-strip::-webkit-scrollbar {
  display: none;
}

.utility-strip {
  display: flex;
  align-items: center;
  gap: 2px;
  flex-shrink: 0;
  padding-left: 5px;
  border-left: 1px solid var(--border);
}

.panel-pill {
  --pill-color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 27px;
  padding: 0 9px;
  border: 1px solid color-mix(in srgb, var(--pill-color) 62%, var(--border));
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  font-size: 12px;
  font-weight: 500;
  transition: background-color 0.1s ease, border-color 0.1s ease, color 0.1s ease, box-shadow 0.1s ease;
}

.panel-pill:hover {
  border-color: var(--pill-color);
  background: color-mix(in srgb, var(--pill-color) 10%, var(--bg-hover));
  color: var(--text);
}

.panel-pill.active {
  border-color: var(--pill-color);
  background: color-mix(in srgb, var(--pill-color) 15%, var(--surface));
  color: var(--text);
  box-shadow: inset 0 0 0 0.5px var(--pill-color), var(--shadow-sm);
}

.panel-pill.active .pill-count {
  color: var(--text);
  opacity: 0.82;
}

.panel-pill.saved-empty:not(.active) {
  opacity: 0.72;
}

.panel-pill.drag-over {
  border-color: var(--pill-color);
  outline: 2px solid var(--pill-color);
  background: color-mix(in srgb, var(--pill-color) 18%, var(--surface));
  color: var(--text);
}

.pill-label {
  max-width: 98px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill-count {
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
}

.icon-btn {
  width: calc(var(--ui-icon-size) + 9px);
  height: calc(var(--ui-icon-size) + 9px);
  padding: 0;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: background-color 0.1s ease, color 0.1s ease, border-color 0.1s ease;
}

.icon-btn svg {
  width: var(--ui-icon-size);
  height: var(--ui-icon-size);
}

.icon-btn:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.icon-btn.active {
  background: var(--accent-soft);
  color: var(--accent);
}

.panel-pill:focus-visible,
.icon-btn:focus-visible,
.pinned-tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.search-bar {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.search-field {
  position: relative;
  display: flex;
  align-items: center;
}

.search-glyph {
  position: absolute;
  left: 9px;
  width: 13.5px;
  height: 13.5px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-field:focus-within .search-glyph {
  color: var(--accent);
}

.search-input {
  width: 100%;
  height: 30px;
  padding: 0 28px 0 29px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--bg-subtle);
  outline: none;
  font-size: 12.5px;
  transition: border-color 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-input:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px var(--accent-soft);
  background: var(--surface);
}

.search-clear {
  position: absolute;
  right: 5px;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: 5px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.search-clear svg {
  width: 12px;
  height: 12px;
}

.search-clear:hover {
  background: var(--bg-hover);
  color: var(--text);
}

.pinned-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}

.view-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.pinned-tile {
  position: relative;
  width: calc(var(--icon-size) + 15px);
  height: calc(var(--icon-size) + 13px);
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--surface);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  transition: background-color 0.1s ease, border-color 0.1s ease;
}

.pinned-tile:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.pinned-tile.active {
  background: var(--bg-active);
  border-color: var(--accent);
}

.pinned-tile.active::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: 2px;
  height: 2px;
  border-radius: 2px;
  background: var(--accent);
}

.pinned-tile.discarded {
  opacity: 0.56;
}

.pinned-tile img,
.pinned-fallback {
  width: var(--icon-size);
  height: var(--icon-size);
  border-radius: 3px;
  color: var(--text-muted);
}

.pinned-audio {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--accent);
}

.popup-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 10px;
  padding: 6px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
  user-select: none;
}

.popup-tip kbd {
  padding: 1px 5px;
  margin-right: 3px;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: var(--surface);
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text);
}
</style>
