import * as T from 'src/types'
import { RemovingSnapshotResult, SnapStoreMode, PanelType } from 'src/enums'
import { NOID, CONTAINER_ID, DEFAULT_CONTAINER_ID } from 'src/defaults'
import * as Utils from 'src/utils'
import * as Logs from 'src/services/logs'
import * as Settings from 'src/services/settings'
import * as Windows from 'src/services/windows.bg'
import * as Tabs from 'src/services/tabs.bg'
import * as Store from 'src/services/storage.bg'
import * as IPC from 'src/services/ipc'
import * as Containers from 'src/services/containers.bg'
import * as SidebarConf from 'src/services/sidebar-config'
import * as TabTreeAnchor from 'src/services/tab-tree-anchor'

import {
  GLOB_PINNED_ID,
  MAX_SIZE_LIMIT,
  AnySnapshot,
  AnySnapTab,
  getNormalizedSnapshot,
  minimizeSnapshot,
  prepareExport,
} from 'src/services/snapshots'
export * from 'src/services/snapshots'

export interface SnapshotsState {
  list: T.Snapshot[]
}

export const Snapshots = {
  state: { list: [] } as SnapshotsState,
}

export const SNAPSHOT_ALARM_NAME = 'sidebery_periodic_snapshot'
const MIN_SNAP_INTERVAL = 60_000
const MIN_LIMITING_COUNT = 1

interface ChromeAlarmsLike {
  create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }): Promise<void> | void
  clear(name?: string): Promise<boolean> | void
  onAlarm?: {
    addListener(cb: (alarm: { name: string }) => void): void
    removeListener?(cb: (alarm: { name: string }) => void): void
  }
}

function getAlarmsApi(): ChromeAlarmsLike | undefined {
  const g = globalThis as any
  return g.chrome?.alarms ?? g.browser?.alarms
}

function hasIpcState(): boolean {
  try {
    return !!(IPC as any)?.state?.sidebarConnections
  } catch {
    return false
  }
}

async function storeSet(values: T.Stored): Promise<void> {
  if (hasIpcState()) {
    return Store.set(values)
  }
  return browser.storage.local.set<T.Stored>(values)
}

async function getStoredKeys<K extends keyof T.Stored>(...keys: K[]): Promise<Partial<T.Stored>> {
  const results = await Promise.all(
    keys.map(k =>
      browser.storage.local
        .get<T.Stored>(k)
        .catch(() => ({}) as T.Stored)
    )
  )
  const merged: Partial<T.Stored> = {}
  for (const res of results) {
    if (res && typeof res === 'object') {
      Object.assign(merged, res)
    }
  }
  return merged
}

/**
 * Create base snapshot
 */
