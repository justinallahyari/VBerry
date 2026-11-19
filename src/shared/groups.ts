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

async function unpinTabs(tabIds: number[]): Promise<void> {
  await Promise.allSettled(
    tabIds.map(async id => {
      const t = await chrome.tabs.get(id)
      if (t.pinned) await chrome.tabs.update(id, { pinned: false })
    })
  )
}

/**
 * Try grouping tabs into a native Chrome Tab Group (reusing an existing group matching
 * `title` if `reuseExisting` is true) and verify the group actually materialized.
 */
async function tryGroupNatively(
  windowId: number,
  tabIds: number[],
  title: string,
  color: ChromeGroupColor,
  reuseExisting = false
): Promise<number | null> {
  if (!tabIds.length || !(await canUseNativeTabGroups())) return null
  try {
    const existing = reuseExisting
      ? (await safeQueryTabGroups({ windowId })).find(
          g => (g.title ?? '').trim().toLowerCase() === title.trim().toLowerCase()
        )
      : undefined

    const groupId = existing
      ? await chrome.tabs.group({ tabIds, groupId: existing.id })
      : await chrome.tabs.group({ tabIds, createProperties: { windowId } })

    if (typeof groupId !== 'number' || groupId === UNGROUPED_ID) return null
    if (!existing) {
      await chrome.tabGroups.update(groupId, { title, color, collapsed: false })
    }
    const live = await safeQueryTabGroups({ windowId })
    return live.some(g => g.id === groupId) ? groupId : null
  } catch {
    return null
  }
}

async function findOrCreateSavedPanel(
  title: string,
  color: ChromeGroupColor,
  updateColorIfFound = false
): Promise<SavedPanel> {
  const panels = await loadSavedPanels()
  let panel = panels.find(p => p.title.trim().toLowerCase() === title.trim().toLowerCase())
  if (!panel) {
    panel = { id: uid('panel'), title, color, moveRules: [] }
    panels.push(panel)
    await saveSavedPanels(panels)
  } else if (updateColorIfFound && panel.color !== color) {
    panel.color = color
    await saveSavedPanels(panels)
  }
  return panel
}

/**
 * Serialize a group's tabs in depth-first pre-order so every child immediately follows
 * its true parent/siblings, guaranteeing lossless tree reconstruction from `level`.
 */
function treeToSnapshotTabs(tabs: chrome.tabs.Tab[], treeMeta: TabTreeMap): SnapshotTab[] {
  const ordered = tabs.slice().sort((a, b) => a.index - b.index)
  const nodes = buildTabTree(ordered, treeMeta)
  const childrenByParent = new Map<number, typeof nodes>()
  const roots: typeof nodes = []

  for (const node of nodes) {
    if (node.parentId === undefined) {
      roots.push(node)
    } else {
      const list = childrenByParent.get(node.parentId)
      if (list) list.push(node)
      else childrenByParent.set(node.parentId, [node])
    }
  }

  const out: SnapshotTab[] = []
  function visit(node: (typeof nodes)[number], depth: number): void {
    out.push({
      url: node.tab.url || node.tab.pendingUrl || '',
      title: node.tab.title || node.tab.url || '',
      level: depth,
      folded: node.folded || undefined,
    })
    for (const child of childrenByParent.get(node.id) ?? []) {
      visit(child, depth + 1)
    }
  }

  for (const root of roots) visit(root, 0)
  return out
}

/**
 * Create a new Tab Group with an initial tab.
 * Uses Chrome's native `chrome.tabGroups` API when supported, and falls back
 * seamlessly to a persisted VBerry panel + virtual tab assignment on Vivaldi.
 */
export async function createGroupWithTab(
  windowId: number,
  title: string,
  color: ChromeGroupColor,
  url?: string
): Promise<{ groupId: number | null; savedPanelId?: string; tab: chrome.tabs.Tab }> {
  const tab = await createNewTab({ windowId, url, active: true })
  if (tab.id === undefined) throw new Error('Failed to create tab')

  const groupId = await tryGroupNatively(windowId, [tab.id], title, color)
  if (groupId !== null) return { groupId, tab }

  const panel = await findOrCreateSavedPanel(title, color, true)
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
  const tab = await createNewTab({ windowId, url, active })
  if (tab.id === undefined) return { groupId: null, savedPanelId: panel.id, tab }

  const groupId = await tryGroupNatively(windowId, [tab.id], panel.title, panel.color, true)
  if (groupId !== null) return { groupId, savedPanelId: panel.id, tab }

  await assignTabsToVirtualGroup([tab.id], panel.id)
  return { groupId: null, savedPanelId: panel.id, tab }
}

/**
 * Move tabs to a Chrome Tab Group, or ungroup them if groupId === UNGROUPED_ID (-1).
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

  await unpinTabs(tabIds)
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
  await unpinTabs(tabIds)

  const groupId = await tryGroupNatively(windowId, tabIds, panel.title, panel.color, true)
  if (groupId !== null) {
    await assignTabsToVirtualGroup(tabIds, null)
    return groupId
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
      return g.collapsed !== shouldCollapse
        ? chrome.tabGroups.update(g.id, { collapsed: shouldCollapse })
        : Promise.resolve()
    })
  )
}

/**
 * Unload (discard) one or more tabs. If any target tab is currently active,
 * activates the most recently accessed loaded tab first (or opens a new tab
 * if no other loaded tab exists) because Chrome forbids discarding the active tab.
 */
