import type {
  RuntimeMessage,
  Settings,
  SpotlightGroup,
  SpotlightItem,
  SpotlightView,
} from '@/shared/types'
import {
  getChromeFaviconUrl,
  loadSavedPanels,
  loadSettings,
  loadTreeMeta,
  loadVirtualGroupMap,
  remapReplacedTabIds,
  STORAGE_KEYS,
  updateTreeMeta,
  updateVirtualGroupMap,
} from '@/shared/storage'
import { createNewTab, getTargetWindowId } from '@/shared/env'
import { rankSearchItems } from '@/shared/search'
import { mountSpotlightOverlay, type SpotlightOverlayConfig } from '@/shared/spotlight-overlay'
import { buildTabTree, matchesMoveRule, reparentOnRemove, toggleFold } from '@/shared/tree'
import {
  assignTabsToVirtualGroup,
  captureSnapshot,
  discardTabs,
  materializeSavedPanel,
  moveTabsToGroup,
  moveTabsToSavedPanel,
  restoreSnapshot,
  safeQueryTabGroups,
  UNGROUPED_ID,
} from '@/shared/groups'
import {
  persistCurrentSession,
  restorePersistedSessionIfNeeded,
} from '@/shared/session-state'

const AUTO_SNAPSHOT_ALARM = 'vberry_auto_snapshot'
const MENU_ROOT_ID = 'vberry_send_to_group'
const openSidePanelWindows = new Set<number>()
let lastFocusedWindowId = -1
let quickSearchWindowId = -1

chrome.windows?.onFocusChanged?.addListener(winId => {
  if (typeof winId === 'number' && winId >= 0 && winId !== quickSearchWindowId) {
    lastFocusedWindowId = winId
  }
})

chrome.windows?.onRemoved?.addListener(winId => {
  openSidePanelWindows.delete(winId)
  if (lastFocusedWindowId === winId) lastFocusedWindowId = -1
  if (quickSearchWindowId === winId) quickSearchWindowId = -1
})

chrome.tabs.onActivated.addListener(info => {
  if (info.windowId >= 0 && info.windowId !== quickSearchWindowId) {
    lastFocusedWindowId = info.windowId
  }
})

function toggleSidePanelForWindow(winId: number): void {
  if (winId < 0) return
  if (openSidePanelWindows.has(winId)) {
    openSidePanelWindows.delete(winId)
    chrome.runtime.sendMessage({ type: 'vberry:close-panel', windowId: winId }).catch(() => {})
    return
  }
  // Must be called synchronously inside user-gesture handler to preserve Chrome's user gesture
  void chrome.sidePanel?.open?.({ windowId: winId }).catch(() => {})
}

async function initSidePanelBehavior(): Promise<void> {
  try {
    // Handle action clicks & _execute_action (Ctrl+E) explicitly via chrome.action.onClicked
    // so sidePanel.open({ windowId }) targets the actually focused window across multi-window sessions.
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false })
  } catch {
    // Some Chromium forks (e.g. Vivaldi) do not implement setPanelBehavior
  }
  try {
    const win = await chrome.windows?.getLastFocused?.({ windowTypes: ['normal'] })
    if (win?.id !== undefined) lastFocusedWindowId = win.id
  } catch {
    // Ignore
  }
}

