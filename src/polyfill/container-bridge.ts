import type {
  ContainerContract,
  NewContainerConfContract,
} from 'src/contracts/sidebery-schema'

type EventListener<T extends (...args: any[]) => any> = T

export interface BridgeEventTarget<T extends (...args: any[]) => any> {
  addListener: (listener: EventListener<T>) => void
  removeListener: (listener: EventListener<T>) => void
  hasListener: (listener: EventListener<T>) => boolean
}

export type ChromeTabGroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange'

interface AnchorModuleLike {
  getTabContainerId?: (tabId: ID) => Promise<string | undefined> | string | undefined
  setTabContainerId?: (tabId: ID, containerId: string) => Promise<void>
}

interface SettingsModuleLike {
  state?: {
    syncContainersTabGroups?: boolean
  }
}

const CONTAINERS_STORAGE_KEY = 'containers'
const SESSION_TAB_CONTAINERS_KEY = '__sidebery_tab_containers__'
const DEFAULT_CONTAINER_ID = 'firefox-default'
const PRIVATE_CONTAINER_ID = 'firefox-private'

const COLOR_CODE_MAP: Record<string, string> = {
  blue: '#37adff',
  turquoise: '#00c79a',
  cyan: '#00c79a',
  green: '#51cd00',
  yellow: '#ffcb00',
  orange: '#ff9f00',
  red: '#ff613d',
  pink: '#ff4bda',
  purple: '#af51f5',
  toolbar: '#686868',
  gray: '#686868',
  grey: '#686868',
}

const SUPPORTED_COLOR_NAMES = [
  'blue',
  'turquoise',
  'green',
  'yellow',
  'orange',
  'red',
  'pink',
  'purple',
  'toolbar',
] as const

const SUPPORTED_ICON_NAMES = [
  'fingerprint',
  'briefcase',
  'dollar',
  'cart',
  'circle',
  'gift',
  'vacation',
  'food',
  'fruit',
  'pet',
  'tree',
  'chill',
  'fence',
] as const

const CHROME_GROUP_COLOR_MAP: Record<string, ChromeTabGroupColor> = {
  blue: 'blue',
  turquoise: 'cyan',
  cyan: 'cyan',
  green: 'green',
  yellow: 'yellow',
  orange: 'orange',
  red: 'red',
  pink: 'pink',
  purple: 'purple',
  toolbar: 'grey',
  gray: 'grey',
  grey: 'grey',
}

function getChrome(): any {
  return (globalThis as unknown as { chrome?: any }).chrome
}

function createEvent<T extends (...args: any[]) => any>() {
  const listeners = new Set<T>()
  const target: BridgeEventTarget<T> = {
    addListener(listener: T) {
      if (typeof listener === 'function') listeners.add(listener)
    },
    removeListener(listener: T) {
      listeners.delete(listener)
    },
    hasListener(listener: T) {
      return listeners.has(listener)
    },
  }
  const emit = (...args: Parameters<T>) => {
    for (const fn of Array.from(listeners)) {
      try {
        fn(...args)
      } catch {
        // Isolate listener failures
      }
    }
  }
  return { target, emit }
}

const createdEvt = createEvent<browser.contextualIdentities.ChangeListener>()
const removedEvt = createEvent<browser.contextualIdentities.ChangeListener>()
const updatedEvt = createEvent<browser.contextualIdentities.ChangeListener>()

export const onCreated = createdEvt.target
export const onRemoved = removedEvt.target
export const onUpdated = updatedEvt.target

let initialized = false
let initPromise: Promise<void> | null = null
let listenersAttached = false
let lastStorageSyncContainers: boolean | undefined

let containersById: Record<string, ContainerContract> = {}
const tabContainerMap = new Map<ID, string>()

let anchorModulePromise: Promise<AnchorModuleLike | null> | null = null
async function getAnchorModule(): Promise<AnchorModuleLike | null> {
  if (!anchorModulePromise) {
    anchorModulePromise = import('src/services/tab-tree-anchor')
      .then(m => m as unknown as AnchorModuleLike)
      .catch(() => null)
  }
  return anchorModulePromise
}

function getSettingsState(): SettingsModuleLike['state'] | undefined {
  return (globalThis as any).__sideberySettingsState
}

async function isSyncContainersTabGroupsEnabled(): Promise<boolean> {
  const state = getSettingsState()
  const stateVal =
    state && typeof state.syncContainersTabGroups === 'boolean'
      ? state.syncContainersTabGroups
      : undefined

  if (stateVal !== undefined) return stateVal
  return Boolean(lastStorageSyncContainers)
}

function resolveColorCode(color?: string): string {
  if (!color) return COLOR_CODE_MAP.blue
  return COLOR_CODE_MAP[color] ?? COLOR_CODE_MAP.blue
}

