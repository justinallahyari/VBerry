import type { RuntimeMessage, SyncStateMeta } from '@/shared/types'
import {
  loadSavedPanels,
  loadSettings,
  loadVirtualGroupMap,
  remapReplacedTabIds,
  STORAGE_KEYS,
  updateTreeMeta,
  updateVirtualGroupMap,
} from '@/shared/storage'
import { reconcileSync } from '@/shared/sync'
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
const SIDEPANEL_PORT_PREFIX = 'vberry-sidepanel:'
const openSidePanelPorts = new Map<number, chrome.runtime.Port>()
const nonNormalWindowIds = new Set<number>()
let lastFocusedWindowId = -1
let focusSeq = 0

chrome.runtime.onConnect?.addListener(port => {
  if (!port.name.startsWith(SIDEPANEL_PORT_PREFIX)) return
  const winId = Number(port.name.slice(SIDEPANEL_PORT_PREFIX.length))
  if (!Number.isFinite(winId) || winId < 0) return
  openSidePanelPorts.set(winId, port)
  port.onDisconnect.addListener(() => {
    if (openSidePanelPorts.get(winId) === port) {
      openSidePanelPorts.delete(winId)
    }
  })
})

chrome.windows?.onCreated?.addListener(win => {
  if (win.id === undefined || win.id < 0) return
  if (win.type && win.type !== 'normal') {
    nonNormalWindowIds.add(win.id)
  } else if (win.type === 'normal') {
    nonNormalWindowIds.delete(win.id)
    if (win.focused) lastFocusedWindowId = win.id
  }
})

chrome.windows?.onFocusChanged?.addListener(winId => {
  if (typeof winId !== 'number' || winId < 0) return
  const seq = ++focusSeq
  void chrome.windows
    .get(winId)
    .then(win => {
      if (win.type === 'normal') {
        nonNormalWindowIds.delete(winId)
        if (seq === focusSeq) lastFocusedWindowId = winId
      } else {
        nonNormalWindowIds.add(winId)
      }
    })
    .catch(() => {})
})

chrome.windows?.onRemoved?.addListener(winId => {
  openSidePanelPorts.delete(winId)
  nonNormalWindowIds.delete(winId)
  if (lastFocusedWindowId === winId) lastFocusedWindowId = -1
})

chrome.tabs.onActivated.addListener(info => {
  if (info.windowId < 0) return
  void chrome.windows
    ?.get?.(info.windowId)
    .then(win => {
      if (win.type === 'normal') {
        nonNormalWindowIds.delete(info.windowId)
        if (win.focused) lastFocusedWindowId = info.windowId
      } else {
        nonNormalWindowIds.add(info.windowId)
      }
    })
    .catch(() => {})
})

function resolveSyncWindowId(tab?: chrome.tabs.Tab): number | undefined {
  if (
    tab?.windowId !== undefined &&
    tab.windowId >= 0 &&
    !nonNormalWindowIds.has(tab.windowId)
  ) {
    lastFocusedWindowId = tab.windowId
    return tab.windowId
  }
  return lastFocusedWindowId >= 0 ? lastFocusedWindowId : undefined
}

function toggleSidePanelForWindow(winId: number, commandTime = Date.now()): void {
  if (winId < 0) return
  const port = openSidePanelPorts.get(winId)
  if (port) {
    openSidePanelPorts.delete(winId)
    try {
      port.postMessage({ type: 'vberry:close-panel', windowId: winId })
      return
    } catch {
      // Port already disconnected; fall through synchronously to open with user gesture intact
    }
  }
  // Must be called synchronously inside user-gesture handler to preserve Chrome's user gesture.
  // If the MV3 service worker restarted while the panel stayed open, open() resolves as a no-op
  // and the follow-up message closes only a panel visible before this command.
  const openOp = chrome.sidePanel?.open?.({ windowId: winId })
  void Promise.resolve(openOp)
    .catch(() => {})
    .then(() => {
      chrome.runtime
        .sendMessage({ type: 'vberry:close-panel', windowId: winId, openedBefore: commandTime })
        .catch(() => {})
    })
}

async function initSidePanelBehavior(): Promise<void> {
  await Promise.allSettled([
    // Toolbar button & _execute_action open the frameless Quick Search default_popup;
    // Side Panel is toggled via Ctrl+E (toggle_side_panel) or right-clicking the toolbar button.
    chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: false }),
    // Explicitly register sidepanel.html so Vivaldi's Window store knows the panel URL immediately
    // on startup before any extension popup or toolbar dropdown is opened.
    chrome.sidePanel?.setOptions?.({ path: 'sidepanel.html', enabled: true }),
    chrome.windows
      ?.getLastFocused?.({ windowTypes: ['normal'] })
      .then(win => {
        if (lastFocusedWindowId < 0 && win?.id !== undefined && win.id >= 0) {
          lastFocusedWindowId = win.id
        }
      }),
  ])
}

chrome.runtime.onMessage.addListener((msg: RuntimeMessage, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return
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
  if (msg.type === 'vberry:sync-now') {
    clearTimeout(syncReconcileTimer)
    pendingSyncPullOnly = true
    void reconcileSync({ forcePush: msg.forcePush })
      .then(meta =>
        sendResponse({ ok: !meta.lastError, error: meta.lastError ?? undefined, meta })
      )
      .catch(err =>
        sendResponse({
          ok: false,
          error: err instanceof Error ? err.message : 'Could not sync right now.',
        })
      )
    return true
  }
})