chrome.action?.onClicked?.addListener(tab => {
  // Chromium's _execute_action shortcut can pass the primary window's tab instead of
  // the currently focused window's tab; prefer tracked lastFocusedWindowId synchronously.
  if (lastFocusedWindowId >= 0) {
    toggleSidePanelForWindow(lastFocusedWindowId)
    return
  }
  if (tab.windowId !== undefined) {
    toggleSidePanelForWindow(tab.windowId)
  }
})

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'vberry:panel-open' && msg.windowId >= 0) {
    openSidePanelWindows.add(msg.windowId)
    return
  }
  if (msg.type === 'vberry:panel-close' && msg.windowId >= 0) {
    openSidePanelWindows.delete(msg.windowId)
    return
  }
  if (msg.type === 'vberry:restore-snapshot') {
    void restoreSnapshot(msg.snapshot, msg.inNewWindow)
      .then(() => persistCurrentSession())
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  if (msg.type === 'vberry:discard-tabs') {
    void chrome.tabs
      .query({ windowId: msg.windowId })
      .then(winTabs => discardTabs(msg.tabIds, winTabs, msg.windowId))
      .then(() => persistCurrentSession())
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  if (msg.type === 'vberry:open-quick-search') {
    void launchQuickSearch(msg.windowId, msg.view)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  if (msg.type === 'vberry:spotlight-toggle-fold') {
    void updateTreeMeta(meta => toggleFold(msg.tabId, meta))
      .then(() => persistCurrentSession())
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }))
    return true
  }
  if (msg.type === 'vberry:spotlight-query') {
    void querySpotlightItems(
      msg.query,
      msg.view,
      msg.windowId,
      msg.groupKey,
      msg.expandedFolderIds
    )
      .then(result => sendResponse(result))
      .catch(() => sendResponse({ items: [], groups: [] }))
    return true
  }
  if (msg.type === 'vberry:spotlight-activate') {
    void (async () => {
      if (msg.kind === 'tab' && msg.tabId !== undefined) {
        await chrome.tabs.update(msg.tabId, { active: true }).catch(() => {})
        if (msg.windowId >= 0) {
          await chrome.windows.update(msg.windowId, { focused: true }).catch(() => {})
        }
      } else if (msg.kind === 'url' && msg.url) {
        await createNewTab({
          windowId: msg.windowId >= 0 ? msg.windowId : undefined,
          url: msg.url,
          active: true,
        }).catch(() => {})
        if (msg.windowId >= 0) {
          await chrome.windows.update(msg.windowId, { focused: true }).catch(() => {})
        }
      }
      sendResponse({ ok: true })
    })()
    return true
  }
})

async function syncAutoSnapshotAlarm(): Promise<void> {
  const settings = await loadSettings()
  await chrome.alarms.clear(AUTO_SNAPSHOT_ALARM)
  if (settings.autoSnapshotMinutes > 0) {
    await chrome.alarms.create(AUTO_SNAPSHOT_ALARM, {
      periodInMinutes: Math.max(5, settings.autoSnapshotMinutes),
    })
  }
}

let menuRebuildTimer: ReturnType<typeof setTimeout> | undefined
function scheduleContextMenuRebuild(): void {
  clearTimeout(menuRebuildTimer)
  menuRebuildTimer = setTimeout(() => {
    void rebuildContextMenus()
  }, 250)
}

let persistSessionTimer: ReturnType<typeof setTimeout> | undefined
function schedulePersistSession(): void {
  clearTimeout(persistSessionTimer)
  persistSessionTimer = setTimeout(() => {
    void persistCurrentSession()
  }, 400)
}

let menuBuildSeq = 0

function createMenuItem(props: Parameters<typeof chrome.contextMenus.create>[0]): void {
  chrome.contextMenus.create(props, () => {
    void chrome.runtime.lastError
  })
}

