<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import {
  CHROME_GROUP_COLORS,
  DEFAULT_SETTINGS,
  type ActiveView,
  type ChromeGroupColor,
  type RuntimeCommandMessage,
  type SavedPanel,
  type Settings,
  type TabTreeMap,
} from '@/shared/types'
import {
  getChromeFaviconUrl,
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  loadTreeMeta,
  loadVirtualGroupMap,
  saveSavedPanels,
  saveSnapshots,
  saveTreeMeta,
  STORAGE_KEYS,
} from '@/shared/storage'
import { createNewTab, getTargetWindowId } from '@/shared/env'
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
  safeQueryTabGroups,
  syncCollapseOnSwitch,
  UNGROUPED_ID,
} from '@/shared/groups'
import { snapshotToMarkdown } from '@/shared/sidebery-import'
import TabTreeView from './components/TabTreeView.vue'
import BookmarksView from './components/BookmarksView.vue'
import HistoryView from './components/HistoryView.vue'
import SnapshotsView, { type SnapshotContextTarget } from './components/SnapshotsView.vue'

const windowId = ref<number>(-1)
const tabs = ref<chrome.tabs.Tab[]>([])
const groups = ref<chrome.tabGroups.TabGroup[]>([])
const savedPanels = ref<SavedPanel[]>([])
const treeMeta = ref<TabTreeMap>({})
const virtualGroupMap = ref<Record<number, string>>({})
const settings = ref<Settings>({ ...DEFAULT_SETTINGS })

const activeView = ref<ActiveView>({ kind: 'ungrouped' })
const lastTabView = ref<
  { kind: 'ungrouped' } | { kind: 'group'; groupId: number } | { kind: 'saved'; savedId: string }
>({ kind: 'ungrouped' })
const searchQuery = ref('')
const searchInputRef = ref<HTMLInputElement | null>(null)
const selectedIds = ref<Set<number>>(new Set())
const lastClickedId = ref<number | null>(null)

// Inline new-group / edit-group modal state
const groupModal = ref<{
  mode: 'create' | 'edit-native' | 'edit-saved'
  groupId?: number
  savedId?: string
  title: string
  color: ChromeGroupColor
} | null>(null)

const historyViewRef = ref<InstanceType<typeof HistoryView> | null>(null)
const snapshotsViewRef = ref<InstanceType<typeof SnapshotsView> | null>(null)

// Context menu state
const tabMenu = ref<{ tab: chrome.tabs.Tab; x: number; y: number } | null>(null)
const groupMenu = ref<
  | { kind: 'ungrouped'; x: number; y: number }
  | { kind: 'native'; group: chrome.tabGroups.TabGroup; x: number; y: number }
  | { kind: 'saved'; panel: SavedPanel; x: number; y: number }
  | null
>(null)
const itemMenu = ref<
  | ((
      | { kind: 'bookmark'; node: chrome.bookmarks.BookmarkTreeNode }
      | { kind: 'history'; item: chrome.history.HistoryItem }
      | { kind: 'session'; session: chrome.sessions.Session }
      | SnapshotContextTarget
    ) & {
      x: number
      y: number
    })
  | null
>(null)
const dragOverPanelKey = ref<string | null>(null)

let refreshTimer: ReturnType<typeof setTimeout> | undefined
let activeRetryTimers: ReturnType<typeof setTimeout>[] = []
let refreshSeq = 0
const activeTabId = ref<number | null>(null)

function clearActiveRetryTimers() {
  for (const t of activeRetryTimers) clearTimeout(t)
  activeRetryTimers = []
}

function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => {
    void refreshChromeState()
  }, 40)
}

async function resolveWindowActiveTabId(
  winTabs: chrome.tabs.Tab[],
  excludeIds?: Set<number>
): Promise<{ id: number | null; authoritative: boolean }> {
  const validIds = new Set(winTabs.map(t => t.id).filter((id): id is number => id !== undefined))
  const direct = winTabs.find(
    t => t.active && t.id !== undefined && !excludeIds?.has(t.id)
  )
  if (direct?.id !== undefined) return { id: direct.id, authoritative: true }

  // Query active tab explicitly (works even when the window is unfocused in Vivaldi/Chromium)
  try {
    const activeInWin = await chrome.tabs.query({ windowId: windowId.value, active: true })
    const match = activeInWin.find(
      t => t.id !== undefined && validIds.has(t.id) && !excludeIds?.has(t.id)
    )
    if (match?.id !== undefined) return { id: match.id, authoritative: true }
  } catch {
    // Fallback below
  }

  try {
    const win = await chrome.windows.get(windowId.value, { populate: true })
    const match = win.tabs?.find(
      t => t.active && t.id !== undefined && validIds.has(t.id) && !excludeIds?.has(t.id)
    )
    if (match?.id !== undefined) return { id: match.id, authoritative: true }
  } catch {
    // Fallback below
  }

  try {
    const anyActive = await chrome.tabs.query({ active: true })
    const match = anyActive.find(
      t => t.id !== undefined && validIds.has(t.id) && !excludeIds?.has(t.id)
    )
    if (match?.id !== undefined) return { id: match.id, authoritative: true }
  } catch {
    // Fallback below
  }

  const highlighted = winTabs.find(
    t => t.highlighted && t.id !== undefined && !excludeIds?.has(t.id)
  )
  if (highlighted?.id !== undefined) return { id: highlighted.id, authoritative: false }

  // Final fallback for unfocused Vivaldi windows where every tab transiently reports
  // active: false after closing a tab: pick the most recently accessed remaining tab.
  const remaining = winTabs
    .filter(t => t.id !== undefined && !excludeIds?.has(t.id))
    .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
  return { id: remaining[0]?.id ?? null, authoritative: false }
}

