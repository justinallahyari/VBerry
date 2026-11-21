import type { RuntimeMessage } from '@/shared/types'
import {
  loadSavedPanels,
  loadSettings,
  loadVirtualGroupMap,
  remapReplacedTabIds,
  STORAGE_KEYS,
  updateTreeMeta,
  updateVirtualGroupMap,
} from '@/shared/storage'
import { createNewTab, getTargetWindowId } from '@/shared/env'
import { searchNonTrashBookmarks } from '@/shared/bookmarks'
import { matchesMoveRule, reparentOnRemove } from '@/shared/tree'
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
const MENU_OPEN_SIDEPANEL_ID = 'vberry_action_open_sidepanel'
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
  if (info.windowId >= 0) {
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
    // Toolbar button & _execute_action open the frameless Quick Search default_popup;
    // Side Panel is toggled via Ctrl+E (toggle_side_panel) or right-clicking the toolbar button.
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
      id: MENU_OPEN_SIDEPANEL_ID,
      title: 'Open VBerry Side Panel',
      contexts: ['action'],
    })

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

chrome.runtime.onInstalled.addListener(details => {
  bootstrap()
  if (details.reason === 'install') {
    void chrome.tabs
      .create({ url: chrome.runtime.getURL('welcome.html'), active: true })
      .catch(() => {})
  }
})
chrome.runtime.onStartup.addListener(bootstrap)
// Hydrate cached settings & lastFocusedWindowId whenever the MV3 service worker wakes up
void initSidePanelBehavior()

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

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const id = String(info.menuItemId)
  if (id === MENU_OPEN_SIDEPANEL_ID) {
    // Must be called synchronously inside user-gesture handler to preserve Chrome's user gesture
    const winId =
      lastFocusedWindowId >= 0 ? lastFocusedWindowId : (tab?.windowId ?? -1)
    if (winId >= 0) {
      void chrome.sidePanel?.open?.({ windowId: winId }).catch(() => {})
    } else if (tab?.id !== undefined) {
      void chrome.sidePanel?.open?.({ tabId: tab.id }).catch(() => {})
    }
    return
  }

  if (!id.startsWith('vberry_group_') && !id.startsWith('vberry_saved_')) return

  void (async () => {
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
  })()
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

// Keyboard commands (synchronous entry point so sidePanel.open keeps Chrome's user gesture)
chrome.commands.onCommand.addListener((command, tab) => {
  const syncWinId = lastFocusedWindowId >= 0 ? lastFocusedWindowId : tab?.windowId

  if (command === 'toggle_side_panel') {
    if (syncWinId !== undefined && syncWinId >= 0) {
      toggleSidePanelForWindow(syncWinId)
    } else if (tab?.id !== undefined) {
      void chrome.sidePanel?.open?.({ tabId: tab.id }).catch(() => {})
    }
    return
  }

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
    q ? searchNonTrashBookmarks(q) : Promise.resolve([]),
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
