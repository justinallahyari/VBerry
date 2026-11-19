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
  safeQueryTabGroups,
  UNGROUPED_ID,
} from '@/shared/groups'

const AUTO_SNAPSHOT_ALARM = 'vberry_auto_snapshot'
const MENU_ROOT_ID = 'vberry_send_to_group'

async function initSidePanelBehavior(): Promise<void> {
  try {
    await chrome.sidePanel?.setPanelBehavior?.({ openPanelOnActionClick: true })
  } catch {
    // Some Chromium forks (e.g. Vivaldi) do not implement setPanelBehavior
  }
}

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

async function rebuildContextMenus(): Promise<void> {
  try {
    await chrome.contextMenus.removeAll()
    chrome.contextMenus.create({
      id: MENU_ROOT_ID,
      title: 'Send to VBerry Group',
      contexts: ['page', 'link'],
    })

    const [groups, savedPanels] = await Promise.all([safeQueryTabGroups(), loadSavedPanels()])
    const liveTitles = new Set<string>()
    const seenIds = new Set<number>()

    for (const g of groups) {
      if (seenIds.has(g.id)) continue
      seenIds.add(g.id)
      const label = g.title?.trim() || `Group (${g.color})`
      liveTitles.add(label.toLowerCase())
      chrome.contextMenus.create({
        id: `vberry_group_${g.id}`,
        parentId: MENU_ROOT_ID,
        title: label,
        contexts: ['page', 'link'],
      })
    }

    for (const sp of savedPanels) {
      if (liveTitles.has(sp.title.trim().toLowerCase())) continue
      chrome.contextMenus.create({
        id: `vberry_saved_${sp.id}`,
        parentId: MENU_ROOT_ID,
        title: sp.title,
        contexts: ['page', 'link'],
      })
    }

    chrome.contextMenus.create({
      id: 'vberry_group_ungroup',
      parentId: MENU_ROOT_ID,
      title: 'Ungrouped',
      contexts: ['page', 'link'],
    })
  } catch {
    // Ignore transient context menu errors during rapid group changes
  }
}

chrome.runtime.onInstalled.addListener(() => {
  void initSidePanelBehavior()
  void syncAutoSnapshotAlarm()
  void rebuildContextMenus()
})

chrome.runtime.onStartup.addListener(() => {
  void initSidePanelBehavior()
  void syncAutoSnapshotAlarm()
  void rebuildContextMenus()
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local') {
    if (changes[STORAGE_KEYS.settings]) void syncAutoSnapshotAlarm()
    if (changes[STORAGE_KEYS.savedPanels]) scheduleContextMenuRebuild()
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
})

chrome.tabs.onReplaced.addListener(async (addedTabId, removedTabId) => {
  const [meta, vmap] = await Promise.all([loadTreeMeta(), loadVirtualGroupMap()])
  if (meta[removedTabId]) {
    meta[addedTabId] = meta[removedTabId]
    delete meta[removedTabId]
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
  if (
    !url ||
    tab.pinned ||
    url.startsWith('chrome://') ||
    url.startsWith('vivaldi://') ||
    url.startsWith('chrome-extension://')
  ) {
    return
  }
  const savedPanels = await loadSavedPanels()
  const matched = savedPanels.find(p => p.moveRules.some(r => matchesMoveRule(url, r)))
  if (!matched) return

  await moveTabsToSavedPanel(tab.windowId, [tabId], matched).catch(() => {})
})

// Keyboard commands
chrome.commands.onCommand.addListener(async command => {
  if (command === 'create_snapshot') {
    await captureSnapshot()
    return
  }

  if (command === 'discard_inactive_tabs') {
    const windowId = await getTargetWindowId()
    const tabs = await chrome.tabs.query(windowId >= 0 ? { windowId } : { currentWindow: true })
    for (const t of tabs) {
      if (t.id !== undefined && !t.active && !t.pinned && !t.audible && !t.discarded) {
        await chrome.tabs.discard(t.id).catch(() => {})
      }
    }
    return
  }

  chrome.runtime.sendMessage({ type: 'vberry:command', command }).catch(() => {})
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