async function refreshChromeState(followActive = false, excludeRemovedIds?: Set<number>) {
  const seq = ++refreshSeq
  if (windowId.value < 0) {
    windowId.value = await getTargetWindowId()
  }
  if (windowId.value < 0) return

  const [winTabs, winGroups] = await Promise.all([
    chrome.tabs.query({ windowId: windowId.value }),
    safeQueryTabGroups({ windowId: windowId.value }),
  ])
  if (seq !== refreshSeq) return

  const resolved = await resolveWindowActiveTabId(winTabs, excludeRemovedIds)
  if (seq !== refreshSeq) return

  if (resolved.authoritative && resolved.id !== null) {
    clearActiveRetryTimers()
    activeTabId.value = resolved.id
  } else if (
    activeTabId.value === null ||
    !winTabs.some(t => t.id === activeTabId.value) ||
    excludeRemovedIds?.has(activeTabId.value)
  ) {
    activeTabId.value = resolved.id
  }

  const effectiveActiveId = resolved.authoritative ? resolved.id : activeTabId.value
  tabs.value = winTabs
    .sort((a, b) => a.index - b.index)
    .map(t => (effectiveActiveId !== null ? { ...t, active: t.id === effectiveActiveId } : t))
  groups.value = winGroups

  // Keep active view valid if a Chrome Tab Group was closed
  const curView = activeView.value
  if (curView.kind === 'group' && !winGroups.some(g => g.id === curView.groupId)) {
    activeView.value = { kind: 'ungrouped' }
  } else if (curView.kind === 'saved' && !savedPanels.value.some(p => p.id === curView.savedId)) {
    activeView.value = { kind: 'ungrouped' }
  }

  if (followActive) {
    const activeTab = tabs.value.find(t => t.active)
    if (activeTab && !activeTab.pinned) {
      if (activeTab.groupId !== UNGROUPED_ID && winGroups.some(g => g.id === activeTab.groupId)) {
        activeView.value = { kind: 'group', groupId: activeTab.groupId }
      } else if (activeTab.id !== undefined && virtualGroupMap.value[activeTab.id]) {
        const sid = virtualGroupMap.value[activeTab.id]
        if (savedPanels.value.some(p => p.id === sid)) {
          activeView.value = { kind: 'saved', savedId: sid }
        } else {
          activeView.value = { kind: 'ungrouped' }
        }
      } else {
        activeView.value = { kind: 'ungrouped' }
      }
    }
  }
}

function scheduleActiveSyncAfterRemove(removedIds: number[]) {
  const removedSet = new Set(removedIds)
  clearActiveRetryTimers()
  // Immediately refresh + follow-up checks until Vivaldi reports the authoritative active tab
  void refreshChromeState(false, removedSet)
  for (const delay of [60, 200, 450]) {
    activeRetryTimers.push(
      setTimeout(() => {
        void refreshChromeState(false, removedSet)
      }, delay)
    )
  }
}

async function loadStoredState() {
  const [s, p, m, v] = await Promise.all([
    loadSettings(),
    loadSavedPanels(),
    loadTreeMeta(),
    loadVirtualGroupMap(),
  ])
  settings.value = s
  savedPanels.value = p
  treeMeta.value = m
  virtualGroupMap.value = v
  applyThemeAndCss(s)
}

