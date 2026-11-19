import {
  CHROME_GROUP_COLORS,
  type ChromeGroupColor,
  type SavedPanel,
  type SnapshotGroup,
  type SnapshotTab,
  type SnapshotWindow,
  type TabTreeMap,
  type VBerrySnapshot,
} from './types'
import {
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  loadTreeMeta,
  loadVirtualGroupMap,
  saveSavedPanels,
  saveSnapshots,
  saveTreeMeta,
  saveVirtualGroupMap,
  uid,
} from './storage'
import { createNewTab, getTargetWindowId, isVivaldi } from './env'
import { buildTabTree } from './tree'

export const UNGROUPED_ID = -1

/**
 * Vivaldi exposes `chrome.tabs.group` / `chrome.tabGroups` as stubs that either throw
 * or silently drop groups (Vivaldi uses Tab Stacks instead). Only use native Chrome
 * Tab Groups on browsers that actually support them.
 */
async function canUseNativeTabGroups(): Promise<boolean> {
  if (await isVivaldi()) return false
  return (
    typeof chrome.tabs?.group === 'function' &&
    typeof chrome.tabGroups?.update === 'function' &&
    typeof chrome.tabGroups?.query === 'function'
  )
}

export async function safeQueryTabGroups(
  info: { windowId?: number } = {}
): Promise<chrome.tabGroups.TabGroup[]> {
  if (!(await canUseNativeTabGroups())) return []
  try {
    return await chrome.tabGroups.query(info)
  } catch {
    return []
  }
}

export function pickNextGroupColor(
  existingColors: Array<ChromeGroupColor | undefined>
): ChromeGroupColor {
  const used = new Set(existingColors.filter(Boolean))
  for (const c of CHROME_GROUP_COLORS) {
    if (c !== 'grey' && !used.has(c)) return c
  }
  return CHROME_GROUP_COLORS[(existingColors.length + 1) % CHROME_GROUP_COLORS.length]
}

export async function assignTabsToVirtualGroup(
  tabIds: number[],
  savedPanelId: string | null
): Promise<Record<number, string>> {
  const map = await loadVirtualGroupMap()
  for (const id of tabIds) {
    if (savedPanelId === null) delete map[id]
    else map[id] = savedPanelId
  }
  await saveVirtualGroupMap(map)
  return map
}

/**
 * Create a new Tab Group with an initial tab.
 * Uses Chrome's native `chrome.tabGroups` API when supported, and falls back
 * seamlessly to a persisted VBerry panel + virtual tab assignment on browsers
 * like Vivaldi that do not support `chrome.tabGroups`.
 */
export async function createGroupWithTab(
  windowId: number,
  title: string,
  color: ChromeGroupColor,
  url?: string
): Promise<{ groupId: number | null; savedPanelId?: string; tab: chrome.tabs.Tab }> {
  const tab = await createNewTab({ windowId, url, active: true })
  if (tab.id === undefined) throw new Error('Failed to create tab')

  if (await canUseNativeTabGroups()) {
    try {
      const groupId = await chrome.tabs.group({
        tabIds: tab.id,
        createProperties: { windowId },
      })
      if (typeof groupId === 'number' && groupId !== UNGROUPED_ID) {
        await chrome.tabGroups.update(groupId, { title, color, collapsed: false })
        const live = await safeQueryTabGroups({ windowId })
        if (live.some(g => g.id === groupId)) {
          return { groupId, tab }
        }
      }
    } catch {
      // Browser rejected native chrome.tabs.group — fall back below
    }
  }

  // Fallback: create a SavedPanel and assign the tab to it in session storage
  const panels = await loadSavedPanels()
  let panel = panels.find(p => p.title.trim().toLowerCase() === title.trim().toLowerCase())
  if (!panel) {
    panel = { id: uid('panel'), title, color, moveRules: [] }
    panels.push(panel)
    await saveSavedPanels(panels)
  } else if (panel.color !== color) {
    panel.color = color
    await saveSavedPanels(panels)
  }

  await assignTabsToVirtualGroup([tab.id], panel.id)
  return { groupId: null, savedPanelId: panel.id, tab }
}

/**
 * Open a tab in a SavedPanel — materializing a native Chrome Tab Group if supported,
 * or assigning the new tab to the SavedPanel virtually on Vivaldi.
 */