export function mapColorToChromeTabGroupColor(color?: string): ChromeTabGroupColor {
  if (!color) return 'grey'
  return CHROME_GROUP_COLOR_MAP[color] ?? 'grey'
}

function isTransientTabEditError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : typeof err === 'string' ? err : ''
  const lower = msg.toLowerCase()
  return lower.includes('cannot be edited right now') || lower.includes('dragging')
}

export async function withTabEditRetry<T>(
  op: () => Promise<T>,
  attempts = 3,
  delayMs = 50
): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await op()
    } catch (err) {
      lastErr = err
      if (i + 1 >= attempts || !isTransientTabEditError(err)) {
        throw err
      }
      await new Promise(resolve => setTimeout(resolve, delayMs))
    }
  }
  throw lastErr
}

function normalizeContainerRecord(id: string, raw: Partial<ContainerContract>): ContainerContract {
  const color = raw.color || 'blue'
  const cookieStoreId = raw.cookieStoreId || raw.id || id
  return {
    id: cookieStoreId,
    cookieStoreId,
    name: raw.name ?? '',
    icon: raw.icon || 'fingerprint',
    color,
    colorCode: raw.colorCode || resolveColorCode(color),
    proxified: Boolean(raw.proxified),
    proxy: raw.proxy ?? null,
    reopenRulesActive: Boolean(raw.reopenRulesActive),
    reopenRules: Array.isArray(raw.reopenRules) ? raw.reopenRules.map(r => ({ ...r })) : [],
    userAgentActive: Boolean(raw.userAgentActive),
    userAgent: raw.userAgent ?? '',
  }
}

function toContextualIdentity(c: ContainerContract): browser.contextualIdentities.Container {
  return {
    cookieStoreId: c.cookieStoreId,
    name: c.name,
    icon: c.icon,
    color: c.color,
    colorCode: c.colorCode || resolveColorCode(c.color),
  }
}

function generateContainerId(): string {
  let maxNum = 0
  for (const key of Object.keys(containersById)) {
    const match = /^firefox-container-(\d+)$/.exec(key)
    if (match) {
      const n = parseInt(match[1], 10)
      if (!isNaN(n) && n > maxNum) maxNum = n
    }
  }
  let next = maxNum + 1
  while (containersById[`firefox-container-${next}`]) {
    next++
  }
  return `firefox-container-${next}`
}

async function readLocalStorage(keys: string | string[]): Promise<Record<string, any>> {
  const chromeApi = getChrome()
  if (chromeApi?.storage?.local) {
    try {
      return (await chromeApi.storage.local.get(keys)) ?? {}
    } catch {
      return {}
    }
  }
  const gBrowser = (globalThis as unknown as { browser?: any }).browser
  if (gBrowser?.storage?.local?.get) {
    try {
      return (await gBrowser.storage.local.get(keys)) ?? {}
    } catch {
      return {}
    }
  }
  return {}
}

async function writeLocalStorage(items: Record<string, any>): Promise<void> {
  const chromeApi = getChrome()
  if (chromeApi?.storage?.local) {
    await chromeApi.storage.local.set(items)
    return
  }
  const gBrowser = (globalThis as unknown as { browser?: any }).browser
  if (gBrowser?.storage?.local?.set) {
    await gBrowser.storage.local.set(items)
  }
}

async function readSessionStorage(keys: string | string[]): Promise<Record<string, any>> {
  const chromeApi = getChrome()
  if (chromeApi?.storage?.session) {
    try {
      return (await chromeApi.storage.session.get(keys)) ?? {}
    } catch {
      return {}
    }
  }
  return {}
}

async function writeSessionStorage(items: Record<string, any>): Promise<void> {
  const chromeApi = getChrome()
  if (chromeApi?.storage?.session) {
    try {
      await chromeApi.storage.session.set(items)
    } catch {
      // Session storage unavailable in some test environments
    }
  }
}

async function persistContainers(): Promise<void> {
  const snapshot: Record<string, ContainerContract> = {}
  for (const [id, ctr] of Object.entries(containersById)) {
    snapshot[id] = normalizeContainerRecord(id, ctr)
  }
  await writeLocalStorage({ [CONTAINERS_STORAGE_KEY]: snapshot })
}

async function persistTabContainerMap(): Promise<void> {
  const obj: Record<string, string> = {}
  for (const [tabId, cid] of tabContainerMap.entries()) {
    obj[String(tabId)] = cid
  }
  await writeSessionStorage({ [SESSION_TAB_CONTAINERS_KEY]: obj })
}

