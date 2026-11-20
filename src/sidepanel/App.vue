<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import type { SavedPanel, SpotlightView, TabTreeMap, VBerrySnapshot } from '@/shared/types'
import {
  downloadTextFile,
  getChromeFaviconUrl,
  loadSavedPanels,
  loadSnapshots,
  loadVirtualGroupMap,
  saveSavedPanels,
  saveSnapshots,
  saveTreeMeta,
} from '@/shared/storage'
import { createNewTab, getTargetWindowId } from '@/shared/env'
import { matchesShortcut, rankSearchItems } from '@/shared/search'
import {
  buildTabTree,
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

const searchQuery = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const searchCursor = ref<number>(-1)
const selectedIds = ref<Set<number>>(new Set())
const lastClickedId = ref<number | null>(null)
const dragOverPanelKey = ref<string | null>(null)

const bookmarksViewRef = ref<InstanceType<typeof BookmarksView> | null>(null)
const historyViewRef = ref<InstanceType<typeof HistoryView> | null>(null)
const snapshotsViewRef = ref<InstanceType<typeof SnapshotsView> | null>(null)

const groupModal = ref<GroupModalState | null>(null)
const bookmarkModal = ref<BookmarkModalState | null>(null)
const bookmarkModalFolders = ref<BookmarkFolderOption[]>([])
const tabMenu = ref<TabMenuState | null>(null)
const groupMenu = ref<GroupMenuState | null>(null)
const itemMenu = ref<ItemMenuState | null>(null)

async function focusSearchInput() {
  await nextTick()
  window.focus()
  const el = searchInputRef.value
  if (!el) return
  el.focus()
  el.select()
  // Follow-up focus frame handles Chrome Side Panel / Vivaldi Web Panel activation delay
  requestAnimationFrame(() => {
    window.focus()
    searchInputRef.value?.focus()
  })
}

const {
  isQuickSearch,
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
  onCommand(command) {
    if (command === 'new_tab_in_panel' && !isQuickSearch) {
      void openNewTabInActiveView()
      return
    }
    if (!isQuickSearch) return
    if (command === 'focus_search') {
      if (
        activeView.value.kind === 'bookmarks' ||
        activeView.value.kind === 'history' ||
        activeView.value.kind === 'snapshots'
      ) {
        void selectView({ kind: 'ungrouped' })
      }
      void focusSearchInput()
    } else if (command === 'switch_to_bookmarks') {
      void selectView({ kind: 'bookmarks' })
      void focusSearchInput()
    } else if (command === 'switch_to_history') {
      void selectView({ kind: 'history' })
      void focusSearchInput()
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
    if (settings.value.focusSearchOnPanelSwitch) {
      void focusSearchInput()
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

const highlightedTabId = computed<number | null>(() => {
  if (searchCursor.value < 0) return null
  const view = activeView.value
  if (view.kind === 'bookmarks' || view.kind === 'history' || view.kind === 'snapshots') {
    return null
  }
  const list = visibleTabNodes.value
  if (!list.length) return null
  const idx = Math.min(searchCursor.value, list.length - 1)
  return list[idx]?.id ?? null
})

watch(searchQuery, q => {
  searchCursor.value = settings.value.autoHighlightSearchMatch && q.trim() ? 0 : -1
})

function getSearchableCount(): number {
  const view = activeView.value
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

async function finishQuickSearch() {
  if (!isQuickSearch) return
  if (windowId.value >= 0) {
    await chrome.windows.update(windowId.value, { focused: true }).catch(() => {})
  }
  window.close()
}

async function openUrlFromSearchView(url: string, background: boolean) {
  await openNewTabInActiveView(url, background)
  if (!background) await finishQuickSearch()
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
      await finishQuickSearch()
    }
  }
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
  } else if (e.key === 'Escape') {
    if (searchQuery.value) {
      e.preventDefault()
      searchQuery.value = ''
      searchCursor.value = -1
    } else if (isQuickSearch) {
      e.preventDefault()
      void finishQuickSearch()
    }
  }
}

// Tab list interactions
async function activateTab(tabId: number, e: MouseEvent) {
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault()
    const next = new Set(selectedIds.value)
    if (next.has(tabId)) next.delete(tabId)
    else next.add(tabId)
    selectedIds.value = next
    lastClickedId.value = tabId
    return
  }

  if (e.shiftKey) {
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
  await finishQuickSearch()
}

async function closeTab(tabId: number) {
  const ids = selectedIds.value.has(tabId) ? [...selectedIds.value] : [tabId]
  selectedIds.value = new Set()
  await chrome.tabs.remove(ids).catch(() => {})
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
  if (!draggedTab || !targetTab) return

  const subtreeIds = getSubtreeIds(draggedId, tabs.value, treeMeta.value)
  if (subtreeIds.includes(targetId)) return

  if (draggedTab.groupId !== targetTab.groupId) {
    await moveTabsToGroup(subtreeIds, targetTab.groupId).catch(() => {})
  }
  const targetVirtual = virtualGroupMap.value[targetId] ?? null
  if ((virtualGroupMap.value[draggedId] ?? null) !== targetVirtual) {
    virtualGroupMap.value = await assignTabsToVirtualGroup(subtreeIds, targetVirtual)
  }

  const targetIdx = position === 'before' ? targetTab.index : targetTab.index + 1
  await chrome.tabs.move(subtreeIds, { index: targetIdx }).catch(() => {})

  const nextMeta: TabTreeMap = { ...treeMeta.value }
  if (position === 'into') {
    nextMeta[draggedId] = { ...nextMeta[draggedId], parentId: targetId }
    nextMeta[targetId] = { ...nextMeta[targetId], folded: false }
  } else {
    const targetParent = nextMeta[targetId]?.parentId
    if (targetParent !== undefined) {
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

  const subtreeIds = getSubtreeIds(draggedId, tabs.value, treeMeta.value)
  if (typeof targetGroupId === 'number') {
    await moveTabsToGroup(subtreeIds, targetGroupId).catch(() => {})
    virtualGroupMap.value = await loadVirtualGroupMap()
  } else {
    const groupId = await moveTabsToSavedPanel(windowId.value, subtreeIds, targetGroupId)
    virtualGroupMap.value = await loadVirtualGroupMap()
    activeView.value =
      groupId !== null ? { kind: 'group', groupId } : { kind: 'saved', savedId: targetGroupId.id }
  }
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
      if (url) await openNewTabInActiveView(url, false)
      return
    case 'open-bg':
      if (url) await openNewTabInActiveView(url, true)
      return
    case 'open-in-group':
      if (url && target !== undefined) await openUrlInSpecificTarget(url, target, false)
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

const mountedAt = Date.now()

function onWindowBlur() {
  closeMenus()
  if (isQuickSearch && Date.now() - mountedAt > 250) {
    window.close()
  }
}

function onWindowFocus() {
  if (isQuickSearch) void focusSearchInput()
}

function triggerQuickSearch(view: SpotlightView) {
  if (isQuickSearch) {
    if (view === 'bookmarks') void selectView({ kind: 'bookmarks' })
    else if (view === 'history') void selectView({ kind: 'history' })
    else void selectView({ kind: 'ungrouped' })
    void focusSearchInput()
    return
  }
  chrome.runtime
    .sendMessage({ type: 'vberry:open-quick-search', view, windowId: windowId.value })
    .catch(() => {})
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    const hadMenu = !!(
      tabMenu.value ||
      groupMenu.value ||
      itemMenu.value ||
      groupModal.value ||
      bookmarkModal.value
    )
    closeMenus()
    if (bookmarkModal.value) bookmarkModal.value = null
    if (groupModal.value) groupModal.value = null
    if (isQuickSearch && !hadMenu && !searchQuery.value) {
      e.preventDefault()
      void finishQuickSearch()
    }
    return
  }

  // Quick Search shortcuts always open Quick Search (overlay or popup) for a consistent UX
  const sc = settings.value.panelShortcuts
  if (matchesShortcut(e, sc.tabs)) {
    e.preventDefault()
    triggerQuickSearch('tabs')
  } else if (matchesShortcut(e, sc.bookmarks)) {
    e.preventDefault()
    triggerQuickSearch('bookmarks')
  } else if (matchesShortcut(e, sc.history)) {
    e.preventDefault()
    triggerQuickSearch('history')
  }
}

onMounted(() => {
  window.addEventListener('click', closeMenus)
  window.addEventListener('blur', onWindowBlur)
  window.addEventListener('focus', onWindowFocus)
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('visibilitychange', closeMenus)
})

onUnmounted(() => {
  window.removeEventListener('click', closeMenus)
  window.removeEventListener('blur', onWindowBlur)
  window.removeEventListener('focus', onWindowFocus)
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
          class="panel-pill"
          :class="{
            active: activeView.kind === 'ungrouped',
            'drag-over': dragOverPanelKey === 'ungrouped',
          }"
          title="Ungrouped Tabs (Right-click for panel actions)"
          @click="selectView({ kind: 'ungrouped' })"
          @contextmenu.prevent="openGroupContextMenu({ kind: 'ungrouped' }, $event)"
          @dragover.prevent="dragOverPanelKey = 'ungrouped'"
          @dragleave="dragOverPanelKey = null"
          @drop="handleDropOnPanel($event, UNGROUPED_ID)"
        >
          <span class="pill-dot" style="background: var(--grp-grey)" />
          <span class="pill-label">Tabs</span>
          <span v-if="settings.showTabCounts" class="pill-count">{{ ungroupedTabs.length }}</span>
        </button>

        <button
          v-for="g in groups"
          :key="g.id"
          class="panel-pill"
          :class="{
            active: activeView.kind === 'group' && activeView.groupId === g.id,
            'drag-over': dragOverPanelKey === `g_${g.id}`,
          }"
          :title="`${g.title || 'Group'} (Right-click for group actions)`"
          @click="selectView({ kind: 'group', groupId: g.id })"
          @contextmenu.prevent="openGroupContextMenu({ kind: 'native', group: g }, $event)"
          @dragover.prevent="dragOverPanelKey = `g_${g.id}`"
          @dragleave="dragOverPanelKey = null"
          @drop="handleDropOnPanel($event, g.id)"
        >
          <span class="pill-dot" :style="{ background: `var(--grp-${g.color})` }" />
          <span class="pill-label">{{ g.title || 'Group' }}</span>
          <span v-if="settings.showTabCounts" class="pill-count">
            {{ tabsByGroupId.get(g.id)?.length ?? 0 }}
          </span>
        </button>

        <button
          v-for="sp in unmaterializedSavedPanels"
          :key="sp.id"
          class="panel-pill"
          :class="{
            active: activeView.kind === 'saved' && activeView.savedId === sp.id,
            'saved-empty': (tabsBySavedId.get(sp.id)?.length ?? 0) === 0,
            'drag-over': dragOverPanelKey === `s_${sp.id}`,
          }"
          :title="`${sp.title} (Right-click for group actions)`"
          @click="selectView({ kind: 'saved', savedId: sp.id })"
          @contextmenu.prevent="openGroupContextMenu({ kind: 'saved', panel: sp }, $event)"
          @dragover.prevent="dragOverPanelKey = `s_${sp.id}`"
          @dragleave="dragOverPanelKey = null"
          @drop="handleDropOnPanel($event, sp)"
        >
          <span class="pill-dot" :style="{ background: `var(--grp-${sp.color})` }" />
          <span class="pill-label">{{ sp.title }}</span>
          <span
            v-if="settings.showTabCounts && (tabsBySavedId.get(sp.id)?.length ?? 0) > 0"
            class="pill-count"
          >
            {{ tabsBySavedId.get(sp.id)?.length }}
          </span>
        </button>

        <button class="icon-btn" title="New Tab Group" @click="openCreateGroupModal">
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
          v-if="settings.showBookmarksPanel"
          class="icon-btn"
          :class="{ active: activeView.kind === 'bookmarks' }"
          title="Bookmarks"
          @click="selectView({ kind: 'bookmarks' })"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M8 1.5 9.95 5.45l4.35.63-3.15 3.07.74 4.35L8 11.45 4.11 13.5l.74-4.35L1.7 6.08l4.35-.63Z"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linejoin="round"
            />
          </svg>
        </button>
        <button
          v-if="settings.showHistoryPanel"
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
        <button class="icon-btn" title="VBerry Settings & Sidebery Import" @click="openOptions">
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
    <div v-if="activeView.kind !== 'snapshots'" class="search-bar">
      <input
        ref="searchInputRef"
        v-model="searchQuery"
        class="search-input"
        type="search"
        :placeholder="
          activeView.kind === 'bookmarks'
            ? 'Search bookmarks…'
            : activeView.kind === 'history'
              ? 'Search history…'
              : 'Search tabs…'
        "
        @keydown="onSearchKeyDown"
      />
    </div>

    <!-- Pinned Tabs Strip -->
    <div
      v-if="
        pinnedTabs.length &&
        activeView.kind !== 'bookmarks' &&
        activeView.kind !== 'history' &&
        activeView.kind !== 'snapshots'
      "
      class="pinned-strip"
    >
      <button
        v-for="pt in pinnedTabs"
        :key="pt.id"
        class="pinned-tile"
        :class="{ active: pt.active, discarded: pt.discarded }"
        :title="pt.title || pt.url"
        @mousedown.left="pt.id !== undefined && activateTab(pt.id, $event)"
        @auxclick.middle.prevent="pt.id !== undefined && closeTab(pt.id)"
        @contextmenu.prevent="openTabContextMenu(pt, $event)"
      >
        <img
          v-if="getChromeFaviconUrl(pt.url || pt.pendingUrl, 32) || pt.favIconUrl"
          :src="getChromeFaviconUrl(pt.url || pt.pendingUrl, 32) || pt.favIconUrl"
          alt=""
        />
        <span v-else>•</span>
      </button>
    </div>

    <!-- Main View -->
    <BookmarksView
      v-if="activeView.kind === 'bookmarks'"
      ref="bookmarksViewRef"
      :query="searchQuery"
      :active-index="searchCursor"
      :can-bookmark-active-tab="Boolean(activeTabForBookmark?.url)"
      @open-url="(url, bg) => openUrlFromSearchView(url, bg)"
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
      @activate="activateTab"
      @close="closeTab"
      @toggle-fold="handleToggleFold"
      @toggle-mute="handleToggleMute"
      @new-tab="openNewTabInActiveView()"
      @context-menu="openTabContextMenu"
      @panel-context-menu="openActivePanelContextMenu"
      @drop-tab="handleDropTab"
    />

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
  gap: 4px;
  padding: 6px 8px 4px;
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
  padding-left: 4px;
  border-left: 1px solid var(--border);
}

.panel-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 26px;
  padding: 0 8px;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  font-size: 12px;
}

.panel-pill:hover {
  background: var(--bg-hover);
}

.panel-pill.active {
  background: var(--bg);
  border-color: var(--border);
  font-weight: 600;
}

.panel-pill.saved-empty {
  border-style: dashed;
  border-color: var(--border);
  opacity: 0.72;
}

.panel-pill.drag-over {
  outline: 2px solid var(--accent);
  background: var(--bg-selected);
}

.pill-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.pill-label {
  max-width: 96px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pill-count {
  font-size: 10.5px;
  color: var(--text-muted);
}

.icon-btn {
  width: calc(var(--ui-icon-size) + 7px);
  height: calc(var(--ui-icon-size) + 7px);
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.icon-btn svg {
  width: var(--ui-icon-size);
  height: var(--ui-icon-size);
}

.icon-btn:hover,
.icon-btn.active {
  background: var(--bg-hover);
  color: var(--text);
}

.search-bar {
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.search-input {
  width: 100%;
  height: 28px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-subtle);
  outline: none;
  font-size: 12.5px;
}

.search-input:focus {
  border-color: var(--accent);
  background: var(--bg);
}

.pinned-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.pinned-tile {
  width: calc(var(--icon-size) + 14px);
  height: calc(var(--icon-size) + 12px);
  border: 1px solid transparent;
  border-radius: 6px;
  background: var(--bg-subtle);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
}

.pinned-tile:hover {
  background: var(--bg-hover);
}

.pinned-tile.active {
  background: var(--bg-active);
  border-color: var(--accent);
}

.pinned-tile.discarded {
  opacity: 0.55;
}

.pinned-tile img {
  width: var(--icon-size);
  height: var(--icon-size);
  border-radius: 2px;
}
</style>