function applyThemeAndCss(s: Settings) {
  const root = document.documentElement
  if (s.theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', s.theme)
  root.setAttribute('data-density', s.density)
  root.style.setProperty('--font-size', `${s.fontSize}px`)
  root.style.setProperty('--icon-size', `${s.iconSize}px`)
  root.style.setProperty('--ui-icon-size', `${s.uiIconSize}px`)

  let styleEl = document.getElementById('vberry-custom-css') as HTMLStyleElement | null
  if (s.customCss.trim()) {
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'vberry-custom-css'
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = s.customCss
  } else if (styleEl) {
    styleEl.remove()
  }
}

// Derived data
const pinnedTabs = computed(() => tabs.value.filter(t => t.pinned))

const savedPanelIdSet = computed(() => new Set(savedPanels.value.map(p => p.id)))

const ungroupedTabs = computed(() =>
  tabs.value.filter(t => {
    if (t.pinned || t.groupId !== UNGROUPED_ID) return false
    const vid = t.id !== undefined ? virtualGroupMap.value[t.id] : undefined
    return !vid || !savedPanelIdSet.value.has(vid)
  })
)

const tabsByGroupId = computed(() => {
  const map = new Map<number, chrome.tabs.Tab[]>()
  for (const t of tabs.value) {
    if (t.pinned || t.groupId === UNGROUPED_ID) continue
    let list = map.get(t.groupId)
    if (!list) {
      list = []
      map.set(t.groupId, list)
    }
    list.push(t)
  }
  return map
})

const tabsBySavedId = computed(() => {
  const map = new Map<string, chrome.tabs.Tab[]>()
  for (const t of tabs.value) {
    if (t.pinned || t.groupId !== UNGROUPED_ID || t.id === undefined) continue
    const vid = virtualGroupMap.value[t.id]
    if (!vid || !savedPanelIdSet.value.has(vid)) continue
    let list = map.get(vid)
    if (!list) {
      list = []
      map.set(vid, list)
    }
    list.push(t)
  }
  return map
})

// Saved panels that don't currently have a matching live native Chrome Tab Group in this window
const unmaterializedSavedPanels = computed(() => {
  const liveTitles = new Set(groups.value.map(g => (g.title ?? '').trim().toLowerCase()))
  return savedPanels.value.filter(p => !liveTitles.has(p.title.trim().toLowerCase()))
})

const activeTabList = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const view = activeView.value
  let list: chrome.tabs.Tab[] = []

  if (q) {
    list = tabs.value.filter(
      t =>
        !t.pinned &&
        ((t.title ?? '').toLowerCase().includes(q) || (t.url ?? '').toLowerCase().includes(q))
    )
  } else if (view.kind === 'ungrouped') {
    list = ungroupedTabs.value
  } else if (view.kind === 'group') {
    list = tabsByGroupId.value.get(view.groupId) ?? []
  } else if (view.kind === 'saved') {
    list = tabsBySavedId.value.get(view.savedId) ?? []
  }

  return buildTabTree(list, treeMeta.value)
})

const activeSavedPanel = computed(() => {
  const view = activeView.value
  if (view.kind !== 'saved') return null
  return savedPanels.value.find(p => p.id === view.savedId) ?? null
})

const activeGroupTitle = computed(() => {
  const view = activeView.value
  if (view.kind === 'ungrouped') return 'Ungrouped'
  if (view.kind === 'group') {
    const g = groups.value.find(x => x.id === view.groupId)
    return g?.title?.trim() || 'Group'
  }
  if (view.kind === 'saved') return activeSavedPanel.value?.title || 'Group'
  return ''
})

// Actions
async function selectView(view: ActiveView) {
  activeView.value = view
  if (view.kind === 'ungrouped' || view.kind === 'group' || view.kind === 'saved') {
    lastTabView.value = view
  }
  selectedIds.value = new Set()
  if (settings.value.autoCollapseInactiveGroups && windowId.value >= 0) {
    if (view.kind === 'group') {
      await syncCollapseOnSwitch(windowId.value, view.groupId)
    } else if (view.kind === 'ungrouped') {
      await syncCollapseOnSwitch(windowId.value, UNGROUPED_ID)
    }
  }
}

async function openNewTabInActiveView(url?: string, background = false) {
  if (windowId.value < 0) windowId.value = await getTargetWindowId()
  if (windowId.value < 0) return

  const view = activeView.value
  const isUtility =
    view.kind === 'bookmarks' || view.kind === 'history' || view.kind === 'snapshots'

  // Resolve target tab panel (current tab panel, or last visited tab panel when opening from Bookmarks/History)
  let target = isUtility ? lastTabView.value : view
  if (target.kind === 'group') {
    const gid = target.groupId
    if (!groups.value.some(g => g.id === gid)) target = { kind: 'ungrouped' }
  } else if (target.kind === 'saved') {
    const sid = target.savedId
    if (!savedPanels.value.some(p => p.id === sid)) target = { kind: 'ungrouped' }
  }

  if (target.kind === 'group') {
    const tab = await createNewTab({
      windowId: windowId.value,
      url,
      active: !background,
    })
    if (tab.id !== undefined) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: target.groupId }).catch(() => {})
    }
    if (!background) await selectView({ kind: 'group', groupId: target.groupId })
    return
  }

  if (target.kind === 'saved') {
    const panel = savedPanels.value.find(p => p.id === target.savedId)
    if (panel) {
      const res = await materializeSavedPanel(windowId.value, panel, url, !background)
      if (res.groupId !== null) {
        if (!background) await selectView({ kind: 'group', groupId: res.groupId })
      } else {
        virtualGroupMap.value = await loadVirtualGroupMap()
        if (!background) await selectView({ kind: 'saved', savedId: res.savedPanelId })
      }
      return
    }
  }

  const created = await createNewTab({ windowId: windowId.value, url, active: !background })
  if (!background) {
    if (created.groupId !== undefined && created.groupId !== UNGROUPED_ID) {
      await selectView({ kind: 'group', groupId: created.groupId })
    } else if (created.id !== undefined && virtualGroupMap.value[created.id]) {
      await selectView({ kind: 'saved', savedId: virtualGroupMap.value[created.id] })
    } else {
      await selectView({ kind: 'ungrouped' })
    }
  }
}

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
  await chrome.tabs.update(tabId, { active: true }).catch(() => {})
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
  const raw = e.dataTransfer?.getData('text/vberry-tab-id')
  const draggedId = Number(raw)
  if (!Number.isFinite(draggedId)) return

  const subtreeIds = getSubtreeIds(draggedId, tabs.value, treeMeta.value)
  if (typeof targetGroupId === 'number') {
    await moveTabsToGroup(subtreeIds, targetGroupId).catch(() => {})
    virtualGroupMap.value = await loadVirtualGroupMap()
  } else {
    const groupId = await moveTabsToSavedPanel(windowId.value, subtreeIds, targetGroupId)
    virtualGroupMap.value = await loadVirtualGroupMap()
    if (groupId !== null) {
      activeView.value = { kind: 'group', groupId }
    } else {
      activeView.value = { kind: 'saved', savedId: targetGroupId.id }
    }
  }
}