async function syncAutoSnapshotAlarm(): Promise<void> {
  const settings = await getSettingsCached()
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

let syncReconcileTimer: ReturnType<typeof setTimeout> | undefined
let pendingSyncPullOnly = true
function scheduleSyncReconcile(delayMs = 1200, opts?: { pullOnly?: boolean }): void {
  if (!chrome.storage?.sync) return
  // Never downgrade a pending full reconcile (e.g. user edit or sync onChanged) to pull-only
  if (!opts?.pullOnly) pendingSyncPullOnly = false
  clearTimeout(syncReconcileTimer)
  syncReconcileTimer = setTimeout(() => {
    const pullOnly = pendingSyncPullOnly
    pendingSyncPullOnly = true
    void reconcileSync(pullOnly ? { pullOnly: true } : undefined)
  }, delayMs)
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

let cachedSettings: Awaited<ReturnType<typeof loadSettings>> | null = null
async function getSettingsCached() {
  if (cachedSettings === null) cachedSettings = await loadSettings()
  return cachedSettings
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
  // Pull-only on startup so VBerry never overwrites remote data before Vivaldi decrypts sync storage
  scheduleSyncReconcile(400, { pullOnly: true })
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
    if (changes[STORAGE_KEYS.settings]) {
      cachedSettings = null
      void syncAutoSnapshotAlarm()
    }
    if (changes[STORAGE_KEYS.savedPanels]) {
      cachedSavedPanels = null
      scheduleContextMenuRebuild()
    }
    if (changes[STORAGE_KEYS.syncConfig]) {
      scheduleSyncReconcile(250)
    } else if (changes[STORAGE_KEYS.syncMeta]) {
      const nextMeta = changes[STORAGE_KEYS.syncMeta].newValue as Partial<SyncStateMeta> | undefined
      if (
        nextMeta &&
        ((nextMeta.settingsUpdatedAt ?? 0) > (nextMeta.appliedSettingsRev ?? 0) ||
          (nextMeta.snapshotsUpdatedAt ?? 0) > (nextMeta.appliedSnapshotsRev ?? 0))
      ) {
        scheduleSyncReconcile(1200)
      }
    } else if (
      changes[STORAGE_KEYS.snapshots] ||
      changes[STORAGE_KEYS.settings] ||
      changes[STORAGE_KEYS.savedPanels]
    ) {
      scheduleSyncReconcile(1200)
    }
  }
  if (area === 'sync') {
    // Full reconcile once browser sync delivers decrypted remote keys: pulls remote changes
    // and merges/pushes any pending local snapshots or newer edits
    scheduleSyncReconcile(350)
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
    const winId = resolveSyncWindowId(tab)
    if (winId !== undefined) {
      void chrome.sidePanel?.open?.({ windowId: winId }).catch(() => {})
    } else if (tab?.id !== undefined) {
      void chrome.sidePanel?.open?.({ tabId: tab.id }).catch(() => {})
    } else {
      void chrome.sidePanel
        ?.open?.({ windowId: chrome.windows?.WINDOW_ID_CURRENT ?? -2 })
        .catch(() => {})
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
      const panels = await getSavedPanelsCached()
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
  if (tab.id === undefined || tab.pinned) return
  const rawUrl = tab.pendingUrl || tab.url || ''
  if (rawUrl.startsWith('chrome-extension://') && rawUrl.endsWith('/sidepanel.html')) return

  let openerTabId = tab.openerTabId
  if (openerTabId === undefined) {
    // Vivaldi attaches `openerTabId` immediately after firing `tabs.onCreated` for extension-created tabs
    const fresh = await chrome.tabs.get(tab.id).catch(() => undefined)
    if (!fresh || fresh.pinned || fresh.openerTabId === undefined) return
    openerTabId = fresh.openerTabId
  }

  const settings = await getSettingsCached()

  try {
    const opener = await chrome.tabs.get(openerTabId)
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

chrome.tabs.onAttached?.addListener(() => {
  schedulePersistSession()
})

chrome.tabs.onDetached?.addListener(() => {
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
  const syncWinId = resolveSyncWindowId(tab)

  if (command === 'toggle_side_panel') {
    const commandTime = Date.now()
    if (syncWinId !== undefined) {
      toggleSidePanelForWindow(syncWinId, commandTime)
    } else {
      // Any `await` before `sidePanel.open()` expires Chromium's user gesture.
      // Open synchronously via `tabId` or `WINDOW_ID_CURRENT` (-2), then resolve `winId`
      // asynchronously only for the post-open close check when the panel was already open.
      const openOp =
        tab?.id !== undefined
          ? chrome.sidePanel?.open?.({ tabId: tab.id })
          : chrome.sidePanel?.open?.({ windowId: chrome.windows?.WINDOW_ID_CURRENT ?? -2 })
      void Promise.resolve(openOp)
        .catch(() => {})
        .then(async () => {
          const winId = await getTargetWindowId()
          if (winId >= 0) {
            if (lastFocusedWindowId < 0) lastFocusedWindowId = winId
            chrome.runtime
              .sendMessage({ type: 'vberry:close-panel', windowId: winId, openedBefore: commandTime })
              .catch(() => {})
          }
        })
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

let omniboxSeq = 0

chrome.omnibox.onInputChanged.addListener(async (text, suggest) => {
  const seq = ++omniboxSeq
  const q = text.trim().toLowerCase()
  const [tabs, bookmarks] = await Promise.all([
    chrome.tabs.query({}),
    q ? searchNonTrashBookmarks(q) : Promise.resolve([]),
  ])
  if (seq !== omniboxSeq) return

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
    const panels = await getSavedPanelsCached()
    const match = panels.find(p => p.title.toLowerCase() === text.trim().toLowerCase())
    if (match) {
      const winId = await getTargetWindowId()
      if (winId >= 0) await materializeSavedPanel(winId, match)
    }
  }
})
