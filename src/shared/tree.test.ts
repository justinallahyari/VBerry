import { describe, expect, it } from 'vitest'
import {
  buildTabTree,
  computeTabDropIndex,
  getSubtreeIds,
  indentTab,
  matchesMoveRule,
  outdentTab,
  reparentOnRemove,
  toggleFold,
} from './tree'
import type { TabTreeMap } from './types'

function tab(id: number, index: number, groupId = -1): chrome.tabs.Tab {
  return {
    id,
    index,
    windowId: 1,
    active: false,
    pinned: false,
    highlighted: false,
    incognito: false,
    groupId,
    title: `Tab ${id}`,
    url: `https://example.com/${id}`,
  }
}

describe('Tab Tree Engine', () => {
  it('computes levels, child counts, and folded visibility', () => {
    const tabs = [tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3)]
    const meta: TabTreeMap = {
      1: { folded: true },
      2: { parentId: 1 },
      3: { parentId: 2 },
    }
    const nodes = buildTabTree(tabs, meta)
    expect(nodes.map(n => [n.id, n.level, n.childCount, n.hidden])).toEqual([
      [1, 0, 2, false],
      [2, 1, 1, true],
      [3, 2, 0, true],
      [4, 0, 0, false],
    ])
  })

  it('safely breaks cyclic parent references', () => {
    const tabs = [tab(1, 0), tab(2, 1)]
    const meta: TabTreeMap = { 1: { parentId: 2 }, 2: { parentId: 1 } }
    const nodes = buildTabTree(tabs, meta)
    expect(nodes.every(n => n.level >= 0 && n.level <= 1)).toBe(true)
  })

  it('extracts full subtree IDs in order', () => {
    const tabs = [tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3)]
    const meta: TabTreeMap = { 2: { parentId: 1 }, 3: { parentId: 2 } }
    expect(getSubtreeIds(1, tabs, meta)).toEqual([1, 2, 3])
    expect(getSubtreeIds(4, tabs, meta)).toEqual([4])
  })

  it('indents, outdents, folds, and reparents on close', () => {
    const tabs = [tab(1, 0), tab(2, 1), tab(3, 2)]
    let meta: TabTreeMap = {}
    meta = indentTab(2, buildTabTree(tabs, meta), meta)
    expect(meta[2]?.parentId).toBe(1)

    meta[3] = { parentId: 2 }
    meta = toggleFold(1, meta)
    expect(meta[1]?.folded).toBe(true)

    meta = reparentOnRemove(2, meta)
    expect(meta[2]).toBeUndefined()
    expect(meta[3]?.parentId).toBe(1)

    meta = outdentTab(3, meta)
    expect(meta[3]?.parentId).toBeUndefined()
  })

  it('computes accurate move indices when dragging tabs upward, downward, into, and after subtrees', () => {
    const flat = [tab(1, 0), tab(2, 1), tab(3, 2), tab(4, 3)]
    expect(computeTabDropIndex(flat, {}, [1], 3, 'after')).toBe(2)
    expect(computeTabDropIndex(flat, {}, [1], 3, 'before')).toBe(1)
    expect(computeTabDropIndex(flat, {}, [4], 2, 'before')).toBe(1)
    expect(computeTabDropIndex(flat, {}, [4], 2, 'into')).toBe(2)

    // Dragging subtree [1, 2] downward after parent [3, 4] lands at index 2 ([3, 4, 1, 2])
    const nested: TabTreeMap = { 2: { parentId: 1 }, 4: { parentId: 3 } }
    expect(computeTabDropIndex(flat, nested, [1, 2], 3, 'after')).toBe(2)

    // Dragging tab 1 after folded parent 2 (whose child 3 is at index 2) skips past child 3 -> index 2
    const foldedParent: TabTreeMap = { 2: { folded: true }, 3: { parentId: 2 } }
    expect(computeTabDropIndex(flat, foldedParent, [1], 2, 'after')).toBe(2)
    expect(computeTabDropIndex(flat, foldedParent, [4], 2, 'after')).toBe(3)
  })

  it('matches move rules with regex literals, plain regex, and fallback substring', () => {
    expect(
      matchesMoveRule('https://github.com/org/repo', {
        id: '1',
        active: true,
        pattern: '/github\\.com/i',
      })
    ).toBe(true)
    expect(
      matchesMoveRule('https://docs.google.com/doc', {
        id: '2',
        active: true,
        pattern: 'docs\\.google\\.com',
      })
    ).toBe(true)
    expect(
      matchesMoveRule('https://github.com/org', {
        id: '3',
        active: false,
        pattern: 'github.com',
      })
    ).toBe(false)
    expect(
      matchesMoveRule('https://example.com/[test]', {
        id: '4',
        active: true,
        pattern: '[test',
      })
    ).toBe(true)
  })
})
