import type { PanelIsolationMode } from 'src/contracts/sidebery-schema'
import { mapColorToChromeTabGroupColor } from 'src/polyfill/container-bridge'

export interface IsolationTabInput {
  id: ID
  panelId?: ID
  pinned?: boolean
  active?: boolean
  hidden?: boolean
  index?: number
  windowId?: ID
  groupId?: number
}

export interface IsolationPanelInfo {
  id?: ID
  name?: string
  color?: string
}

export interface ParkedTabOrigin {
  windowId: ID
  index: number
}

type HiddenChangeListener = (changes: Array<{ tabId: ID; hidden: boolean }>) => void

interface SettingsModuleLike {
  state?: {
    panelIsolationMode?: PanelIsolationMode
  }
}

const SESSION_HIDDEN_TABS_KEY = '__sidebery_hidden_tabs__'
const SESSION_PARKED_WIN_KEY = '__sidebery_parked_win_id__'
const SESSION_PARKED_ORIGINS_KEY = '__sidebery_parked_origins__'
const SESSION_PANEL_GROUPS_KEY = '__sidebery_panel_groups__'

const VALID_MODES = new Set<PanelIsolationMode>(['virtual', 'tabGroups', 'windowParking'])

function getChrome(): any {
  return (globalThis as unknown as { chrome?: any }).chrome
}

let initialized = false
let initPromise: Promise<void> | null = null
let listenersAttached = false
let lastStorageIsolationMode: PanelIsolationMode | undefined

const hiddenTabIds = new Set<ID>()
let parkedWindowId: ID | null = null
const parkedOrigins = new Map<ID, ParkedTabOrigin>()
const panelGroupIds = new Map<string, number>()
const hiddenChangeListeners = new Set<HiddenChangeListener>()

let settingsModulePromise: Promise<SettingsModuleLike | null> | null = null
function getSettingsModule(): Promise<SettingsModuleLike | null> {
  if (!settingsModulePromise) {
    settingsModulePromise = import('src/services/settings')
      .then(m => m as unknown as SettingsModuleLike)
      .catch(() => null)
  }
  return settingsModulePromise
}

async function getIsolationMode(): Promise<PanelIsolationMode> {
  const mod = await getSettingsModule()
  const rawStateMode = mod?.state?.panelIsolationMode
  const stateMode = rawStateMode && VALID_MODES.has(rawStateMode) ? rawStateMode : undefined

  if (stateMode !== undefined) return stateMode
  return lastStorageIsolationMode ?? 'virtual'
}

function toTabIdList(tabIds: ID | ID[]): ID[] {
  const arr = Array.isArray(tabIds) ? tabIds : [tabIds]
  const seen = new Set<ID>()
  const out: ID[] = []
  for (const id of arr) {
    if (id === undefined || id === null || id === -1) continue
    if (!seen.has(id)) {
      seen.add(id)
      out.push(id)
    }
  }
  return out
}

function normalizeIdKey(key: string): ID {
  const n = Number(key)
  return !Number.isNaN(n) && String(n) === key ? n : key
}

function emitHiddenChanges(changes: Array<{ tabId: ID; hidden: boolean }>): void {
  if (!changes.length) return
  for (const fn of Array.from(hiddenChangeListeners)) {
    try {
      fn(changes)
    } catch {
      // Isolate subscriber errors
    }
  }
}

export function onHiddenStateChanged(listener: HiddenChangeListener): () => void {
  hiddenChangeListeners.add(listener)
  return () => hiddenChangeListeners.delete(listener)
}