export async function createSnapshot(auto = false): Promise<T.Snapshot | undefined> {
  Logs.info('Snapshots.bg.createSnapshot', auto)

  // Get snapshot src data and current snapshots list
  const [stored] = await Promise.all([
    getStoredKeys('sidebar', 'containers', 'snapshots'),
    Tabs.updateBgTabsTreeData().catch(() => {}),
    TabTreeAnchor.init().catch(() => {}),
  ])
  if (!stored) {
    Logs.err('createSnapshot: Cannot get source data')
    return
  }

  if (!stored.containers) stored.containers = {}
  if (!stored.sidebar) stored.sidebar = SidebarConf.createDefaultSidebarConfig()
  if (!stored.snapshots) stored.snapshots = []

  // Get tabs info per window per panel
  const tabs: AnySnapTab[][][] = []
  for (const window of Windows.byId.values()) {
    if (Settings.state.snapExcludePrivate && window.incognito) continue
    if (window.id === undefined || !window.tabs) continue
    if (window.type !== 'normal') continue

    const winTabs: AnySnapTab[][] = []
    const snapTabsById: Record<ID, AnySnapTab> = {}
    let panelTabs: AnySnapTab[] | undefined
    let targetGroup: ID = ''

    for (const tab of window.tabs) {
      // Recover tree/panel anchor if sidebar wasn't connected during updateBgTabsTreeData
      if ((tab.panelId === undefined || tab.panelId === NOID) && (tab.parentId === undefined || tab.parentId === NOID)) {
        const anchoredData = await TabTreeAnchor.getTabValue<T.TabSessionData>(tab.id, 'data').catch(() => undefined)
        if (anchoredData) {
          if (anchoredData.panelId !== undefined) tab.panelId = anchoredData.panelId
          if (anchoredData.parentId !== undefined) tab.parentId = anchoredData.parentId
          if (anchoredData.folded) tab.folded = true
          if (anchoredData.customTitle && !tab.customTitle) tab.customTitle = anchoredData.customTitle
          if (anchoredData.customColor && !tab.customColor) tab.customColor = anchoredData.customColor
        }
      }

      const anchoredTitle =
        !tab.title || tab.title === tab.url || tab.discarded
          ? TabTreeAnchor.getTabTitle(tab.id)
          : undefined

      const snapTab: AnySnapTab = {
        url: tab.url,
        title: (!tab.title || tab.title === tab.url) && anchoredTitle ? anchoredTitle : tab.title,
        panelId: tab.panelId ?? NOID,
      }
      const parent = snapTabsById[tab.parentId ?? NOID]
      if (parent && parent.panelId === tab.panelId) snapTab.lvl = (parent.lvl ?? 0) + 1
      if (tab.pinned) {
        snapTab.pinned = true
        if (Settings.state.pinnedTabsPosition !== 'panel') snapTab.panelId = -1
      }
      if (tab.folded) snapTab.folded = true

      // Resolve containerId from cookieStoreId or TabTreeAnchor in Chrome
      let containerId: string | undefined
      if (tab.cookieStoreId && tab.cookieStoreId !== CONTAINER_ID) {
        containerId = tab.cookieStoreId
      } else {
        containerId = TabTreeAnchor.getTabContainerId(tab.id) ?? tab.containerId
      }
      if (containerId) snapTab.containerId = containerId

      if (tab.customTitle) snapTab.customTitle = tab.customTitle
      if (tab.customColor) snapTab.customColor = tab.customColor

      // Restore Firefox/original URL cleanly
      const anchoredOriginalUrl = TabTreeAnchor.getTabOriginalUrl(tab.id) ?? tab.originalUrl
      const restoredUrl = Utils.restoreOriginalUrlForExport(snapTab.url, anchoredOriginalUrl)
      snapTab.url = restoredUrl
      if (anchoredOriginalUrl && anchoredOriginalUrl !== restoredUrl) {
        snapTab.originalUrl = anchoredOriginalUrl
      }

      snapTabsById[tab.id] = snapTab

      // Check panel
      if (snapTab.panelId !== -1) {
        const panelConf = stored.sidebar.panels[snapTab.panelId]
        if (!panelConf) {
          Logs.warn('Snapshots.createSnapshot: Unable to find a panel for tab:', snapTab.panelId)
          snapTab.panelId = -1
        }
      }

      // Check container
      if (snapTab.containerId) {
        const containerConf = stored.containers[snapTab.containerId]
        if (!containerConf) snapTab.containerId = undefined
      }

      // Pinned tabs
      if (tab.pinned && targetGroup !== 'pinned') {
        panelTabs = []
        winTabs.push(panelTabs)
        targetGroup = 'pinned'
      }

      // Tabs by panel
      if (!tab.pinned && targetGroup !== tab.panelId) {
        panelTabs = []
        winTabs.push(panelTabs)
        targetGroup = tab.panelId ?? NOID
      }

      if (panelTabs) panelTabs.push(snapTab)
    }

    // Mark private window
    if (window.incognito && winTabs[0]?.[0]) {
      winTabs[0][0].priv = true
    }

    tabs.push(winTabs)
  }

  if (!tabs.length) {
    Logs.warn('Snapshots.createSnapshot: No tabs')
    return
  }

  const currentSnapshot: T.NormalizedSnapshot = {
    id: Math.random().toString(36).replace('0.', Date.now().toString(36)),
    time: Date.now(),
    containers: stored.containers,
    sidebar: stored.sidebar,
    tabs,
  }

  if (Settings.state.snapAutoExport) {
    exportSnapshot(currentSnapshot)
  }

  minimizeSnapshot(stored.snapshots, currentSnapshot)

  const prevSnapshot = stored.snapshots[stored.snapshots.length - 1]
  if (auto && prevSnapshot && isSnapshotRedundant(prevSnapshot, currentSnapshot)) return

  stored.snapshots.push(currentSnapshot)

  try {
    const limited = limitSnapshots(stored.snapshots)
    if (limited) stored.snapshots = limited
  } catch (err) {
    Logs.err('Cannot limit snapshots', err)
  }

  await storeSet({ snapshots: stored.snapshots, lastSnapTime: currentSnapshot.time })

  if (Settings.state.snapNotify) {
    IPC.sendToSidebars('notifyAboutNewSnapshot')
  }

  return currentSnapshot
}

