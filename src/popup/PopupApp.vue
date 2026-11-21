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
import { buildTabTree, getSubtreeIds, indentTab, outdentTab, toggleFold } from '@/shared/tree'
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
import { useChromeWindow } from '@/sidepanel/composables/useChromeWindow'
import TabTreeView from '@/sidepanel/components/TabTreeView.vue'
import UnifiedSearchView from '@/sidepanel/components/UnifiedSearchView.vue'
import BookmarksView from '@/sidepanel/components/BookmarksView.vue'
import HistoryView from '@/sidepanel/components/HistoryView.vue'
import SnapshotsView from '@/sidepanel/components/SnapshotsView.vue'
import GroupModal, { type GroupModalState } from '@/sidepanel/components/GroupModal.vue'
import BookmarkModal, { type BookmarkModalState } from '@/sidepanel/components/BookmarkModal.vue'
import SidePanelMenus, {
  type GroupMenuPayload,
  type GroupMenuState,
  type ItemMenuPayload,
  type ItemMenuState,
  type TabMenuState,
} from '@/sidepanel/components/SidePanelMenus.vue'
import { vAutofocus } from './autofocus'

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
  mode: 'popup',
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
    return buildTabTree(ranked, {})
  }

  return buildTabTree(panelList, treeMeta.value)
})

const visibleTabNodes = computed(() => activeTabList.value.filter(n => !n.hidden))

const highlightedTabId = computed<number | null>(() => {
  if (searchCursor.value < 0) return null
  const view = activeView.value
  if (
    view.kind === 'search' ||
    view.kind === 'bookmarks' ||
    view.kind === 'history' ||
    view.kind === 'snapshots'
  ) {
    return null
  }
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
  if (!background) window.close()
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
      window.close()
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
      window.close()
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
    } else {
      e.preventDefault()
      window.close()
    }
  }
}

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
  window.close()
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
  const dragged = tabs.value.find(t => t.id === draggedId)
  const target = tabs.value.find(t => t.id === targetId)
  if (!dragged || !target || draggedId === targetId) return

  const subtree = getSubtreeIds(draggedId, tabs.value, treeMeta.value)
  const idsToMove = subtree.length ? subtree : [draggedId]
  if (idsToMove.includes(targetId)) return

  const meta: TabTreeMap = { ...treeMeta.value }
  if (position === 'into') {
    meta[draggedId] = { ...meta[draggedId], parentId: targetId }
    if (meta[targetId]?.folded) meta[targetId] = { ...meta[targetId], folded: false }
  } else {
    const targetParent = meta[targetId]?.parentId
    if (targetParent !== undefined && targetParent !== draggedId) {
      meta[draggedId] = { ...meta[draggedId], parentId: targetParent }
    } else if (meta[draggedId]) {
      const copy = { ...meta[draggedId] }
      delete copy.parentId
      meta[draggedId] = copy
    }
  }
  treeMeta.value = meta
  await saveTreeMeta(meta)

  const targetIndex = position === 'before' ? target.index : target.index + 1
  await chrome.tabs.move(idsToMove, { index: targetIndex }).catch(() => {})

  if (target.groupId !== UNGROUPED_ID && dragged.groupId !== target.groupId) {
    await moveTabsToGroup(idsToMove, target.groupId)
  } else if (target.groupId === UNGROUPED_ID && dragged.groupId !== UNGROUPED_ID) {
    await moveTabsToGroup(idsToMove, UNGROUPED_ID)
  } else if (target.groupId === UNGROUPED_ID) {
    const targetVirtual = virtualGroupMap.value[targetId] ?? null
    const draggedVirtual = virtualGroupMap.value[draggedId] ?? null
    if (targetVirtual !== draggedVirtual) {
      virtualGroupMap.value = await assignTabsToVirtualGroup(idsToMove, targetVirtual)
    }
  }
}

async function handleDropOnPanel(e: DragEvent, target: number | SavedPanel) {
  dragOverPanelKey.value = null
  const raw = e.dataTransfer?.getData('text/vberry-tab-id')
  const draggedId = Number(raw)
  if (!Number.isFinite(draggedId)) return

  const ids = selectedIds.value.has(draggedId)
    ? [...selectedIds.value]
    : getSubtreeIds(draggedId, tabs.value, treeMeta.value)
  const toMove = ids.length ? ids : [draggedId]

  if (typeof target === 'number') {
    await moveTabsToGroup(toMove, target)
    virtualGroupMap.value = await loadVirtualGroupMap()
  } else {
    if (windowId.value < 0) windowId.value = await getTargetWindowId()
    await moveTabsToSavedPanel(windowId.value, toMove, target)
    virtualGroupMap.value = await loadVirtualGroupMap()
  }
  selectedIds.value = new Set()
}

