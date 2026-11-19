import { describe, expect, it } from 'vitest'
import { matchAndRebuildSession, serializeWindowsState } from './session-state'
import type { TabTreeMap } from './types'

function makeTab(
  id: number,
  index: number,
  url: string,
  pinned = false
): chrome.tabs.Tab {
  return {
    id,
    index,
    windowId: 1,
    active: false,
    pinned,
    highlighted: false,
    incognito: false,
    groupId: -1,
    url,
    title: url,
  }
}

describe('Session Tab Tree Persistence across browser restart', () => {
  it('serializes and restores multi-level tab trees, folded state, and virtual groups with new tab IDs', () => {
    // Session 1 before quitting browser
    const oldTabs = [
      makeTab(10, 0, 'https://pinned.example.com', true),
      makeTab(11, 1, 'https://parent.example.com'),
      makeTab(12, 2, 'https://child-a.example.com'),
      makeTab(13, 3, 'https://grandchild.example.com'),
      makeTab(14, 4, 'https://child-b.example.com'),
      makeTab(15, 5, 'https://work.example.com'),
    ]
    const oldTree: TabTreeMap = {
      11: { folded: true },
      12: { parentId: 11 },
      13: { parentId: 12 },
      14: { parentId: 11 },
    }
    const oldVirtualGroups: Record<number, string> = {
      15: 'panel_work',
    }

    const persisted = serializeWindowsState([{ tabs: oldTabs }], oldTree, oldVirtualGroups)
    expect(persisted).toHaveLength(1)
    expect(persisted[0].tabs.map(t => t.level)).toEqual([0, 0, 1, 2, 1, 0])

    // Session 2 after quitting & reopening Vivaldi (all brand-new tab IDs!)
    const newTabs = [
      makeTab(500, 0, 'https://pinned.example.com', true),
      makeTab(501, 1, 'https://parent.example.com'),
      makeTab(502, 2, 'https://child-a.example.com'),
      makeTab(503, 3, 'https://grandchild.example.com'),
      makeTab(504, 4, 'https://child-b.example.com'),
      makeTab(505, 5, 'https://work.example.com'),
    ]

    const rebuilt = matchAndRebuildSession([{ tabs: newTabs }], persisted)
    expect(rebuilt.treeMeta).toEqual({
      501: { folded: true },
      502: { parentId: 501, folded: undefined },
      503: { parentId: 502, folded: undefined },
      504: { parentId: 501, folded: undefined },
    })
    expect(rebuilt.virtualGroups).toEqual({
      505: 'panel_work',
    })
  })
})