export async function addSnapshot(snapshot: T.NormalizedSnapshot): Promise<void> {
  const stored = await browser.storage.local.get<T.Stored>('snapshots').catch(() => undefined)
  const snapshots = stored?.snapshots ?? []
  const timestamp = Date.now()

  snapshot.time = timestamp
  snapshots.push(snapshot)

  return await storeSet({ snapshots, lastSnapTime: timestamp })
}

function getExportPath(expInfo: T.SnapExportInfo) {
  let snapAutoExportPath = Settings.state.snapAutoExportPath
  if (!snapAutoExportPath) snapAutoExportPath = 'Sidebery/snapshot-%Y.%M.%D-%h.%m.%s'
  snapAutoExportPath = Utils.dateTimeTemplate(snapAutoExportPath, expInfo.time)
  snapAutoExportPath = snapAutoExportPath.replace(/^\.+/, '')

  const pathArr = snapAutoExportPath.split(/\/|\\/)
  const normPathArr = pathArr.filter(part => !!part)
  const normPath = normPathArr.join('/')

  return normPath
}

export function exportSnapshot(snapshot: T.NormalizedSnapshot) {
  if (!browser?.downloads) return

  const expType = Settings.state.snapAutoExportType
  const wantJSON = expType === 'json' || expType === 'both'
  const wantMD = expType === 'md' || expType === 'both'

  const expInfo = prepareExport(snapshot, {
    JSON: wantJSON,
    Markdown: wantMD,
  })

  const path = getExportPath(expInfo)
  const hasCreateObjectURL =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'

  if (wantJSON) {
    const jsonUrl =
      hasCreateObjectURL && expInfo.jsonFile
        ? URL.createObjectURL(expInfo.jsonFile)
        : `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(snapshot))}`

    browser.downloads.download({
      url: jsonUrl,
      filename: `${path}.json`,
      conflictAction: 'overwrite',
      saveAs: false,
    })
  }

  if (wantMD && expInfo.md !== undefined) {
    const mdUrl =
      hasCreateObjectURL && expInfo.mdFile
        ? URL.createObjectURL(expInfo.mdFile)
        : `data:text/markdown;charset=utf-8,${encodeURIComponent(expInfo.md)}`

    browser.downloads.download({
      url: mdUrl,
      filename: `${path}.md`,
      conflictAction: 'overwrite',
      saveAs: false,
    })
  }
}

function isSnapshotRedundant(prevSnapshot: T.Snapshot, snapshot: T.Snapshot): boolean {
  if (snapshot.containers !== SnapStoreMode.Unchanged) return false
  if (snapshot.sidebar !== SnapStoreMode.Unchanged) return false

  if (prevSnapshot.tabs.length !== snapshot.tabs.length) return false

  for (let wi = 0; wi < snapshot.tabs.length; wi++) {
    const win = snapshot.tabs[wi]
    const prevWin = prevSnapshot.tabs[wi]
    if (!win) return false
    if (prevWin?.length !== win?.length) return false

    for (let pi = 0; pi < win.length; pi++) {
      const panel = win[pi]
      const prevPanel = prevWin[pi]
      if (!panel) return false
      if (prevPanel?.length !== panel?.length) return false

      for (const tab of panel) {
        if (tab !== SnapStoreMode.Unchanged) return false
      }
    }
  }
  return true
}

let registeredAlarmTarget: any = null
function onAlarmFired(alarm: { name: string }): void {
  if (alarm?.name !== SNAPSHOT_ALARM_NAME) return
  void createSnapshot(true)
}

export function setupAlarmsListener(): void {
  const alarms = getAlarmsApi()
  if (!alarms?.onAlarm) return
  if (registeredAlarmTarget === alarms.onAlarm) return
  registeredAlarmTarget = alarms.onAlarm
  alarms.onAlarm.addListener(onAlarmFired)
}