export async function materializeSavedPanel(
  windowId: number,
  panel: SavedPanel,
  url?: string,
  active = true
): Promise<{ groupId: number | null; savedPanelId: string; tab?: chrome.tabs.Tab }> {
  const groups = await safeQueryTabGroups({ windowId })
  const existing = groups.find(
    g => (g.title ?? '').trim().toLowerCase() === panel.title.trim().toLowerCase()
  )

  const tab = await createNewTab({ windowId, url, active })

  if (existing && tab.id !== undefined) {
    try {
      await chrome.tabs.group({ tabIds: tab.id, groupId: existing.id })
      return { groupId: existing.id, savedPanelId: panel.id, tab }
    } catch {
      // Fallback below
    }
  }

  if (tab.id !== undefined && (await canUseNativeTabGroups())) {
    try {
      const groupId = await chrome.tabs.group({
        tabIds: tab.id,
        createProperties: { windowId },
      })
      if (typeof groupId === 'number' && groupId !== UNGROUPED_ID) {
        await chrome.tabGroups.update(groupId, {
          title: panel.title,
          color: panel.color,
          collapsed: false,
        })
        const live = await safeQueryTabGroups({ windowId })
        if (live.some(g => g.id === groupId)) {
          return { groupId, savedPanelId: panel.id, tab }
        }
      }
    } catch {
      // Browser does not support native chrome.tabs.group — fall back below
    }
  }

  if (tab.id !== undefined) {
    await assignTabsToVirtualGroup([tab.id], panel.id)
  }
  return { groupId: null, savedPanelId: panel.id, tab }
}

/**
 * Move tabs to a Chrome Tab Group, or ungroup them if groupId === UNGROUPED_ID (-1).
 * Automatically unpins any pinned tabs before grouping and clears virtual group assignments.
 */
export async function moveTabsToGroup(tabIds: number[], targetGroupId: number): Promise<void> {
  if (!tabIds.length) return
  if (targetGroupId === UNGROUPED_ID) {
    await assignTabsToVirtualGroup(tabIds, null)
    if (typeof chrome.tabs?.ungroup === 'function') {
      await chrome.tabs.ungroup(tabIds).catch(() => {})
    }
    return
  }

  for (const id of tabIds) {
    try {
      const t = await chrome.tabs.get(id)
      if (t.pinned) await chrome.tabs.update(id, { pinned: false })
    } catch {
      // Tab may already be closed
    }
  }
  await assignTabsToVirtualGroup(tabIds, null)
  await chrome.tabs.group({ tabIds, groupId: targetGroupId })
}

/**
 * Move tabs into a SavedPanel (trying native Chrome Tab Group first, falling back to virtual group).
 */
export async function moveTabsToSavedPanel(
  windowId: number,
  tabIds: number[],
  panel: SavedPanel
): Promise<number | null> {
  if (!tabIds.length) return null

  for (const id of tabIds) {
    try {
      const t = await chrome.tabs.get(id)
      if (t.pinned) await chrome.tabs.update(id, { pinned: false })
    } catch {
      // Ignore closed tabs
    }
  }

  if (await canUseNativeTabGroups()) {
    try {
      const groups = await safeQueryTabGroups({ windowId })
      const existing = groups.find(
        g => (g.title ?? '').trim().toLowerCase() === panel.title.trim().toLowerCase()
      )
      const groupId = existing
        ? await chrome.tabs.group({ tabIds, groupId: existing.id })
        : await chrome.tabs.group({ tabIds, createProperties: { windowId } })
      if (typeof groupId === 'number' && groupId !== UNGROUPED_ID) {
        if (!existing) {
          await chrome.tabGroups.update(groupId, {
            title: panel.title,
            color: panel.color,
            collapsed: false,
          })
        }
        const live = await safeQueryTabGroups({ windowId })
        if (live.some(g => g.id === groupId)) {
          await assignTabsToVirtualGroup(tabIds, null)
          return groupId
        }
      }
    } catch {
      // Fallback to virtual group assignment below
    }
  }

  await assignTabsToVirtualGroup(tabIds, panel.id)
  return null
}

/**
 * Optionally collapse all other Chrome Tab Groups in the window and expand the active one.
 */
export async function syncCollapseOnSwitch(
  windowId: number,
  activeGroupId: number | null
): Promise<void> {
  const groups = await safeQueryTabGroups({ windowId })
  await Promise.allSettled(
    groups.map(g => {
      const shouldCollapse = activeGroupId !== null && g.id !== activeGroupId
      if (g.collapsed !== shouldCollapse) {
        return chrome.tabGroups.update(g.id, { collapsed: shouldCollapse })
      }
      return Promise.resolve()
    })
  )
}

/**
 * Unload (discard) one or more tabs. If any target tab is currently active,
 * activates the most recently accessed remaining tab first (or opens a new tab
 * if none is available) because Chrome forbids discarding the active tab.
 */