// Group modal (Create / Rename & Recolor)
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

function openEditNativeGroupModal(group: chrome.tabGroups.TabGroup) {
  groupMenu.value = null
  groupModal.value = {
    mode: 'edit-native',
    groupId: group.id,
    title: group.title ?? '',
    color: group.color,
  }
}

function openEditSavedPanelModal(panel: SavedPanel) {
  groupMenu.value = null
  groupModal.value = {
    mode: 'edit-saved',
    savedId: panel.id,
    title: panel.title,
    color: panel.color,
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
function clampMenuPos(e: MouseEvent, estW = 195, estH = 280) {
  return {
    x: Math.max(4, Math.min(e.clientX, window.innerWidth - estW)),
    y: Math.max(4, Math.min(e.clientY, window.innerHeight - estH)),
  }
}

function openTabContextMenu(tab: chrome.tabs.Tab, e: MouseEvent) {
  groupMenu.value = null
  itemMenu.value = null
  tabMenu.value = { tab, ...clampMenuPos(e, 190, 280) }
}

function openUngroupedContextMenu(e: MouseEvent) {
  tabMenu.value = null
  itemMenu.value = null
  groupMenu.value = { kind: 'ungrouped', ...clampMenuPos(e, 195, 310) }
}

function openNativeGroupContextMenu(group: chrome.tabGroups.TabGroup, e: MouseEvent) {
  tabMenu.value = null
  itemMenu.value = null
  groupMenu.value = { kind: 'native', group, ...clampMenuPos(e, 195, 340) }
}

function openSavedPanelContextMenu(panel: SavedPanel, e: MouseEvent) {
  tabMenu.value = null
  itemMenu.value = null
  groupMenu.value = { kind: 'saved', panel, ...clampMenuPos(e, 195, 340) }
}

function openActivePanelContextMenu(e: MouseEvent) {
  const view = activeView.value
  if (view.kind === 'ungrouped') {
    openUngroupedContextMenu(e)
  } else if (view.kind === 'group') {
    const g = groups.value.find(x => x.id === view.groupId)
    if (g) openNativeGroupContextMenu(g, e)
  } else if (view.kind === 'saved') {
    const p = savedPanels.value.find(x => x.id === view.savedId)
    if (p) openSavedPanelContextMenu(p, e)
  }
}

function closeMenus() {
  tabMenu.value = null
  groupMenu.value = null
  itemMenu.value = null
}

function openItemContextMenu(
  payload:
    | { kind: 'bookmark'; node: chrome.bookmarks.BookmarkTreeNode }
    | { kind: 'history'; item: chrome.history.HistoryItem }
    | { kind: 'session'; session: chrome.sessions.Session }
    | SnapshotContextTarget,
  e: MouseEvent
) {
  tabMenu.value = null
  groupMenu.value = null
  itemMenu.value = {
    ...payload,
    ...clampMenuPos(e, 195, 280),
  }
}

async function openUrlInSpecificTarget(
  url: string,
  target: number | SavedPanel,
  background = false
) {
  if (windowId.value < 0) windowId.value = await getTargetWindowId()
  if (windowId.value < 0) return

  if (typeof target === 'number') {
    const tab = await createNewTab({ windowId: windowId.value, url, active: !background })
    if (target !== UNGROUPED_ID && tab.id !== undefined) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: target }).catch(() => {})
      if (!background) await selectView({ kind: 'group', groupId: target })
    } else if (!background) {
      await selectView({ kind: 'ungrouped' })
    }
    return
  }

  const res = await materializeSavedPanel(windowId.value, target, url, !background)
  if (res.groupId !== null) {
    if (!background) await selectView({ kind: 'group', groupId: res.groupId })
  } else {
    virtualGroupMap.value = await loadVirtualGroupMap()
    if (!background) await selectView({ kind: 'saved', savedId: res.savedPanelId })
  }
}

