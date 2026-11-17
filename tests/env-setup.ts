/// <reference types="../src/types/web-ext.d.ts" />

import manifest from '../src/manifest.json'
import { installBrowserPolyfill } from '../src/polyfill/browser-polyfill'

class EventTarget<T extends (...args: any[]) => any> {
  private listeners = new Set<T>()
  addListener = (listener: T) => {
    if (typeof listener === 'function') this.listeners.add(listener)
  }
  removeListener = (listener: T) => {
    this.listeners.delete(listener)
  }
  hasListener = (listener: T) => this.listeners.has(listener)
  emit = (...args: Parameters<T>) => {
    for (const fn of Array.from(this.listeners)) {
      try {
        fn(...args)
      } catch {
        // Ignore listener errors in tests
      }
    }
  }
}

export interface ChromeMockEnv {
  localStore: Record<string, any>
  sessionStore: Record<string, any>
  syncStore: Record<string, any>
  windows: any[]
  tabs: any[]
  tabGroups: any[]
  alarms: Record<string, any>
  downloads: any[]
  contextMenus: any[]
  sidePanelBehavior: any
  nextWinId: number
  nextTabId: number
  nextGroupId: number
  nextDownloadId: number
  reset: () => void
  triggerAlarm: (name: string) => void
}

function cloneVal<T>(v: T): T {
  if (v === undefined || v === null || typeof v !== 'object') return v
  return JSON.parse(JSON.stringify(v))
}

function createStorageArea(getStore: () => Record<string, any>, areaName: string, onChanged: EventTarget<any>) {
  const get = (keys?: string | string[] | Record<string, any> | null): Promise<Record<string, any>> => {
    const store = getStore()
    if (keys === undefined || keys === null) {
      return Promise.resolve(cloneVal(store))
    }
    if (typeof keys === 'string') {
      return Promise.resolve(keys in store ? { [keys]: cloneVal(store[keys]) } : {})
    }
    if (Array.isArray(keys)) {
      const out: Record<string, any> = {}
      for (const k of keys) {
        if (k in store) out[k] = cloneVal(store[k])
      }
      return Promise.resolve(out)
    }
    const out: Record<string, any> = {}
    for (const [k, defVal] of Object.entries(keys)) {
      out[k] = k in store ? cloneVal(store[k]) : cloneVal(defVal)
    }
    return Promise.resolve(out)
  }

  const set = (items: Record<string, any>): Promise<void> => {
    const store = getStore()
    const changes: Record<string, { oldValue?: any; newValue?: any }> = {}
    for (const [k, v] of Object.entries(items)) {
      const oldValue = cloneVal(store[k])
      store[k] = cloneVal(v)
      changes[k] = { oldValue, newValue: cloneVal(v) }
    }
    onChanged.emit(changes, areaName)
    return Promise.resolve()
  }

  const remove = (keys: string | string[]): Promise<void> => {
    const store = getStore()
    const list = Array.isArray(keys) ? keys : [keys]
    const changes: Record<string, { oldValue?: any; newValue?: any }> = {}
    for (const k of list) {
      if (k in store) {
        changes[k] = { oldValue: cloneVal(store[k]), newValue: undefined }
        delete store[k]
      }
    }
    if (Object.keys(changes).length) onChanged.emit(changes, areaName)
    return Promise.resolve()
  }

  const clear = (): Promise<void> => {
    const store = getStore()
    for (const k of Object.keys(store)) delete store[k]
    return Promise.resolve()
  }

  return { get, set, remove, clear }
}