export async function discardTabs(
  tabIds: number[],
  windowTabs: chrome.tabs.Tab[],
  windowId: number
): Promise<void> {
  if (!tabIds.length) return
  const targetSet = new Set(tabIds)
  const tabById = new Map(
    windowTabs.filter(t => t.id !== undefined).map(t => [t.id as number, t])
  )
  const activeTarget = windowTabs.find(t => t.id !== undefined && targetSet.has(t.id) && t.active)

  if (activeTarget) {
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

  await Promise.allSettled(
    tabIds
      .filter(id => !tabById.get(id)?.discarded)
      .map(id => chrome.tabs.discard(id))
  )
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
    if (
      !url ||
      url.startsWith('chrome://newtab') ||
      url.startsWith('chrome://vivaldi-webui/startpage')
    ) {
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

    const sortedTabs = win.tabs.slice().sort((a, b) => a.index - b.index)
    for (const tab of sortedTabs) {
      const url = tab.url || tab.pendingUrl || ''
      if (!url) continue
      if (tab.pinned) {
        pinned.push({ url, title: tab.title || url, level: 0, pinned: true })
      } else if (tab.groupId !== UNGROUPED_ID && groupById.has(tab.groupId)) {
        const list = tabsByNativeGroup.get(tab.groupId)
        if (list) list.push(tab)
        else tabsByNativeGroup.set(tab.groupId, [tab])
      } else if (tab.id !== undefined && virtualGroups[tab.id] && savedById.has(virtualGroups[tab.id])) {
        const vid = virtualGroups[tab.id]
        const list = tabsByVirtualGroup.get(vid)
        if (list) list.push(tab)
        else tabsByVirtualGroup.set(vid, [tab])
      } else {
        ungroupedTabs.push(tab)
      }
    }

    const snapGroups: SnapshotGroup[] = []

    if (ungroupedTabs.length) {
      snapGroups.push({
        id: 'ungrouped',
        title: 'Ungrouped',
        color: 'grey',
        ungrouped: true,
        tabs: treeToSnapshotTabs(ungroupedTabs, treeMeta),
      })
    }

    for (const g of groups) {
      const gTabs = tabsByNativeGroup.get(g.id)
      if (!gTabs?.length) continue
      snapGroups.push({
        id: `group_${g.id}`,
        title: g.title || 'Group',
        color: g.color,
        tabs: treeToSnapshotTabs(gTabs, treeMeta),
      })
    }

    for (const [vid, vTabs] of tabsByVirtualGroup.entries()) {
      const panel = savedById.get(vid)
      if (!panel || !vTabs.length) continue
      snapGroups.push({
        id: panel.id,
        title: panel.title,
        color: panel.color,
        tabs: treeToSnapshotTabs(vTabs, treeMeta),
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
  const existingTabs = await chrome.tabs.query({ windowId }).catch(() => [])
  const startIndex = existingTabs.length
  let nextIndex = startIndex

  const createdIds: number[] = []
  const levelStack: number[] = []
  const metaPatch: TabTreeMap = {}

  for (const item of group.tabs) {
    if (!item.url || item.url.startsWith('about:') || item.url.startsWith('moz-extension://')) {
      continue
    }
    try {
      // Pass explicit ascending `index` so browsers with "Open After Active Tab"
      // (like Vivaldi) never insert children above their parent in reverse order.
      const tab = await chrome.tabs.create({
        windowId,
        index: nextIndex++,
        url: item.url,
        active: false,
      })
      if (tab.id === undefined) continue
      createdIds.push(tab.id)

      // Clamp depth to current stack length so skipping an invalid intermediate parent
      // attaches descendants to the nearest surviving ancestor instead of flattening them.
      const effectiveLvl = Math.min(Math.max(0, item.level || 0), levelStack.length)
      if (effectiveLvl > 0) {
        metaPatch[tab.id] = {
          parentId: levelStack[effectiveLvl - 1],
          folded: item.folded || undefined,
        }
      } else if (item.folded) {
        metaPatch[tab.id] = { folded: true }
      }
      levelStack[effectiveLvl] = tab.id
      levelStack.length = effectiveLvl + 1
    } catch {
      // Skip restricted/invalid URLs safely
    }
  }

  if (createdIds.length > 1) {
    // Enforce exact parent-before-children order in case the browser ignored `index`
    await chrome.tabs.move?.(createdIds, { windowId, index: startIndex }).catch(() => {})
  }

  if (Object.keys(metaPatch).length) {
    const existingMeta = await loadTreeMeta()
    await saveTreeMeta({ ...existingMeta, ...metaPatch })
  }

  if (createdIds.length && !group.ungrouped) {
    const groupId = await tryGroupNatively(windowId, createdIds, group.title, group.color)
    if (groupId === null) {
      const panel = await findOrCreateSavedPanel(group.title, group.color)
      await assignTabsToVirtualGroup(createdIds, panel.id)
    }
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