export async function scheduleSnapshots(): Promise<void> {
  clearTimeout(scheduleTimeout)
  scheduleTimeout = undefined

  const alarms = getAlarmsApi()
  if (alarms?.clear) {
    try {
      await alarms.clear(SNAPSHOT_ALARM_NAME)
    } catch {
      // ignore alarm clear failure
    }
  }

  const interval = getSnapInterval()
  if (interval < MIN_SNAP_INTERVAL) return

  const elapsed = await getLastSnapTimeElapsed()
  let nextInterval = interval - elapsed
  if (nextInterval < MIN_SNAP_INTERVAL) nextInterval = MIN_SNAP_INTERVAL

  if (alarms?.create) {
    try {
      setupAlarmsListener()
      await alarms.create(SNAPSHOT_ALARM_NAME, {
        delayInMinutes: nextInterval / 60_000,
        periodInMinutes: interval / 60_000,
      })
      return
    } catch (err) {
      Logs.warn('Snapshots.scheduleSnapshots: chrome.alarms.create failed, falling back to setTimeout', err)
    }
  }

  scheduleNextSnapshot(nextInterval)
}

let scheduleTimeout: ReturnType<typeof setTimeout> | number | undefined
function scheduleNextSnapshot(nextTimeout: number): void {
  scheduleTimeout = setTimeout(() => {
    nextTimeout = getSnapInterval()
    if (nextTimeout < MIN_SNAP_INTERVAL) nextTimeout = MIN_SNAP_INTERVAL
    void createSnapshot(true)
    scheduleNextSnapshot(nextTimeout)
  }, nextTimeout)
}

function getSnapInterval(): number {
  let interval = Settings.state.snapInterval
  const unit = Settings.state.snapIntervalUnit
  if (!interval || typeof interval !== 'number') return 0
  if (unit === 'min') interval = Settings.state.snapInterval * 60000
  if (unit === 'hr') interval = Settings.state.snapInterval * 3600000
  if (unit === 'day') interval = Settings.state.snapInterval * 86400000
  return interval
}

async function getLastSnapTimeElapsed(): Promise<number> {
  const stored = await browser.storage.local
    .get<T.Stored>('lastSnapTime')
    .catch(() => ({}) as T.Stored)
  const now = Date.now()
  const lastSnapTime = stored?.lastSnapTime ?? now
  const elapsed = now - lastSnapTime
  if (elapsed < 0) return 0
  return elapsed
}

async function adaptContainers(snapshot: T.NormalizedSnapshot): Promise<void> {
  const currentContainers = Object.values(Containers.reactive.byId)
  const oldNewIds: Record<string, string> = {}

  for (const container of Object.values(snapshot.containers)) {
    let sColor = container.color
    if (sColor === 'turquoise') sColor = 'cyan'
    if (sColor === 'toolbar') sColor = 'gray'

    const currentContainer = currentContainers.find(c => {
      let lColor = c.color
      if (lColor === 'turquoise') lColor = 'cyan'
      if (lColor === 'toolbar') lColor = 'gray'
      return c.name === container.name && c.icon === container.icon && lColor === sColor
    })

    // Create new container
    if (!currentContainer) {
      try {
        const newContainer = await Containers.create(Utils.clone(container))
        oldNewIds[container.id] = newContainer.id
      } catch {
        // Fallback when contextualIdentities.create is unavailable (e.g. Chrome MV3 virtual containers or tests)
        const clonedContainer = Utils.clone(container)
        Containers.reactive.byId[clonedContainer.id] = clonedContainer
        oldNewIds[container.id] = clonedContainer.id
      }
    }

    // Do nothing with existed
    else {
      oldNewIds[container.id] = currentContainer.id
    }
  }

  // Update snapshot tabs container ids
  for (const win of snapshot.tabs) {
    for (const panel of win) {
      for (const tab of panel) {
        if (tab.containerId && oldNewIds[tab.containerId]) {
          tab.containerId = oldNewIds[tab.containerId]
        }
      }
    }
  }

  // Save containers config
  if (hasIpcState()) {
    await Containers.saveContainers().catch(() => {})
  } else {
    await storeSet({ containers: Utils.clone(Containers.reactive.byId) }).catch(() => {})
  }
}

