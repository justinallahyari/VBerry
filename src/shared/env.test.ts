import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createNewTab,
  isVivaldi,
  resetVivaldiDetectionCache,
  VIVALDI_STARTPAGE_URL,
} from './env'
import { createGroupWithTab, discardTabs } from './groups'
import { STORAGE_KEYS } from './storage'

describe('Vivaldi detection & Tab Groups fallback', () => {
  const localStore: Record<string, unknown> = {}
  const sessionStore: Record<string, unknown> = {}

  beforeEach(() => {
    resetVivaldiDetectionCache()
    for (const k of Object.keys(localStore)) delete localStore[k]
    for (const k of Object.keys(sessionStore)) delete sessionStore[k]
  })

  function installChromeMock(opts: {
    vivaldiTab?: boolean
    groupThrows?: boolean
    groupSilentNoop?: boolean
  }) {
    const liveGroups: any[] = []
    const createMock = vi.fn(async (props: any) => ({
      id: 42,
      index: 0,
      windowId: props.windowId ?? 1,
      active: true,
      pinned: false,
      highlighted: true,
      incognito: false,
      groupId: -1,
      url: props.url ?? 'chrome://newtab/',
    }))

    const groupMock = opts.groupThrows
      ? vi.fn(async () => {
          throw new Error('Tab groups are not supported')
        })
      : vi.fn(async () => 99)

    const groupUpdateMock = vi.fn(async (id: number, props: any) => {
      const grp = { id, windowId: 1, collapsed: false, ...props }
      if (!opts.groupSilentNoop) liveGroups.push(grp)
      return grp
    })

    ;(globalThis as any).chrome = {
      tabs: {
        query: vi.fn(async () =>
          opts.vivaldiTab
            ? [{ id: 1, url: 'https://example.com', vivExtData: '{}' }]
            : [{ id: 1, url: 'https://example.com' }]
        ),
        create: createMock,
        group: groupMock,
      },
      tabGroups: {
        update: groupUpdateMock,
        query: vi.fn(async () => [...liveGroups]),
      },
      storage: {
        local: {
          get: vi.fn(async (k: string) => ({ [k]: localStore[k] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(localStore, items)),
        },
        session: {
          get: vi.fn(async (k: string) => ({ [k]: sessionStore[k] })),
          set: vi.fn(async (items: Record<string, unknown>) => Object.assign(sessionStore, items)),
        },
      },
    }

    return { createMock, groupMock, groupUpdateMock }
  }

  it('detects Vivaldi via vivExtData and opens chrome://vivaldi-webui/startpage', async () => {
    const { createMock } = installChromeMock({ vivaldiTab: true })
    expect(await isVivaldi()).toBe(true)

    await createNewTab({ windowId: 1 })
    expect(createMock).toHaveBeenCalledWith({
      windowId: 1,
      active: true,
      url: VIVALDI_STARTPAGE_URL,
    })
  })

  it('omits url on standard Chrome so native New Tab Page opens', async () => {
    const { createMock } = installChromeMock({ vivaldiTab: false })
    expect(await isVivaldi()).toBe(false)

    await createNewTab({ windowId: 1 })
    expect(createMock).toHaveBeenCalledWith({
      windowId: 1,
      active: true,
    })
  })

  it('uses native chrome.tabGroups on Chrome', async () => {
    const { groupMock, groupUpdateMock } = installChromeMock({
      vivaldiTab: false,
      groupThrows: false,
    })
    const res = await createGroupWithTab(1, 'Work', 'blue')
    expect(res.groupId).toBe(99)
    expect(groupMock).toHaveBeenCalled()
    expect(groupUpdateMock).toHaveBeenCalledWith(99, {
      title: 'Work',
      color: 'blue',
      collapsed: false,
    })
  })

  it('falls back to persisted SavedPanel + virtual group on Vivaldi even when chrome.tabs.group does not throw', async () => {
    const { groupMock } = installChromeMock({ vivaldiTab: true, groupSilentNoop: true })
    const res = await createGroupWithTab(1, 'Research', 'cyan')
    expect(groupMock).not.toHaveBeenCalled()
    expect(res.groupId).toBeNull()
    expect(res.savedPanelId).toBeTruthy()

    const panels = localStore[STORAGE_KEYS.savedPanels] as any[]
    expect(panels).toHaveLength(1)
    expect(panels[0]).toMatchObject({ title: 'Research', color: 'cyan' })

    const vmap = sessionStore[STORAGE_KEYS.virtualGroups] as Record<number, string>
    expect(vmap[42]).toBe(res.savedPanelId)
  })

  it('falls back cleanly if a browser silently drops a native tab group', async () => {
    installChromeMock({ vivaldiTab: false, groupSilentNoop: true })
    const res = await createGroupWithTab(1, 'Fallback', 'orange')
    expect(res.groupId).toBeNull()
    expect(res.savedPanelId).toBeTruthy()
  })

  it('switches to last-used tab before unloading the active tab, or opens a new tab if sole tab', async () => {
    const { createMock } = installChromeMock({ vivaldiTab: false })
    const updateMock = vi.fn(async () => ({}))
    const discardMock = vi.fn(async () => ({}))
    ;(globalThis as any).chrome.tabs.update = updateMock
    ;(globalThis as any).chrome.tabs.discard = discardMock

    const windowTabs = [
      { id: 1, index: 0, windowId: 1, active: false, pinned: false, highlighted: false, incognito: false, groupId: -1, lastAccessed: 100 },
      { id: 2, index: 1, windowId: 1, active: true, pinned: false, highlighted: true, incognito: false, groupId: -1, lastAccessed: 300 },
      { id: 3, index: 2, windowId: 1, active: false, pinned: false, highlighted: false, incognito: false, groupId: -1, lastAccessed: 250 },
    ] as chrome.tabs.Tab[]

    await discardTabs([2], windowTabs, 1)
    expect(updateMock).toHaveBeenCalledWith(3, { active: true })
    expect(discardMock).toHaveBeenCalledWith(2)

    // When all other tabs are already discarded -> opens a new tab instead of waking them
    updateMock.mockClear()
    discardMock.mockClear()
    createMock.mockClear()
    const onlyUnloadedOthers = [
      { ...windowTabs[0], discarded: true },
      windowTabs[1],
      { ...windowTabs[2], discarded: true },
    ]
    await discardTabs([2], onlyUnloadedOthers, 1)
    expect(updateMock).not.toHaveBeenCalled()
    expect(createMock).toHaveBeenCalledWith({ windowId: 1, active: true })
    expect(discardMock).toHaveBeenCalledWith(2)
  })
})
