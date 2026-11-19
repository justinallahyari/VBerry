import { beforeEach, describe, expect, it, vi } from 'vitest'
import { captureSnapshot, restoreSnapshot, restoreSnapshotGroup } from './groups'
import { resetVivaldiDetectionCache } from './env'
import { STORAGE_KEYS } from './storage'
import type { SavedPanel, TabTreeMap } from './types'

function makeTab(
  id: number,
  index: number,
  url: string,
  opts: Partial<chrome.tabs.Tab> = {}
): chrome.tabs.Tab {
  return {
    id,
    index,
    windowId: 1,
    active: false,
    pinned: false,
    highlighted: false,
    incognito: false,
    groupId: -1,
    url,
    title: url,
    ...opts,
  }
}

describe('Snapshot Tab Tree Save & Restore', () => {
  const localStore: Record<string, unknown> = {}
  const sessionStore: Record<string, unknown> = {}
  let nextTabId = 100
  let createdTabs: chrome.tabs.Tab[] = []
  let liveGroups: chrome.tabGroups.TabGroup[] = []

  beforeEach(() => {
    resetVivaldiDetectionCache()
    for (const k of Object.keys(localStore)) delete localStore[k]
    for (const k of Object.keys(sessionStore)) delete sessionStore[k]
    nextTabId = 100
    createdTabs = []
    liveGroups = []
  })

  function installMock(initialWindows: chrome.windows.Window[], groups: chrome.tabGroups.TabGroup[] = []) {
    liveGroups = [...groups]
    let nextGroupId = 50

    ;(globalThis as any).chrome = {
      windows: {
        getAll: vi.fn(async () => initialWindows),
        getCurrent: vi.fn(async () => ({ id: 1, type: 'normal', focused: true })),
        create: vi.fn(async () => ({ id: 2, type: 'normal', focused: true, tabs: [{ id: 999 }] })),
      },
      tabs: {
        query: vi.fn(async (q: any) =>
          q?.windowId ? createdTabs.filter(t => t.windowId === q.windowId) : initialWindows.flatMap(w => w.tabs ?? [])
        ),
        create: vi.fn(async (props: any) => {
          const t = makeTab(nextTabId++, props.index ?? createdTabs.length, props.url, {
            windowId: props.windowId ?? 1,
            pinned: Boolean(props.pinned),
          })
          createdTabs.push(t)
          return t
        }),
        move: vi.fn(async () => []),
        remove: vi.fn(async () => {}),
        group: vi.fn(async ({ tabIds, groupId }: any) => {
          const gid = groupId ?? nextGroupId++
          const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
          for (const t of createdTabs) {
            if (t.id !== undefined && ids.includes(t.id)) t.groupId = gid
          }
          return gid
        }),
      },
      tabGroups: {
        query: vi.fn(async () => [...liveGroups]),
        update: vi.fn(async (id: number, props: any) => {
          const existing = liveGroups.find(g => g.id === id)
          if (existing) Object.assign(existing, props)
          else liveGroups.push({ id, windowId: 1, collapsed: false, ...props })
          return props
        }),
      },
      storage: {
        local: {
          get: vi.fn(async (key: string | string[]) => {
            if (Array.isArray(key)) {
              const out: Record<string, unknown> = {}
              for (const k of key) out[k] = localStore[k]
              return out
            }
            return { [key]: localStore[key] }
          }),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(localStore, items)),
        },
        session: {
          get: vi.fn(async (key: string | string[]) => {
            if (Array.isArray(key)) {
              const out: Record<string, unknown> = {}
              for (const k of key) out[k] = sessionStore[k]
              return out
            }
            return { [key]: sessionStore[key] }
          }),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(sessionStore, items)),
        },
      },
    }
  }

  it('captures tab trees in depth-first order (even with interleaved tabs) and restores exact parent/child/folded tree', async () => {
    const savedPanels: SavedPanel[] = [
      { id: 'panel_work', title: 'Work', color: 'purple', moveRules: [] },
    ]
    localStore[STORAGE_KEYS.savedPanels] = savedPanels

    // Interleaved tab indices: Parent A (idx 0), Unrelated X (idx 1), Child B of A (idx 2), Grandchild C of B (idx 3)
    const winTabs = [
      makeTab(1, 0, 'https://pinned.example.com', { pinned: true }),
      makeTab(2, 1, 'https://parent-a.example.com'),
      makeTab(3, 2, 'https://unrelated-x.example.com'),
      makeTab(4, 3, 'https://child-b.example.com'),
      makeTab(5, 4, 'https://grandchild-c.example.com'),
      makeTab(6, 5, 'https://work-root.example.com'),
      makeTab(7, 6, 'https://work-child.example.com'),
    ]

    const initialTree: TabTreeMap = {
      2: { folded: true },
      4: { parentId: 2 },
      5: { parentId: 4 },
      7: { parentId: 6 },
    }
    sessionStore[STORAGE_KEYS.treeMeta] = initialTree
    sessionStore[STORAGE_KEYS.virtualGroups] = { 6: 'panel_work', 7: 'panel_work' }

    installMock([{ id: 1, focused: true, incognito: false, tabs: winTabs }])

    const snap = await captureSnapshot()
    expect(snap.windows).toHaveLength(1)
    expect(snap.windows[0].pinned).toHaveLength(1)

    const ungrouped = snap.windows[0].groups.find(g => g.ungrouped)!
    // Depth-first order keeps Child B & Grandchild C directly under Parent A, NOT under Unrelated X!
    expect(ungrouped.tabs.map(t => [t.url, t.level, Boolean(t.folded)])).toEqual([
      ['https://parent-a.example.com', 0, true],
      ['https://child-b.example.com', 1, false],
      ['https://grandchild-c.example.com', 2, false],
      ['https://unrelated-x.example.com', 0, false],
    ])

    const workGroup = snap.windows[0].groups.find(g => g.title === 'Work')!
    expect(workGroup.tabs.map(t => [t.url, t.level])).toEqual([
      ['https://work-root.example.com', 0],
      ['https://work-child.example.com', 1],
    ])

    // Clear session state and restore snapshot into current window
    sessionStore[STORAGE_KEYS.treeMeta] = {}
    sessionStore[STORAGE_KEYS.virtualGroups] = {}

    await restoreSnapshot(snap, false)

    const restoredTree = sessionStore[STORAGE_KEYS.treeMeta] as TabTreeMap
    const byUrl = new Map(createdTabs.map(t => [t.url!, t.id!]))

    const idA = byUrl.get('https://parent-a.example.com')!
    const idB = byUrl.get('https://child-b.example.com')!
    const idC = byUrl.get('https://grandchild-c.example.com')!
    const idX = byUrl.get('https://unrelated-x.example.com')!
    const idWorkRoot = byUrl.get('https://work-root.example.com')!
    const idWorkChild = byUrl.get('https://work-child.example.com')!

    expect(restoredTree[idA]).toEqual({ folded: true })
    expect(restoredTree[idB]?.parentId).toBe(idA)
    expect(restoredTree[idC]?.parentId).toBe(idB)
    expect(restoredTree[idX]).toBeUndefined()
    expect(restoredTree[idWorkChild]?.parentId).toBe(idWorkRoot)
  })

  it('gracefully attaches descendants to nearest surviving ancestor if an intermediate parent URL is skipped', async () => {
    installMock([{ id: 1, focused: true, incognito: false, tabs: [] }])
    sessionStore[STORAGE_KEYS.treeMeta] = {}

    const ids = await restoreSnapshotGroup(
      {
        id: 'g1',
        title: 'Docs',
        color: 'blue',
        tabs: [
          { url: 'https://root.example.com', title: 'Root', level: 0 },
          { url: 'about:config', title: 'Skipped Firefox page', level: 1 },
          { url: 'https://grandchild.example.com', title: 'Grandchild', level: 2 },
        ],
      },
      1
    )

    expect(ids).toHaveLength(2)
    const restoredTree = sessionStore[STORAGE_KEYS.treeMeta] as TabTreeMap
    expect(restoredTree[ids[1]]?.parentId).toBe(ids[0])
  })

  it('preserves full tab tree when restoring a snapshot into a new window', async () => {
    installMock([{ id: 1, focused: true, incognito: false, tabs: [] }])
    sessionStore[STORAGE_KEYS.treeMeta] = {}

    await restoreSnapshot(
      {
        id: 'snap_new_win',
        time: Date.now(),
        windows: [
          {
            pinned: [],
            groups: [
              {
                id: 'ungrouped',
                title: 'Ungrouped',
                color: 'grey',
                ungrouped: true,
                tabs: [
                  { url: 'https://a.example.com', title: 'A', level: 0, folded: true },
                  { url: 'https://b.example.com', title: 'B', level: 1 },
                  { url: 'https://c.example.com', title: 'C', level: 2 },
                ],
              },
            ],
          },
        ],
      },
      true
    )

    const win2Tabs = createdTabs.filter(t => t.windowId === 2)
    expect(win2Tabs).toHaveLength(3)
    expect(win2Tabs.map(t => t.index)).toEqual([0, 1, 2])
    const restoredTree = sessionStore[STORAGE_KEYS.treeMeta] as TabTreeMap
    expect(restoredTree[win2Tabs[0].id!]).toEqual({ folded: true })
    expect(restoredTree[win2Tabs[1].id!]?.parentId).toBe(win2Tabs[0].id)
    expect(restoredTree[win2Tabs[2].id!]?.parentId).toBe(win2Tabs[1].id)
  })
})
