import type { MoveRule, TabTreeMap, TreeTabNode } from './types'

const MAX_TREE_DEPTH = 12

function setParentId(meta: TabTreeMap, id: number, parentId: number | undefined): void {
  const cur = meta[id]
  if (parentId !== undefined) {
    meta[id] = { ...cur, parentId }
    return
  }
  if (!cur) return
  const { parentId: _, ...rest } = cur
  if (Object.keys(rest).length) meta[id] = rest
  else delete meta[id]
}

/**
 * Build a flat, renderable tree list from a panel's ordered Chrome tabs and tree metadata.
 * Strictly O(N) via memoized level/descendant/visibility caches, cycle-safe, and scoped to `tabs`.
 */
export function buildTabTree(tabs: chrome.tabs.Tab[], meta: TabTreeMap): TreeTabNode[] {
  const validIds = new Set<number>()
  for (const t of tabs) {
    if (t.id !== undefined) validIds.add(t.id)
  }

  const parentMap = new Map<number, number | undefined>()
  for (const t of tabs) {
    if (t.id === undefined) continue
    const rawParent = meta[t.id]?.parentId
    parentMap.set(
      t.id,
      rawParent !== undefined && rawParent !== t.id && validIds.has(rawParent)
        ? rawParent
        : undefined
    )
  }

  const levelCache = new Map<number, number>()
  function getLevel(id: number, visiting?: Set<number>): number {
    const cached = levelCache.get(id)
    if (cached !== undefined) return cached
    const p = parentMap.get(id)
    if (p === undefined) {
      levelCache.set(id, 0)
      return 0
    }
    const seen = visiting ?? new Set<number>([id])
    if (seen.has(p)) {
      parentMap.set(id, undefined)
      levelCache.set(id, 0)
      return 0
    }
    seen.add(p)
    const lvl = Math.min(MAX_TREE_DEPTH, getLevel(p, seen) + 1)
    levelCache.set(id, lvl)
    return lvl
  }

  const childrenMap = new Map<number, number[]>()
  for (const t of tabs) {
    if (t.id === undefined) continue
    getLevel(t.id)
    const p = parentMap.get(t.id)
    if (p !== undefined) {
      let arr = childrenMap.get(p)
      if (!arr) {
        arr = []
        childrenMap.set(p, arr)
      }
      arr.push(t.id)
    }
  }

  const descendantCache = new Map<number, number>()
  function countDescendants(id: number): number {
    const cached = descendantCache.get(id)
    if (cached !== undefined) return cached
    const kids = childrenMap.get(id)
    if (!kids || kids.length === 0) {
      descendantCache.set(id, 0)
      return 0
    }
    let total = kids.length
    for (const k of kids) total += countDescendants(k)
    descendantCache.set(id, total)
    return total
  }

  const hiddenCache = new Map<number, boolean>()
  function isHidden(id: number): boolean {
    const cached = hiddenCache.get(id)
    if (cached !== undefined) return cached
    const p = parentMap.get(id)
    const hidden = p !== undefined && (Boolean(meta[p]?.folded) || isHidden(p))
    hiddenCache.set(id, hidden)
    return hidden
  }

  const nodes: TreeTabNode[] = []
  for (const tab of tabs) {
    if (tab.id === undefined) continue
    const id = tab.id
    const childCount = countDescendants(id)
    nodes.push({
      tab,
      id,
      level: levelCache.get(id) ?? 0,
      parentId: parentMap.get(id),
      hasChildren: childCount > 0,
      childCount,
      folded: Boolean(meta[id]?.folded && childCount > 0),
      hidden: isHidden(id),
    })
  }

  return nodes
}

/**
 * Return [rootId, ...allDescendantIds] in current tab order.
 */
export function getSubtreeIds(rootId: number, tabs: chrome.tabs.Tab[], meta: TabTreeMap): number[] {
  const nodes = buildTabTree(tabs, meta)
  const result = [rootId]
  const included = new Set<number>([rootId])
  for (const node of nodes) {
    if (node.id === rootId) continue
    if (node.parentId !== undefined && included.has(node.parentId)) {
      included.add(node.id)
      result.push(node.id)
    }
  }
  return result
}