export async function discardTabs(
  tabIds: number[],
  windowTabs: chrome.tabs.Tab[],
  windowId: number
): Promise<void> {
  if (!tabIds.length) return
  const targetSet = new Set(tabIds)
  const activeTarget = windowTabs.find(t => t.id !== undefined && targetSet.has(t.id) && t.active)

  if (activeTarget) {
    // Only switch to another already-loaded tab so we don't wake up unloaded tabs;
    // if no other loaded tab exists, open a fresh startpage/new tab instead.
    const loaded = windowTabs.filter(
      t => t.id !== undefined && !targetSet.has(t.id) && !t.discarded
    )
    loaded.sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0) || a.index - b.index)

    const fallback = loaded[0]
    if (fallback?.id !== undefined) {
      await chrome.tabs.update(fallback.id, { active: true }).catch(() => {})
    } else {
      await createNewTab({ windowId, active: true }).catch(() => {})
    }
  }

  for (const id of tabIds) {
    const t = windowTabs.find(x => x.id === id)
    if (!t?.discarded) {
      await chrome.tabs.discard(id).catch(() => {})
    }
  }
}

/**
 * Bookmark all tabs in a group into a new Chrome Bookmark folder.
 */
export async function bookmarkGroupTabs(
  title: string,
  tabs: chrome.tabs.Tab[]
): Promise<chrome.bookmarks.BookmarkTreeNode> {
  const folder = await chrome.bookmarks.create({ title: title || 'VBerry Group' })
  for (const tab of tabs) {
    const url = tab.url || tab.pendingUrl
    if (!url || url.startsWith('chrome://newtab') || url.startsWith('chrome://vivaldi-webui/startpage')) {
      continue
    }
    await chrome.bookmarks.create({
      parentId: folder.id,
      title: tab.title || url,
      url,
    })
  }
  return folder
}

/**
 * Capture a snapshot of all open normal windows, preserving both native Chrome Tab Groups
 * and Vivaldi fallback virtual groups + tab trees.
 */
export async function captureSnapshot(): Promise<VBerrySnapshot> {
  const [windows, treeMeta, virtualGroups, savedPanels, settings, existing] = await Promise.all([
    chrome.windows.getAll({ populate: true, windowTypes: ['normal'] }),
    loadTreeMeta(),
    loadVirtualGroupMap(),
    loadSavedPanels(),
    loadSettings(),
    loadSnapshots(),
  ])

  const savedById = new Map(savedPanels.map(p => [p.id, p]))
  const snapWindows: SnapshotWindow[] = []

  for (const win of windows) {
    if (win.id === undefined || !win.tabs?.length) continue
    const groups = await safeQueryTabGroups({ windowId: win.id })
    const groupById = new Map(groups.map(g => [g.id, g]))

    const pinned: SnapshotTab[] = []
    const ungroupedTabs: chrome.tabs.Tab[] = []
    const tabsByNativeGroup = new Map<number, chrome.tabs.Tab[]>()
    const tabsByVirtualGroup = new Map<string, chrome.tabs.Tab[]>()

    for (const tab of win.tabs) {
      const url = tab.url || tab.pendingUrl || ''
      if (!url) continue
      if (tab.pinned) {
        pinned.push({ url, title: tab.title || url, level: 0, pinned: true })
      } else if (tab.groupId !== UNGROUPED_ID && groupById.has(tab.groupId)) {
        let list = tabsByNativeGroup.get(tab.groupId)
        if (!list) {
          list = []
          tabsByNativeGroup.set(tab.groupId, list)
        }
        list.push(tab)
      } else if (tab.id !== undefined && virtualGroups[tab.id] && savedById.has(virtualGroups[tab.id])) {
        const vid = virtualGroups[tab.id]
        let list = tabsByVirtualGroup.get(vid)
        if (!list) {
          list = []
          tabsByVirtualGroup.set(vid, list)
        }
        list.push(tab)
      } else {
        ungroupedTabs.push(tab)
      }
    }

    const snapGroups: SnapshotGroup[] = []

    if (ungroupedTabs.length) {
      const nodes = buildTabTree(ungroupedTabs, treeMeta)
      snapGroups.push({
        id: 'ungrouped',
        title: 'Ungrouped',
        color: 'grey',
        ungrouped: true,
        tabs: nodes.map(n => ({
          url: n.tab.url || n.tab.pendingUrl || '',
          title: n.tab.title || n.tab.url || '',
          level: n.level,
          folded: n.folded || undefined,
        })),
      })
    }

    for (const g of groups) {
      const gTabs = tabsByNativeGroup.get(g.id)
      if (!gTabs?.length) continue
      const nodes = buildTabTree(gTabs, treeMeta)
      snapGroups.push({
        id: `group_${g.id}`,
        title: g.title || 'Group',
        color: g.color,
        tabs: nodes.map(n => ({
          url: n.tab.url || n.tab.pendingUrl || '',
          title: n.tab.title || n.tab.url || '',
          level: n.level,
          folded: n.folded || undefined,
        })),
      })
    }

    for (const [vid, vTabs] of tabsByVirtualGroup.entries()) {
      const panel = savedById.get(vid)
      if (!panel || !vTabs.length) continue
      const nodes = buildTabTree(vTabs, treeMeta)
      snapGroups.push({
        id: panel.id,
        title: panel.title,
        color: panel.color,
        tabs: nodes.map(n => ({
          url: n.tab.url || n.tab.pendingUrl || '',
          title: n.tab.title || n.tab.url || '',
          level: n.level,
          folded: n.folded || undefined,
        })),
      })
    }

    if (pinned.length || snapGroups.length) {
      snapWindows.push({ pinned, groups: snapGroups })
    }
  }

  const snapshot: VBerrySnapshot = {
    id: uid('snap'),
    time: Date.now(),
    source: 'vberry',
    windows: snapWindows,
  }

  const next = [snapshot, ...existing].slice(0, Math.max(1, settings.maxSnapshots))
  await saveSnapshots(next)
  return snapshot
}