async function adaptTabsPanels(snapshot: T.NormalizedSnapshot): Promise<void> {
  const stored = await browser.storage.local
    .get<T.Stored>('sidebar')
    .catch(() => ({}) as T.Stored)
  if (!stored?.sidebar?.nav) return

  // Find last index of tabs panel
  let lastStoredTabsPanelIndex = stored.sidebar.nav.length
  while (lastStoredTabsPanelIndex-- > 0) {
    const storedId = stored.sidebar.nav[lastStoredTabsPanelIndex]
    if (storedId === undefined) break
    const storedPanel = stored.sidebar.panels[storedId]
    if (storedPanel && storedPanel.type === PanelType.tabs) break
  }

  // Recreate tabs panels
  let changed = false
  for (let i = 0; i < snapshot.sidebar.nav.length; i++) {
    const snapNavId = snapshot.sidebar.nav[i]
    if (snapNavId === undefined) continue
    const snapPanel = snapshot.sidebar.panels[snapNavId]
    if (!snapPanel || snapPanel.type !== PanelType.tabs) continue

    const storedIndex = stored.sidebar.nav.indexOf(snapNavId)
    if (storedIndex === -1) {
      changed = true
      lastStoredTabsPanelIndex++
      stored.sidebar.nav.splice(lastStoredTabsPanelIndex, 0, snapNavId)
      stored.sidebar.panels[snapNavId] = snapPanel
    }
  }

  // Update snapshot tabs ordering
  for (let i = 0; i < snapshot.tabs.length; i++) {
    const win = snapshot.tabs[i]
    if (!win || win.length <= 1) continue

    const newOrder: T.SnapTab[][] = []

    // Pinned tabs
    if (win[0]?.[0]?.pinned) {
      newOrder.push(win[0])
      win.shift()
    }

    // Tabs list w/o panelId in the first tab
    for (const tabs of win) {
      if (tabs[0]?.panelId === NOID) {
        Logs.warn('Snapshots.adaptTabsPanels: Tabs list without panelId, len:', tabs.length)
        newOrder.push(tabs)
      }
    }

    for (const storedId of stored.sidebar.nav) {
      const storedPanel = stored.sidebar.panels[storedId]
      if (!storedPanel || storedPanel.type !== PanelType.tabs) continue

      const snapPanelTabs = win.find(tabs => tabs[0]?.panelId === storedPanel.id)
      if (snapPanelTabs) newOrder.push(snapPanelTabs)
      else continue
    }

    snapshot.tabs[i] = newOrder
  }

  if (changed) await storeSet({ sidebar: stored.sidebar })
}

/**
 * Open windows (all or by index) of snapshot
 */
export async function openWindows(
  snapshot: T.NormalizedSnapshot,
  winIndex?: number,
  incognito: boolean = false
): Promise<void> {
  Logs.info('Snapshots.openWindows')

  // Adapt containers
  await adaptContainers(snapshot)

  // Adapt nav and panels
  await adaptTabsPanels(snapshot)

  // Open windows
  if (winIndex === undefined) {
    for (let i = 0; i < snapshot.tabs.length; i++) {
      await openWindow(snapshot, i, incognito)
    }
  } else {
    await openWindow(snapshot, winIndex, incognito)
  }
}

export interface ApplySnapshotOptions {
  winIndex?: number
  incognito?: boolean
  adaptContainers?: boolean
  adaptPanels?: boolean
}

/**
 * Normalize (if needed), adapt containers/panels, and open snapshot window(s).
 */
export async function applySnapshot(
  snapshot: AnySnapshot | T.NormalizedSnapshot,
  opts: ApplySnapshotOptions = {}
): Promise<T.NormalizedSnapshot | undefined> {
  const norm = getNormalizedSnapshot([snapshot], 0)
  if (!norm) return undefined

  if (opts.adaptContainers !== false) {
    await adaptContainers(norm)
  }
  if (opts.adaptPanels !== false) {
    await adaptTabsPanels(norm)
  }

  if (opts.winIndex === undefined) {
    for (let i = 0; i < norm.tabs.length; i++) {
      await openWindow(norm, i, !!opts.incognito)
    }
  } else {
    await openWindow(norm, opts.winIndex, !!opts.incognito)
  }

  return norm
}

/**
 * Open window of snapshot
 */
