import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mountSpotlightOverlay, type SpotlightOverlayConfig } from './spotlight-overlay'
import { DEFAULT_PANEL_SHORTCUTS } from './types'

function makeConfig(overrides: Partial<SpotlightOverlayConfig> = {}): SpotlightOverlayConfig {
  return {
    windowId: 7,
    view: 'tabs',
    theme: 'dark',
    density: 'comfortable',
    fontSize: 13,
    iconSize: 16,
    uiIconSize: 19,
    tabControlIconSize: 12,
    showTabCounts: true,
    showBookmarksPanel: true,
    showHistoryPanel: true,
    autoHighlight: true,
    clearOnPanelSwitch: false,
    panelShortcuts: { ...DEFAULT_PANEL_SHORTCUTS },
    requireFocus: false,
    ...overrides,
  }
}

describe('mountSpotlightOverlay', () => {
  const sendMessage = vi.fn()

  beforeEach(() => {
    document.documentElement.innerHTML = '<head></head><body><button id="prev">Btn</button></body>'
    sendMessage.mockReset()
    sendMessage.mockImplementation(
      async (msg: { type: string; view?: string; expandedFolderIds?: string[] }) => {
        if (msg.type === 'vberry:spotlight-query') {
          if (msg.view === 'bookmarks') {
            const expanded = new Set(msg.expandedFolderIds ?? ['1', '2'])
            return {
              groups: [{ key: 'ungrouped', title: 'Tabs', count: 2 }],
              activeGroupKey: 'ungrouped',
              items: [
                {
                  id: 'bmf:1',
                  kind: 'folder',
                  folderId: '1',
                  title: 'Bookmarks Bar',
                  url: '',
                  level: 0,
                  expanded: expanded.has('1'),
                },
                ...(expanded.has('1')
                  ? [
                      {
                        id: 'bm:10',
                        kind: 'url',
                        title: 'Example',
                        url: 'https://example.com',
                        level: 1,
                      },
                    ]
                  : []),
              ],
            }
          }
          return {
            groups: [{ key: 'ungrouped', title: 'Tabs', count: 2 }],
            activeGroupKey: 'ungrouped',
            items: [
              {
                id: 'tab:1',
                kind: 'tab',
                tabId: 1,
                title: 'GitHub',
                url: 'https://github.com',
                level: 0,
                hasChildren: true,
                childCount: 1,
                folded: false,
              },
              {
                id: 'tab:2',
                kind: 'tab',
                tabId: 2,
                title: 'Docs',
                url: 'https://docs.example.com',
                level: 1,
              },
            ],
          }
        }
        return { ok: true }
      }
    )
    ;(globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: { sendMessage },
    }
  })

  it('mounts overlay with tab tree, moves selection with arrows, and activates on Enter', async () => {
    const mounted = await mountSpotlightOverlay(makeConfig({ windowId: 7 }))
    expect(mounted).toBe(true)
    expect(document.getElementById('vberry-spotlight-host')).not.toBeNull()
    await new Promise(r => setTimeout(r, 0))

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'vberry:spotlight-query',
      query: '',
      view: 'tabs',
      windowId: 7,
      groupKey: undefined,
      expandedFolderIds: ['1', '2'],
    })

    // ArrowDown twice moves cursor from -1 -> 0 -> 1, then Enter activates child tab 2
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))

    expect(sendMessage).toHaveBeenCalledWith({
      type: 'vberry:spotlight-activate',
      kind: 'tab',
      tabId: 2,
      url: 'https://docs.example.com',
      windowId: 7,
    })
    expect(document.getElementById('vberry-spotlight-host')).toBeNull()
  })

  it('switches to bookmark tree on Tab, toggles folder on Enter, and dismisses on Escape', async () => {
    const prevBtn = document.getElementById('prev') as HTMLButtonElement
    prevBtn.focus()

    await mountSpotlightOverlay(makeConfig({ windowId: 3, theme: 'light' }))
    await new Promise(r => setTimeout(r, 0))

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }))
    await new Promise(r => setTimeout(r, 0))

    // Highlight folder 0 ("Bookmarks Bar") and press Enter to collapse it without closing overlay
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }))
    await new Promise(r => setTimeout(r, 0))

    expect(document.getElementById('vberry-spotlight-host')).not.toBeNull()
    expect(sendMessage).toHaveBeenLastCalledWith({
      type: 'vberry:spotlight-query',
      query: '',
      view: 'bookmarks',
      windowId: 3,
      groupKey: 'ungrouped',
      expandedFolderIds: ['2'],
    })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(document.getElementById('vberry-spotlight-host')).toBeNull()
    expect(document.activeElement).toBe(prevBtn)
  })
})
