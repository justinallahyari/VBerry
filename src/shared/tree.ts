import type { MoveRule, TabTreeMap, TreeTabNode } from './types'

const MAX_TREE_DEPTH = 12

/**
 * Build a flat, renderable tree list from a panel's ordered Chrome tabs and tree metadata.
 * Guarantees cycle safety and ensures parents belong to the same tab list (same group).
 */
export function buildTabTree(tabs: chrome.tabs.Tab[], meta: TabTreeMap): TreeTabNode[] {
  const byId = new Map<number, chrome.tabs.Tab>()
  for (const t of tabs) {
    if (t.id !== undefined) byId.set(t.id, t)
  }

  // Resolve valid parentId per tab (must exist in the same panel & not create a cycle)
  const parentMap = new Map<number, number | undefined>()
  for (const t of tabs) {
    if (t.id === undefined) continue
    const rawParent = meta[t.id]?.parentId
    if (rawParent !== undefined && rawParent !== t.id && byId.has(rawParent)) {
      parentMap.set(t.id, rawParent)
    } else {
      parentMap.set(t.id, undefined)
    }
  }

  // Break any accidental cycles
  const levelCache = new Map<number, number>()
  function getLevel(id: number, visiting = new Set<number>()): number {
    const cached = levelCache.get(id)
    if (cached !== undefined) return cached
    const p = parentMap.get(id)
    if (p === undefined) {
      levelCache.set(id, 0)
      return 0
    }
    if (visiting.has(p)) {
      parentMap.set(id, undefined)
      levelCache.set(id, 0)
      return 0
    }
    visiting.add(id)
    const lvl = Math.min(MAX_TREE_DEPTH, getLevel(p, visiting) + 1)
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

  function countDescendants(id: number): number {
    const kids = childrenMap.get(id)
    if (!kids || kids.length === 0) return 0
    let total = kids.length
    for (const k of kids) total += countDescendants(k)
    return total
  }

  function isHidden(id: number): boolean {
    let cur = parentMap.get(id)
    let guard = 0
    while (cur !== undefined && guard++ < MAX_TREE_DEPTH + 1) {
      if (meta[cur]?.folded) return true
      cur = parentMap.get(cur)
    }
    return false
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
 * Indent a tab under the nearest preceding tab at the same or higher level.
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
  const grandParent = meta[cur.parentId]?.parentId
  const next: TabTreeMap = { ...meta }
  if (grandParent !== undefined) {
    next[tabId] = { ...cur, parentId: grandParent }
  } else {
    const { parentId: _, ...rest } = cur
    if (Object.keys(rest).length) next[tabId] = rest
    else delete next[tabId]
  }
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
      const id = Number(idStr)
      if (grandParent !== undefined) {
        next[id] = { ...entry, parentId: grandParent }
      } else {
        const { parentId: _, ...rest } = entry
        if (Object.keys(rest).length) next[id] = rest
        else delete next[id]
      }
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