function collectFolderUrls(node: chrome.bookmarks.BookmarkTreeNode): string[] {
  const urls: string[] = []
  if (node.url) urls.push(node.url)
  for (const child of node.children ?? []) {
    urls.push(...collectFolderUrls(child))
  }
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
        for (const u of collectFolderUrls(menu.node)) {
          await openNewTabInActiveView(u, true)
        }
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
    case 'delete-bookmark':
      if (menu.kind === 'bookmark') {
        if (!menu.node.url) {
          if (!confirm(`Delete folder "${menu.node.title}" and all its bookmarks?`)) return
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
      if (menu.kind === 'snapshot') await restoreSnapshot(menu.snapshot, true)
      return
    case 'snap-restore-here':
      if (menu.kind === 'snapshot') await restoreSnapshot(menu.snapshot, false)
      return
    case 'snap-export-md':
      if (menu.kind === 'snapshot') {
        const md = snapshotToMarkdown(menu.snapshot)
        const blob = new Blob([md], { type: 'text/markdown' })
        const blobUrl = URL.createObjectURL(blob)
        const a = document.createElement('a')
        a.href = blobUrl
        a.download = `vberry-snapshot-${menu.snapshot.id}.md`
        a.click()
        URL.revokeObjectURL(blobUrl)
      }
      return
    case 'snap-delete':
      if (menu.kind === 'snapshot') {
        const all = await loadSnapshots()
        await saveSnapshots(all.filter(s => s.id !== menu.snapshot.id))
        await snapshotsViewRef.value?.reload()
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
        const next: TabTreeMap = {
          ...treeMeta.value,
          [created.id]: { parentId: tab.id },
        }
        treeMeta.value = next
        await saveTreeMeta(next)
      }
      break
    }
    case 'duplicate':
      await chrome.tabs.duplicate(tab.id)
      break
    case 'pin':
      for (const id of ids) {
        const t = tabs.value.find(x => x.id === id)
        if (t) await chrome.tabs.update(id, { pinned: !t.pinned }).catch(() => {})
      }
      break
    case 'mute':
      await chrome.tabs.update(tab.id, { muted: !tab.mutedInfo?.muted }).catch(() => {})
      break
    case 'discard':
      await discardTabs(ids, tabs.value, windowId.value)
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
      break
    }
    case 'close':
      await chrome.tabs.remove(ids).catch(() => {})
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
      if (menu.kind === 'native') openEditNativeGroupModal(menu.group)
      else if (menu.kind === 'saved') openEditSavedPanelModal(menu.panel)
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
      for (const t of panelTabs) {
        if (t.id !== undefined) {
          await chrome.tabs.update(t.id, { muted: anyUnmuted }).catch(() => {})
        }
      }
      return
    }
    case 'discard':
      for (const t of panelTabs) {
        if (t.id !== undefined && !t.active && !t.discarded) {
          await chrome.tabs.discard(t.id).catch(() => {})
        }
      }
      return
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

// Switch panels via keyboard commands
function cyclePanel(dir: 1 | -1) {
  const views: Array<
    { kind: 'ungrouped' } | { kind: 'group'; groupId: number } | { kind: 'saved'; savedId: string }
  > = [
    { kind: 'ungrouped' },
    ...groups.value.map(g => ({ kind: 'group' as const, groupId: g.id })),
    ...unmaterializedSavedPanels.value.map(p => ({ kind: 'saved' as const, savedId: p.id })),
  ]
  const current = activeView.value
  const curIdx = views.findIndex(v => {
    if (v.kind === 'ungrouped') return current.kind === 'ungrouped'
    if (v.kind === 'group') return current.kind === 'group' && v.groupId === current.groupId
    return current.kind === 'saved' && v.savedId === current.savedId
  })
  const nextIdx = (curIdx + dir + views.length) % views.length
  void selectView(views[nextIdx])
}

function onRuntimeMessage(msg: RuntimeCommandMessage) {
  if (msg?.type !== 'vberry:command') return
  if (msg.command === 'new_tab_in_panel') void openNewTabInActiveView()
  else if (msg.command === 'next_panel') cyclePanel(1)
  else if (msg.command === 'prev_panel') cyclePanel(-1)
  else if (msg.command === 'focus_search') searchInputRef.value?.focus()
}

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area === 'session') {
    if (changes[STORAGE_KEYS.treeMeta]) {
      treeMeta.value = (changes[STORAGE_KEYS.treeMeta].newValue as TabTreeMap) ?? {}
    }
    if (changes[STORAGE_KEYS.virtualGroups]) {
      virtualGroupMap.value =
        (changes[STORAGE_KEYS.virtualGroups].newValue as Record<number, string>) ?? {}
    }
  }
  if (area === 'local') {
    if (changes[STORAGE_KEYS.settings]) {
      settings.value = { ...DEFAULT_SETTINGS, ...(changes[STORAGE_KEYS.settings].newValue ?? {}) }
      applyThemeAndCss(settings.value)
    }
    if (changes[STORAGE_KEYS.savedPanels]) {
      const nextRaw = changes[STORAGE_KEYS.savedPanels].newValue
      const nextPanels: SavedPanel[] = Array.isArray(nextRaw)
        ? nextRaw
        : nextRaw && typeof nextRaw === 'object'
          ? (Object.values(nextRaw) as SavedPanel[]).filter(v => v && typeof v === 'object')
          : []
      savedPanels.value = nextPanels
      const curView = activeView.value
      if (curView.kind === 'saved' && !nextPanels.some(p => p.id === curView.savedId)) {
        activeView.value = { kind: 'ungrouped' }
      }
    }
  }
}

function onTabRemoved(tabId: number, info: { windowId: number; isWindowClosing: boolean }) {
  if (info.isWindowClosing) return
  if (info.windowId !== windowId.value && !tabs.value.some(t => t.id === tabId)) return
  scheduleActiveSyncAfterRemove([tabId])
}