async function rebuildContextMenus(): Promise<void> {
  const seq = ++menuBuildSeq
  try {
    // Fetch data BEFORE removeAll() so removeAll -> create() has zero awaits in between
    const [groups, savedPanels] = await Promise.all([safeQueryTabGroups(), getSavedPanelsCached()])
    if (seq !== menuBuildSeq) return

    await new Promise<void>(resolve => {
      chrome.contextMenus.removeAll(() => {
        void chrome.runtime.lastError
        resolve()
      })
    })
    if (seq !== menuBuildSeq) return

    createMenuItem({
      id: MENU_ROOT_ID,
      title: 'Send to VBerry Group',
      contexts: ['page', 'link'],
    })

    const liveTitles = new Set<string>()
    const seenIds = new Set<number>()

    for (const g of groups) {
      if (seenIds.has(g.id)) continue
      seenIds.add(g.id)
      const label = g.title?.trim() || `Group (${g.color})`
      liveTitles.add(label.toLowerCase())
      createMenuItem({
        id: `vberry_group_${g.id}`,
        parentId: MENU_ROOT_ID,
        title: label,
        contexts: ['page', 'link'],
      })
    }

    for (const sp of savedPanels) {
      if (liveTitles.has(sp.title.trim().toLowerCase())) continue
      createMenuItem({
        id: `vberry_saved_${sp.id}`,
        parentId: MENU_ROOT_ID,
        title: sp.title,
        contexts: ['page', 'link'],
      })
    }

    createMenuItem({
      id: 'vberry_group_ungroup',
      parentId: MENU_ROOT_ID,
      title: 'Ungrouped',
      contexts: ['page', 'link'],
    })
  } catch {
    // Ignore transient context menu errors during rapid group changes
  }
}

let cachedSavedPanels: Awaited<ReturnType<typeof loadSavedPanels>> | null = null
async function getSavedPanelsCached() {
  if (cachedSavedPanels === null) cachedSavedPanels = await loadSavedPanels()
  return cachedSavedPanels
}

function bootstrap(): void {
  void initSidePanelBehavior()
  void syncAutoSnapshotAlarm()
  void rebuildContextMenus()
  void restorePersistedSessionIfNeeded()
}

chrome.runtime.onInstalled.addListener(bootstrap)
chrome.runtime.onStartup.addListener(bootstrap)

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes[STORAGE_KEYS.settings]) void syncAutoSnapshotAlarm()
    if (changes[STORAGE_KEYS.savedPanels]) {
      cachedSavedPanels = null
      scheduleContextMenuRebuild()
    }
  }
  if (area === 'session') {
    if (changes[STORAGE_KEYS.treeMeta] || changes[STORAGE_KEYS.virtualGroups]) {
      schedulePersistSession()
    }
  }
})

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUTO_SNAPSHOT_ALARM) {
    void captureSnapshot()
  }
})

chrome.tabGroups?.onCreated?.addListener(scheduleContextMenuRebuild)
chrome.tabGroups?.onUpdated?.addListener(scheduleContextMenuRebuild)
chrome.tabGroups?.onRemoved?.addListener(scheduleContextMenuRebuild)

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  const id = String(info.menuItemId)
  if (!id.startsWith('vberry_group_') && !id.startsWith('vberry_saved_')) return

  const windowId = tab?.windowId ?? (await getTargetWindowId())
  let targetTabId = tab?.id

  if (info.linkUrl && windowId >= 0) {
    const created = await chrome.tabs.create({
      windowId,
      url: info.linkUrl,
      active: false,
    })
    targetTabId = created.id
  }

  if (targetTabId === undefined) return

  if (id === 'vberry_group_ungroup') {
    await moveTabsToGroup([targetTabId], UNGROUPED_ID).catch(() => {})
    return
  }

  if (id.startsWith('vberry_saved_')) {
    const savedId = id.replace('vberry_saved_', '')
    const panels = await loadSavedPanels()
    const panel = panels.find(p => p.id === savedId)
    if (panel && windowId >= 0) {
      await moveTabsToSavedPanel(windowId, [targetTabId], panel).catch(() => {})
    }
    return
  }

  const groupId = Number(id.replace('vberry_group_', ''))
  if (Number.isFinite(groupId)) {
    await moveTabsToGroup([targetTabId], groupId).catch(() => {})
  }
})