function applyStoredContainers(rawContainers: unknown): void {
  const next: Record<string, ContainerContract> = {}
  if (rawContainers && typeof rawContainers === 'object') {
    for (const [id, value] of Object.entries(rawContainers as Record<string, Partial<ContainerContract>>)) {
      if (!value || typeof value !== 'object') continue
      const normalized = normalizeContainerRecord(id, value)
      next[normalized.cookieStoreId] = normalized
    }
  }
  containersById = next
}

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true

  const chromeApi = getChrome()
  if (chromeApi?.storage?.onChanged?.addListener) {
    chromeApi.storage.onChanged.addListener((changes: Record<string, { newValue?: any }>, area: string) => {
      if (area === 'local') {
        if (changes[CONTAINERS_STORAGE_KEY]) {
          applyStoredContainers(changes[CONTAINERS_STORAGE_KEY].newValue)
        }
        if (changes.settings?.newValue && typeof changes.settings.newValue.syncContainersTabGroups === 'boolean') {
          const val = changes.settings.newValue.syncContainersTabGroups
          lastStorageSyncContainers = val
          const state = getSettingsState()
          if (state) state.syncContainersTabGroups = val
        }
      } else if (area === 'session' && changes[SESSION_TAB_CONTAINERS_KEY]) {
        const nextMap = changes[SESSION_TAB_CONTAINERS_KEY].newValue
        tabContainerMap.clear()
        if (nextMap && typeof nextMap === 'object') {
          for (const [k, v] of Object.entries(nextMap as Record<string, string>)) {
            if (typeof v !== 'string') continue
            const num = Number(k)
            tabContainerMap.set(Number.isNaN(num) ? k : num, v)
          }
        }
      }
    })
  }

  if (chromeApi?.tabs?.onRemoved?.addListener) {
    chromeApi.tabs.onRemoved.addListener((tabId: number) => {
      if (tabContainerMap.delete(tabId)) {
        void persistTabContainerMap()
      }
    })
  }
}

export async function init(): Promise<void> {
  if (initialized) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    attachListeners()
    const [localData, sessionData] = await Promise.all([
      readLocalStorage([CONTAINERS_STORAGE_KEY, 'settings']),
      readSessionStorage([SESSION_TAB_CONTAINERS_KEY]),
    ])

    applyStoredContainers(localData[CONTAINERS_STORAGE_KEY])
    if (localData.settings && typeof localData.settings === 'object' && typeof localData.settings.syncContainersTabGroups === 'boolean') {
      lastStorageSyncContainers = localData.settings.syncContainersTabGroups
    }

    const sessionMap = sessionData[SESSION_TAB_CONTAINERS_KEY]
    if (sessionMap && typeof sessionMap === 'object') {
      for (const [k, v] of Object.entries(sessionMap as Record<string, string>)) {
        if (typeof v !== 'string') continue
        const num = Number(k)
        tabContainerMap.set(Number.isNaN(num) ? k : num, v)
      }
    }

    initialized = true
  })()

  try {
    await initPromise
  } finally {
    initPromise = null
  }
}

async function ensureInitialized(): Promise<void> {
  if (!initialized) await init()
}

export async function query(
  details?: browser.contextualIdentities.QueryDetails
): Promise<browser.contextualIdentities.Container[]> {
  await ensureInitialized()
  const filterName = details?.name
  const results: browser.contextualIdentities.Container[] = []
  for (const ctr of Object.values(containersById)) {
    if (filterName !== undefined && ctr.name !== filterName) continue
    results.push(toContextualIdentity(ctr))
  }
  return results
}

export async function get(
  cookieStoreId: string
): Promise<browser.contextualIdentities.Container> {
  await ensureInitialized()
  const ctr = containersById[cookieStoreId]
  if (!ctr) return undefined as unknown as browser.contextualIdentities.Container
  return toContextualIdentity(ctr)
}

export async function create(
  details: NewContainerConfContract | browser.contextualIdentities.CreateDetails
): Promise<browser.contextualIdentities.Container> {
  await ensureInitialized()
  const extDetails = details as NewContainerConfContract
  const id = extDetails.cookieStoreId || extDetails.id || generateContainerId()
  const normalized = normalizeContainerRecord(id, {
    ...extDetails,
    id,
    cookieStoreId: id,
  })

  containersById[id] = normalized
  await persistContainers()

  const identity = toContextualIdentity(normalized)
  createdEvt.emit({ contextualIdentity: identity })
  return identity
}

export async function update(
  cookieStoreId: string,
  details: browser.contextualIdentities.UpdateDetails
): Promise<browser.contextualIdentities.Container> {
  await ensureInitialized()
  const existing = containersById[cookieStoreId]
  if (!existing) {
    throw new Error(`ContainerBridge.update: Invalid cookieStoreId "${cookieStoreId}"`)
  }

  if (details.name !== undefined) existing.name = details.name
  if (details.icon !== undefined) existing.icon = details.icon
  if (details.color !== undefined) {
    existing.color = details.color
    existing.colorCode = resolveColorCode(details.color)
  }

  await persistContainers()

  const identity = toContextualIdentity(existing)
  updatedEvt.emit({ contextualIdentity: identity })
  return identity
}