async function readSession(keys: string[]): Promise<Record<string, any>> {
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

async function writeSession(items: Record<string, any>): Promise<void> {
  const chromeApi = getChrome()
  if (chromeApi?.storage?.session) {
    try {
      await chromeApi.storage.session.set(items)
    } catch {
      // Ignore if session storage unavailable
    }
  }
}

async function readLocalSettingsMode(): Promise<void> {
  const chromeApi = getChrome()
  let settings: any
  if (chromeApi?.storage?.local) {
    try {
      const data = await chromeApi.storage.local.get('settings')
      settings = data?.settings
    } catch {
      settings = undefined
    }
  }
  const mode = settings?.panelIsolationMode
  if (mode && VALID_MODES.has(mode)) lastStorageIsolationMode = mode
}

async function persistHiddenTabs(): Promise<void> {
  await writeSession({ [SESSION_HIDDEN_TABS_KEY]: Array.from(hiddenTabIds) })
}

async function persistParkedState(): Promise<void> {
  const originsObj: Record<string, ParkedTabOrigin> = {}
  for (const [tabId, origin] of parkedOrigins.entries()) {
    originsObj[String(tabId)] = origin
  }
  await writeSession({
    [SESSION_PARKED_WIN_KEY]: parkedWindowId,
    [SESSION_PARKED_ORIGINS_KEY]: originsObj,
  })
}

async function persistPanelGroups(): Promise<void> {
  const obj: Record<string, number> = {}
  for (const [k, v] of panelGroupIds.entries()) {
    obj[k] = v
  }
  await writeSession({ [SESSION_PANEL_GROUPS_KEY]: obj })
}

function attachListeners(): void {
  if (listenersAttached) return
  listenersAttached = true

  const chromeApi = getChrome()
  if (chromeApi?.storage?.onChanged?.addListener) {
    chromeApi.storage.onChanged.addListener((changes: Record<string, { newValue?: any }>, area: string) => {
      if (area === 'local' && changes.settings?.newValue) {
        const mode = changes.settings.newValue.panelIsolationMode
        if (mode && VALID_MODES.has(mode)) {
          lastStorageIsolationMode = mode
          void getSettingsModule().then(mod => {
            if (mod?.state) mod.state.panelIsolationMode = mode
          })
        }
      } else if (area === 'session') {
        if (changes[SESSION_HIDDEN_TABS_KEY]) {
          const nextArr = changes[SESSION_HIDDEN_TABS_KEY].newValue
          hiddenTabIds.clear()
          if (Array.isArray(nextArr)) {
            for (const id of nextArr) hiddenTabIds.add(id)
          }
        }
        if (changes[SESSION_PARKED_WIN_KEY]) {
          parkedWindowId = changes[SESSION_PARKED_WIN_KEY].newValue ?? null
        }
        if (changes[SESSION_PARKED_ORIGINS_KEY]) {
          parkedOrigins.clear()
          const nextObj = changes[SESSION_PARKED_ORIGINS_KEY].newValue
          if (nextObj && typeof nextObj === 'object') {
            for (const [k, v] of Object.entries(nextObj as Record<string, ParkedTabOrigin>)) {
              if (v && typeof v === 'object') parkedOrigins.set(normalizeIdKey(k), v)
            }
          }
        }
        if (changes[SESSION_PANEL_GROUPS_KEY]) {
          panelGroupIds.clear()
          const nextObj = changes[SESSION_PANEL_GROUPS_KEY].newValue
          if (nextObj && typeof nextObj === 'object') {
            for (const [k, v] of Object.entries(nextObj as Record<string, number>)) {
              if (typeof v === 'number') panelGroupIds.set(k, v)
            }
          }
        }
      }
    })
  }

  if (chromeApi?.tabs?.onRemoved?.addListener) {
    chromeApi.tabs.onRemoved.addListener((tabId: number) => {
      let dirtyHidden = false
      let dirtyParked = false
      if (hiddenTabIds.delete(tabId)) dirtyHidden = true
      if (parkedOrigins.delete(tabId)) dirtyParked = true
      if (dirtyHidden) void persistHiddenTabs()
      if (dirtyParked) void persistParkedState()
    })
  }

  if (chromeApi?.windows?.onRemoved?.addListener) {
    chromeApi.windows.onRemoved.addListener((winId: number) => {
      if (parkedWindowId !== null && Number(parkedWindowId) === winId) {
        parkedWindowId = null
        void persistParkedState()
      }
      let dirtyGroups = false
      for (const key of Array.from(panelGroupIds.keys())) {
        if (key.startsWith(`${winId}:`)) {
          panelGroupIds.delete(key)
          dirtyGroups = true
        }
      }
      if (dirtyGroups) void persistPanelGroups()
    })
  }
}

export async function init(): Promise<void> {
  if (initialized) return
  if (initPromise) return initPromise

  initPromise = (async () => {
    attachListeners()
    await readLocalSettingsMode()

    const sessionData = await readSession([
      SESSION_HIDDEN_TABS_KEY,
      SESSION_PARKED_WIN_KEY,
      SESSION_PARKED_ORIGINS_KEY,
      SESSION_PANEL_GROUPS_KEY,
    ])

    hiddenTabIds.clear()
    if (Array.isArray(sessionData[SESSION_HIDDEN_TABS_KEY])) {
      for (const id of sessionData[SESSION_HIDDEN_TABS_KEY]) hiddenTabIds.add(id)
    }

    parkedWindowId = sessionData[SESSION_PARKED_WIN_KEY] ?? null
    if (parkedWindowId !== null) {
      const chromeApi = getChrome()
      if (chromeApi?.windows?.get) {
        try {
          await chromeApi.windows.get(Number(parkedWindowId))
        } catch {
          parkedWindowId = null
        }
      }
    }

    parkedOrigins.clear()
    const rawOrigins = sessionData[SESSION_PARKED_ORIGINS_KEY]
    if (rawOrigins && typeof rawOrigins === 'object') {
      for (const [k, v] of Object.entries(rawOrigins as Record<string, ParkedTabOrigin>)) {
        if (v && typeof v === 'object') parkedOrigins.set(normalizeIdKey(k), v)
      }
    }

    panelGroupIds.clear()
    const rawGroups = sessionData[SESSION_PANEL_GROUPS_KEY]
    if (rawGroups && typeof rawGroups === 'object') {
      for (const [k, v] of Object.entries(rawGroups as Record<string, number>)) {
        if (typeof v === 'number') panelGroupIds.set(k, v)
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

export function isTabHidden(tabId: ID): boolean {
  return hiddenTabIds.has(tabId)
}

export function getParkedWindowId(): ID | null {
  return parkedWindowId
}

async function ensureParkedWindow(): Promise<{ windowId: ID; placeholderTabId?: number } | null> {
  const chromeApi = getChrome()
  if (!chromeApi?.windows?.create) return null

  if (parkedWindowId !== null) {
    try {
      const win = await chromeApi.windows.get(Number(parkedWindowId))
      if (win?.id !== undefined) return { windowId: win.id }
    } catch {
      parkedWindowId = null
    }
  }

  try {
    const created = await chromeApi.windows.create({
      state: 'minimized',
      focused: false,
      type: 'normal',
    })
    if (created?.id === undefined) return null
    parkedWindowId = created.id
    await persistParkedState()
    const placeholderTabId = created.tabs?.[0]?.id
    return { windowId: created.id, placeholderTabId }
  } catch {
    return null
  }
}

async function parkTabs(ids: ID[]): Promise<void> {
  const chromeApi = getChrome()
  if (!chromeApi?.tabs?.get || !chromeApi?.tabs?.move) return

  const ensured = await ensureParkedWindow()
  if (!ensured) return

  const targetWinId = Number(ensured.windowId)
  const tabsToMove: number[] = []

  for (const id of ids) {
    const numId = Number(id)
    if (Number.isNaN(numId)) continue
    try {
      const tab = await chromeApi.tabs.get(numId)
      if (!tab || tab.pinned) continue
      if (tab.windowId === targetWinId) continue

      if (!parkedOrigins.has(id)) {
        parkedOrigins.set(id, { windowId: tab.windowId, index: tab.index ?? 0 })
      }
      tabsToMove.push(numId)
    } catch {
      // Tab no longer exists
    }
  }

  if (tabsToMove.length) {
    try {
      await chromeApi.tabs.move(tabsToMove, { windowId: targetWinId, index: -1 })
    } catch {
      // Best-effort per-tab move if batch fails
      for (const tabId of tabsToMove) {
        try {
          await chromeApi.tabs.move(tabId, { windowId: targetWinId, index: -1 })
        } catch {
          parkedOrigins.delete(tabId)
        }
      }
    }

    if (ensured.placeholderTabId !== undefined && chromeApi.tabs.remove) {
      try {
        await chromeApi.tabs.remove(ensured.placeholderTabId)
      } catch {
        // Ignore if placeholder already closed
      }
    }
    await persistParkedState()
  }
}

async function unparkTabs(ids: ID[], fallbackWindowId?: ID): Promise<void> {
  const chromeApi = getChrome()
  if (!chromeApi?.tabs?.get || !chromeApi?.tabs?.move) return

  const toRestore: Array<{ tabId: ID; numericId: number; windowId: number; index: number }> = []
  let defaultFallbackWinId: number | undefined =
    fallbackWindowId !== undefined ? Number(fallbackWindowId) : undefined

  if (defaultFallbackWinId === undefined || Number.isNaN(defaultFallbackWinId)) {
    try {
      const wins = (await chromeApi.windows.getAll({ windowTypes: ['normal'] })) ?? []
      const normalWin = wins.find((w: any) => w.id !== undefined && w.id !== parkedWindowId)
      if (normalWin?.id !== undefined) defaultFallbackWinId = Number(normalWin.id)
    } catch {
      // Ignore
    }
  }

  for (const id of ids) {
    const numId = Number(id)
    if (Number.isNaN(numId)) continue
    const origin = parkedOrigins.get(id)
    let tab: any
    try {
      tab = await chromeApi.tabs.get(numId)
    } catch {
      parkedOrigins.delete(id)
      continue
    }
    if (!tab) continue

    const isInParkedWin = parkedWindowId !== null && tab.windowId === Number(parkedWindowId)
    if (!isInParkedWin && !origin) continue

    let dstWinId = origin ? Number(origin.windowId) : defaultFallbackWinId
    if (dstWinId !== undefined && chromeApi.windows?.get) {
      try {
        await chromeApi.windows.get(dstWinId)
      } catch {
        dstWinId = defaultFallbackWinId
      }
    }
    if (dstWinId === undefined || Number.isNaN(dstWinId)) continue

    toRestore.push({
      tabId: id,
      numericId: numId,
      windowId: dstWinId,
      index: origin?.index ?? -1,
    })
  }

  if (!toRestore.length) return

  // Restore in ascending index order so indices don't invert
  toRestore.sort((a, b) => a.index - b.index)

  for (const item of toRestore) {
    try {
      await chromeApi.tabs.move(item.numericId, {
        windowId: item.windowId,
        index: item.index,
      })
      parkedOrigins.delete(item.tabId)
    } catch {
      try {
        await chromeApi.tabs.move(item.numericId, { windowId: item.windowId, index: -1 })
        parkedOrigins.delete(item.tabId)
      } catch {
        // Ignore if tab/window vanished
      }
    }
  }

  if (parkedWindowId !== null && chromeApi.tabs?.query) {
    try {
      const remaining = await chromeApi.tabs.query({ windowId: Number(parkedWindowId) })
      if (!remaining || remaining.length === 0) parkedWindowId = null
    } catch {
      parkedWindowId = null
    }
  }

  await persistParkedState()
}

async function setTabGroupCollapsedForTabs(ids: ID[], collapsed: boolean): Promise<void> {
  const chromeApi = getChrome()
  if (!chromeApi?.tabs?.get || !chromeApi?.tabGroups?.update) return

  const seenGroups = new Set<number>()
  for (const id of ids) {
    const numId = Number(id)
    if (Number.isNaN(numId)) continue
    try {
      const tab = await chromeApi.tabs.get(numId)
      if (!tab || tab.pinned) continue
      if (collapsed && tab.active) continue
      if (typeof tab.groupId === 'number' && tab.groupId !== -1 && !seenGroups.has(tab.groupId)) {
        seenGroups.add(tab.groupId)
        try {
          await chromeApi.tabGroups.update(tab.groupId, { collapsed })
        } catch {
          // Chrome throws if collapsing a group that contains the active tab
        }
      }
    } catch {
      // Ignore missing tab
    }
  }
}

export async function hideTabs(tabIds: ID | ID[]): Promise<void> {
  await ensureInitialized()
  const ids = toTabIdList(tabIds)
  if (!ids.length) return

  const changed: Array<{ tabId: ID; hidden: boolean }> = []
  for (const id of ids) {
    if (!hiddenTabIds.has(id)) {
      hiddenTabIds.add(id)
      changed.push({ tabId: id, hidden: true })
    }
  }

  if (changed.length) {
    await persistHiddenTabs()
    emitHiddenChanges(changed)
  }

  const mode = await getIsolationMode()
  if (mode === 'windowParking') {
    await parkTabs(ids)
  } else if (mode === 'tabGroups') {
    await setTabGroupCollapsedForTabs(ids, true)
  }
}

export async function showTabs(tabIds: ID | ID[]): Promise<void> {
  await ensureInitialized()
  const ids = toTabIdList(tabIds)
  if (!ids.length) return

  const changed: Array<{ tabId: ID; hidden: boolean }> = []
  for (const id of ids) {
    if (hiddenTabIds.delete(id)) {
      changed.push({ tabId: id, hidden: false })
    }
  }

  if (changed.length) {
    await persistHiddenTabs()
    emitHiddenChanges(changed)
  }

  const mode = await getIsolationMode()
  if (mode === 'windowParking') {
    await unparkTabs(ids)
  } else if (mode === 'tabGroups') {
    await setTabGroupCollapsedForTabs(ids, false)
  }
}

async function syncTabGroupsForWindow(
  windowId: ID,
  activePanelId: ID,
  tabs: IsolationTabInput[],
  panelsById?: Record<ID, IsolationPanelInfo>
): Promise<void> {
  const chromeApi = getChrome()
  if (!chromeApi?.tabs?.group || !chromeApi?.tabGroups) return

  const numericWinId = Number(windowId)
  if (Number.isNaN(numericWinId)) return

  let existingGroups: Array<{ id: number; title?: string; color?: string; collapsed?: boolean }> = []
  try {
    existingGroups = (await chromeApi.tabGroups.query({ windowId: numericWinId })) ?? []
  } catch {
    existingGroups = []
  }
  const existingGroupIds = new Set(existingGroups.map(g => g.id))

  const tabsByPanel = new Map<ID, IsolationTabInput[]>()
  for (const tab of tabs) {
    if (tab.pinned) continue
    if (tab.panelId === undefined || tab.panelId === -1) continue
    let list = tabsByPanel.get(tab.panelId)
    if (!list) {
      list = []
      tabsByPanel.set(tab.panelId, list)
    }
    list.push(tab)
  }

  let groupsDirty = false
  for (const [panelId, panelTabs] of tabsByPanel.entries()) {
    const tabIds = panelTabs.map(t => Number(t.id)).filter(n => !Number.isNaN(n))
    if (!tabIds.length) continue

    const panelInfo = panelsById?.[panelId]
    const title = panelInfo?.name ?? String(panelId)
    const color = mapColorToChromeTabGroupColor(panelInfo?.color)
    const mapKey = `${numericWinId}:${panelId}`

    let groupId = panelGroupIds.get(mapKey)
    if (groupId !== undefined && !existingGroupIds.has(groupId)) {
      const byTitle = existingGroups.find(g => g.title === title)
      groupId = byTitle?.id
    }

    try {
      if (groupId !== undefined && existingGroupIds.has(groupId)) {
        await chromeApi.tabs.group({ groupId, tabIds })
      } else {
        groupId = await chromeApi.tabs.group({
          createProperties: { windowId: numericWinId },
          tabIds,
        })
        if (groupId !== undefined) {
          existingGroupIds.add(groupId)
          panelGroupIds.set(mapKey, groupId)
          groupsDirty = true
        }
      }

      if (groupId !== undefined) {
        const hasActiveTab = panelTabs.some(t => t.active)
        const shouldCollapse = panelId !== activePanelId && !hasActiveTab
        await chromeApi.tabGroups.update(groupId, {
          title,
          color,
          collapsed: shouldCollapse,
        })
      }
    } catch {
      // Ignore transient tab/group errors (e.g. tab closing mid-update)
    }
  }

  if (groupsDirty) await persistPanelGroups()
}

export async function syncWindowIsolation(
  windowId: ID,
  activePanelId: ID,
  tabs: IsolationTabInput[],
  panelsById?: Record<ID, IsolationPanelInfo>
): Promise<void> {
  await ensureInitialized()

  const toShow: ID[] = []
  const toHide: ID[] = []
  const changed: Array<{ tabId: ID; hidden: boolean }> = []

  for (const tab of tabs) {
    if (tab.pinned) {
      if (hiddenTabIds.delete(tab.id)) {
        changed.push({ tabId: tab.id, hidden: false })
      }
      continue
    }

    const isActivePanelTab = tab.panelId === activePanelId
    if (isActivePanelTab) {
      toShow.push(tab.id)
      if (hiddenTabIds.delete(tab.id)) {
        changed.push({ tabId: tab.id, hidden: false })
      }
    } else {
      toHide.push(tab.id)
      if (!hiddenTabIds.has(tab.id)) {
        hiddenTabIds.add(tab.id)
        changed.push({ tabId: tab.id, hidden: true })
      }
    }
  }

  if (changed.length) {
    await persistHiddenTabs()
    emitHiddenChanges(changed)
  }

  const mode = await getIsolationMode()
  if (mode === 'virtual') return

  if (mode === 'tabGroups') {
    await syncTabGroupsForWindow(windowId, activePanelId, tabs, panelsById)
  } else if (mode === 'windowParking') {
    // Park inactive tabs before unparking so an existing parked window stays open and is reused without flicker
    if (toHide.length) await parkTabs(toHide)
    if (toShow.length) await unparkTabs(toShow, windowId)
  }
}

export const PanelIsolationEngine = {
  init,
  hideTabs,
  showTabs,
  isTabHidden,
  syncWindowIsolation,
  getParkedWindowId,
  onHiddenStateChanged,
}