// Track parent-child tree hierarchy & inherit group automatically via openerTabId
chrome.tabs.onCreated.addListener(async tab => {
  if (tab.id === undefined || tab.pinned || tab.openerTabId === undefined) return
  const settings = await loadSettings()

  try {
    const opener = await chrome.tabs.get(tab.openerTabId)
    if (opener.pinned || opener.windowId !== tab.windowId) return

    if (opener.groupId !== UNGROUPED_ID && tab.groupId === UNGROUPED_ID) {
      await chrome.tabs.group({ tabIds: tab.id, groupId: opener.groupId }).catch(() => {})
    } else if (opener.id !== undefined) {
      const vmap = await loadVirtualGroupMap()
      if (vmap[opener.id] && !vmap[tab.id]) {
        await assignTabsToVirtualGroup([tab.id], vmap[opener.id])
      }
    }

    if (settings.autoNestChildTabs && tab.id !== undefined) {
      const childId = tab.id
      const parentId = opener.id
      await updateTreeMeta(meta => {
        meta[childId] = { ...meta[childId], parentId }
        return meta
      })
    }
  } catch {
    // Opener may have closed before onCreated finished
  }
})

chrome.tabs.onRemoved.addListener(async tabId => {
  await Promise.all([
    updateTreeMeta(meta =>
      meta[tabId] || Object.values(meta).some(e => e.parentId === tabId)
        ? reparentOnRemove(tabId, meta)
        : null
    ),
    updateVirtualGroupMap(vmap => {
      if (!vmap[tabId]) return null
      delete vmap[tabId]
      return vmap
    }),
  ])
  schedulePersistSession()
})

chrome.tabs.onMoved.addListener(() => {
  schedulePersistSession()
})

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  await remapReplacedTabIds(new Map([[removedTabId, addedTabId]]))
  schedulePersistSession()
})

// Apply URL moveRules from SavedPanels (including imported Sidebery moveRules)
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const url = changeInfo.url
  if (!url) return
  schedulePersistSession()
  if (
    tab.pinned ||
    url.startsWith('chrome://') ||
    url.startsWith('vivaldi://') ||
    url.startsWith('chrome-extension://')
  ) {
    return
  }
  const savedPanels = await getSavedPanelsCached()
  const matched = savedPanels.find(p => p.moveRules.some(r => matchesMoveRule(url, r)))
  if (!matched) return

  await moveTabsToSavedPanel(tab.windowId, [tabId], matched).catch(() => {})
})

const QUICK_SEARCH_COMMANDS: Record<string, SpotlightView> = {
  focus_search: 'tabs',
  switch_to_bookmarks: 'bookmarks',
  switch_to_history: 'history',
}

function commandForSpotlightView(view: SpotlightView): string {
  if (view === 'bookmarks') return 'switch_to_bookmarks'
  if (view === 'history') return 'switch_to_history'
  return 'focus_search'
}

function flattenBookmarkTree(
  nodes: chrome.bookmarks.BookmarkTreeNode[],
  expanded: Set<string>,
  level = 0
): SpotlightItem[] {
  const out: SpotlightItem[] = []
  for (const n of nodes) {
    if (n.id === '0') {
      if (n.children) out.push(...flattenBookmarkTree(n.children, expanded, 0))
      continue
    }
    const isFolder = !n.url
    if (isFolder) {
      const isExpanded = expanded.has(n.id)
      out.push({
        id: `bmf:${n.id}`,
        kind: 'folder',
        folderId: n.id,
        title: n.title || 'Folder',
        url: '',
        level,
        expanded: isExpanded,
      })
      if (isExpanded && n.children) {
        out.push(...flattenBookmarkTree(n.children, expanded, level + 1))
      }
    } else {
      out.push({
        id: `bm:${n.id}`,
        kind: 'url',
        title: n.title || n.url || '',
        url: n.url || '',
        favIconUrl: getChromeFaviconUrl(n.url, 32),
        level,
      })
    }
  }
  return out
}