// Group & Bookmark Modals
function openCreateGroupModal() {
  const used = [...groups.value.map(g => g.color), ...savedPanels.value.map(p => p.color)]
  groupModal.value = { mode: 'create', title: '', color: pickNextGroupColor(used) }
}

function openRenameGroupModal(
  kind: 'native' | 'saved',
  id: number | string,
  title: string,
  color: GroupModalState['color']
) {
  groupModal.value =
    kind === 'native'
      ? { mode: 'edit-native', groupId: id as number, title, color }
      : { mode: 'edit-saved', savedId: id as string, title, color }
}

async function submitGroupModal() {
  const m = groupModal.value
  if (!m) return
  const title = m.title.trim() || 'New Group'
  groupModal.value = null

  if (m.mode === 'create') {
    if (windowId.value < 0) windowId.value = await getTargetWindowId()
    if (windowId.value < 0) return
    const res = await createGroupWithTab(windowId.value, title, m.color)
    savedPanels.value = await loadSavedPanels()
    if (res.groupId !== null) {
      await selectView({ kind: 'group', groupId: res.groupId })
    } else if (res.savedPanelId) {
      virtualGroupMap.value = await loadVirtualGroupMap()
      await selectView({ kind: 'saved', savedId: res.savedPanelId })
    }
    return
  }

  if (m.mode === 'edit-native' && m.groupId !== undefined) {
    await chrome.tabGroups?.update?.(m.groupId, { title, color: m.color }).catch(() => {})
    const oldGroup = groups.value.find(g => g.id === m.groupId)
    if (oldGroup) {
      const oldTitle = (oldGroup.title ?? '').trim().toLowerCase()
      const idx = savedPanels.value.findIndex(p => p.title.trim().toLowerCase() === oldTitle)
      if (idx !== -1) {
        savedPanels.value[idx] = { ...savedPanels.value[idx], title, color: m.color }
        await saveSavedPanels(savedPanels.value)
      }
    }
  } else if (m.mode === 'edit-saved' && m.savedId !== undefined) {
    savedPanels.value = savedPanels.value.map(p =>
      p.id === m.savedId ? { ...p, title, color: m.color } : p
    )
    await saveSavedPanels(savedPanels.value)
  }
}

const activeTabForBookmark = computed<chrome.tabs.Tab | null>(
  () => tabs.value.find(t => t.active) ?? null
)

function refreshBookmarkModalFolders(excludeSubtreeId?: string): BookmarkFolderOption[] {
  const list = bookmarksViewRef.value?.getFolders(excludeSubtreeId) ?? []
  bookmarkModalFolders.value = list
  return list
}

function openAddBookmarkModal(parentId?: string) {
  const folders = refreshBookmarkModalFolders()
  const fallback = parentId || bookmarksViewRef.value?.getDefaultFolderId() || folders[0]?.id || '1'
  bookmarkModal.value = { mode: 'add-bookmark', title: '', url: '', parentId: fallback }
}

function openAddFolderModal(parentId?: string) {
  const folders = refreshBookmarkModalFolders()
  const fallback = parentId || bookmarksViewRef.value?.getDefaultFolderId() || folders[0]?.id || '1'
  bookmarkModal.value = { mode: 'add-folder', title: '', url: '', parentId: fallback }
}

function openEditBookmarkModal(node: chrome.bookmarks.BookmarkTreeNode) {
  const isFolder = !node.url
  const folders = refreshBookmarkModalFolders(isFolder ? node.id : undefined)
  const fallback = node.parentId || folders[0]?.id || '1'
  bookmarkModal.value = {
    mode: isFolder ? 'edit-folder' : 'edit-bookmark',
    nodeId: node.id,
    originalParentId: node.parentId,
    title: node.title || '',
    url: node.url || '',
    parentId: fallback,
  }
}

async function bookmarkActiveTabInFolder(parentId?: string) {
  const active = activeTabForBookmark.value
  const url = active?.url || active?.pendingUrl
  if (!url) return
  const targetParent = parentId || bookmarksViewRef.value?.getDefaultFolderId() || '1'
  const created = await chrome.bookmarks
    .create({ parentId: targetParent, title: active?.title || url, url })
    .catch(() => null)
  if (created) {
    bookmarksViewRef.value?.expandFolder(targetParent)
    await bookmarksViewRef.value?.revealBookmark(created.id)
  }
}