/**
 * Restore a SnapshotGroup into a target window (native Chrome Tab Group on Chrome,
 * virtual SavedPanel on Vivaldi), rebuilding the tab tree hierarchy.
 */
export async function restoreSnapshotGroup(
  group: SnapshotGroup,
  windowId: number
): Promise<number[]> {
  const createdIds: number[] = []
  const levelStack: number[] = []
  const metaPatch: TabTreeMap = {}

  for (const item of group.tabs) {
    if (!item.url || item.url.startsWith('about:') || item.url.startsWith('moz-extension://')) {
      continue
    }
    try {
      const tab = await chrome.tabs.create({
        windowId,
        url: item.url,
        active: false,
      })
      if (tab.id === undefined) continue
      createdIds.push(tab.id)

      const lvl = Math.max(0, item.level || 0)
      if (lvl > 0 && levelStack[lvl - 1] !== undefined) {
        metaPatch[tab.id] = {
          parentId: levelStack[lvl - 1],
          folded: item.folded || undefined,
        }
      } else if (item.folded) {
        metaPatch[tab.id] = { folded: true }
      }
      levelStack[lvl] = tab.id
      levelStack.length = lvl + 1
    } catch {
      // Skip restricted/invalid URLs safely
    }
  }

  if (createdIds.length && !group.ungrouped) {
    let groupedNatively = false
    if (await canUseNativeTabGroups()) {
      try {
        const groupId = await chrome.tabs.group({
          tabIds: createdIds,
          createProperties: { windowId },
        })
        if (typeof groupId === 'number' && groupId !== UNGROUPED_ID) {
          await chrome.tabGroups.update(groupId, {
            title: group.title,
            color: group.color,
            collapsed: false,
          })
          const live = await safeQueryTabGroups({ windowId })
          groupedNatively = live.some(g => g.id === groupId)
        }
      } catch {
        // Fall back to virtual panel below
      }
    }

    if (!groupedNatively) {
      const panels = await loadSavedPanels()
      let panel = panels.find(p => p.title.trim().toLowerCase() === group.title.trim().toLowerCase())
      if (!panel) {
        panel = { id: uid('panel'), title: group.title, color: group.color, moveRules: [] }
        panels.push(panel)
        await saveSavedPanels(panels)
      }
      await assignTabsToVirtualGroup(createdIds, panel.id)
    }
  }

  if (Object.keys(metaPatch).length) {
    const existingMeta = await loadTreeMeta()
    await saveTreeMeta({ ...existingMeta, ...metaPatch })
  }

  return createdIds
}

/**
 * Restore an entire VBerrySnapshot (in current window or new windows).
 */
export async function restoreSnapshot(
  snapshot: VBerrySnapshot,
  inNewWindow = true
): Promise<void> {
  for (const win of snapshot.windows) {
    let targetWindowId: number
    let placeholderTabId: number | undefined

    if (inNewWindow) {
      const createdWin = await chrome.windows.create({ focused: true })
      if (createdWin.id === undefined) continue
      targetWindowId = createdWin.id
      placeholderTabId = createdWin.tabs?.[0]?.id
    } else {
      targetWindowId = await getTargetWindowId()
      if (targetWindowId < 0) continue
    }

    for (const pinned of win.pinned) {
      if (!pinned.url || pinned.url.startsWith('about:') || pinned.url.startsWith('moz-extension://')) {
        continue
      }
      await chrome.tabs
        .create({ windowId: targetWindowId, url: pinned.url, pinned: true, active: false })
        .catch(() => {})
    }

    for (const group of win.groups) {
      await restoreSnapshotGroup(group, targetWindowId)
    }

    if (placeholderTabId !== undefined) {
      const allTabs = await chrome.tabs.query({ windowId: targetWindowId })
      if (allTabs.length > 1) {
        await chrome.tabs.remove(placeholderTabId).catch(() => {})
      }
    }
  }
}
