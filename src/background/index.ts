import type { RuntimeMessage } from '@/shared/types'
import {
  loadSavedPanels,
  loadSettings,
  loadTreeMeta,
  loadVirtualGroupMap,
  saveTreeMeta,
  saveVirtualGroupMap,
  STORAGE_KEYS,
} from '@/shared/storage'
import { getTargetWindowId } from '@/shared/env'
import { matchesMoveRule, reparentOnRemove } from '@/shared/tree'
import {
  assignTabsToVirtualGroup,
  captureSnapshot,
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

chrome.windows?.onFocusChanged?.addListener(winId => {
  if (typeof winId === 'number' && winId >= 0) {
    lastFocusedWindowId = winId
  }
})

chrome.windows?.onRemoved?.addListener(winId => {
  openSidePanelWindows.delete(winId)
  if (lastFocusedWindowId === winId) lastFocusedWindowId = -1
})

chrome.tabs.onActivated.addListener(info => {
  if (info.windowId >= 0) lastFocusedWindowId = info.windowId
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

    if (settings.autoNestChildTabs) {
      const meta = await loadTreeMeta()
      meta[tab.id] = { ...meta[tab.id], parentId: opener.id }
      await saveTreeMeta(meta)
    }
  } catch {
    // Opener may have closed before onCreated finished
  }
})

chrome.tabs.onRemoved.addListener(async tabId => {
  const [meta, vmap] = await Promise.all([loadTreeMeta(), loadVirtualGroupMap()])
  if (meta[tabId] || Object.values(meta).some(e => e.parentId === tabId)) {
    await saveTreeMeta(reparentOnRemove(tabId, meta))
  }
  if (vmap[tabId]) {
    delete vmap[tabId]
    await saveVirtualGroupMap(vmap)
  }
  schedulePersistSession()
})

chrome.tabs.onMoved.addListener(() => {
  schedulePersistSession()
})

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const [meta, vmap] = await Promise.all([loadTreeMeta(), loadVirtualGroupMap()])
  const hasMetaEntry = Boolean(meta[removedTabId])
  const hasChildren = Object.values(meta).some(e => e.parentId === removedTabId)
  if (hasMetaEntry || hasChildren) {
    if (hasMetaEntry) {
      meta[addedTabId] = meta[removedTabId]
      delete meta[removedTabId]
    }
    for (const entry of Object.values(meta)) {
      if (entry.parentId === removedTabId) entry.parentId = addedTabId
    }
    await saveTreeMeta(meta)
  }
  if (vmap[removedTabId]) {
    vmap[addedTabId] = vmap[removedTabId]
    delete vmap[removedTabId]
    await saveVirtualGroupMap(vmap)
  }
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

// Keyboard commands
chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command === 'create_snapshot') {
    await captureSnapshot()
    return
  }

  if (command === 'discard_inactive_tabs') {
    const windowId = tab?.windowId ?? (await getTargetWindowId())
    const tabs = await chrome.tabs.query(windowId >= 0 ? { windowId } : { currentWindow: true })
    await Promise.allSettled(
      tabs
        .filter(t => t.id !== undefined && !t.active && !t.pinned && !t.audible && !t.discarded)
        .map(t => chrome.tabs.discard(t.id!))
    )
    return
  }

  const targetWinId = lastFocusedWindowId >= 0 ? lastFocusedWindowId : tab?.windowId
  chrome.runtime
    .sendMessage({ type: 'vberry:command', command, windowId: targetWinId })
    .catch(() => {})
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
    await chrome.tabs.create({ url, active: true })
  } else {
    const panels = await loadSavedPanels()
    const match = panels.find(p => p.title.toLowerCase() === text.trim().toLowerCase())
    if (match) {
      const winId = await getTargetWindowId()
      if (winId >= 0) await materializeSavedPanel(winId, match)
    }
  }
})