async function submitBookmarkModal() {
  const m = bookmarkModal.value
  if (!m) return
  const title = m.title.trim()
  const isFolder = m.mode === 'add-folder' || m.mode === 'edit-folder'
  const url = isFolder ? '' : normalizeBookmarkUrl(m.url)
  if (!isFolder && !url) return

  bookmarkModal.value = null

  if (m.mode === 'add-bookmark') {
    const created = await chrome.bookmarks
      .create({ parentId: m.parentId, title: title || url, url })
      .catch(() => null)
    if (created) {
      bookmarksViewRef.value?.expandFolder(m.parentId)
      await bookmarksViewRef.value?.revealBookmark(created.id)
    }
    return
  }

  if (m.mode === 'add-folder') {
    const created = await chrome.bookmarks
      .create({ parentId: m.parentId, title: title || 'New Folder' })
      .catch(() => null)
    if (created) {
      bookmarksViewRef.value?.expandFolder(m.parentId)
      bookmarksViewRef.value?.expandFolder(created.id)
      await bookmarksViewRef.value?.revealBookmark(created.id)
    }
    return
  }

  if (m.nodeId) {
    const changes: { title?: string; url?: string } = {
      title: title || (isFolder ? 'Untitled Folder' : url),
    }
    if (!isFolder) changes.url = url
    await chrome.bookmarks.update(m.nodeId, changes).catch(() => {})
    if (m.parentId && m.parentId !== m.originalParentId) {
      await chrome.bookmarks.move(m.nodeId, { parentId: m.parentId }).catch(() => {})
      bookmarksViewRef.value?.expandFolder(m.parentId)
    }
  }
}

// Context Menus
function closeMenus() {
  tabMenu.value = null
  groupMenu.value = null
  itemMenu.value = null
}

function openTabContextMenu(tab: chrome.tabs.Tab, e: MouseEvent) {
  closeMenus()
  tabMenu.value = { x: e.clientX, y: e.clientY, tab }
}

function openGroupContextMenu(payload: GroupMenuPayload, e: MouseEvent) {
  closeMenus()
  groupMenu.value = { ...payload, x: e.clientX, y: e.clientY }
}

function openItemContextMenu(payload: ItemMenuPayload, e: MouseEvent) {
  closeMenus()
  itemMenu.value = { ...payload, x: e.clientX, y: e.clientY }
}

function openActivePanelContextMenu(e: MouseEvent) {
  const view = activeView.value
  if (view.kind === 'ungrouped') {
    openGroupContextMenu({ kind: 'ungrouped' }, e)
  } else if (view.kind === 'group') {
    const g = groups.value.find(x => x.id === view.groupId)
    if (g) openGroupContextMenu({ kind: 'native', group: g }, e)
  } else if (view.kind === 'saved') {
    const sp = savedPanels.value.find(p => p.id === view.savedId)
    if (sp) openGroupContextMenu({ kind: 'saved', panel: sp }, e)
  }
}

function collectFolderUrls(node: chrome.bookmarks.BookmarkTreeNode): string[] {
  const out: string[] = []
  const walk = (n: chrome.bookmarks.BookmarkTreeNode) => {
    if (n.url) out.push(n.url)
    if (n.children) for (const c of n.children) walk(c)
  }
  walk(node)
  return out
}

async function requestRestoreSnapshot(snapshot: VBerrySnapshot, inNewWindow: boolean) {
  if (inNewWindow) {
    try {
      const res = await chrome.runtime.sendMessage<{ ok?: boolean }>({
        type: 'vberry:restore-snapshot',
        snapshot: JSON.parse(JSON.stringify(snapshot)),
        inNewWindow: true,
      })
      if (res?.ok) return
    } catch {
      // Fall back below
    }
  }
  await restoreSnapshot(snapshot, inNewWindow)
}

