import * as ContainerBridge from 'src/polyfill/container-bridge'
import * as PanelIsolation from 'src/polyfill/panel-isolation'

interface AnchorModuleLike {
  setTabValue?: <T = any>(tabId: ID, key: string, value: T) => Promise<void>
  getTabValue?: <T = any>(tabId: ID, key: string) => Promise<T | undefined>
  setWindowValue?: <T = any>(windowId: ID, key: string, value: T) => Promise<void>
  getWindowValue?: <T = any>(windowId: ID, key: string) => Promise<T | undefined>
}

interface EventEmitter<T extends (...args: any[]) => any> {
  addListener: (listener: T) => void
  removeListener: (listener: T) => void
  hasListener: (listener: T) => boolean
  emit: (...args: Parameters<T>) => void
}

function getChrome(): any {
  return (globalThis as unknown as { chrome?: any }).chrome
}

function createEventEmitter<T extends (...args: any[]) => any>(): EventEmitter<T> {
  const listeners = new Set<T>()
  return {
    addListener(listener: T) {
      if (typeof listener === 'function') listeners.add(listener)
    },
    removeListener(listener: T) {
      listeners.delete(listener)
    },
    hasListener(listener: T) {
      return listeners.has(listener)
    },
    emit(...args: Parameters<T>) {
      for (const fn of Array.from(listeners)) {
        try {
          fn(...args)
        } catch {
          // Isolate listener failures
        }
      }
    },
  }
}

function wrapChromeEvent<T extends (...args: any[]) => any>(chromeEvent: any): browser.EventTarget<T> {
  if (chromeEvent && typeof chromeEvent.addListener === 'function') {
    return {
      addListener(listener: T) {
        chromeEvent.addListener(listener)
      },
      removeListener(listener: T) {
        chromeEvent.removeListener(listener)
      },
      hasListener(listener: T) {
        return typeof chromeEvent.hasListener === 'function' ? chromeEvent.hasListener(listener) : false
      },
    }
  }
  return createEventEmitter<T>()
}

/**
 * Install minimal safe globals when running inside a Chrome MV3 Service Worker
 * where DOM `window` and `document` do not exist.
 */
function ensureServiceWorkerEnv(): void {
  const g = globalThis as Record<string, any>
  if (typeof g.window === 'undefined') {
    g.window = globalThis
  }
  if (typeof g.window.matchMedia !== 'function') {
    g.window.matchMedia = (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })
  }
  if (typeof g.document === 'undefined') {
    g.document = {
      getElementById: () => null,
    }
  }
}

// Lazy TabTreeAnchor loader (avoids static circular dependency with defaults/utils)
let anchorPromise: Promise<AnchorModuleLike | null> | null = null
function getAnchorModule(): Promise<AnchorModuleLike | null> {
  if (!anchorPromise) {
    anchorPromise = import('src/services/tab-tree-anchor')
      .then(m => m as unknown as AnchorModuleLike)
      .catch(() => null)
  }
  return anchorPromise
}

// ============================================================================
// Bookmarks ID & Node Type Translation (Firefox <-> Chrome)
// ============================================================================

const FF_TO_CHROME_BKM_ID: Record<string, string> = {
  root________: '0',
  toolbar_____: '1',
  unfiled_____: '2',
  menu________: '2',
  mobile______: '3',
}

const CHROME_TO_FF_BKM_ID: Record<string, string> = {
  '0': 'root________',
  '1': 'toolbar_____',
  '2': 'unfiled_____',
  '3': 'mobile______',
}

function toChromeBookmarkId(id: ID): string {
  const s = String(id)
  return FF_TO_CHROME_BKM_ID[s] ?? s
}

function toFirefoxBookmarkId(id: ID): string {
  const s = String(id)
  return CHROME_TO_FF_BKM_ID[s] ?? s
}

function normalizeBookmarkNode(raw: any): browser.bookmarks.TreeNode {
  const nodeType: browser.bookmarks.TreeNodeType =
    raw.type ?? (raw.url !== undefined ? 'bookmark' : 'folder')
  const normalized: browser.bookmarks.TreeNode = {
    ...raw,
    id: toFirefoxBookmarkId(raw.id),
    parentId: raw.parentId !== undefined ? toFirefoxBookmarkId(raw.parentId) : undefined,
    title: raw.title ?? '',
    type: nodeType,
  }
  if (Array.isArray(raw.children)) {
    normalized.children = raw.children.map(normalizeBookmarkNode)
  }
  return normalized
}

// ============================================================================
// Public Suffix Fallback
// ============================================================================

const MULTI_PART_PUBLIC_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'plc.uk', 'ltd.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'ad.jp', 'ed.jp', 'go.jp', 'gr.jp', 'lg.jp',
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'pe.kr', 'go.kr', 'ac.kr',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw', 'idv.tw',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'net.mx', 'org.mx', 'edu.mx', 'gob.mx',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz',
  'co.za', 'org.za', 'net.za', 'gov.za', 'ac.za',
  'co.in', 'net.in', 'org.in', 'gov.in', 'ac.in', 'res.in', 'gen.in', 'firm.in',
  'co.id', 'or.id', 'web.id', 'ac.id', 'go.id',
  'com.tr', 'net.tr', 'org.tr', 'gen.tr', 'gov.tr', 'edu.tr',
  'com.ar', 'net.ar', 'org.ar', 'gob.ar', 'gov.ar',
  'com.ua', 'org.ua', 'net.ua', 'in.ua', 'kiev.ua',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il',
  'com.pl', 'net.pl', 'org.pl', 'waw.pl',
  'eu.org', 'github.io', 'gitlab.io', 'pages.dev', 'vercel.app', 'netlify.app',
  'herokuapp.com', 'blogspot.com', 'wordpress.com',
])

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

function computeKnownSuffix(hostname: string): string | null {
  if (!hostname) return null
  const clean = hostname.toLowerCase().replace(/\.+$/, '')
  if (!clean || clean === 'localhost' || IPV4_RE.test(clean) || clean.includes(':')) return null
  const parts = clean.split('.').filter(Boolean)
  if (parts.length < 2) return null
  const lastTwo = `${parts[parts.length - 2]}.${parts[parts.length - 1]}`
  if (MULTI_PART_PUBLIC_SUFFIXES.has(lastTwo)) return lastTwo
  return parts[parts.length - 1]
}

function computePublicDomain(
  hostname: string,
  options?: browser.publicSuffix.GetDomainOptions
): string | null {
  if (!hostname) return null
  const clean = hostname.toLowerCase().replace(/\.+$/, '')
  if (!clean) return null
  if (IPV4_RE.test(clean) || clean.includes(':')) {
    return options?.allowIPAddress ? clean : null
  }
  const parts = clean.split('.').filter(Boolean)
  if (parts.length < 2) return options?.allowPlainSuffix ? clean : null
  const suffix = computeKnownSuffix(clean)
  if (!suffix) return options?.allowUnknownSuffix ? clean : null
  const suffixPartsLen = suffix.split('.').length
  if (parts.length <= suffixPartsLen) return null
  return parts.slice(parts.length - suffixPartsLen - 1).join('.')
}

// ============================================================================
// Virtual Storage Fallbacks
// ============================================================================

const SESSION_VALUE_PREFIX = '__sidebery_session_val__'
const COMMAND_OVERRIDES_KEY = '__sidebery_command_overrides__'
const VIRTUAL_GRANTED_PERMS = new Set([
  'tabhide',
  'webrequestblocking',
  'contextualidentities',
  'menus.overridecontext',
  'menus',
  'theme',
  'publicsuffix',
])

function createInMemoryStorageArea(): browser.storage.StorageArea {
  const store = new Map<string, any>()
  return {
    async get<S>(props?: keyof S | (keyof S)[] | S | string): Promise<S> {
      const out: Record<string, any> = {}
      if (props === undefined || props === null) {
        for (const [k, v] of store.entries()) out[k] = v
      } else if (typeof props === 'string') {
        if (store.has(props)) out[props] = store.get(props)
      } else if (Array.isArray(props)) {
        for (const k of props) {
          const key = String(k)
          if (store.has(key)) out[key] = store.get(key)
        }
      } else if (typeof props === 'object') {
        for (const [k, def] of Object.entries(props as Record<string, any>)) {
          out[k] = store.has(k) ? store.get(k) : def
        }
      }
      return out as S
    },
    async set<S>(props: { [key in keyof S]: S[key] }): Promise<void> {
      for (const [k, v] of Object.entries(props as Record<string, any>)) {
        store.set(k, v)
      }
    },
    async remove<S>(props: keyof S | (keyof S)[]): Promise<void> {
      const keys = Array.isArray(props) ? props : [props]
      for (const k of keys) store.delete(String(k))
    },
    async clear(): Promise<void> {
      store.clear()
    },
  }
}

function wrapStorageArea(area: any, swallowErrors = false): browser.storage.StorageArea {
  if (!area) return createInMemoryStorageArea()
  return {
    async get<S>(props?: keyof S | (keyof S)[] | S | string): Promise<S> {
      try {
        return (await area.get(props)) as S
      } catch (err) {
        if (swallowErrors) return {} as S
        throw err
      }
    },
    async set<S>(props: { [key in keyof S]: S[key] }): Promise<void> {
      await area.set(props)
    },
    async remove<S>(props: keyof S | (keyof S)[]): Promise<void> {
      await area.remove(props)
    },
    async clear(): Promise<void> {
      await area.clear()
    },
  }
}

// ============================================================================
// Namespace Builders
// ============================================================================