/**
 * Compute the Chrome `tabs.move` target index when dropping `subtreeIds` relative to `targetId`.
 * Accounts for moved tabs preceding the insertion point and places `'after'` drops past
 * `targetId`'s full subtree so folded or expanded parents are never split from their children.
 */
export function computeTabDropIndex(
  tabs: chrome.tabs.Tab[],
  meta: TabTreeMap,
  subtreeIds: number[],
  targetId: number,
  position: 'before' | 'into' | 'after'
): number {
  const targetTab = tabs.find(t => t.id === targetId)
  if (!targetTab) return 0

  let rawIdx: number
  if (position === 'before') {
    rawIdx = targetTab.index
  } else if (position === 'into') {
    rawIdx = targetTab.index + 1
  } else {
    const targetSubtree = new Set(getSubtreeIds(targetId, tabs, meta))
    let maxIdx = targetTab.index
    for (const t of tabs) {
      if (t.id !== undefined && targetSubtree.has(t.id) && t.index > maxIdx) {
        maxIdx = t.index
      }
    }
    rawIdx = maxIdx + 1
  }

  const movingSet = new Set(subtreeIds)
  let beforeCount = 0
  for (const t of tabs) {
    if (t.id !== undefined && movingSet.has(t.id) && t.index < rawIdx) {
      beforeCount++
    }
  }
  return Math.max(0, rawIdx - beforeCount)
}

/**
 * Indent a tab under the nearest preceding tab at the same level.
 */
export function indentTab(tabId: number, nodes: TreeTabNode[], meta: TabTreeMap): TabTreeMap {
  const idx = nodes.findIndex(n => n.id === tabId)
  if (idx <= 0) return meta
  const target = nodes[idx]
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = nodes[i]
    if (!candidate.hidden && candidate.level === target.level) {
      return {
        ...meta,
        [tabId]: { ...meta[tabId], parentId: candidate.id },
        [candidate.id]: { ...meta[candidate.id], folded: false },
      }
    }
  }
  return meta
}

/**
 * Outdent a tab one level (adopt its grandparent as parent).
 */
export function outdentTab(tabId: number, meta: TabTreeMap): TabTreeMap {
  const cur = meta[tabId]
  if (!cur?.parentId) return meta
  const next: TabTreeMap = { ...meta }
  setParentId(next, tabId, meta[cur.parentId]?.parentId)
  return next
}

/**
 * Reparent direct children of a closed tab to the closed tab's parent, and remove the closed tab entry.
 */
export function reparentOnRemove(removedTabId: number, meta: TabTreeMap): TabTreeMap {
  const next: TabTreeMap = { ...meta }
  const grandParent = next[removedTabId]?.parentId
  delete next[removedTabId]
  for (const [idStr, entry] of Object.entries(next)) {
    if (entry.parentId === removedTabId) {
      setParentId(next, Number(idStr), grandParent)
    }
  }
  return next
}

export function toggleFold(tabId: number, meta: TabTreeMap): TabTreeMap {
  const cur = meta[tabId]
  return {
    ...meta,
    [tabId]: { ...cur, folded: !cur?.folded },
  }
}

/**
 * Match a URL against a Sidebery/VBerry MoveRule pattern.
 * Supports `/regex/flags`, plain regex, or substring/domain match.
 */
export function matchesMoveRule(url: string, rule: MoveRule): boolean {
  if (!rule.active || !rule.pattern.trim() || !url) return false
  const pattern = rule.pattern.trim()
  const regexLiteral = pattern.match(/^\/(.+)\/([gimsuy]*)$/)
  if (regexLiteral) {
    try {
      return new RegExp(regexLiteral[1], regexLiteral[2]).test(url)
    } catch {
      return false
    }
  }
  try {
    return new RegExp(pattern, 'i').test(url)
  } catch {
    return url.toLowerCase().includes(pattern.toLowerCase())
  }
}