async function requestDiscardTabs(tabIds: number[]) {
  if (!tabIds.length) return
  if (windowId.value < 0) windowId.value = await getTargetWindowId()
  if (windowId.value < 0) return
  try {
    const res = await chrome.runtime.sendMessage<{ ok?: boolean }>({
      type: 'vberry:discard-tabs',
      windowId: windowId.value,
      tabIds,
    })
    if (res?.ok) {
      await refreshChromeState()
      return
    }
  } catch {
    // Fall back below
  }
  await discardTabs(tabIds, tabs.value, windowId.value)
  await refreshChromeState()
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
        window.close()
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
        window.close()
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
        const res = await createGroupWithTab(
          windowId.value,
          menu.node.title || 'Bookmarks',
          color,
          urls[0]
        )
        const rest = urls.slice(1)
        if (rest.length) {
          const createdIds: number[] = []
          for (const u of rest) {
            const t = await createNewTab({ windowId: windowId.value, url: u, active: false })
            if (t.id !== undefined) createdIds.push(t.id)
          }
          if (res.groupId !== null && createdIds.length) {
            await chrome.tabs.group({ tabIds: createdIds, groupId: res.groupId }).catch(() => {})
          } else if (res.savedPanelId && createdIds.length) {
            await assignTabsToVirtualGroup(createdIds, res.savedPanelId)
          }
        }
        savedPanels.value = await loadSavedPanels()
        virtualGroupMap.value = await loadVirtualGroupMap()
        if (res.groupId !== null) await selectView({ kind: 'group', groupId: res.groupId })
        else if (res.savedPanelId) await selectView({ kind: 'saved', savedId: res.savedPanelId })
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
    case 'edit-bookmark':
      if (menu.kind === 'bookmark') openEditBookmarkModal(menu.node)
      return
    case 'add-bookmark-here':
      if (menu.kind === 'bookmark') {
        const targetFolder = menu.node.url ? menu.node.parentId : menu.node.id
        openAddBookmarkModal(targetFolder)
      }
      return
    case 'bookmark-active-here':
      if (menu.kind === 'bookmark') {
        const targetFolder = menu.node.url ? menu.node.parentId : menu.node.id
        await bookmarkActiveTabInFolder(targetFolder)
      }
      return
    case 'add-folder-here':
      if (menu.kind === 'bookmark') {
        const targetFolder = menu.node.url ? menu.node.parentId : menu.node.id
        openAddFolderModal(targetFolder)
      }
      return
    case 'sort-folder-az':
      if (menu.kind === 'bookmark' && !menu.node.url) {
        await sortFolderBookmarks(menu.node.id, 'title')
      }
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
        const next = { ...treeMeta.value, [created.id]: { parentId: tab.id } }
        treeMeta.value = next
        await saveTreeMeta(next)
      }
      return
    }
    case 'reload':
      for (const id of ids) await chrome.tabs.reload(id).catch(() => {})
      return
    case 'duplicate':
      for (const id of ids) await chrome.tabs.duplicate(id).catch(() => {})
      return
    case 'pin':
      for (const id of ids) await chrome.tabs.update(id, { pinned: !tab.pinned }).catch(() => {})
      return
    case 'mute':
      for (const id of ids) {
        await chrome.tabs.update(id, { muted: !tab.mutedInfo?.muted }).catch(() => {})
      }
      return
    case 'discard':
      await requestDiscardTabs(ids)
      selectedIds.value = new Set()
      return
    case 'indent': {
      const next = indentTab(tab.id, activeTabList.value, treeMeta.value)
      treeMeta.value = next
      await saveTreeMeta(next)
      return
    }
    case 'outdent': {
      const next = outdentTab(tab.id, treeMeta.value)
      treeMeta.value = next
      await saveTreeMeta(next)
      return
    }
    case 'move-group':
      if (typeof target === 'number') {
        await moveTabsToGroup(ids, target)
        virtualGroupMap.value = await loadVirtualGroupMap()
      } else if (target) {
        if (windowId.value < 0) windowId.value = await getTargetWindowId()
        await moveTabsToSavedPanel(windowId.value, ids, target)
        virtualGroupMap.value = await loadVirtualGroupMap()
      }
      selectedIds.value = new Set()
      return
    case 'copy-url':
      if (tab.url) await navigator.clipboard?.writeText(tab.url).catch(() => {})
      return
    case 'close-branch': {
      const branchIds = getSubtreeIds(tab.id, tabs.value, treeMeta.value)
      if (branchIds.length) {
        await chrome.tabs.remove(branchIds).catch(() => {})
        scheduleActiveSyncAfterRemove(branchIds)
      }
      return
    }
    case 'close':
      await chrome.tabs.remove(ids).catch(() => {})
      selectedIds.value = new Set()
      scheduleActiveSyncAfterRemove(ids)
      return
  }
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
      ? 'Ungrouped Tabs'
      : menu.kind === 'native'
        ? menu.group.title?.trim() || 'Group'
        : menu.panel.title

  switch (action) {
    case 'new-tab':
      if (menu.kind === 'ungrouped') {
        await selectView({ kind: 'ungrouped' })
        await openNewTabInActiveView()
      } else if (menu.kind === 'native') {
        await selectView({ kind: 'group', groupId: menu.group.id })
        await openNewTabInActiveView()
      } else {
        if (windowId.value < 0) windowId.value = await getTargetWindowId()
        if (windowId.value < 0) return
        const res = await materializeSavedPanel(windowId.value, menu.panel)
        if (res.groupId !== null) {
          await selectView({ kind: 'group', groupId: res.groupId })
        } else {
          virtualGroupMap.value = await loadVirtualGroupMap()
          await selectView({ kind: 'saved', savedId: res.savedPanelId })
        }
      }
      return
    case 'rename':
      if (menu.kind === 'native') {
        openRenameGroupModal('native', menu.group.id, menu.group.title || '', menu.group.color)
      } else if (menu.kind === 'saved') {
        openRenameGroupModal('saved', menu.panel.id, menu.panel.title, menu.panel.color)
      }
      return
    case 'collapse-chrome':
      if (menu.kind === 'native') {
        await chrome.tabGroups
          ?.update?.(menu.group.id, { collapsed: !menu.group.collapsed })
          .catch(() => {})
      }
      return
    case 'fold-all': {
      const next: TabTreeMap = { ...treeMeta.value }
      const parentSet = new Set<number>()
      for (const id of panelTabIds) {
        const pid = next[id]?.parentId
        if (pid !== undefined && panelTabIds.includes(pid)) parentSet.add(pid)
      }
      for (const pid of parentSet) next[pid] = { ...next[pid], folded: true }
      treeMeta.value = next
      await saveTreeMeta(next)
      return
    }
    case 'expand-all': {
      const next: TabTreeMap = { ...treeMeta.value }
      for (const id of panelTabIds) {
        if (next[id]?.folded) next[id] = { ...next[id], folded: false }
      }
      treeMeta.value = next
      await saveTreeMeta(next)
      return
    }
    case 'unload-all':
      await requestDiscardTabs(panelTabIds)
      return
    case 'bookmark-all':
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
    if (!hadMenu && !searchQuery.value) {
      e.preventDefault()
      window.close()
    }
    return
  }

  if (groupModal.value || bookmarkModal.value) return

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
          type="button"
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
          type="button"
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
          v-if="settings.unifiedSearch"
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
    <form
      v-if="activeView.kind !== 'snapshots'"
      role="search"
      class="search-bar"
      @submit.prevent
    >
      <input
        id="vberry-search"
        ref="searchInputRef"
        v-model="searchQuery"
        v-autofocus
        class="search-input"
        type="search"
        name="searchText"
        autocomplete="off"
        :placeholder="searchPlaceholder"
        @keydown="onSearchKeyDown"
      />
    </form>

    <!-- Pinned Tabs Strip -->
    <div
      v-if="
        pinnedTabs.length &&
        activeView.kind !== 'search' &&
        activeView.kind !== 'bookmarks' &&
        activeView.kind !== 'history' &&
        activeView.kind !== 'snapshots'
      "
      class="pinned-strip"
    >
      <button
        v-for="pt in pinnedTabs"
        :key="pt.id"
        type="button"
        class="pinned-tile"
        :class="{ active: pt.active, discarded: pt.discarded }"
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
        <span v-else>•</span>
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
        @activate="activateTab"
        @close="closeTab"
        @toggle-fold="handleToggleFold"
        @toggle-mute="handleToggleMute"
        @new-tab="openNewTabInActiveView()"
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

    <footer class="popup-tip">
      <span><kbd>Tab</kbd> navigate controls</span>
      <span><kbd>↑↓</kbd> select result</span>
      <span><kbd>Enter</kbd> open</span>
      <span><kbd>Esc</kbd> close</span>
    </footer>
  </div>
</template>

<style>
html {
  overflow: hidden;
  min-height: 540px;
  height: 100%;
}

body {
  width: 100%;
  height: 100%;
  min-height: inherit;
  margin: 0;
  padding: 0;
  position: relative;
  overflow: hidden;
}
</style>

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

.panel-pill:focus-visible,
.icon-btn:focus-visible,
.pinned-tile:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
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
  box-shadow: 0 0 0 1px var(--accent);
  background: var(--bg);
}

.pinned-strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 6px 8px;
  border-bottom: 1px solid var(--border);
}

.view-body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
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

.popup-tip {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 5px 8px;
  border-top: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-muted);
  font-size: 11px;
  flex-shrink: 0;
  user-select: none;
}

.popup-tip kbd {
  padding: 1px 4px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--bg);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 10px;
  color: var(--text);
}
</style>