function onTabHighlighted(info: { tabIds: number[]; windowId: number }) {
  if (info.windowId !== windowId.value) return
  scheduleRefresh()
}

function onTabActivated(info: { tabId: number; windowId: number }) {
  if (info.windowId !== windowId.value && !tabs.value.some(t => t.id === info.tabId)) return
  refreshSeq++ // Supersede any older in-flight refresh so it cannot overwrite this activation
  activeTabId.value = info.tabId
  lastClickedId.value = info.tabId
  selectedIds.value = new Set()
  // Optimistically update active highlight immediately even in unfocused windows
  if (tabs.value.some(t => t.id === info.tabId)) {
    tabs.value = tabs.value.map(t => ({ ...t, active: t.id === info.tabId }))
  }
  scheduleRefresh()
  const isUtility =
    activeView.value.kind === 'bookmarks' ||
    activeView.value.kind === 'history' ||
    activeView.value.kind === 'snapshots'
  if (isUtility) return
  const tab = tabs.value.find(t => t.id === info.tabId)
  if (tab && !tab.pinned) {
    if (tab.groupId !== UNGROUPED_ID) {
      activeView.value = { kind: 'group', groupId: tab.groupId }
    } else if (tab.id !== undefined && virtualGroupMap.value[tab.id]) {
      const sid = virtualGroupMap.value[tab.id]
      activeView.value = savedPanelIdSet.value.has(sid)
        ? { kind: 'saved', savedId: sid }
        : { kind: 'ungrouped' }
    } else {
      activeView.value = { kind: 'ungrouped' }
    }
  }
}

function openOptions() {
  void chrome.runtime.openOptionsPage()
}

watch(
  () => settings.value,
  s => applyThemeAndCss(s),
  { deep: true }
)

function onKeyDown(e: KeyboardEvent) {
  if (e.key === 'Escape') closeMenus()
}

function onWindowFocusChanged() {
  scheduleRefresh()
}

onMounted(async () => {
  await loadStoredState()
  await refreshChromeState(true)

  chrome.tabs.onCreated.addListener(scheduleRefresh)
  chrome.tabs.onUpdated.addListener(scheduleRefresh)
  chrome.tabs.onRemoved.addListener(onTabRemoved)
  chrome.tabs.onMoved.addListener(scheduleRefresh)
  chrome.tabs.onAttached.addListener(scheduleRefresh)
  chrome.tabs.onDetached.addListener(scheduleRefresh)
  chrome.tabs.onActivated.addListener(onTabActivated)
  chrome.tabs.onHighlighted?.addListener(onTabHighlighted)
  chrome.windows?.onFocusChanged?.addListener(onWindowFocusChanged)

  chrome.tabGroups?.onCreated?.addListener(scheduleRefresh)
  chrome.tabGroups?.onUpdated?.addListener(scheduleRefresh)
  chrome.tabGroups?.onRemoved?.addListener(scheduleRefresh)
  chrome.tabGroups?.onMoved?.addListener(scheduleRefresh)

  chrome.storage.onChanged.addListener(onStorageChanged)
  chrome.runtime.onMessage.addListener(onRuntimeMessage)
  window.addEventListener('click', closeMenus)
  window.addEventListener('blur', closeMenus)
  window.addEventListener('focus', scheduleRefresh)
  window.addEventListener('keydown', onKeyDown)
  document.addEventListener('visibilitychange', closeMenus)
})

