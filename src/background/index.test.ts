import { beforeEach, describe, expect, it, vi } from 'vitest'

type Listener<T extends (...args: any[]) => any> = T

function makeEvent<T extends (...args: any[]) => any>() {
  const listeners: Listener<T>[] = []
  return {
    addListener: vi.fn((cb: T) => {
      listeners.push(cb)
    }),
    removeListener: vi.fn((cb: T) => {
      const idx = listeners.indexOf(cb)
      if (idx >= 0) listeners.splice(idx, 1)
    }),
    emit: (...args: Parameters<T>) => {
      for (const cb of [...listeners]) cb(...args)
    },
  }
}

function makeMockPort(name: string, opts?: { throwOnPost?: boolean }) {
  const onDisconnect = makeEvent<(port: any) => void>()
  const onMessage = makeEvent<(msg: any, port: any) => void>()
  const port = {
    name,
    disconnect: vi.fn(),
    postMessage: vi.fn(() => {
      if (opts?.throwOnPost) throw new Error('Attempting to use a disconnected port object')
    }),
    onDisconnect,
    onMessage,
  }
  return port
}

async function flushMicrotasks() {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('toggle_side_panel background lifecycle', () => {
  let onCommand: ReturnType<typeof makeEvent<(cmd: string, tab?: any) => void>>
  let onConnect: ReturnType<typeof makeEvent<(port: any) => void>>
  let onFocusChanged: ReturnType<typeof makeEvent<(winId: number) => void>>
  let onWinRemoved: ReturnType<typeof makeEvent<(winId: number) => void>>
  let onTabActivated: ReturnType<typeof makeEvent<(info: { tabId: number; windowId: number }) => void>>
  let sidePanelOpen: ReturnType<typeof vi.fn>
  let sendMessage: ReturnType<typeof vi.fn>
  let windowsById: Map<number, { id: number; type: string; focused: boolean }>

  async function bootServiceWorker(opts?: { lastFocusedWinId?: number | null }) {
    vi.resetModules()
    onCommand = makeEvent()
    onConnect = makeEvent()
    onFocusChanged = makeEvent()
    onWinRemoved = makeEvent()
    onTabActivated = makeEvent()
    sidePanelOpen = vi.fn(async () => {})
    sendMessage = vi.fn(async () => {})
    windowsById = new Map([
      [10, { id: 10, type: 'normal', focused: true }],
      [20, { id: 20, type: 'normal', focused: false }],
      [99, { id: 99, type: 'popup', focused: true }],
    ])

    const lastFocusedWinId = opts?.lastFocusedWinId === undefined ? 10 : opts.lastFocusedWinId

    ;(globalThis as any).chrome = {
      runtime: {
        onConnect,
        onMessage: makeEvent(),
        onInstalled: makeEvent(),
        onStartup: makeEvent(),
        sendMessage,
        getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
      },
      sidePanel: {
        open: sidePanelOpen,
        setPanelBehavior: vi.fn(async () => {}),
      },
      windows: {
        onFocusChanged,
        onRemoved: onWinRemoved,
        get: vi.fn(async (id: number) => {
          const w = windowsById.get(id)
          if (!w) throw new Error(`No window ${id}`)
          return w
        }),
        getCurrent: vi.fn(async () =>
          lastFocusedWinId !== null ? windowsById.get(lastFocusedWinId) : { id: undefined }
        ),
        getLastFocused: vi.fn(async () =>
          lastFocusedWinId !== null ? windowsById.get(lastFocusedWinId) : undefined
        ),
        getAll: vi.fn(async () =>
          [...windowsById.values()].filter(w => w.type === 'normal')
        ),
      },
      tabs: {
        onActivated: onTabActivated,
        onCreated: makeEvent(),
        onRemoved: makeEvent(),
        onMoved: makeEvent(),
        onReplaced: makeEvent(),
        onUpdated: makeEvent(),
        query: vi.fn(async () => []),
      },
      tabGroups: {
        onCreated: makeEvent(),
        onUpdated: makeEvent(),
        onRemoved: makeEvent(),
        query: vi.fn(async () => []),
      },
      storage: {
        local: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
        session: {
          get: vi.fn(async () => ({})),
          set: vi.fn(async () => {}),
        },
        onChanged: makeEvent(),
      },
      alarms: {
        clear: vi.fn(async () => true),
        create: vi.fn(async () => {}),
        onAlarm: makeEvent(),
      },
      contextMenus: {
        create: vi.fn(),
        removeAll: vi.fn((cb?: () => void) => cb?.()),
        onClicked: makeEvent(),
      },
      commands: {
        onCommand,
      },
      omnibox: {
        setDefaultSuggestion: vi.fn(),
        onInputChanged: makeEvent(),
        onInputEntered: makeEvent(),
      },
    }

    await import('./index')
  }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('closes an open panel via its live port, and opens again after manual port disconnect', async () => {
    await bootServiceWorker()
    await flushMicrotasks()

    const port = makeMockPort('vberry-sidepanel:10')
    onConnect.emit(port)

    // First toggle closes directly via port without calling sidePanel.open
    onCommand.emit('toggle_side_panel', { id: 1, windowId: 10 })
    expect(port.postMessage).toHaveBeenCalledWith({ type: 'vberry:close-panel', windowId: 10 })
    expect(sidePanelOpen).not.toHaveBeenCalled()

    // Re-connect then simulate user manually clicking X (port disconnects)
    const port2 = makeMockPort('vberry-sidepanel:10')
    onConnect.emit(port2)
    port2.onDisconnect.emit(port2)

    // Next toggle opens synchronously with user gesture
    onCommand.emit('toggle_side_panel', { id: 1, windowId: 10 })
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 10 })
  })

  it('closes an already-open panel after cold service worker restart via openedBefore timestamp', async () => {
    await bootServiceWorker({ lastFocusedWinId: null })
    // Simulate cold wakeup: no port is registered yet, lastFocusedWindowId is still -1
    const beforeCmd = Date.now()
    onCommand.emit('toggle_side_panel', { id: 1, windowId: 10 })

    // Synchronously calls sidePanel.open to preserve user gesture in case panel is closed
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 10 })

    await flushMicrotasks()

    // After open() settles, sends close-panel gated by openedBefore so an older open panel closes
    // while a newly opened panel (mountedAt >= openedBefore) stays open
    expect(sendMessage).toHaveBeenCalledTimes(1)
    const msg = sendMessage.mock.calls[0][0]
    expect(msg.type).toBe('vberry:close-panel')
    expect(msg.windowId).toBe(10)
    expect(msg.openedBefore).toBeGreaterThanOrEqual(beforeCmd)
  })

  it('falls back to getTargetWindowId when cold service worker receives no tab', async () => {
    await bootServiceWorker({ lastFocusedWinId: null })
    onCommand.emit('toggle_side_panel', undefined)

    await flushMicrotasks()

    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 10 })
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'vberry:close-panel', windowId: 10 })
    )
  })

  it('ignores popup focus and unfocused window tab activation when tracking lastFocusedWindowId', async () => {
    await bootServiceWorker({ lastFocusedWinId: 10 })
    await flushMicrotasks()

    // Focusing a popup window must not pollute lastFocusedWindowId
    onFocusChanged.emit(99)
    // Activating a tab in an unfocused normal window must not steal lastFocusedWindowId
    onTabActivated.emit({ tabId: 5, windowId: 20 })
    await flushMicrotasks()

    onCommand.emit('toggle_side_panel', { id: 1, windowId: 10 })
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 10 })
  })

  it('falls through synchronously to sidePanel.open if a stale port throws on postMessage', async () => {
    await bootServiceWorker()
    await flushMicrotasks()

    const deadPort = makeMockPort('vberry-sidepanel:10', { throwOnPost: true })
    onConnect.emit(deadPort)

    onCommand.emit('toggle_side_panel', { id: 1, windowId: 10 })
    expect(sidePanelOpen).toHaveBeenCalledWith({ windowId: 10 })
  })
})