function isInjectableUrl(url?: string): boolean {
  if (!url) return false
  if (!/^https?:\/\//i.test(url)) return false
  if (
    url.startsWith('https://chromewebstore.google.com/') ||
    url.startsWith('https://chrome.google.com/webstore')
  ) {
    return false
  }
  return true
}

async function querySpotlightItems(
  query: string,
  view: SpotlightView,
  windowId: number,
  groupKey?: string,
  expandedFolderIds?: string[]
): Promise<{ items: SpotlightItem[]; groups: SpotlightGroup[]; activeGroupKey: string }> {
  const q = query.trim()

  const [winTabs, winGroups, savedPanels, vmap, treeMeta, settings] = await Promise.all([
    chrome.tabs.query(windowId >= 0 ? { windowId } : { currentWindow: true }),
    safeQueryTabGroups(windowId >= 0 ? { windowId } : {}),
    getSavedPanelsCached(),
    loadVirtualGroupMap(),
    loadTreeMeta(),
    loadSettings(),
  ])

  const validSavedIds = new Set(savedPanels.map(p => p.id))
  const ungroupedTabs: chrome.tabs.Tab[] = []
  const byGroupId = new Map<number, chrome.tabs.Tab[]>()
  const bySavedId = new Map<string, chrome.tabs.Tab[]>()

  for (const t of [...winTabs].sort((a, b) => a.index - b.index)) {
    if (t.pinned || t.id === undefined) continue
    if (t.groupId !== UNGROUPED_ID) {
      const list = byGroupId.get(t.groupId)
      if (list) list.push(t)
      else byGroupId.set(t.groupId, [t])
    } else if (vmap[t.id] && validSavedIds.has(vmap[t.id])) {
      const sid = vmap[t.id]
      const list = bySavedId.get(sid)
      if (list) list.push(t)
      else bySavedId.set(sid, [t])
    } else {
      ungroupedTabs.push(t)
    }
  }

  const liveTitles = new Set(winGroups.map(g => (g.title ?? '').trim().toLowerCase()))
  const unmaterializedSaved = savedPanels.filter(
    p => !liveTitles.has(p.title.trim().toLowerCase())
  )

  const groups: SpotlightGroup[] = [
    { key: 'ungrouped', title: 'Tabs', count: ungroupedTabs.length },
    ...winGroups.map(g => ({
      key: `group:${g.id}`,
      title: g.title?.trim() || 'Group',
      color: g.color,
      count: byGroupId.get(g.id)?.length ?? 0,
    })),
    ...unmaterializedSaved.map(p => ({
      key: `saved:${p.id}`,
      title: p.title,
      color: p.color,
      count: bySavedId.get(p.id)?.length ?? 0,
    })),
  ]

  let resolvedGroupKey = groupKey || 'ungrouped'
  if (!groupKey) {
    const activeTab = winTabs.find(t => t.active && !t.pinned)
    if (activeTab) {
      if (activeTab.groupId !== UNGROUPED_ID && byGroupId.has(activeTab.groupId)) {
        resolvedGroupKey = `group:${activeTab.groupId}`
      } else if (activeTab.id !== undefined && vmap[activeTab.id] && validSavedIds.has(vmap[activeTab.id])) {
        resolvedGroupKey = `saved:${vmap[activeTab.id]}`
      }
    }
  }

  if (view === 'bookmarks') {
    if (q) {
      const found = (await chrome.bookmarks.search(q).catch(() => [])).filter(b => !!b.url)
      const ranked = rankSearchItems(found, q, b => ({
        title: b.title,
        url: b.url,
        tieBreaker: b.dateAdded ?? 0,
      }))
      return {
        groups,
        activeGroupKey: resolvedGroupKey,
        items: ranked.slice(0, 40).map(b => ({
          id: `bm:${b.id}`,
          kind: 'url',
          title: b.title || b.url || '',
          url: b.url || '',
          favIconUrl: getChromeFaviconUrl(b.url, 32),
        })),
      }
    }
    const tree = await chrome.bookmarks.getTree().catch(() => [])
    const expanded = new Set<string>(expandedFolderIds ?? ['1', '2'])
    return {
      groups,
      activeGroupKey: resolvedGroupKey,
      items: flattenBookmarkTree(tree, expanded),
    }
  }

  if (view === 'history') {
    const found = (
      await chrome.history
        .search({ text: q, maxResults: q ? 60 : 40, startTime: 0 })
        .catch(() => [])
    ).filter(h => !!h.url)
    const list = q
      ? rankSearchItems(found, q, h => ({
          title: h.title,
          url: h.url,
          tieBreaker: h.lastVisitTime ?? 0,
        }))
      : found
    return {
      groups,
      activeGroupKey: resolvedGroupKey,
      items: list.slice(0, 40).map(h => ({
        id: `hist:${h.id}`,
        kind: 'url',
        title: h.title || h.url || '',
        url: h.url || '',
        favIconUrl: getChromeFaviconUrl(h.url, 32),
      })),
    }
  }

  // Tabs
  const groupMap = new Map(winGroups.map(g => [g.id, g]))
  const savedMap = new Map(savedPanels.map(p => [p.id, p]))
  let panelList = ungroupedTabs
  if (resolvedGroupKey.startsWith('group:')) {
    const gid = Number(resolvedGroupKey.slice(6))
    panelList = byGroupId.get(gid) ?? []
  } else if (resolvedGroupKey.startsWith('saved:')) {
    const sid = resolvedGroupKey.slice(6)
    panelList = bySavedId.get(sid) ?? []
  }

  if (q) {
    const ranked = rankSearchItems(
      settings.searchAllGroups ? winTabs.filter(t => !t.pinned && t.id !== undefined) : panelList,
      q,
      t => ({
        title: t.title,
        url: t.url || t.pendingUrl,
        tieBreaker: (t.active ? 1e12 : 0) + (t.lastAccessed ?? 0),
      })
    )
    return {
      groups,
      activeGroupKey: resolvedGroupKey,
      items: ranked.map(t => {
        const grp = t.groupId !== UNGROUPED_ID ? groupMap.get(t.groupId) : undefined
        const saved =
          !grp && t.id !== undefined && vmap[t.id] ? savedMap.get(vmap[t.id]) : undefined
        return {
          id: `tab:${t.id}`,
          kind: 'tab',
          tabId: t.id,
          title: t.title || t.url || '(Untitled)',
          url: t.url || t.pendingUrl || '',
          favIconUrl: getChromeFaviconUrl(t.url || t.pendingUrl, 32) || t.favIconUrl,
          active: t.active,
          discarded: t.discarded,
          groupTitle: grp?.title?.trim() || saved?.title || undefined,
          groupColor: grp?.color || saved?.color,
        }
      }),
    }
  }

  const treeNodes = buildTabTree(panelList, treeMeta).filter(n => !n.hidden)
  return {
    groups,
    activeGroupKey: resolvedGroupKey,
    items: treeNodes.map(n => {
      const t = n.tab
      const grp = t.groupId !== UNGROUPED_ID ? groupMap.get(t.groupId) : undefined
      const saved = !grp && t.id !== undefined && vmap[t.id] ? savedMap.get(vmap[t.id]) : undefined
      return {
        id: `tab:${t.id}`,
        kind: 'tab',
        tabId: t.id,
        title: t.title || t.url || '(Untitled)',
        url: t.url || t.pendingUrl || '',
        favIconUrl: getChromeFaviconUrl(t.url || t.pendingUrl, 32) || t.favIconUrl,
        active: t.active,
        discarded: t.discarded,
        level: n.level,
        hasChildren: n.hasChildren,
        childCount: n.childCount,
        folded: n.folded,
        groupTitle: grp?.title?.trim() || saved?.title || undefined,
        groupColor: grp?.color || saved?.color,
      }
    }),
  }
}

async function openQuickSearchPopup(
  targetWinId: number,
  view: SpotlightView,
  command: string
): Promise<void> {
  if (quickSearchWindowId >= 0) {
    try {
      await chrome.windows.update(quickSearchWindowId, { focused: true })
      chrome.runtime
        .sendMessage({ type: 'vberry:command', command, windowId: targetWinId })
        .catch(() => {})
      return
    } catch {
      quickSearchWindowId = -1
    }
  }

  const width = 520
  const height = 540
  let left: number | undefined
  let top: number | undefined
  try {
    if (targetWinId >= 0) {
      const win = await chrome.windows.get(targetWinId)
      if (
        win.left !== undefined &&
        win.top !== undefined &&
        win.width !== undefined &&
        win.height !== undefined
      ) {
        left = Math.round(win.left + Math.max(0, (win.width - width) / 2))
        top = Math.round(win.top + Math.max(40, (win.height - height) / 4))
      }
    }
  } catch {
    // Use OS default placement
  }

  const params = new URLSearchParams({
    quicksearch: '1',
    view,
  })
  if (targetWinId >= 0) params.set('win', String(targetWinId))
  const url = chrome.runtime.getURL(`sidepanel.html?${params.toString()}`)

  const created = await chrome.windows
    .create({
      url,
      type: 'popup',
      width,
      height,
      left,
      top,
      focused: true,
    })
    .catch(() => null)
  if (created?.id !== undefined) {
    quickSearchWindowId = created.id
  }
}

async function tryOpenSpotlightOverlay(
  targetWinId: number,
  view: SpotlightView,
  settings: Settings
): Promise<boolean> {
  try {
    const granted = await chrome.permissions.contains({ origins: ['<all_urls>'] })
    if (!granted || !chrome.scripting?.executeScript) return false

    const tabs = await chrome.tabs.query(
      targetWinId >= 0 ? { windowId: targetWinId, active: true } : { currentWindow: true, active: true }
    )
    const activeTab = tabs[0]
    if (!activeTab?.id || !isInjectableUrl(activeTab.url)) return false

    const winId = activeTab.windowId ?? targetWinId
    if (winId >= 0) {
      await chrome.windows.update(winId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(activeTab.id, { active: true }).catch(() => {})

    const config: SpotlightOverlayConfig = {
      windowId: winId,
      view,
      theme: settings.theme,
      density: settings.density,
      fontSize: settings.fontSize,
      iconSize: settings.iconSize,
      uiIconSize: settings.uiIconSize,
      tabControlIconSize: settings.tabControlIconSize,
      showTabCounts: settings.showTabCounts,
      showBookmarksPanel: settings.showBookmarksPanel,
      showHistoryPanel: settings.showHistoryPanel,
      autoHighlight: settings.autoHighlightSearchMatch,
      clearOnPanelSwitch: settings.clearSearchOnPanelSwitch,
      panelShortcuts: settings.panelShortcuts,
      requireFocus: true,
    }
    const results = await chrome.scripting.executeScript({
      target: { tabId: activeTab.id },
      func: mountSpotlightOverlay,
      args: [config],
    })
    return results?.[0]?.result === true
  } catch {
    return false
  }
}

async function launchQuickSearch(targetWinId: number, view: SpotlightView): Promise<void> {
  const command = commandForSpotlightView(view)
  // If the Floating Quick Search popup is already open, reuse and refocus it cleanly
  if (quickSearchWindowId >= 0) {
    try {
      await chrome.windows.update(quickSearchWindowId, { focused: true })
      chrome.runtime
        .sendMessage({ type: 'vberry:command', command, windowId: targetWinId })
        .catch(() => {})
      return
    } catch {
      quickSearchWindowId = -1
    }
  }

  const settings = await loadSettings()
  if (settings.webpageSearchMode === 'overlay') {
    const injected = await tryOpenSpotlightOverlay(targetWinId, view, settings)
    if (injected) return
  }
  await openQuickSearchPopup(targetWinId, view, command)
}

// Keyboard commands
chrome.commands.onCommand.addListener((command, tab) => {
  const tabWinId =
    tab?.windowId !== undefined && tab.windowId !== quickSearchWindowId ? tab.windowId : undefined
  const syncWinId = lastFocusedWindowId >= 0 ? lastFocusedWindowId : tabWinId

  void (async () => {
    const targetWinId = syncWinId ?? (await getTargetWindowId())

    if (command === 'create_snapshot') {
      await captureSnapshot()
      return
    }

    if (command === 'discard_inactive_tabs') {
      const tabs = await chrome.tabs.query(
        targetWinId >= 0 ? { windowId: targetWinId } : { currentWindow: true }
      )
      const inactiveIds = tabs
        .filter(t => t.id !== undefined && !t.active && !t.pinned && !t.audible && !t.discarded)
        .map(t => t.id!)
      await discardTabs(inactiveIds, tabs, targetWinId)
      return
    }

    const searchView = QUICK_SEARCH_COMMANDS[command]
    if (searchView) {
      await launchQuickSearch(targetWinId, searchView)
      return
    }

    chrome.runtime
      .sendMessage({ type: 'vberry:command', command, windowId: targetWinId })
      .catch(() => {})
  })()
})

function escapeXml(str: string): string {
  return str.replace(/[<>&'"]/g, ch => {
    switch (ch) {
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '&':
        return '&amp;'
      case "'":
        return '&apos;'
      default:
        return '&quot;'
    }
  })
}

chrome.omnibox.setDefaultSuggestion({
  description: 'VBerry: Search open tabs and bookmarks',
})

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const q = text.trim().toLowerCase()
  const [tabs, bookmarks] = await Promise.all([
    chrome.tabs.query({}),
    q ? chrome.bookmarks.search(q).catch(() => []) : Promise.resolve([]),
  ])

  const results: chrome.omnibox.SuggestResult[] = []

  for (const t of tabs) {
    if (t.id === undefined) continue
    const title = t.title || ''
    const url = t.url || ''
    if (!q || title.toLowerCase().includes(q) || url.toLowerCase().includes(q)) {
      results.push({
        content: `tab:${t.windowId}:${t.id}`,
        description: `<match>[Tab]</match> ${escapeXml(title || url)} — <url>${escapeXml(url)}</url>`,
      })
      if (results.length >= 6) break
    }
  }

  for (const b of bookmarks) {
    if (!b.url) continue
    results.push({
      content: `url:${b.url}`,
      description: `<dim>[Bookmark]</dim> ${escapeXml(b.title || b.url)} — <url>${escapeXml(b.url)}</url>`,
    })
    if (results.length >= 10) break
  }

  suggest(results)
})

chrome.omnibox.onInputEntered.addListener(async text => {
  if (text.startsWith('tab:')) {
    const [, winStr, tabStr] = text.split(':')
    const tabId = Number(tabStr)
    const windowId = Number(winStr)
    if (Number.isFinite(tabId)) {
      await chrome.tabs.update(tabId, { active: true }).catch(() => {})
    }
    if (Number.isFinite(windowId)) {
      await chrome.windows.update(windowId, { focused: true }).catch(() => {})
    }
    return
  }

  const url = text.startsWith('url:') ? text.slice(4) : text
  if (/^https?:\/\//i.test(url)) {
    const winId = await getTargetWindowId()
    await createNewTab({ windowId: winId >= 0 ? winId : undefined, url, active: true })
  } else {
    const panels = await loadSavedPanels()
    const match = panels.find(p => p.title.toLowerCase() === text.trim().toLowerCase())
    if (match) {
      const winId = await getTargetWindowId()
      if (winId >= 0) await materializeSavedPanel(winId, match)
    }
  }
})