onUnmounted(() => {
  clearTimeout(refreshTimer)
  clearActiveRetryTimers()
  chrome.tabs.onCreated.removeListener(scheduleRefresh)
  chrome.tabs.onUpdated.removeListener(scheduleRefresh)
  chrome.tabs.onRemoved.removeListener(onTabRemoved)
  chrome.tabs.onMoved.removeListener(scheduleRefresh)
  chrome.tabs.onAttached.removeListener(scheduleRefresh)
  chrome.tabs.onDetached.removeListener(scheduleRefresh)
  chrome.tabs.onActivated.removeListener(onTabActivated)
  chrome.tabs.onHighlighted?.removeListener(onTabHighlighted)
  chrome.windows?.onFocusChanged?.removeListener(onWindowFocusChanged)

  chrome.tabGroups?.onCreated?.removeListener(scheduleRefresh)
  chrome.tabGroups?.onUpdated?.removeListener(scheduleRefresh)
  chrome.tabGroups?.onRemoved?.removeListener(scheduleRefresh)
  chrome.tabGroups?.onMoved?.removeListener(scheduleRefresh)

  chrome.storage.onChanged.removeListener(onStorageChanged)
  chrome.runtime.onMessage.removeListener(onRuntimeMessage)
  window.removeEventListener('click', closeMenus)
  window.removeEventListener('blur', closeMenus)
  window.removeEventListener('focus', scheduleRefresh)
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
          @contextmenu.prevent="openUngroupedContextMenu($event)"
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
          @contextmenu.prevent="openNativeGroupContextMenu(g, $event)"
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

        <!-- Saved / Virtual panels (used for empty Sidebery panels on Chrome, or active groups on Vivaldi) -->
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
          @contextmenu.prevent="openSavedPanelContextMenu(sp, $event)"
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
        @click="pt.id !== undefined && activateTab(pt.id, $event)"
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
      :query="searchQuery"
      @open-url="(url, bg) => openNewTabInActiveView(url, bg)"
      @context-menu="(node, e) => openItemContextMenu({ kind: 'bookmark', node }, e)"
    />
    <HistoryView
      v-else-if="activeView.kind === 'history'"
      ref="historyViewRef"
      :query="searchQuery"
      @open-url="(url, bg) => openNewTabInActiveView(url, bg)"
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

    <!-- Create / Edit Tab Group Modal -->
    <div v-if="groupModal" class="modal-backdrop" @click.self="groupModal = null">
      <form class="modal" @submit.prevent="submitGroupModal">
        <div class="modal-title">
          {{ groupModal.mode === 'create' ? 'New Tab Group' : 'Edit Tab Group' }}
        </div>
        <input
          v-model="groupModal.title"
          class="modal-input"
          placeholder="Group name"
        />
        <div class="color-picker">
          <button
            v-for="c in CHROME_GROUP_COLORS"
            :key="c"
            type="button"
            class="color-swatch"
            :class="{ selected: groupModal.color === c }"
            :style="{ background: `var(--grp-${c})` }"
            :title="c"
            @click="groupModal.color = c"
          />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn-ghost" @click="groupModal = null">Cancel</button>
          <button type="submit" class="btn-primary">
            {{ groupModal.mode === 'create' ? 'Create' : 'Save' }}
          </button>
        </div>
      </form>
    </div>

    <!-- Tab Context Menu -->
    <div
      v-if="tabMenu"
      class="ctx-menu"
      :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }"
      @click.stop
    >
      <button @click="tabMenuAction('new-child')">New Child Tab</button>
      <button @click="tabMenuAction('duplicate')">Duplicate</button>
      <button @click="tabMenuAction('pin')">{{ tabMenu.tab.pinned ? 'Unpin' : 'Pin' }}</button>
      <button @click="tabMenuAction('mute')">
        {{ tabMenu.tab.mutedInfo?.muted ? 'Unmute' : 'Mute' }}
      </button>
      <button @click="tabMenuAction('discard')">Unload Tab</button>
      <hr />
      <button @click="tabMenuAction('indent')">Indent (Make Child)</button>
      <button @click="tabMenuAction('outdent')">Outdent</button>
      <hr />
      <div class="ctx-label">Move to Group</div>
      <button @click="tabMenuAction('move-group', UNGROUPED_ID)">Ungrouped</button>
      <button
        v-for="g in groups"
        :key="`ng_${g.id}`"
        @click="tabMenuAction('move-group', g.id)"
      >
        <span class="ctx-dot" :style="{ background: `var(--grp-${g.color})` }" />
        {{ g.title || 'Group' }}
      </button>
      <button
        v-for="sp in unmaterializedSavedPanels"
        :key="`sp_${sp.id}`"
        @click="tabMenuAction('move-group', sp)"
      >
        <span class="ctx-dot" :style="{ background: `var(--grp-${sp.color})` }" />
        {{ sp.title }}
      </button>
      <hr />
      <button class="danger" @click="tabMenuAction('close-branch')">Close Branch</button>
      <button class="danger" @click="tabMenuAction('close')">Close Tab</button>
    </div>

    <!-- Panel / Group Context Menu -->
    <div
      v-if="groupMenu"
      class="ctx-menu"
      :style="{ left: `${groupMenu.x}px`, top: `${groupMenu.y}px` }"
      @click.stop
    >
      <button @click="groupMenuAction('new-tab')">New Tab</button>
      <button @click="groupMenuAction('new-group')">New Tab Group…</button>
      <template v-if="groupMenu.kind !== 'ungrouped'">
        <hr />
        <button @click="groupMenuAction('edit')">Rename / Change Color…</button>
        <button v-if="groupMenu.kind === 'native'" @click="groupMenuAction('toggle-collapse')">
          {{ groupMenu.group.collapsed ? 'Expand in Tab Strip' : 'Collapse in Tab Strip' }}
        </button>
      </template>
      <hr />
      <button @click="groupMenuAction('expand-all')">Expand All Branches</button>
      <button @click="groupMenuAction('collapse-all')">Collapse All Branches</button>
      <button @click="groupMenuAction('sort-title')">Sort Tabs by Title</button>
      <button @click="groupMenuAction('sort-url')">Sort Tabs by URL</button>
      <button @click="groupMenuAction('dedupe')">Close Duplicate Tabs</button>
      <hr />
      <button @click="groupMenuAction('discard')">Unload Inactive Tabs</button>
      <button @click="groupMenuAction('mute-all')">Toggle Mute All Tabs</button>
      <button @click="groupMenuAction('bookmark')">Bookmark All Tabs</button>
      <button @click="groupMenuAction('snapshot')">Take Snapshot</button>
      <hr />
      <button v-if="groupMenu.kind !== 'ungrouped'" @click="groupMenuAction('ungroup')">
        Ungroup All Tabs
      </button>
      <button class="danger" @click="groupMenuAction('close-all')">Close All Tabs</button>
      <button
        v-if="groupMenu.kind === 'saved'"
        class="danger"
        @click="groupMenuAction('delete-panel')"
      >
        Delete Panel
      </button>
    </div>

    <!-- Bookmarks / History / Snapshots Context Menu -->
    <div
      v-if="itemMenu"
      class="ctx-menu"
      :style="{ left: `${itemMenu.x}px`, top: `${itemMenu.y}px` }"
      @click.stop
    >
      <!-- Link-based items: Bookmark link, History item, Recently Closed tab, Snapshot tab -->
      <template
        v-if="
          (itemMenu.kind === 'bookmark' && itemMenu.node.url) ||
          itemMenu.kind === 'history' ||
          (itemMenu.kind === 'session' && itemMenu.session.tab?.url) ||
          itemMenu.kind === 'snapshot-tab'
        "
      >
        <button v-if="itemMenu.kind === 'session'" @click="itemMenuAction('restore-session')">
          Restore Tab
        </button>
        <button @click="itemMenuAction('open')">Open</button>
        <button @click="itemMenuAction('open-bg')">Open in Background</button>
        <hr />
        <div class="ctx-label">Open in Tab Group</div>
        <button @click="itemMenuAction('open-in-group', UNGROUPED_ID)">Ungrouped</button>
        <button
          v-for="g in groups"
          :key="`ig_${g.id}`"
          @click="itemMenuAction('open-in-group', g.id)"
        >
          <span class="ctx-dot" :style="{ background: `var(--grp-${g.color})` }" />
          {{ g.title || 'Group' }}
        </button>
        <button
          v-for="sp in unmaterializedSavedPanels"
          :key="`isp_${sp.id}`"
          @click="itemMenuAction('open-in-group', sp)"
        >
          <span class="ctx-dot" :style="{ background: `var(--grp-${sp.color})` }" />
          {{ sp.title }}
        </button>
        <hr />
        <button @click="itemMenuAction('copy-url')">Copy URL</button>
        <button
          v-if="itemMenu.kind === 'bookmark'"
          class="danger"
          @click="itemMenuAction('delete-bookmark')"
        >
          Delete Bookmark
        </button>
        <button
          v-if="itemMenu.kind === 'history'"
          class="danger"
          @click="itemMenuAction('delete-history')"
        >
          Delete from History
        </button>
      </template>

      <!-- Bookmark folder -->
      <template v-else-if="itemMenu.kind === 'bookmark' && !itemMenu.node.url">
        <button @click="itemMenuAction('open-folder-tabs')">Open All in New Tabs</button>
        <button @click="itemMenuAction('open-folder-group')">Open All as Tab Group</button>
        <template v-if="itemMenu.node.parentId && itemMenu.node.parentId !== '0'">
          <hr />
          <button class="danger" @click="itemMenuAction('delete-bookmark')">Delete Folder</button>
        </template>
      </template>

      <!-- Snapshot card -->
      <template v-else-if="itemMenu.kind === 'snapshot'">
        <button @click="itemMenuAction('snap-restore-new')">Restore in New Window</button>
        <button @click="itemMenuAction('snap-restore-here')">Restore in Current Window</button>
        <button @click="itemMenuAction('snap-export-md')">Export Markdown</button>
        <hr />
        <button class="danger" @click="itemMenuAction('snap-delete')">Delete Snapshot</button>
      </template>

      <!-- Recently closed window session -->
      <template v-else-if="itemMenu.kind === 'session'">
        <button @click="itemMenuAction('restore-session')">Restore Window</button>
      </template>

      <!-- Snapshot group -->
      <template v-else-if="itemMenu.kind === 'snapshot-group'">
        <button @click="itemMenuAction('snap-restore-group')">Restore Group Here</button>
      </template>
    </div>
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

.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.38);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
}