export async function remove(
  cookieStoreId: string
): Promise<browser.contextualIdentities.Container> {
  await ensureInitialized()
  const existing = containersById[cookieStoreId]
  if (!existing) {
    throw new Error(`ContainerBridge.remove: Invalid cookieStoreId "${cookieStoreId}"`)
  }

  const identity = toContextualIdentity(existing)
  delete containersById[cookieStoreId]
  await persistContainers()

  removedEvt.emit({ contextualIdentity: identity })
  return identity
}

export async function getSupportedColors(): Promise<browser.contextualIdentities.ColorInfo[]> {
  return SUPPORTED_COLOR_NAMES.map(color => ({
    color,
    colorCode: resolveColorCode(color),
  }))
}

export async function getSupportedIcons(): Promise<browser.contextualIdentities.IconInfo[]> {
  const chromeApi = getChrome()
  return SUPPORTED_ICON_NAMES.map(icon => ({
    icon,
    iconUrl: chromeApi?.runtime?.getURL ? chromeApi.runtime.getURL(`assets/${icon}.svg`) : '',
  }))
}

export function getCachedTabCookieStoreId(tabId: ID, incognito?: boolean): string {
  const cached = tabContainerMap.get(tabId) ?? tabContainerMap.get(String(tabId))
  if (cached) return cached
  return incognito ? PRIVATE_CONTAINER_ID : DEFAULT_CONTAINER_ID
}

export async function getTabCookieStoreId(tabId: ID): Promise<string | undefined> {
  await ensureInitialized()
  const cached = tabContainerMap.get(tabId) ?? tabContainerMap.get(String(tabId))
  if (cached) return cached

  const anchor = await getAnchorModule()
  const anchoredId = await anchor?.getTabContainerId?.(tabId)
  if (anchoredId) {
    tabContainerMap.set(tabId, anchoredId)
    return anchoredId
  }
  return undefined
}

export async function setTabCookieStoreId(tabId: ID, cookieStoreId: string): Promise<void> {
  await ensureInitialized()
  if (!cookieStoreId) return

  tabContainerMap.set(tabId, cookieStoreId)
  await persistTabContainerMap()

  const anchor = await getAnchorModule()
  if (anchor?.setTabContainerId) {
    await anchor.setTabContainerId(tabId, cookieStoreId).catch(() => undefined)
  }
}

export async function syncTabWithNativeTabGroup(
  tabId: ID,
  windowId: ID,
  containerId: string,
  panelName?: string,
  panelColor?: string
): Promise<number | undefined> {
  await ensureInitialized()
  const enabled = await isSyncContainersTabGroupsEnabled()
  if (!enabled) return undefined

  const chromeApi = getChrome()
  if (!chromeApi?.tabs?.group || !chromeApi?.tabGroups) return undefined

  const ctr = containersById[containerId]
  const isDefault =
    !containerId || containerId === DEFAULT_CONTAINER_ID || containerId === PRIVATE_CONTAINER_ID
  if (!ctr && isDefault && !panelName) return undefined

  const title = ctr?.name || panelName || containerId
  const color = mapColorToChromeTabGroupColor(ctr?.color || panelColor)
  const numericTabId = Number(tabId)
  const numericWinId = Number(windowId)
  if (Number.isNaN(numericTabId) || Number.isNaN(numericWinId)) return undefined

  try {
    const existingGroups: { id: number; title?: string; color?: ChromeTabGroupColor }[] =
      (await chromeApi.tabGroups.query({ windowId: numericWinId })) ?? []
    const matched = existingGroups.find(g => g.title === title)

    if (matched) {
      await withTabEditRetry(() =>
        chromeApi.tabs.group({ groupId: matched.id, tabIds: [numericTabId] })
      )
      if (matched.color !== color) {
        await withTabEditRetry(() => chromeApi.tabGroups.update(matched.id, { title, color }))
      }
      return matched.id
    }

    const groupId: number = await withTabEditRetry(() =>
      chromeApi.tabs.group({
        createProperties: { windowId: numericWinId },
        tabIds: [numericTabId],
      })
    )
    await withTabEditRetry(() => chromeApi.tabGroups.update(groupId, { title, color }))
    return groupId
  } catch {
    return undefined
  }
}

export const ContainerBridge = {
  init,
  query,
  get,
  create,
  update,
  remove,
  getSupportedColors,
  getSupportedIcons,
  onCreated,
  onRemoved,
  onUpdated,
  getCachedTabCookieStoreId,
  getTabCookieStoreId,
  setTabCookieStoreId,
  syncTabWithNativeTabGroup,
  mapColorToChromeTabGroupColor,
  withTabEditRetry,
}