void (function () {
  const msgHandlers: ((a: any) => void)[] = []
  const storageOnChanged = new EventTarget<any>()

  const env: ChromeMockEnv = {
    localStore: {},
    sessionStore: {},
    syncStore: {},
    windows: [],
    tabs: [],
    tabGroups: [],
    alarms: {},
    downloads: [],
    contextMenus: [],
    sidePanelBehavior: { openPanelOnActionClick: false },
    nextWinId: 1,
    nextTabId: 100,
    nextGroupId: 1,
    nextDownloadId: 1,
    reset() {
      env.localStore = {}
      env.sessionStore = {}
      env.syncStore = {}
      env.windows = []
      env.tabs = []
      env.tabGroups = []
      env.alarms = {}
      env.downloads = []
      env.contextMenus = []
      env.sidePanelBehavior = { openPanelOnActionClick: false }
      env.nextWinId = 1
      env.nextTabId = 100
      env.nextGroupId = 1
      env.nextDownloadId = 1
    },
    triggerAlarm(name: string) {
      const alarm = env.alarms[name] ?? { name, scheduledTime: Date.now() }
      chromeOnAlarm.emit(alarm)
    },
  }

  const reindexWindowTabs = (winId: number) => {
    const winTabs = env.tabs.filter(t => t.windowId === winId)
    winTabs.sort((a, b) => a.index - b.index)
    winTabs.forEach((t, i) => {
      t.index = i
    })
    const win = env.windows.find(w => w.id === winId)
    if (win) win.tabs = winTabs
  }

  const chromeOnAlarm = new EventTarget<any>()
  const tabOnCreated = new EventTarget<any>()
  const tabOnRemoved = new EventTarget<any>()
  const tabOnUpdated = new EventTarget<any>()
  const tabOnMoved = new EventTarget<any>()
  const tabOnActivated = new EventTarget<any>()
  const tabOnAttached = new EventTarget<any>()
  const tabOnDetached = new EventTarget<any>()
  const tabOnReplaced = new EventTarget<any>()
  const winOnCreated = new EventTarget<any>()
  const winOnRemoved = new EventTarget<any>()
  const winOnFocusChanged = new EventTarget<any>()
  const tabGroupOnCreated = new EventTarget<any>()
  const tabGroupOnUpdated = new EventTarget<any>()
  const tabGroupOnRemoved = new EventTarget<any>()

  const chromeMock: any = {
    extension: {
      inIncognitoContext: false,
    },
    i18n: {
      getUILanguage: () => 'en_US',
      getMessage: (key: string) => key,
    },
    runtime: {
      id: 'sidebery-chrome-ext-id',
      getURL: (p: string) => {
        const base = 'chrome-extension://sidebery-chrome-ext-id'
        if (p.startsWith('/')) return base + p
        return base + '/' + p
      },
      getManifest: () => cloneVal(manifest),
      getPlatformInfo: () => Promise.resolve({ os: 'mac', arch: 'arm' }),
      getContexts: () => Promise.resolve([{ contextType: 'SIDE_PANEL', windowId: env.windows[0]?.id ?? 1 }]),
      sendMessage: (msg: any) => Promise.all(msgHandlers.map(h => h(msg))),
      openOptionsPage: () => Promise.resolve(),
      reload: () => {},
      connect: (): any => ({
        name: '',
        disconnect: () => {},
        onDisconnect: new EventTarget(),
        onMessage: new EventTarget(),
        postMessage: () => {},
      }),
      onConnect: new EventTarget(),
      onMessage: {
        addListener: (h: any) => msgHandlers.push(h),
        removeListener: () => {},
        hasListener: (h: any) => msgHandlers.includes(h),
      },
      onUpdateAvailable: new EventTarget(),
    },
    storage: {
      local: createStorageArea(() => env.localStore, 'local', storageOnChanged),
      session: createStorageArea(() => env.sessionStore, 'session', storageOnChanged),
      sync: createStorageArea(() => env.syncStore, 'sync', storageOnChanged),
      onChanged: storageOnChanged,
    },
    windows: {
      WINDOW_ID_CURRENT: -2,
      WINDOW_ID_NONE: -1,
      get: (windowId: number, opts?: { populate?: boolean }) => {
        const w = env.windows.find(x => x.id === windowId)
        if (!w) return Promise.reject(new Error(`No window with id: ${windowId}`))
        return Promise.resolve({
          ...w,
          tabs: opts?.populate === false ? undefined : env.tabs.filter(t => t.windowId === w.id),
        })
      },
      getAll: (opts?: { populate?: boolean }) => {
        const wins = env.windows.map(w => ({
          ...w,
          tabs: opts?.populate === false ? undefined : env.tabs.filter(t => t.windowId === w.id),
        }))
        return Promise.resolve(wins)
      },
      getCurrent: () => {
        const w = env.windows[0]
        if (!w) return Promise.resolve({ id: 1, focused: true, incognito: false, type: 'normal', tabs: [] })
        return Promise.resolve({ ...w, tabs: env.tabs.filter(t => t.windowId === w.id) })
      },
      getLastFocused: () => {
        const w = env.windows.find(x => x.focused) ?? env.windows[0]
        return Promise.resolve(w ?? { id: 1, focused: true, incognito: false, type: 'normal', tabs: [] })
      },
      create: (createData: any = {}) => {
        const winId = env.nextWinId++
        const win: any = {
          id: winId,
          focused: createData.focused ?? true,
          incognito: !!createData.incognito,
          type: createData.type ?? 'normal',
          state: createData.state ?? 'normal',
          alwaysOnTop: false,
          tabs: [],
        }
        env.windows.push(win)

        if (createData.tabId !== undefined) {
          const movedTab = env.tabs.find(t => t.id === createData.tabId)
          if (movedTab) {
            const oldWinId = movedTab.windowId
            movedTab.windowId = winId
            movedTab.index = 0
            reindexWindowTabs(oldWinId)
            reindexWindowTabs(winId)
          }
        } else {
          const initialUrl = typeof createData.url === 'string' ? createData.url : 'about:blank'
          const initialTab = {
            id: env.nextTabId++,
            windowId: winId,
            index: 0,
            url: initialUrl,
            title: initialUrl === 'about:blank' ? 'New Tab' : initialUrl,
            active: true,
            pinned: false,
            highlighted: true,
            incognito: win.incognito,
            discarded: false,
            status: 'complete',
            groupId: -1,
          }
          env.tabs.push(initialTab)
          reindexWindowTabs(winId)
        }

        winOnCreated.emit(win)
        return Promise.resolve({ ...win, tabs: env.tabs.filter(t => t.windowId === winId) })
      },
      update: (windowId: number, updateInfo: any) => {
        const win = env.windows.find(w => w.id === windowId)
        if (win) Object.assign(win, updateInfo)
        return Promise.resolve(win ?? { id: windowId })
      },
      remove: (windowId: number) => {
        env.windows = env.windows.filter(w => w.id !== windowId)
        env.tabs = env.tabs.filter(t => t.windowId !== windowId)
        winOnRemoved.emit(windowId)
        return Promise.resolve()
      },
      onCreated: winOnCreated,
      onRemoved: winOnRemoved,
      onFocusChanged: winOnFocusChanged,
    },
    tabs: {
      query: (q: any = {}) => {
        let res = env.tabs.slice()
        if (q.windowId !== undefined && q.windowId !== -2) {
          res = res.filter(t => t.windowId === q.windowId)
        } else if (q.windowId === -2 && env.windows[0]) {
          res = res.filter(t => t.windowId === env.windows[0].id)
        }
        if (q.active !== undefined) res = res.filter(t => !!t.active === q.active)
        if (q.pinned !== undefined) res = res.filter(t => !!t.pinned === q.pinned)
        if (q.highlighted !== undefined) res = res.filter(t => !!t.highlighted === q.highlighted)
        if (q.groupId !== undefined) res = res.filter(t => t.groupId === q.groupId)
        if (q.url !== undefined) res = res.filter(t => t.url === q.url)
        return Promise.resolve(res.sort((a, b) => a.index - b.index))
      },
      get: (tabId: number) => {
        const t = env.tabs.find(x => x.id === tabId)
        if (!t) return Promise.reject(new Error(`No tab with id: ${tabId}`))
        return Promise.resolve(t)
      },
      create: (props: any = {}) => {
        let winId = props.windowId
        if (winId === undefined || winId === -2) {
          winId = env.windows[0]?.id
          if (winId === undefined) {
            winId = env.nextWinId++
            env.windows.push({ id: winId, focused: true, incognito: false, type: 'normal', tabs: [] })
          }
        }
        const winTabs = env.tabs.filter(t => t.windowId === winId)
        const targetIndex = props.index !== undefined ? Math.min(props.index, winTabs.length) : winTabs.length

        for (const t of winTabs) {
          if (t.index >= targetIndex) t.index++
          if (props.active) t.active = false
        }

        const win = env.windows.find(w => w.id === winId)
        const tab: any = {
          id: env.nextTabId++,
          windowId: winId,
          index: targetIndex,
          url: props.url ?? 'chrome://newtab/',
          title: props.url ?? 'New Tab',
          active: props.active ?? true,
          pinned: !!props.pinned,
          highlighted: !!props.active,
          incognito: !!win?.incognito,
          discarded: false,
          status: 'complete',
          openerTabId: props.openerTabId,
          groupId: -1,
        }
        env.tabs.push(tab)
        reindexWindowTabs(winId)
        tabOnCreated.emit(tab)
        return Promise.resolve(tab)
      },
      update: (tabId: number, props: any = {}) => {
        const t = env.tabs.find(x => x.id === tabId)
        if (!t) return Promise.resolve({})
        if (props.active) {
          for (const wt of env.tabs.filter(x => x.windowId === t.windowId)) {
            wt.active = wt.id === tabId
          }
        }
        Object.assign(t, props)
        tabOnUpdated.emit(tabId, props, t)
        return Promise.resolve(t)
      },
      remove: (tabIds: number | number[]) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        const touchedWins = new Set<number>()
        for (const id of ids) {
          const idx = env.tabs.findIndex(t => t.id === id)
          if (idx !== -1) {
            const [removed] = env.tabs.splice(idx, 1)
            touchedWins.add(removed.windowId)
            tabOnRemoved.emit(id, { windowId: removed.windowId, isWindowClosing: false })
          }
        }
        for (const wid of touchedWins) reindexWindowTabs(wid)
        return Promise.resolve()
      },
      move: (tabIds: number | number[], moveProps: { windowId?: number; index: number }) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        const moved: any[] = []
        for (const id of ids) {
          const t = env.tabs.find(x => x.id === id)
          if (!t) continue
          const oldWinId = t.windowId
          const targetWinId = moveProps.windowId ?? oldWinId
          const oldIndex = t.index
          t.windowId = targetWinId
          const destTabs = env.tabs.filter(x => x.windowId === targetWinId && x.id !== id)
          const insertIdx = moveProps.index < 0 ? destTabs.length : Math.min(moveProps.index, destTabs.length)
          destTabs.forEach((dt, idx) => {
            dt.index = idx >= insertIdx ? idx + 1 : idx
          })
          t.index = insertIdx
          reindexWindowTabs(oldWinId)
          if (targetWinId !== oldWinId) {
            reindexWindowTabs(targetWinId)
            tabOnDetached.emit(id, { oldWindowId: oldWinId, oldPosition: oldIndex })
            tabOnAttached.emit(id, { newWindowId: targetWinId, newPosition: insertIdx })
          } else {
            tabOnMoved.emit(id, { windowId: targetWinId, fromIndex: oldIndex, toIndex: insertIdx })
          }
          moved.push(t)
        }
        return Promise.resolve(Array.isArray(tabIds) ? moved : moved[0])
      },
      discard: (tabId: number) => {
        const t = env.tabs.find(x => x.id === tabId)
        if (t) t.discarded = true
        return Promise.resolve(t)
      },
      reload: () => Promise.resolve(),
      duplicate: (tabId: number) => {
        const t = env.tabs.find(x => x.id === tabId)
        if (!t) return Promise.resolve(undefined)
        return chromeMock.tabs.create({ windowId: t.windowId, url: t.url, index: t.index + 1, active: false })
      },
      highlight: () => Promise.resolve(),
      group: (opts: { tabIds: number | number[]; groupId?: number; createProperties?: { windowId?: number } }) => {
        const ids = Array.isArray(opts.tabIds) ? opts.tabIds : [opts.tabIds]
        let groupId = opts.groupId
        if (groupId === undefined) {
          groupId = env.nextGroupId++
          const firstTab = env.tabs.find(t => t.id === ids[0])
          const winId = opts.createProperties?.windowId ?? firstTab?.windowId ?? 1
          const grp = { id: groupId, windowId: winId, title: '', color: 'grey', collapsed: false }
          env.tabGroups.push(grp)
          tabGroupOnCreated.emit(grp)
        }
        for (const id of ids) {
          const t = env.tabs.find(x => x.id === id)
          if (t) t.groupId = groupId
        }
        return Promise.resolve(groupId)
      },
      ungroup: (tabIds: number | number[]) => {
        const ids = Array.isArray(tabIds) ? tabIds : [tabIds]
        for (const id of ids) {
          const t = env.tabs.find(x => x.id === id)
          if (t) t.groupId = -1
        }
        return Promise.resolve()
      },
      captureVisibleTab: () => Promise.resolve('tab image'),
      onCreated: tabOnCreated,
      onRemoved: tabOnRemoved,
      onUpdated: tabOnUpdated,
      onMoved: tabOnMoved,
      onActivated: tabOnActivated,
      onAttached: tabOnAttached,
      onDetached: tabOnDetached,
      onReplaced: tabOnReplaced,
    },
    tabGroups: {
      get: (groupId: number) => {
        const g = env.tabGroups.find(x => x.id === groupId)
        if (!g) return Promise.reject(new Error(`No group ${groupId}`))
        return Promise.resolve(g)
      },
      query: (q: any = {}) => {
        let res = env.tabGroups.slice()
        if (q.windowId !== undefined) res = res.filter(g => g.windowId === q.windowId)
        if (q.title !== undefined) res = res.filter(g => g.title === q.title)
        if (q.collapsed !== undefined) res = res.filter(g => g.collapsed === q.collapsed)
        return Promise.resolve(res)
      },
      update: (groupId: number, props: any) => {
        const g = env.tabGroups.find(x => x.id === groupId)
        if (!g) return Promise.reject(new Error(`No group ${groupId}`))
        Object.assign(g, props)
        tabGroupOnUpdated.emit(g)
        return Promise.resolve(g)
      },
      onCreated: tabGroupOnCreated,
      onUpdated: tabGroupOnUpdated,
      onRemoved: tabGroupOnRemoved,
    },
    sidePanel: {
      setPanelBehavior: (behavior: any) => {
        env.sidePanelBehavior = { ...env.sidePanelBehavior, ...behavior }
        return Promise.resolve()
      },
      setOptions: () => Promise.resolve(),
      open: () => Promise.resolve(),
      close: () => Promise.resolve(),
    },
    action: {
      setPopup: () => Promise.resolve(),
      openPopup: () => Promise.resolve(),
      setTitle: () => Promise.resolve(),
      enable: () => Promise.resolve(),
      disable: () => Promise.resolve(),
      onClicked: new EventTarget(),
    },
    alarms: {
      create: (name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }) => {
        env.alarms[name] = {
          name,
          scheduledTime: Date.now() + (alarmInfo.delayInMinutes ?? 1) * 60_000,
          periodInMinutes: alarmInfo.periodInMinutes,
        }
        return Promise.resolve()
      },
      get: (name: string) => Promise.resolve(env.alarms[name]),
      getAll: () => Promise.resolve(Object.values(env.alarms)),
      clear: (name?: string) => {
        if (name) delete env.alarms[name]
        else env.alarms = {}
        return Promise.resolve(true)
      },
      onAlarm: chromeOnAlarm,
    },
    downloads: {
      download: (options: any) => {
        const id = env.nextDownloadId++
        env.downloads.push({ id, ...options })
        return Promise.resolve(id)
      },
    },
    commands: {
      getAll: () =>
        Promise.resolve(
          Object.entries((manifest as any).commands ?? {}).map(([name, cmd]: [string, any]) => ({
            name,
            description: cmd.description ?? '',
            shortcut: cmd.suggested_key?.default ?? '',
          }))
        ),
      onCommand: new EventTarget(),
    },
    contextMenus: {
      create: (props: any) => {
        env.contextMenus.push(props)
        return props.id
      },
      removeAll: () => {
        env.contextMenus = []
        return Promise.resolve()
      },
      onClicked: new EventTarget(),
    },
    bookmarks: {
      getTree: () =>
        Promise.resolve([
          {
            id: '0',
            title: '',
            children: [
              { id: '1', parentId: '0', index: 0, title: 'Bookmarks Bar', children: [] },
              { id: '2', parentId: '0', index: 1, title: 'Other Bookmarks', children: [] },
            ],
          },
        ]),
      create: (d: any) => Promise.resolve({ id: String(Date.now()), ...d }),
      update: (id: string, c: any) => Promise.resolve({ id, ...c }),
      move: (id: string, d: any) => Promise.resolve({ id, ...d }),
      remove: () => Promise.resolve(),
      removeTree: () => Promise.resolve(),
      onCreated: new EventTarget(),
      onChanged: new EventTarget(),
      onMoved: new EventTarget(),
      onRemoved: new EventTarget(),
    },
    history: {
      search: () => Promise.resolve([]),
      getVisits: () => Promise.resolve([]),
      deleteUrl: () => Promise.resolve(),
      deleteRange: () => Promise.resolve(),
      onVisited: new EventTarget(),
      onTitleChanged: new EventTarget(),
      onVisitRemoved: new EventTarget(),
    },
    sessions: {
      getRecentlyClosed: () => Promise.resolve([]),
      restore: () => Promise.resolve({}),
    },
    permissions: {
      contains: () => Promise.resolve(true),
      request: () => Promise.resolve(true),
      remove: () => Promise.resolve(true),
      onAdded: new EventTarget(),
      onRemoved: new EventTarget(),
    },
    cookies: {
      getAll: () => Promise.resolve([]),
      remove: () => Promise.resolve(null),
    },
    search: {
      query: () => Promise.resolve(),
    },
    omnibox: {
      setDefaultSuggestion: () => {},
      onInputChanged: new EventTarget(),
      onInputEntered: new EventTarget(),
    },
    identity: {
      getRedirectURL: () => 'https://sidebery-chrome-ext-id.chromiumapp.org/',
      launchWebAuthFlow: () => Promise.resolve(''),
    },
    scripting: {
      executeScript: () => Promise.resolve([{ result: true }]),
    },
  }

  ;(globalThis as any).__chromeMockEnv = env
  ;(globalThis as any).chrome = chromeMock

  // Install the real Chrome-to-Firefox polyfill over chromeMock
  installBrowserPolyfill(true)

  // Preserve test-compatibility hooks expected by upstream unit tests (utils.test.ts, etc.)
  const b = (globalThis as any).browser
  if (b?.tabs && !b.tabs.captureTab) {
    b.tabs.captureTab = () => Promise.resolve('tab image')
  }
})()