.modal {
  width: min(290px, calc(100vw - 24px));
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 14px;
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.modal-title {
  font-weight: 600;
  font-size: 13.5px;
}

.modal-input {
  width: 100%;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg-subtle);
  outline: none;
}

.modal-input:focus {
  border-color: var(--accent);
  background: var(--bg);
}

.color-picker {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.color-swatch {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 2px solid transparent;
  cursor: pointer;
}

.color-swatch.selected {
  outline: 2px solid var(--text);
  outline-offset: 2px;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}

.btn-ghost,
.btn-primary {
  padding: 5px 12px;
  border-radius: 6px;
  border: 1px solid var(--border);
  cursor: pointer;
  font-size: 12px;
}

.btn-ghost {
  background: transparent;
}

.btn-primary {
  background: var(--accent);
  color: var(--accent-text);
  border-color: transparent;
}

.ctx-menu {
  position: fixed;
  min-width: 175px;
  max-height: 80vh;
  overflow-y: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px;
  box-shadow: var(--shadow);
  z-index: 50;
  display: flex;
  flex-direction: column;
}

.ctx-menu button {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 5px 8px;
  border: none;
  border-radius: 5px;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font-size: 12.5px;
}

.ctx-menu button:hover {
  background: var(--bg-hover);
}

.ctx-menu button.danger {
  color: var(--danger);
}

.ctx-menu hr {
  border: none;
  border-top: 1px solid var(--border);
  margin: 4px 0;
}

.ctx-label {
  padding: 3px 8px;
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--text-muted);
}

.ctx-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