export async function openWindow(
  snapshot: T.NormalizedSnapshot,
  winIndex: number,
  incognito: boolean = false
): Promise<void> {
  Logs.info('Snapshots.openWindow')

  const winTabs = snapshot.tabs[winIndex]
  if (!winTabs) return Logs.warn('Snapshots.openWindow: No winTabs')

  // Create tabs info
  const items: T.ItemInfo[] = []
  const tabsInfoByLvl: Record<number, T.ItemInfo> = {}
  let index = 0
  for (const panel of winTabs) {
    Logs.info('Snapshots.openWindow: panel/pin panelId, len:', panel[0]?.panelId, panel.length)

    for (const rawTab of panel) {
      const tab = rawTab as AnySnapTab
      if (tab.panelId === GLOB_PINNED_ID) tab.panelId = NOID

      const sourceUrl = tab.originalUrl ?? tab.url
      const { chromeUrl, originalUrl } = Utils.translateFirefoxUrlForChrome(sourceUrl, tab.title)
      const url = chromeUrl !== undefined ? Utils.sanitizeUrl(chromeUrl, tab.title) : undefined

      const tabInfo: T.ItemInfo = {
        id: index++,
        url,
        originalUrl,
        chromeUrl,
        title: tab.title,
        parentId: NOID,
        folded: tab.folded,
        panelId: tab.panelId ?? NOID,
        container: tab.containerId ?? DEFAULT_CONTAINER_ID,
        containerId: tab.containerId,
        lvl: tab.lvl,
      }
      if (tab.customTitle) tabInfo.customTitle = tab.customTitle
      if (tab.customColor) tabInfo.customColor = tab.customColor
      tabsInfoByLvl[tab.lvl ?? 0] = tabInfo

      if (tab.pinned) tabInfo.pinned = true

      if (tab.lvl) {
        const parent = tabsInfoByLvl[tab.lvl - 1]
        if (parent) tabInfo.parentId = parent.id
      }

      items.push(tabInfo)
    }
  }

  const firstItem = items[0]
  if (firstItem) firstItem.active = true

  await Windows.createWithTabs(items, { incognito: incognito })
}

const sizeCalcBuffer = new Uint8Array(MAX_SIZE_LIMIT * 1024 + 4)
const sizeCalcEncoder = new TextEncoder()

function limitSnapshots(snapshots: T.Snapshot[]): T.Snapshot[] | undefined {
  if (snapshots.length <= MIN_LIMITING_COUNT) return

  const normMaxSize = MAX_SIZE_LIMIT * 1024
  let limit = Settings.state.snapLimit
  let unit = Settings.state.snapLimitUnit

  if (!limit || limit < 0) {
    limit = MAX_SIZE_LIMIT
    unit = 'kb'
  }

  let normLimit = limit
  if (unit === 'day') normLimit = Date.now() - limit * 86400000
  else if (unit === 'kb') {
    if (limit > MAX_SIZE_LIMIT) limit = MAX_SIZE_LIMIT
    normLimit = limit * 1024
  }

  let index = snapshots.length
  let accum = 0
  let sizeAccum = 0
  while (index--) {
    const snapshot = snapshots[index]
    if (!snapshot) continue

    sizeAccum += sizeCalcEncoder.encodeInto(JSON.stringify(snapshot), sizeCalcBuffer).written

    if (unit === 'snap') {
      accum++
      if (accum > normLimit) break
    }

    if (unit === 'kb' && sizeAccum > normLimit) break

    if (unit === 'day' && snapshot.time < normLimit) break

    if (sizeAccum > normMaxSize) break
  }

  index++

  const normSnapshot = getNormalizedSnapshot(snapshots, index)
  if (normSnapshot) snapshots[index] = normSnapshot
  else return

  return snapshots.slice(index)
}

export async function removeSnapshot(id: ID): Promise<RemovingSnapshotResult> {
  let stored
  try {
    stored = await browser.storage.local.get<T.Stored>('snapshots')
  } catch (err) {
    Logs.err('removeSnapshot: Cannot get snapshots', err)
    return RemovingSnapshotResult.Err
  }
  if (!stored.snapshots) return RemovingSnapshotResult.Err

  const index = stored.snapshots.findIndex(s => s.id === id)
  const snapshot = stored.snapshots[index]
  if (!snapshot) return RemovingSnapshotResult.Err

  const nextSnapshot = stored.snapshots[index + 1]
  if (nextSnapshot) {
    const normSnapshot = getNormalizedSnapshot(stored.snapshots, index + 1)
    if (!normSnapshot) return RemovingSnapshotResult.Err
    stored.snapshots[index + 1] = normSnapshot
  }

  stored.snapshots.splice(index, 1)

  await storeSet(stored)

  return RemovingSnapshotResult.Ok
}