function buildPolyfillNamespaces() {
  const chromeApi = getChrome()
  const WINDOW_ID_NONE: number = chromeApi?.windows?.WINDOW_ID_NONE ?? -1
  const WINDOW_ID_CURRENT: number = chromeApi?.windows?.WINDOW_ID_CURRENT ?? -2
  const TAB_ID_NONE: number = chromeApi?.tabs?.TAB_ID_NONE ?? -1

  function enrichTab(raw: any): browser.tabs.Tab {
    const id: ID = raw?.id ?? TAB_ID_NONE
    const incognito = Boolean(raw?.incognito)
    return {
      ...raw,
      id,
      index: raw?.index ?? 0,
      windowId: raw?.windowId ?? WINDOW_ID_NONE,
      active: Boolean(raw?.active),
      highlighted: Boolean(raw?.highlighted),
      pinned: Boolean(raw?.pinned),
      incognito,
      url: raw?.url || raw?.pendingUrl || '',
      title: raw?.title ?? '',
      hidden: PanelIsolation.isTabHidden(id),
      cookieStoreId:
        raw?.cookieStoreId || ContainerBridge.getCachedTabCookieStoreId(id, incognito),
      isInReaderMode: Boolean(raw?.isInReaderMode),
      lastAccessed: raw?.lastAccessed ?? Date.now(),
    }
  }

  async function resolveCurrentWindowId(): Promise<number | undefined> {
    if (!chromeApi?.windows) return undefined
    try {
      const win = await chromeApi.windows.getCurrent({ populate: false })
      if (win?.id !== undefined && win.id >= 0) return win.id
    } catch {
      // Service worker has no current window
    }
    try {
      const win = await chromeApi.windows.getLastFocused({
        populate: false,
        windowTypes: ['normal'],
      })
      if (win?.id !== undefined && win.id >= 0) return win.id
    } catch {
      // Fallback
    }
    return undefined
  }

  function enrichWindow(raw: any): browser.windows.Window {
    if (!raw) return raw
    return {
      ...raw,
      tabs: Array.isArray(raw.tabs) ? raw.tabs.map(enrichTab) : raw.tabs,
    }
  }

  // --- runtime ---
  const runtime = {
    getURL(resource: string): string {
      if (chromeApi?.runtime?.getURL) return chromeApi.runtime.getURL(resource)
      return resource.startsWith('/') ? `chrome-extension://sidebery${resource}` : `chrome-extension://sidebery/${resource}`
    },
    getManifest(): browser.Manifest {
      if (chromeApi?.runtime?.getManifest) return chromeApi.runtime.getManifest()
      return { version: '5.6.1' }
    },
    connect(connectInfo?: browser.runtime.ConnectInfo): browser.runtime.Port {
      return chromeApi.runtime.connect(connectInfo)
    },
    async sendMessage<T, R>(msg: T): Promise<R> {
      return chromeApi.runtime.sendMessage(msg)
    },
    openOptionsPage(): void {
      chromeApi?.runtime?.openOptionsPage?.()
    },
    reload(): void {
      chromeApi?.runtime?.reload?.()
    },
    async getPlatformInfo(): Promise<browser.runtime.PlatformInfo> {
      if (chromeApi?.runtime?.getPlatformInfo) return chromeApi.runtime.getPlatformInfo()
      return { os: 'linux', arch: 'x86-64' }
    },
    async getBrowserInfo(): Promise<browser.runtime.BrowserInfo> {
      const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
      const version = /Chrome\/([\d.]+)/.exec(ua)?.[1] ?? '120.0.0.0'
      return { name: 'Chrome', vendor: 'Google', version, buildID: '' }
    },
    onMessage: wrapChromeEvent(chromeApi?.runtime?.onMessage),
    onConnect: wrapChromeEvent(chromeApi?.runtime?.onConnect),
    onUpdateAvailable: wrapChromeEvent<browser.runtime.UpdateAvailableListener>(
      chromeApi?.runtime?.onUpdateAvailable
    ),
  }

  // --- storage ---
  const storage = {
    local: wrapStorageArea(chromeApi?.storage?.local),
    sync: wrapStorageArea(chromeApi?.storage?.sync),
    session: wrapStorageArea(chromeApi?.storage?.session, true),
    managed: wrapStorageArea(chromeApi?.storage?.managed, true),
    onChanged: wrapChromeEvent<browser.storage.ChangeListener>(chromeApi?.storage?.onChanged),
  }

  // --- extension ---
  const extension = {
    inIncognitoContext: Boolean(chromeApi?.extension?.inIncognitoContext),
  }

  // --- tabs ---
  const tabUpdatedMap = new Map<browser.tabs.UpdatedListener, { wrapped: any; extra?: browser.tabs.ExtraParameters }>()
  const tabUpdatedSyntheticSet = new Map<browser.tabs.UpdatedListener, browser.tabs.ExtraParameters | undefined>()

  PanelIsolation.onHiddenStateChanged(async changes => {
    if (!tabUpdatedSyntheticSet.size) return
    const resolved = await Promise.all(
      changes.map(async ({ tabId, hidden }) => {
        let tabObj: browser.tabs.Tab | undefined
        if (chromeApi?.tabs?.get) {
          try {
            const raw = await chromeApi.tabs.get(Number(tabId))
            if (raw) tabObj = enrichTab(raw)
          } catch {
            tabObj = undefined
          }
        }
        if (!tabObj) {
          tabObj = enrichTab({ id: tabId, hidden })
        } else {
          tabObj.hidden = hidden
        }
        return { tabId, hidden, tabObj }
      })
    )
    for (const { tabId, hidden, tabObj } of resolved) {
      for (const [listener, extra] of tabUpdatedSyntheticSet.entries()) {
        if (extra?.properties && !extra.properties.includes('hidden')) continue
        if (extra?.tabId !== undefined && extra.tabId !== tabId) continue
        if (extra?.windowId !== undefined && extra.windowId !== tabObj.windowId) continue
        try {
          listener(tabId, { hidden }, tabObj)
        } catch {
          // Isolate listener errors
        }
      }
    }
  })

  const tabsOnCreatedRaw = chromeApi?.tabs?.onCreated
  async function waitForTabUrlCommit(
    tabId: number,
    targetUrl: string,
    timeoutMs = 3000
  ): Promise<boolean> {
    if (!chromeApi?.tabs?.get) return false
    try {
      const current = await chromeApi.tabs.get(tabId)
      if (current?.url && current.url !== 'about:blank') {
        return true
      }
    } catch {
      return false
    }
    if (!chromeApi?.tabs?.onUpdated?.addListener) return false

    return new Promise<boolean>(resolve => {
      let settled = false
      const finish = (ok: boolean) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        try {
          chromeApi.tabs.onUpdated.removeListener(onUpd)
        } catch {
          // ignore
        }
        resolve(ok)
      }
      const onUpd = (id: number, changeInfo: any, tab: any) => {
        if (id !== tabId) return
        const u = changeInfo?.url || tab?.url
        if (u && u !== 'about:blank') {
          finish(true)
        } else if (changeInfo?.status === 'complete' && targetUrl === 'about:blank') {
          finish(true)
        }
      }
      const timer = setTimeout(async () => {
        try {
          const latest = await chromeApi.tabs.get(tabId)
          finish(Boolean(latest?.url && latest.url !== 'about:blank'))
        } catch {
          finish(false)
        }
      }, timeoutMs)

      chromeApi.tabs.onUpdated.addListener(onUpd)
      chromeApi.tabs
        .get(tabId)
        .then((t: any) => {
          if (t?.url && t.url !== 'about:blank') finish(true)
        })
        .catch(() => finish(false))
    })
  }

  const VIVALDI_FLAG_KEY = '__sidebery_is_vivaldi__'
  let cachedIsVivaldi =
    typeof navigator !== 'undefined' && /Vivaldi/i.test(navigator.userAgent)
  let vivaldiDetectionDone = cachedIsVivaldi

  if (!cachedIsVivaldi && chromeApi?.storage?.local?.get) {
    Promise.resolve(chromeApi.storage.local.get(VIVALDI_FLAG_KEY))
      .then((res: any) => {
        if (res?.[VIVALDI_FLAG_KEY]) {
          cachedIsVivaldi = true
          vivaldiDetectionDone = true
        }
      })
      .catch(() => {})
  }

  function markVivaldiDetected(): void {
    vivaldiDetectionDone = true
    if (cachedIsVivaldi) return
    cachedIsVivaldi = true
    chromeApi?.storage?.local?.set?.({ [VIVALDI_FLAG_KEY]: true })?.catch?.(() => {})
  }

  async function isVivaldiBrowser(): Promise<boolean> {
    if (vivaldiDetectionDone) return cachedIsVivaldi
    try {
      if (chromeApi?.storage?.local?.get) {
        const stored = await chromeApi.storage.local.get(VIVALDI_FLAG_KEY).catch(() => undefined)
        if (stored?.[VIVALDI_FLAG_KEY]) {
          cachedIsVivaldi = true
          vivaldiDetectionDone = true
          return true
        }
      }
      if (chromeApi?.tabs?.query) {
        const tabs: any[] = (await chromeApi.tabs.query({})) ?? []
        if (
          tabs.some(
            t =>
              t &&
              ('vivExtData' in t ||
                (typeof t.url === 'string' &&
                  (t.url.startsWith('chrome://vivaldi-webui/') || t.url.startsWith('vivaldi://'))) ||
                (typeof t.favIconUrl === 'string' && t.favIconUrl.includes('vivaldi-webui')))
          )
        ) {
          markVivaldiDetected()
          return true
        }
      }
      if (chromeApi?.windows?.getAll) {
        const wins: any[] = (await chromeApi.windows.getAll({})) ?? []
        if (wins.some(w => w && 'vivExtData' in w)) {
          markVivaldiDetected()
          return true
        }
      }
    } catch {
      // ignore
    }
    vivaldiDetectionDone = true
    return false
  }

  const tabsCreatedListeners = new Map<browser.tabs.CreatedListener, any>()

  const tabs = {
    TAB_ID_NONE,
    SPLIT_VIEW_ID_NONE: -1,

    async query(options: browser.tabs.TabsQueryOptions & { hidden?: boolean; cookieStoreId?: string }): Promise<browser.tabs.Tab[]> {
      const { hidden, cookieStoreId, ...rest } = options ?? {}
      const cleanOpts: Record<string, any> = { ...rest }
      if (cleanOpts.windowId === WINDOW_ID_CURRENT) {
        const resolved = await resolveCurrentWindowId()
        if (resolved !== undefined) cleanOpts.windowId = resolved
        else delete cleanOpts.windowId
      }
      const rawTabs: any[] = (await chromeApi.tabs.query(cleanOpts)) ?? []
      let result = rawTabs.map(enrichTab)
      if (hidden !== undefined) result = result.filter(t => t.hidden === hidden)
      if (cookieStoreId !== undefined) result = result.filter(t => t.cookieStoreId === cookieStoreId)
      return result
    },

    async get(tabId: ID): Promise<browser.tabs.Tab> {
      const raw = await chromeApi.tabs.get(Number(tabId))
      return enrichTab(raw)
    },

    async getCurrent(): Promise<browser.tabs.Tab> {
      const raw = await chromeApi.tabs.getCurrent()
      return raw ? enrichTab(raw) : (undefined as unknown as browser.tabs.Tab)
    },

    async create(createProperties: browser.tabs.CreateProperties): Promise<browser.tabs.Tab> {
      const { cookieStoreId, discarded, title: _title, openInReaderMode: _reader, ...rest } =
        createProperties ?? {}
      const cleanProps: Record<string, any> = { ...rest }

      if (cleanProps.url === undefined) {
        cleanProps.url = (await isVivaldiBrowser())
          ? 'chrome://vivaldi-webui/startpage?section=Speed-dials'
          : 'chrome://newtab'
      }

      if (cleanProps.windowId === WINDOW_ID_CURRENT) {
        const resolved = await resolveCurrentWindowId()
        if (resolved !== undefined) cleanProps.windowId = resolved
        else delete cleanProps.windowId
      }

      let raw = await chromeApi.tabs.create(cleanProps)
      if (raw?.id !== undefined) {
        if (cookieStoreId) {
          await ContainerBridge.setTabCookieStoreId(raw.id, cookieStoreId)
        }
        const targetUrl = typeof cleanProps.url === 'string' ? cleanProps.url : ''
        if (
          discarded &&
          !cleanProps.active &&
          !cleanProps.pinned &&
          targetUrl &&
          !targetUrl.startsWith('chrome://')
        ) {
          const committed = await waitForTabUrlCommit(raw.id, targetUrl)
          if (committed) {
            const discardedTab = await chromeApi.tabs.discard(raw.id).catch(() => undefined)
            if (discardedTab?.id !== undefined) {
              if (cookieStoreId && discardedTab.id !== raw.id) {
                await ContainerBridge.setTabCookieStoreId(discardedTab.id, cookieStoreId)
              }
              raw = discardedTab
            }
          }
        }
      }
      const enriched = enrichTab(raw)
      if (cookieStoreId) enriched.cookieStoreId = cookieStoreId
      return enriched
    },

    async update(
      tabIdOrProps: ID | browser.tabs.UpdateProperties,
      maybeProps?: browser.tabs.UpdateProperties
    ): Promise<browser.tabs.Tab> {
      let tabId: number | undefined
      let props: browser.tabs.UpdateProperties
      if (typeof tabIdOrProps === 'object' && tabIdOrProps !== null) {
        props = tabIdOrProps
      } else {
        tabId = Number(tabIdOrProps)
        props = maybeProps ?? {}
      }
      const { loadReplace: _lr, successorTabId: _st, ...cleanProps } = props as Record<string, any>
      if (
        cleanProps.openerTabId !== undefined &&
        (Number(cleanProps.openerTabId) === -1 ||
          (tabId !== undefined && Number(cleanProps.openerTabId) === tabId))
      ) {
        delete cleanProps.openerTabId
      }
      if (tabId !== undefined && Object.keys(cleanProps).length === 0) {
        const current = await chromeApi.tabs.get(tabId).catch(() => ({ id: tabId }))
        return enrichTab(current)
      }
      const raw =
        tabId !== undefined
          ? await chromeApi.tabs.update(tabId, cleanProps)
          : await chromeApi.tabs.update(cleanProps)
      return enrichTab(raw)
    },

    async remove(tabIds: ID | ID[]): Promise<void> {
      const ids = Array.isArray(tabIds) ? tabIds.map(Number) : Number(tabIds)
      await chromeApi.tabs.remove(ids)
    },

    async move<T extends ID[] | ID>(
      tabIds: T,
      moveProps: browser.tabs.MoveProps
    ): Promise<browser.tabs.Moved<T>> {
      const ids = Array.isArray(tabIds) ? tabIds.map(Number) : Number(tabIds)
      const props: Record<string, any> = { ...moveProps }
      if (props.windowId === WINDOW_ID_CURRENT) {
        const resolved = await resolveCurrentWindowId()
        if (resolved !== undefined) props.windowId = resolved
        else delete props.windowId
      }
      const moved = await ContainerBridge.withTabEditRetry(() => chromeApi.tabs.move(ids, props))
      if (Array.isArray(moved)) return moved.map(enrichTab) as browser.tabs.Moved<T>
      return enrichTab(moved) as browser.tabs.Moved<T>
    },

    async discard(tabIds: ID | ID[]): Promise<void> {
      const ids = (Array.isArray(tabIds) ? tabIds : [tabIds]).map(Number).filter(n => !Number.isNaN(n))
      await Promise.allSettled(ids.map(id => chromeApi.tabs.discard(id)))
    },

    async reload(tabId: ID, reloadProps?: browser.tabs.ReloadProps): Promise<void> {
      await chromeApi.tabs.reload(Number(tabId), reloadProps)
    },

    async duplicate(tabId: ID, opts?: browser.tabs.DuplOpts): Promise<browser.tabs.Tab> {
      const dup = await chromeApi.tabs.duplicate(Number(tabId))
      if (dup?.id !== undefined) {
        if (opts?.index !== undefined) {
          await ContainerBridge.withTabEditRetry(() =>
            chromeApi.tabs.move(dup.id, { index: opts.index })
          ).catch(() => undefined)
        }
        if (opts?.active !== undefined) {
          await chromeApi.tabs.update(dup.id, { active: opts.active }).catch(() => undefined)
        }
      }
      return enrichTab(dup)
    },

    async highlight(highlightInfo: browser.tabs.HighlightInfo): Promise<browser.windows.Window> {
      const { populate: _populate, ...cleanInfo } = highlightInfo
      const win = await chromeApi.tabs.highlight(cleanInfo)
      return enrichWindow(win)
    },

    async captureTab(tabId: ID, imageDetails?: browser.ImageDetails): Promise<string> {
      if (!chromeApi?.tabs?.captureVisibleTab) return ''
      try {
        const tab = await chromeApi.tabs.get(Number(tabId))
        if (!tab || !tab.active) return ''
        const opts: Record<string, any> = {
          format: imageDetails?.format ?? 'jpeg',
        }
        if (opts.format === 'jpeg' && imageDetails?.quality !== undefined) {
          opts.quality = imageDetails.quality
        }
        return (await chromeApi.tabs.captureVisibleTab(tab.windowId, opts)) ?? ''
      } catch {
        return ''
      }
    },

    async executeScript(tabId: ID, opts: browser.tabs.ExecuteOpts): Promise<any[]> {
      if (!chromeApi?.scripting?.executeScript) return []
      const target: Record<string, any> = {
        tabId: Number(tabId),
        allFrames: Boolean(opts.allFrames),
      }
      if (opts.frameId !== undefined && !opts.allFrames) {
        target.frameIds = [opts.frameId]
      }
      const injectImmediately = opts.runAt === 'document_start'

      if (opts.file) {
        const normalizedFile = opts.file.replace(/^(\.\.\/)+|^\.\/|^\//, '')
        const results: any[] =
          (await chromeApi.scripting.executeScript({
            target,
            files: [normalizedFile],
            injectImmediately,
          })) ?? []
        return results.map(r => r?.result)
      }

      if (opts.code) {
        // Translate Sidebery's inline preview init data & force-discard snippets to CSP-safe MV3 funcs
        const previewPrefix = 'window.sideberyInitData='
        const previewSuffix = ';window.onSideberyInitDataReady?.();true;'
        if (opts.code.startsWith(previewPrefix) && opts.code.endsWith(previewSuffix)) {
          const initDataJson = opts.code.slice(previewPrefix.length, -previewSuffix.length)
          const results: any[] =
            (await chromeApi.scripting.executeScript({
              target,
              func: (jsonStr: string) => {
                ;(window as any).sideberyInitData = JSON.parse(jsonStr)
                ;(window as any).onSideberyInitDataReady?.()
                return true
              },
              args: [initDataJson],
              injectImmediately,
            })) ?? []
          return results.map(r => r?.result)
        }

        if (opts.code.includes('beforeunload')) {
          const results: any[] =
            (await chromeApi.scripting.executeScript({
              target,
              func: () => {
                window.onbeforeunload = null
                window.addEventListener('beforeunload', e => {
                  e.returnValue = ''
                })
              },
              injectImmediately,
            })) ?? []
          return results.map(r => r?.result)
        }
      }

      return []
    },

    async hide(tabIds: ID | ID[]): Promise<void> {
      await PanelIsolation.hideTabs(tabIds)
    },

    async show(tabIds: ID | ID[]): Promise<void> {
      await PanelIsolation.showTabs(tabIds)
    },

    async moveInSuccession(_tabIds: ID[], _tabId?: ID): Promise<void> {
      // Chrome manages tab opener/succession natively; no-op
    },

    async warmup(_tabId: ID): Promise<void> {
      // No Chrome equivalent; no-op
    },

    async group(options: browser.tabs.GroupOpts): Promise<void> {
      if (!chromeApi?.tabs?.group) return
      const tabIds = Array.isArray(options.tabIds)
        ? options.tabIds.map(Number)
        : Number(options.tabIds)
      await ContainerBridge.withTabEditRetry(() => chromeApi.tabs.group({ ...options, tabIds }))
    },

    async ungroup(tabIds: ID | ID[]): Promise<void> {
      if (!chromeApi?.tabs?.ungroup) return
      const ids = Array.isArray(tabIds) ? tabIds.map(Number) : Number(tabIds)
      await ContainerBridge.withTabEditRetry(() => chromeApi.tabs.ungroup(ids))
    },

    async sendMessage(tabId: ID, msg: any): Promise<any> {
      return chromeApi.tabs.sendMessage(Number(tabId), msg)
    },

    async saveAsPDF(_pageSettings: browser.tabs.PageSettings): Promise<browser.tabs.SavePDFResult> {
      return 'not_saved'
    },

    onCreated: {
      addListener(listener: browser.tabs.CreatedListener) {
        if (!tabsOnCreatedRaw) return
        const wrapped = (rawTab: any) => listener(enrichTab(rawTab))
        tabsCreatedListeners.set(listener, wrapped)
        tabsOnCreatedRaw.addListener(wrapped)
      },
      removeListener(listener: browser.tabs.CreatedListener) {
        const wrapped = tabsCreatedListeners.get(listener)
        if (wrapped && tabsOnCreatedRaw) {
          tabsOnCreatedRaw.removeListener(wrapped)
          tabsCreatedListeners.delete(listener)
        }
      },
      hasListener(listener: browser.tabs.CreatedListener) {
        return tabsCreatedListeners.has(listener)
      },
    },
    onRemoved: wrapChromeEvent<browser.tabs.RemovedListener>(chromeApi?.tabs?.onRemoved),
    onUpdated: {
      addListener(listener: browser.tabs.UpdatedListener, extraParameters?: browser.tabs.ExtraParameters) {
        tabUpdatedSyntheticSet.set(listener, extraParameters)
        if (!chromeApi?.tabs?.onUpdated) return
        const wrapped = (tabId: number, changeInfo: browser.tabs.ChangeInfo, rawTab: any) => {
          if (extraParameters?.tabId !== undefined && extraParameters.tabId !== tabId) return
          if (extraParameters?.windowId !== undefined && extraParameters.windowId !== rawTab?.windowId) {
            return
          }
          if (extraParameters?.properties) {
            const matchesProp = extraParameters.properties.some(
              p => (changeInfo as Record<string, any>)[p] !== undefined
            )
            if (!matchesProp) return
          }
          listener(tabId, changeInfo, enrichTab(rawTab))
        }
        tabUpdatedMap.set(listener, { wrapped, extra: extraParameters })
        chromeApi.tabs.onUpdated.addListener(wrapped)
      },
      removeListener(listener: browser.tabs.UpdatedListener) {
        tabUpdatedSyntheticSet.delete(listener)
        const entry = tabUpdatedMap.get(listener)
        if (entry && chromeApi?.tabs?.onUpdated) {
          chromeApi.tabs.onUpdated.removeListener(entry.wrapped)
          tabUpdatedMap.delete(listener)
        }
      },
      hasListener(listener: browser.tabs.UpdatedListener) {
        return tabUpdatedMap.has(listener) || tabUpdatedSyntheticSet.has(listener)
      },
    },
    onActivated: wrapChromeEvent<browser.tabs.ActivatedListener>(chromeApi?.tabs?.onActivated),
    onMoved: wrapChromeEvent<browser.tabs.MovedListener>(chromeApi?.tabs?.onMoved),
    onAttached: wrapChromeEvent<browser.tabs.AttachedListener>(chromeApi?.tabs?.onAttached),
    onDetached: wrapChromeEvent<browser.tabs.DetachListener>(chromeApi?.tabs?.onDetached),
    onReplaced: wrapChromeEvent<browser.tabs.ReplacedListener>(chromeApi?.tabs?.onReplaced),
  }

  // --- windows ---
  const winCreatedListeners = new Map<browser.windows.createdListener, any>()

  const windows = {
    WINDOW_ID_NONE,
    WINDOW_ID_CURRENT,

    async get(windowId: ID, getInfo?: browser.windows.GetInfo): Promise<browser.windows.Window> {
      const id =
        windowId === WINDOW_ID_CURRENT
          ? (await resolveCurrentWindowId()) ?? Number(windowId)
          : Number(windowId)
      const win = await chromeApi.windows.get(id, getInfo)
      return enrichWindow(win)
    },

    async getCurrent(getInfo?: browser.windows.GetInfo): Promise<browser.windows.Window> {
      try {
        const win = await chromeApi.windows.getCurrent(getInfo)
        if (win?.id !== undefined) return enrichWindow(win)
      } catch {
        // Fallback when called from Service Worker or Vivaldi Web Panel startup
      }
      try {
        const fallback = await chromeApi.windows.getLastFocused(getInfo)
        if (fallback?.id !== undefined) return enrichWindow(fallback)
      } catch {
        // Fallback to first normal window
      }
      const all: any[] =
        (await chromeApi.windows.getAll({ windowTypes: ['normal'], ...getInfo }).catch(() => [])) ??
        []
      return enrichWindow(all[0])
    },

    async getLastFocused(getInfo?: browser.windows.GetInfo): Promise<browser.windows.Window> {
      const win = await chromeApi.windows.getLastFocused(getInfo)
      return enrichWindow(win)
    },

    async getAll(getInfo?: browser.windows.GetInfo): Promise<browser.windows.Window[]> {
      const wins: any[] = (await chromeApi.windows.getAll(getInfo)) ?? []
      return wins.map(enrichWindow)
    },

    async create(createData: browser.windows.CreateData): Promise<browser.windows.Window> {
      const {
        titlePreface: _tp,
        cookieStoreId: _cs,
        allowScriptsToClose: _asc,
        ...rest
      } = createData ?? {}
      const cleanData: Record<string, any> = { ...rest }
      if (cleanData.type === 'detached_panel') cleanData.type = 'popup'
      if (cleanData.state === 'minimized' && cleanData.focused === undefined) {
        cleanData.focused = false
      }
      const win = await chromeApi.windows.create(cleanData)
      return enrichWindow(win)
    },

    async update(
      windowId: ID,
      updateInfo: browser.windows.UpdateInfo
    ): Promise<browser.windows.Window> {
      const { titlePreface: _tp, ...cleanInfo } = updateInfo ?? {}
      const id =
        windowId === WINDOW_ID_CURRENT
          ? (await resolveCurrentWindowId()) ?? Number(windowId)
          : Number(windowId)
      if (Object.keys(cleanInfo).length === 0) {
        try {
          const existing = await chromeApi.windows.get(id)
          return enrichWindow(existing)
        } catch {
          return { id, alwaysOnTop: false, focused: false, incognito: false }
        }
      }
      const win = await chromeApi.windows.update(id, cleanInfo)
      return enrichWindow(win)
    },

    async remove(windowId: ID): Promise<void> {
      await chromeApi.windows.remove(Number(windowId))
    },

    onCreated: {
      addListener(listener: browser.windows.createdListener) {
        if (!chromeApi?.windows?.onCreated) return
        const wrapped = (rawWin: any) => listener(enrichWindow(rawWin))
        winCreatedListeners.set(listener, wrapped)
        chromeApi.windows.onCreated.addListener(wrapped)
      },
      removeListener(listener: browser.windows.createdListener) {
        const wrapped = winCreatedListeners.get(listener)
        if (wrapped && chromeApi?.windows?.onCreated) {
          chromeApi.windows.onCreated.removeListener(wrapped)
          winCreatedListeners.delete(listener)
        }
      },
      hasListener(listener: browser.windows.createdListener) {
        return winCreatedListeners.has(listener)
      },
    },
    onRemoved: wrapChromeEvent<browser.windows.removedListener>(chromeApi?.windows?.onRemoved),
    onFocusChanged: wrapChromeEvent<browser.windows.focusChangeListener>(
      chromeApi?.windows?.onFocusChanged
    ),
  }

  // --- sessions ---
  async function resolveSessionWindowId(windowId: ID): Promise<ID> {
    if (windowId === WINDOW_ID_CURRENT || Number(windowId) < 0) {
      const resolved = await resolveCurrentWindowId()
      if (resolved !== undefined) return resolved
    }
    return windowId
  }

  const sessions = {
    async getRecentlyClosed(
      filter?: browser.sessions.Filter
    ): Promise<browser.sessions.Session[]> {
      if (!chromeApi?.sessions?.getRecentlyClosed) return []
      const list: any[] = (await chromeApi.sessions.getRecentlyClosed(filter)) ?? []
      return list.map(s => ({
        ...s,
        tab: s.tab ? enrichTab(s.tab) : undefined,
        window: s.window ? enrichWindow(s.window) : undefined,
      }))
    },
    async restore(sessionId?: string): Promise<browser.sessions.Session> {
      const s = await chromeApi.sessions.restore(sessionId)
      return {
        ...s,
        tab: s?.tab ? enrichTab(s.tab) : undefined,
        window: s?.window ? enrichWindow(s.window) : undefined,
      }
    },
    async setTabValue<T>(tabId: ID, key: string, value: T): Promise<void> {
      const anchor = await getAnchorModule()
      if (anchor?.setTabValue) {
        await anchor.setTabValue(tabId, key, value)
        return
      }
      await storage.session.set({ [`${SESSION_VALUE_PREFIX}tab:${tabId}:${key}`]: value })
    },
    async getTabValue<T>(tabId: ID, key: string): Promise<T | undefined> {
      const anchor = await getAnchorModule()
      if (anchor?.getTabValue) {
        return anchor.getTabValue<T>(tabId, key)
      }
      const k = `${SESSION_VALUE_PREFIX}tab:${tabId}:${key}`
      const res = await storage.session.get<Record<string, T>>(k)
      return res?.[k]
    },
    async setWindowValue<T>(windowId: ID, key: string, value: T): Promise<void> {
      const resolvedWinId = await resolveSessionWindowId(windowId)
      const anchor = await getAnchorModule()
      if (anchor?.setWindowValue) {
        await anchor.setWindowValue(resolvedWinId, key, value)
        return
      }
      await storage.session.set({
        [`${SESSION_VALUE_PREFIX}win:${resolvedWinId}:${key}`]: value,
      })
    },
    async getWindowValue<T>(windowId: ID, key: string): Promise<T | undefined> {
      const resolvedWinId = await resolveSessionWindowId(windowId)
      const anchor = await getAnchorModule()
      if (anchor?.getWindowValue) {
        return anchor.getWindowValue<T>(resolvedWinId, key)
      }
      const k = `${SESSION_VALUE_PREFIX}win:${resolvedWinId}:${key}`
      const res = await storage.session.get<Record<string, T>>(k)
      return res?.[k]
    },
    async forgetClosedWindow(_sessionId: string): Promise<void> {},
    async forgetClosedTab(_windowId: number, _sessionId: string): Promise<void> {},
    onChanged: wrapChromeEvent<browser.sessions.SessionChangeListener>(chromeApi?.sessions?.onChanged),
  }

  // --- contextualIdentities ---
  const contextualIdentities = {
    query: ContainerBridge.query,
    get: ContainerBridge.get,
    create: ContainerBridge.create,
    update: ContainerBridge.update,
    remove: ContainerBridge.remove,
    getSupportedColors: ContainerBridge.getSupportedColors,
    getSupportedIcons: ContainerBridge.getSupportedIcons,
    onCreated: ContainerBridge.onCreated,
    onRemoved: ContainerBridge.onRemoved,
    onUpdated: ContainerBridge.onUpdated,
  }

  // --- bookmarks ---
  const bkmCreatedListeners = new Map<browser.bookmarks.CreateListener, any>()
  const bkmChangedListeners = new Map<browser.bookmarks.ChangeListener, any>()
  const bkmMovedListeners = new Map<browser.bookmarks.MoveListener, any>()
  const bkmRemovedListeners = new Map<browser.bookmarks.RemoveListener, any>()

  const bookmarks = {
    async create(details: browser.bookmarks.CreateDetails): Promise<browser.bookmarks.TreeNode> {
      if (details.type === 'separator') {
        return {
          id: `sep-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          parentId: details.parentId ? toFirefoxBookmarkId(details.parentId) : 'unfiled_____',
          index: details.index ?? 0,
          title: '',
          type: 'separator',
        }
      }
      const { type: _type, ...rest } = details
      const cleanDetails: Record<string, any> = { ...rest }
      if (cleanDetails.parentId !== undefined) {
        cleanDetails.parentId = toChromeBookmarkId(cleanDetails.parentId)
      }
      const created = await chromeApi.bookmarks.create(cleanDetails)
      return normalizeBookmarkNode(created)
    },
    async get(ids: ID | ID[]): Promise<browser.bookmarks.TreeNode[]> {
      const mapped = Array.isArray(ids) ? ids.map(toChromeBookmarkId) : toChromeBookmarkId(ids)
      const nodes: any[] = (await chromeApi.bookmarks.get(mapped)) ?? []
      return nodes.map(normalizeBookmarkNode)
    },
    async getTree(): Promise<browser.bookmarks.TreeNode[]> {
      const tree: any[] = (await chromeApi.bookmarks.getTree()) ?? []
      return tree.map(normalizeBookmarkNode)
    },
    async move(
      id: ID,
      destination: browser.bookmarks.MoveDestination
    ): Promise<browser.bookmarks.TreeNode> {
      const dest: Record<string, any> = { ...destination }
      if (dest.parentId !== undefined) dest.parentId = toChromeBookmarkId(dest.parentId)
      const moved = await chromeApi.bookmarks.move(toChromeBookmarkId(id), dest)
      return normalizeBookmarkNode(moved)
    },
    async remove(id: ID): Promise<void> {
      await chromeApi.bookmarks.remove(toChromeBookmarkId(id))
    },
    async removeTree(folderId: ID): Promise<void> {
      await chromeApi.bookmarks.removeTree(toChromeBookmarkId(folderId))
    },
    async update(id: ID, changes: browser.bookmarks.UpdateChanges): Promise<void> {
      await chromeApi.bookmarks.update(toChromeBookmarkId(id), changes)
    },
    onCreated: {
      addListener(listener: browser.bookmarks.CreateListener) {
        if (!chromeApi?.bookmarks?.onCreated) return
        const wrapped = (id: string, node: any) =>
          listener(toFirefoxBookmarkId(id), normalizeBookmarkNode(node))
        bkmCreatedListeners.set(listener, wrapped)
        chromeApi.bookmarks.onCreated.addListener(wrapped)
      },
      removeListener(listener: browser.bookmarks.CreateListener) {
        const wrapped = bkmCreatedListeners.get(listener)
        if (wrapped && chromeApi?.bookmarks?.onCreated) {
          chromeApi.bookmarks.onCreated.removeListener(wrapped)
          bkmCreatedListeners.delete(listener)
        }
      },
      hasListener(listener: browser.bookmarks.CreateListener) {
        return bkmCreatedListeners.has(listener)
      },
    },
    onChanged: {
      addListener(listener: browser.bookmarks.ChangeListener) {
        if (!chromeApi?.bookmarks?.onChanged) return
        const wrapped = (id: string, info: browser.bookmarks.UpdateChanges) =>
          listener(toFirefoxBookmarkId(id), info)
        bkmChangedListeners.set(listener, wrapped)
        chromeApi.bookmarks.onChanged.addListener(wrapped)
      },
      removeListener(listener: browser.bookmarks.ChangeListener) {
        const wrapped = bkmChangedListeners.get(listener)
        if (wrapped && chromeApi?.bookmarks?.onChanged) {
          chromeApi.bookmarks.onChanged.removeListener(wrapped)
          bkmChangedListeners.delete(listener)
        }
      },
      hasListener(listener: browser.bookmarks.ChangeListener) {
        return bkmChangedListeners.has(listener)
      },
    },
    onMoved: {
      addListener(listener: browser.bookmarks.MoveListener) {
        if (!chromeApi?.bookmarks?.onMoved) return
        const wrapped = (id: string, info: any) =>
          listener(toFirefoxBookmarkId(id), {
            ...info,
            parentId: toFirefoxBookmarkId(info.parentId),
            oldParentId: toFirefoxBookmarkId(info.oldParentId),
          })
        bkmMovedListeners.set(listener, wrapped)
        chromeApi.bookmarks.onMoved.addListener(wrapped)
      },
      removeListener(listener: browser.bookmarks.MoveListener) {
        const wrapped = bkmMovedListeners.get(listener)
        if (wrapped && chromeApi?.bookmarks?.onMoved) {
          chromeApi.bookmarks.onMoved.removeListener(wrapped)
          bkmMovedListeners.delete(listener)
        }
      },
      hasListener(listener: browser.bookmarks.MoveListener) {
        return bkmMovedListeners.has(listener)
      },
    },
    onRemoved: {
      addListener(listener: browser.bookmarks.RemoveListener) {
        if (!chromeApi?.bookmarks?.onRemoved) return
        const wrapped = (id: string, info: any) =>
          listener(toFirefoxBookmarkId(id), {
            ...info,
            parentId: toFirefoxBookmarkId(info.parentId),
            node: info.node ? normalizeBookmarkNode(info.node) : info.node,
          })
        bkmRemovedListeners.set(listener, wrapped)
        chromeApi.bookmarks.onRemoved.addListener(wrapped)
      },
      removeListener(listener: browser.bookmarks.RemoveListener) {
        const wrapped = bkmRemovedListeners.get(listener)
        if (wrapped && chromeApi?.bookmarks?.onRemoved) {
          chromeApi.bookmarks.onRemoved.removeListener(wrapped)
          bkmRemovedListeners.delete(listener)
        }
      },
      hasListener(listener: browser.bookmarks.RemoveListener) {
        return bkmRemovedListeners.has(listener)
      },
    },
  }

  // --- history ---
  function toEpochMs(val?: number | string | Date): number | undefined {
    if (val === undefined) return undefined
    if (typeof val === 'number') return val
    if (val instanceof Date) return val.getTime()
    const parsed = Date.parse(val)
    return Number.isNaN(parsed) ? undefined : parsed
  }

  const history = {
    async search(query: browser.history.SearchQuery): Promise<browser.history.HistoryItem[]> {
      if (!chromeApi?.history?.search) return []
      const q: Record<string, any> = { text: query.text }
      const startTime = toEpochMs(query.startTime)
      const endTime = toEpochMs(query.endTime)
      if (startTime !== undefined) q.startTime = startTime
      if (endTime !== undefined) q.endTime = endTime
      if (query.maxResults !== undefined) q.maxResults = query.maxResults
      return (await chromeApi.history.search(q)) ?? []
    },
    async getVisits(details: { url: string }): Promise<browser.history.VisitItem[]> {
      if (!chromeApi?.history?.getVisits) return []
      return (await chromeApi.history.getVisits(details)) ?? []
    },
    async deleteRange(range: browser.history.Range): Promise<void> {
      if (!chromeApi?.history?.deleteRange) return
      await chromeApi.history.deleteRange({
        startTime: toEpochMs(range.startTime) ?? 0,
        endTime: toEpochMs(range.endTime) ?? Date.now(),
      })
    },
    async deleteUrl(details: { url: string }): Promise<void> {
      if (!chromeApi?.history?.deleteUrl) return
      await chromeApi.history.deleteUrl(details)
    },
    onVisited: wrapChromeEvent<browser.history.VisitedListener>(chromeApi?.history?.onVisited),
    onVisitRemoved: wrapChromeEvent<browser.history.VisitRemovedListener>(
      chromeApi?.history?.onVisitRemoved
    ),
    onTitleChanged: wrapChromeEvent<browser.history.TitleChangedListener>(
      chromeApi?.history?.onTitleChanged
    ),
  }

  // --- downloads ---
  const downloads = {
    async search(query: browser.downloads.DownloadQuery): Promise<browser.downloads.DownloadItem[]> {
      if (!chromeApi?.downloads?.search) return []
      return (await chromeApi.downloads.search(query)) ?? []
    },
    async pause(id: number): Promise<void> {
      await chromeApi?.downloads?.pause?.(id)
    },
    async resume(id: number): Promise<void> {
      await chromeApi?.downloads?.resume?.(id)
    },
    async cancel(id: number): Promise<void> {
      await chromeApi?.downloads?.cancel?.(id)
    },
    async getFileIcon(id: number, options?: { size: number }): Promise<string> {
      if (!chromeApi?.downloads?.getFileIcon) return ''
      return (await chromeApi.downloads.getFileIcon(id, options)) ?? ''
    },
    async open(id: number): Promise<void> {
      await chromeApi?.downloads?.open?.(id)
    },
    async show(id: number): Promise<boolean> {
      if (!chromeApi?.downloads?.show) return false
      chromeApi.downloads.show(id)
      return true
    },
    async erase(query: browser.downloads.DownloadQuery): Promise<number[]> {
      if (!chromeApi?.downloads?.erase) return []
      return (await chromeApi.downloads.erase(query)) ?? []
    },
    async removeFile(id: number): Promise<void> {
      await chromeApi?.downloads?.removeFile?.(id)
    },
    showDefaultFolder(): void {
      chromeApi?.downloads?.showDefaultFolder?.()
    },
    async download(options: browser.downloads.DownloadOptions): Promise<number> {
      const { allowHttpErrors: _ahe, incognito: _inc, ...cleanOpts } = options ?? {}
      return chromeApi.downloads.download(cleanOpts)
    },
    onCreated: wrapChromeEvent<browser.downloads.CreatedListener>(chromeApi?.downloads?.onCreated),
    onErased: wrapChromeEvent<browser.downloads.ErasedListener>(chromeApi?.downloads?.onErased),
    onChanged: wrapChromeEvent<browser.downloads.ChangedListener>(chromeApi?.downloads?.onChanged),
  }

  // --- alarms ---
  const alarms = {
    create(name: string, alarmInfo: Record<string, any>): void {
      chromeApi?.alarms?.create?.(name, alarmInfo)
    },
    async get(name?: string): Promise<any> {
      return chromeApi?.alarms?.get?.(name)
    },
    async getAll(): Promise<any[]> {
      return (await chromeApi?.alarms?.getAll?.()) ?? []
    },
    async clear(name?: string): Promise<boolean> {
      return Boolean(await chromeApi?.alarms?.clear?.(name))
    },
    async clearAll(): Promise<boolean> {
      return Boolean(await chromeApi?.alarms?.clearAll?.())
    },
    onAlarm: wrapChromeEvent(chromeApi?.alarms?.onAlarm),
  }

  // --- i18n ---
  const i18n = {
    getUILanguage(): string {
      return chromeApi?.i18n?.getUILanguage?.() ?? 'en'
    },
    getMessage(msgId: string, substitutions?: string | string[]): string {
      return chromeApi?.i18n?.getMessage?.(msgId, substitutions) ?? ''
    },
  }

  // --- cookies ---
  const cookies = {
    async getAll(details: browser.cookies.GetAllDetails): Promise<browser.cookies.Cookie[]> {
      if (!chromeApi?.cookies?.getAll) return []
      const { firstPartyDomain: _fpd, ...rest } = details ?? {}
      const cleanDetails: Record<string, any> = { ...rest }
      if (typeof cleanDetails.storeId === 'string' && cleanDetails.storeId.startsWith('firefox-')) {
        delete cleanDetails.storeId
      }
      const list: any[] = (await chromeApi.cookies.getAll(cleanDetails)) ?? []
      return list.map(c => ({ ...c, firstPartyDomain: c.firstPartyDomain ?? '' }))
    },
    async remove(details: browser.cookies.RemoveDetails): Promise<browser.cookies.Cookie> {
      const { firstPartyDomain: _fpd, ...rest } = details ?? {}
      const cleanDetails: Record<string, any> = { ...rest }
      if (typeof cleanDetails.storeId === 'string' && cleanDetails.storeId.startsWith('firefox-')) {
        delete cleanDetails.storeId
      }
      return chromeApi.cookies.remove(cleanDetails)
    },
  }

  // --- identity ---
  const identity = {
    getRedirectURL(path?: string): string {
      return chromeApi?.identity?.getRedirectURL?.(path) ?? ''
    },
    async launchWebAuthFlow(details: browser.identity.LaunchWebAuthDetails): Promise<string> {
      return chromeApi.identity.launchWebAuthFlow(details)
    },
  }

  // --- omnibox ---
  const omnibox = {
    setDefaultSuggestion(suggestion: { description: string }): void {
      chromeApi?.omnibox?.setDefaultSuggestion?.(suggestion)
    },
    onInputStarted: wrapChromeEvent<browser.omnibox.InputStartedListener>(
      chromeApi?.omnibox?.onInputStarted
    ),
    onInputChanged: wrapChromeEvent<browser.omnibox.InputChangedListener>(
      chromeApi?.omnibox?.onInputChanged
    ),
    onInputEntered: wrapChromeEvent<browser.omnibox.InputEnteredListener>(
      chromeApi?.omnibox?.onInputEntered
    ),
    onInputCancelled: wrapChromeEvent<browser.omnibox.InputCancelledListener>(
      chromeApi?.omnibox?.onInputCancelled
    ),
  }

  // --- search ---
  const search = {
    search(searchProps: browser.search.SearchProps): void {
      if (!chromeApi?.search?.query) return
      const queryInfo: Record<string, any> = { text: searchProps.query }
      if (searchProps.tabId !== undefined) {
        queryInfo.tabId = Number(searchProps.tabId)
      } else if (searchProps.disposition) {
        queryInfo.disposition = searchProps.disposition
      }
      chromeApi.search.query(queryInfo)
    },
  }

  // --- permissions ---
  function filterChromePermissions(perms: browser.permissions.Permissions) {
    const virtualPerms: string[] = []
    const realPerms: string[] = []
    for (const p of perms.permissions ?? []) {
      if (VIRTUAL_GRANTED_PERMS.has(String(p).toLowerCase())) virtualPerms.push(p)
      else realPerms.push(p)
    }
    const origins = perms.origins ? [...perms.origins] : []
    const requestPayload: Record<string, string[]> = {}
    if (realPerms.length) requestPayload.permissions = realPerms
    if (origins.length) requestPayload.origins = origins
    return { virtualPerms, realPerms, origins, requestPayload }
  }

  const permissions = {
    async contains(perms: browser.permissions.Permissions): Promise<boolean> {
      const { requestPayload } = filterChromePermissions(perms)
      if (!Object.keys(requestPayload).length) return true
      if (!chromeApi?.permissions?.contains) return false
      try {
        return Boolean(await chromeApi.permissions.contains(requestPayload))
      } catch {
        return false
      }
    },
    async request(perms: browser.permissions.Permissions): Promise<boolean> {
      const { requestPayload } = filterChromePermissions(perms)
      if (!Object.keys(requestPayload).length) return true
      if (!chromeApi?.permissions?.request) return false
      try {
        return Boolean(await chromeApi.permissions.request(requestPayload))
      } catch {
        return false
      }
    },
    async remove(perms: browser.permissions.Permissions): Promise<boolean> {
      const { requestPayload } = filterChromePermissions(perms)
      if (!Object.keys(requestPayload).length) return true
      if (!chromeApi?.permissions?.remove) return false
      try {
        return Boolean(await chromeApi.permissions.remove(requestPayload))
      } catch {
        return false
      }
    },
    onAdded: wrapChromeEvent<browser.permissions.PermissionsChangeListener>(
      chromeApi?.permissions?.onAdded
    ),
    onRemoved: wrapChromeEvent<browser.permissions.PermissionsChangeListener>(
      chromeApi?.permissions?.onRemoved
    ),
  }

  // --- menus (contextMenus) ---
  const CHROME_MENU_CONTEXTS = new Set([
    'all',
    'page',
    'frame',
    'selection',
    'link',
    'editable',
    'image',
    'video',
    'audio',
    'launcher',
    'action',
  ])
  const menuClickHandlers = new Map<string | number, (info: any, tab?: any) => void>()
  const createdMenuIds = new Set<string>()
  let menuOpQueue: Promise<void> = Promise.resolve()
  let menuIdCounter = 0

  if (chromeApi?.contextMenus?.onClicked?.addListener) {
    chromeApi.contextMenus.onClicked.addListener((info: any, tab: any) => {
      const handler =
        menuClickHandlers.get(info?.menuItemId) ??
        menuClickHandlers.get(String(info?.menuItemId))
      if (handler) {
        try {
          handler(info, tab)
        } catch {
          // Isolate menu handler failures
        }
      }
    })
  }

  function invokeContextMenusRemoveAll(): Promise<void> {
    if (!chromeApi?.contextMenus?.removeAll) return Promise.resolve()
    return new Promise<void>(resolve => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        void chromeApi?.runtime?.lastError
        resolve()
      }
      try {
        const res = chromeApi.contextMenus.removeAll(done)
        if (res && typeof res.then === 'function') {
          res.then(done, done)
        } else if (chromeApi.contextMenus.removeAll.length === 0) {
          done()
        }
      } catch {
        done()
      }
    })
  }

  function invokeContextMenusCreate(cleanProps: Record<string, any>): Promise<void> {
    if (!chromeApi?.contextMenus?.create) return Promise.resolve()
    const itemId = String(cleanProps.id)
    return new Promise<void>(resolve => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        void chromeApi?.runtime?.lastError
        resolve()
      }
      const doCreate = () => {
        try {
          createdMenuIds.add(itemId)
          const res = chromeApi.contextMenus.create(cleanProps, done)
          if (res && typeof res.then === 'function') {
            res.then(done, done)
          } else if (chromeApi.contextMenus.create.length <= 1) {
            done()
          }
        } catch {
          done()
        }
      }
      if (createdMenuIds.has(itemId)) {
        if (typeof chromeApi?.contextMenus?.remove === 'function') {
          try {
            const rmRes = chromeApi.contextMenus.remove(itemId, () => {
              void chromeApi?.runtime?.lastError
              doCreate()
            })
            if (rmRes && typeof rmRes.then === 'function') {
              rmRes.then(doCreate, doCreate)
            } else if (chromeApi.contextMenus.remove.length <= 1) {
              doCreate()
            }
            return
          } catch {
            // Fall through
          }
        } else if (typeof chromeApi?.contextMenus?.update === 'function') {
          try {
            const { id: _id, ...updateProps } = cleanProps
            const updRes = chromeApi.contextMenus.update(itemId, updateProps, done)
            if (updRes && typeof updRes.then === 'function') {
              updRes.then(done, done)
            } else if (chromeApi.contextMenus.update.length <= 2) {
              done()
            }
            return
          } catch {
            // Fall through
          }
        } else {
          done()
          return
        }
      }
      doCreate()
    })
  }

  const menuHiddenEmitter = createEventEmitter<browser.menus.HiddenListener>()

  const menus = {
    create(createProperties: browser.menus.CreateProperties): string {
      const id = createProperties.id ?? `sb_menu_${++menuIdCounter}`
      if (!chromeApi?.contextMenus?.create) return id

      const {
        icons: _icons,
        viewTypes: _viewTypes,
        onclick,
        contexts,
        ...rest
      } = createProperties

      const mappedContexts: string[] = []
      for (const ctx of contexts ?? []) {
        if (ctx === 'browser_action' || ctx === 'page_action') {
          if (!mappedContexts.includes('action')) mappedContexts.push('action')
        } else if (ctx === 'tab' || ctx === 'bookmark') {
          if (!mappedContexts.includes('page')) mappedContexts.push('page')
        } else if (CHROME_MENU_CONTEXTS.has(ctx) && !mappedContexts.includes(ctx)) {
          mappedContexts.push(ctx)
        }
      }
      if (!mappedContexts.length) mappedContexts.push('all')

      if (typeof onclick === 'function') {
        menuClickHandlers.set(id, onclick)
      }

      const cleanProps: Record<string, any> = {
        ...rest,
        id,
        contexts: mappedContexts,
      }
      if (cleanProps.parentId !== undefined) cleanProps.parentId = String(cleanProps.parentId)

      menuOpQueue = menuOpQueue
        .then(async () => {
          if (typeof onclick === 'function') {
            menuClickHandlers.set(id, onclick)
          }
          await invokeContextMenusCreate(cleanProps)
        })
        .catch(() => undefined)

      return id
    },
    removeAll(): Promise<void> {
      menuClickHandlers.clear()
      const next = menuOpQueue
        .then(async () => {
          menuClickHandlers.clear()
          createdMenuIds.clear()
          await invokeContextMenusRemoveAll()
        })
        .catch(() => undefined)
      menuOpQueue = next
      return next
    },
    overrideContext(_contextOptions: browser.menus.ContextOptions): void {
      // No Chrome equivalent; no-op
    },
    onHidden: menuHiddenEmitter as browser.EventTarget<browser.menus.HiddenListener>,
  }

  // --- commands (with persistent virtual overrides for update/reset) ---
  let commandsWriteQueue: Promise<void> = Promise.resolve()
  const commands = {
    async getAll(): Promise<browser.commands.Command[]> {
      await commandsWriteQueue
      const nativeCommands: browser.commands.Command[] = chromeApi?.commands?.getAll
        ? (await chromeApi.commands.getAll()) ?? []
        : []
      const stored = await storage.local.get<Record<string, Record<string, string>>>(
        COMMAND_OVERRIDES_KEY
      )
      const overrides = stored?.[COMMAND_OVERRIDES_KEY] ?? {}
      return nativeCommands.map(cmd => {
        if (cmd.name && Object.prototype.hasOwnProperty.call(overrides, cmd.name)) {
          return { ...cmd, shortcut: overrides[cmd.name] }
        }
        return cmd
      })
    },
    update(details: browser.commands.UpdateDetails): Promise<void> {
      const next = commandsWriteQueue.then(async () => {
        const stored = await storage.local.get<Record<string, Record<string, string>>>(
          COMMAND_OVERRIDES_KEY
        )
        const overrides = { ...(stored?.[COMMAND_OVERRIDES_KEY] ?? {}) }
        overrides[details.name] = details.shortcut ?? ''
        await storage.local.set({ [COMMAND_OVERRIDES_KEY]: overrides })
      })
      commandsWriteQueue = next.catch(() => undefined)
      return next
    },
    reset(name: string): Promise<void> {
      const next = commandsWriteQueue.then(async () => {
        const stored = await storage.local.get<Record<string, Record<string, string>>>(
          COMMAND_OVERRIDES_KEY
        )
        const overrides = { ...(stored?.[COMMAND_OVERRIDES_KEY] ?? {}) }
        delete overrides[name]
        await storage.local.set({ [COMMAND_OVERRIDES_KEY]: overrides })
      })
      commandsWriteQueue = next.catch(() => undefined)
      return next
    },
    onCommand: wrapChromeEvent<browser.commands.CommandListener>(chromeApi?.commands?.onCommand),
  }

  // --- sidebarAction (chrome.sidePanel) ---
  const sidebarAction = {
    async isOpen(details?: browser.sidebarAction.IsOpenDetails): Promise<boolean> {
      if (chromeApi?.runtime?.getContexts) {
        try {
          const query: Record<string, any> = { contextTypes: ['SIDE_PANEL'] }
          if (details?.windowId !== undefined) query.windowIds = [Number(details.windowId)]
          const contexts = await chromeApi.runtime.getContexts(query)
          return Array.isArray(contexts) && contexts.length > 0
        } catch {
          return false
        }
      }
      return false
    },
    setTitle(_details: browser.sidebarAction.SetTitleDetails): void {
      // Chrome sidePanel title comes from manifest/page title; no-op
    },
    open(): void {
      if (!chromeApi?.sidePanel?.open) return
      void resolveCurrentWindowId().then(winId => {
        if (winId !== undefined) {
          chromeApi.sidePanel.open({ windowId: winId }).catch(() => undefined)
        }
      })
    },
    close(): void {
      if (!chromeApi?.sidePanel?.close) return
      void resolveCurrentWindowId().then(winId => {
        if (winId !== undefined) {
          chromeApi.sidePanel.close({ windowId: winId }).catch(() => undefined)
        }
      })
    },
    toggle(): void {
      if (!chromeApi?.sidePanel?.open) return
      void resolveCurrentWindowId().then(async winId => {
        if (winId === undefined) return
        const openNow = await sidebarAction.isOpen({ windowId: winId })
        if (openNow && chromeApi.sidePanel.close) {
          chromeApi.sidePanel.close({ windowId: winId }).catch(() => undefined)
        } else {
          chromeApi.sidePanel.open({ windowId: winId }).catch(() => undefined)
        }
      })
    },
  }

  // --- browserAction & pageAction (chrome.action) ---
  const actionClickListeners = new Map<browser.browserAction.ClickListener, any>()

  const browserAction = {
    setPopup(details: browser.browserAction.PopupDetails): void {
      if (!chromeApi?.action?.setPopup) return
      const payload: Record<string, any> = { popup: details.popup ?? '' }
      if (details.tabId !== undefined) payload.tabId = Number(details.tabId)
      chromeApi.action.setPopup(payload).catch?.(() => undefined)
    },
    openPopup(): void {
      chromeApi?.action?.openPopup?.().catch?.(() => undefined)
    },
    onClicked: {
      addListener(listener: browser.browserAction.ClickListener) {
        if (!chromeApi?.action?.onClicked) return
        const wrapped = (rawTab: any) => {
          listener(enrichTab(rawTab), { modifiers: [], button: 0 })
        }
        actionClickListeners.set(listener, wrapped)
        chromeApi.action.onClicked.addListener(wrapped)
      },
      removeListener(listener: browser.browserAction.ClickListener) {
        const wrapped = actionClickListeners.get(listener)
        if (wrapped && chromeApi?.action?.onClicked) {
          chromeApi.action.onClicked.removeListener(wrapped)
          actionClickListeners.delete(listener)
        }
      },
      hasListener(listener: browser.browserAction.ClickListener) {
        return actionClickListeners.has(listener)
      },
    },
  }

  const pageAction = {
    setTitle(details: browser.pageAction.SetTitleDetails): void {
      if (!chromeApi?.action?.setTitle) return
      chromeApi.action
        .setTitle({ title: details.title ?? '', tabId: Number(details.tabId) })
        .catch?.(() => undefined)
    },
    async show(tabId: ID): Promise<void> {
      await chromeApi?.action?.enable?.(Number(tabId))?.catch?.(() => undefined)
    },
    async hide(tabId: ID): Promise<void> {
      await chromeApi?.action?.disable?.(Number(tabId))?.catch?.(() => undefined)
    },
  }

  // --- theme ---
  const themeUpdatedEmitter = createEventEmitter<browser.theme.ThemeUpdatedListener>()
  const theme = {
    async getCurrent(_windowId?: ID): Promise<browser.theme.Theme> {
      return { colors: {}, images: {}, properties: {} }
    },
    update(): void {},
    reset(): void {},
    onUpdated: themeUpdatedEmitter as browser.EventTarget<browser.theme.ThemeUpdatedListener>,
  }

  // --- proxy ---
  const proxyReqEmitter = createEventEmitter<browser.proxy.Listener>()
  const proxy = {
    onRequest: chromeApi?.proxy?.onRequest
      ? {
          addListener(
            listener: browser.proxy.Listener,
            filter: browser.webRequest.RequestFilter,
            extraInfoSpec?: browser.proxy.ExtraInfoSpec[]
          ) {
            try {
              chromeApi.proxy.onRequest.addListener(listener, filter, extraInfoSpec)
            } catch {
              proxyReqEmitter.addListener(listener)
            }
          },
          removeListener(listener: browser.proxy.Listener) {
            try {
              chromeApi.proxy.onRequest.removeListener(listener)
            } catch {
              proxyReqEmitter.removeListener(listener)
            }
          },
          hasListener(listener: browser.proxy.Listener): boolean {
            try {
              return Boolean(chromeApi.proxy.onRequest.hasListener(listener))
            } catch {
              return proxyReqEmitter.hasListener(listener)
            }
          },
        }
      : (proxyReqEmitter as unknown as typeof browser.proxy.onRequest),
  }

  // --- webRequest ---
  function wrapWebRequestEvent<T extends (...args: any[]) => any, E extends string[]>(
    chromeEvt: any
  ): browser.webRequest.EventTarget<T, E> {
    const fallbackEmitter = createEventEmitter<T>()
    if (!chromeEvt) {
      return {
        addListener: (l: T) => fallbackEmitter.addListener(l),
        removeListener: (l: T) => fallbackEmitter.removeListener(l),
        hasListener: (l: T) => fallbackEmitter.hasListener(l),
      }
    }
    return {
      addListener(listener: T, filter: browser.webRequest.RequestFilter, extraInfoSpec?: E) {
        const safeSpec = Array.isArray(extraInfoSpec)
          ? extraInfoSpec.filter(spec => spec !== 'blocking')
          : undefined
        try {
          if (safeSpec && safeSpec.length) chromeEvt.addListener(listener, filter, safeSpec)
          else chromeEvt.addListener(listener, filter)
        } catch {
          fallbackEmitter.addListener(listener)
        }
      },
      removeListener(listener: T) {
        try {
          chromeEvt.removeListener(listener)
        } catch {
          // Ignore
        }
        fallbackEmitter.removeListener(listener)
      },
      hasListener(listener: T): boolean {
        try {
          if (chromeEvt.hasListener(listener)) return true
        } catch {
          // Ignore
        }
        return fallbackEmitter.hasListener(listener)
      },
    }
  }

  const webRequest = {
    onBeforeRequest: wrapWebRequestEvent<browser.webRequest.Listener, browser.webRequest.ExtraInfoSpec[]>(
      chromeApi?.webRequest?.onBeforeRequest
    ),
    onBeforeSendHeaders: wrapWebRequestEvent<
      browser.webRequest.Listener,
      browser.webRequest.ExtraInfoSpec[]
    >(chromeApi?.webRequest?.onBeforeSendHeaders),
    onHeadersReceived: wrapWebRequestEvent<
      browser.webRequest.Listener,
      browser.webRequest.ExtraInfoSpec[]
    >(chromeApi?.webRequest?.onHeadersReceived),
    onAuthRequired: wrapWebRequestEvent<
      browser.webRequest.AuthListener,
      browser.webRequest.ExtraInfoSpec[]
    >(chromeApi?.webRequest?.onAuthRequired),
    onCompleted: wrapWebRequestEvent<browser.webRequest.Listener, browser.webRequest.ExtraInfoSpec[]>(
      chromeApi?.webRequest?.onCompleted
    ),
    onErrorOccurred: wrapWebRequestEvent<
      browser.webRequest.ErrorListener,
      browser.webRequest.ExtraInfoSpec[]
    >(chromeApi?.webRequest?.onErrorOccurred),
  }

  // --- publicSuffix ---
  const publicSuffix = {
    getDomain(hostname: string, options?: browser.publicSuffix.GetDomainOptions): string | null {
      return computePublicDomain(hostname, options)
    },
    getKnownSuffix(hostname: string): string | null {
      return computeKnownSuffix(hostname)
    },
    isKnownSuffix(hostname: string): boolean {
      const clean = hostname.toLowerCase().replace(/\.+$/, '')
      return computeKnownSuffix(clean) === clean
    },
  }

  return {
    extension,
    runtime,
    storage,
    tabs,
    windows,
    sessions,
    contextualIdentities,
    bookmarks,
    history,
    downloads,
    alarms,
    i18n,
    cookies,
    identity,
    omnibox,
    search,
    permissions,
    menus,
    commands,
    sidebarAction,
    browserAction,
    pageAction,
    theme,
    proxy,
    webRequest,
    publicSuffix,
  }
}

export function installBrowserPolyfill(force = false): void {
  ensureServiceWorkerEnv()

  const g = globalThis as Record<string, any>
  const chromeApi = getChrome()
  const existing = g.browser

  // Do not clobber existing Vitest mocks when chrome runtime is absent
  const isVitest = Boolean(g.__vitest_worker__ || g.process?.env?.VITEST)
  if (!force && isVitest && existing && !chromeApi?.runtime) {
    return
  }

  // Already installed over Chrome runtime unless forced
  if (
    !force &&
    g.__sideberyBrowser?.__sideberyPolyfillInstalled &&
    existing?.__sideberyPolyfillInstalled
  ) {
    return
  }

  const namespaces = buildPolyfillNamespaces() as Record<string, any>
  if (!chromeApi?.runtime) {
    Object.defineProperty(namespaces, '__sideberyPolyfillWithoutChrome', {
      value: true,
      enumerable: false,
      configurable: true,
    })
  } else {
    Object.defineProperty(namespaces, '__sideberyPolyfillInstalled', {
      value: true,
      enumerable: false,
      configurable: true,
    })
  }

  // Always expose on `globalThis.__sideberyBrowser` (used by Vite `define.browser` so
  // locked-down/non-configurable `window.browser` in Vivaldi <webview> cannot bypass it)
  g.__sideberyBrowser = namespaces

  // Always replace Chrome's native `globalThis.browser` (which aliases `chrome` in Chromium 126+)
  // so Firefox-specific wrappers (tabs.onUpdated filters, permissions.contains('tabHide'), etc.)
  // are active across all contexts.
  if (
    force ||
    !existing ||
    chromeApi?.runtime ||
    (existing.__sideberyPolyfillWithoutChrome && chromeApi?.runtime)
  ) {
    try {
      g.browser = namespaces
      return
    } catch {
      try {
        Object.defineProperty(g, 'browser', {
          value: namespaces,
          writable: true,
          configurable: true,
          enumerable: true,
        })
        return
      } catch {
        // Fall through to in-place overwrite on `existing`
      }
    }
  }

  // Overwrite polyfill namespaces/methods on existing object if `g.browser` is non-configurable
  for (const [nsKey, nsVal] of Object.entries(namespaces)) {
    try {
      existing[nsKey] = nsVal
    } catch {
      if (nsVal && typeof nsVal === 'object' && typeof existing[nsKey] === 'object') {
        for (const [propKey, propVal] of Object.entries(nsVal as Record<string, any>)) {
          try {
            existing[nsKey][propKey] = propVal
          } catch {
            // Ignore non-writable property
          }
        }
      }
    }
  }
}

installBrowserPolyfill()
