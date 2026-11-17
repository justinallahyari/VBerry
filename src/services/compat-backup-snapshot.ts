import type {
  BackupData,
  Container,
  NormalizedSnapshot,
  PanelConfig,
  Snapshot,
  Stored,
} from 'src/types'
import * as D from 'src/defaults'
import * as Utils from 'src/utils'
import * as Settings from 'src/services/settings'
import * as IPC from 'src/services/ipc'
import * as Store from 'src/services/storage.bg'
import * as Containers from 'src/services/containers'
import * as SidebarConfig from 'src/services/sidebar-config'
import * as Favicons from 'src/services/favicons'
import * as Snapshots from 'src/services/snapshots'
import { applySnapshot } from 'src/services/snapshots.bg'
import type { AnySnapTab } from 'src/services/snapshots'

export {
  normalizeSnapshot,
  getNormalizedSnapshot,
  minimizeSnapshot,
  convertToMarkdown,
  prepareExport,
} from 'src/services/snapshots'
export { applySnapshot } from 'src/services/snapshots.bg'

export interface ImportBackupOptions {
  importContainers?: boolean
  importSettings?: boolean
  importSidebar?: boolean
  importContextMenu?: boolean
  importStyles?: boolean
  importSnapshots?: boolean
  importFavicons?: boolean
  importKeybindings?: boolean
}

export interface ExportBackupOptions {
  settings?: boolean
  menu?: boolean
  containers?: boolean
  nav?: boolean
  styles?: boolean
  snapshots?: boolean
  favicons?: boolean
  keybindings?: boolean
}

function hasIpcState(): boolean {
  try {
    return !!(IPC as any)?.state?.sidebarConnections
  } catch {
    return false
  }
}

async function storeSet(values: Stored): Promise<void> {
  if (hasIpcState()) {
    return Store.set(values)
  }
  return browser.storage.local.set<Stored>(values)
}

async function getStoredKeys<K extends keyof Stored>(...keys: K[]): Promise<Partial<Stored>> {
  const results = await Promise.all(
    keys.map(k =>
      browser.storage.local
        .get<Stored>(k)
        .catch(() => ({}) as Stored)
    )
  )
  const merged: Partial<Stored> = {}
  for (const res of results) {
    if (res && typeof res === 'object') {
      Object.assign(merged, res)
    }
  }
  return merged
}

/**
 * Parse and validate Sidebery v5 / Sidecherry BackupData from JSON string or object.
 */
export function parseBackupData(jsonOrObj: string | BackupData): BackupData {
  let parsed: unknown
  if (typeof jsonOrObj === 'string') {
    const trimmed = jsonOrObj.trim()
    if (!trimmed) throw new Error('Empty backup data')
    parsed = JSON.parse(trimmed)
  } else {
    parsed = jsonOrObj
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid backup data format')
  }

  const data = parsed as BackupData
  if (data.ver !== undefined && typeof data.ver !== 'string') {
    throw new Error('Invalid backup version')
  }

  return Utils.clone(data)
}

function normalizeImportedSidebarPanels(
  panels: Record<ID, PanelConfig>
): void {
  for (const conf of Object.values(panels)) {
    if (Utils.isTabsPanel(conf)) Utils.normalizeObject(conf, D.TABS_PANEL_CONFIG)
    else if (Utils.isBookmarksPanel(conf)) Utils.normalizeObject(conf, D.BOOKMARKS_PANEL_CONFIG)
    else if (Utils.isHistoryPanel(conf)) Utils.normalizeObject(conf, D.HISTORY_PANEL_CONFIG)
    else if (Utils.isSyncPanel(conf)) Utils.normalizeObject(conf, D.SYNC_PANEL_CONFIG)
  }
}

/**
 * Import Sidebery v5 backup data into local storage and runtime state losslessly.
 */
export async function importBackupData(
  backup: BackupData,
  options: ImportBackupOptions = {}
): Promise<{ containersIds: Record<string, string>; importedSnapshotsCount: number }> {
  const cloned = parseBackupData(backup)
  const containersIds: Record<string, string> = {}
  let importedSnapshotsCount = 0

  // 1. Containers (preserve original container IDs)
  const existingStorage = await getStoredKeys('containers', 'sidebar')
  const mergedContainers: Record<ID, Container> = {
    ...(existingStorage.containers ? Utils.clone(existingStorage.containers) : {}),
    ...Utils.clone(Containers.reactive.byId),
  }

  if (options.importContainers !== false && cloned.containers) {
    for (const [origId, rawCtr] of Object.entries(cloned.containers)) {
      if (!rawCtr || typeof rawCtr !== 'object') continue
      const ctr = Utils.clone(rawCtr)
      Utils.normalizeObject(ctr, D.DEFAULT_CONTAINER)
      const preservedId = ctr.id || ctr.cookieStoreId || origId
      ctr.id = preservedId
      ctr.cookieStoreId = preservedId

      mergedContainers[preservedId] = ctr
      Containers.reactive.byId[preservedId] = ctr
      containersIds[origId] = preservedId
      containersIds[preservedId] = preservedId
    }

    await storeSet({ containers: mergedContainers })
  }

  // 2. Settings (preserve all Firefox keys and populate missing Chrome defaults)
  if (options.importSettings !== false && cloned.settings) {
    const normalizedSettings = Utils.clone(cloned.settings)
    Utils.normalizeObject(normalizedSettings, D.DEFAULT_SETTINGS)
    Utils.updateObject(Settings.state, normalizedSettings, Settings.state)
    Settings.updPrecalcSettings()
    await storeSet({ settings: normalizedSettings })
  }

  // 3. Sidebar & Panels (update newTabCtx and moveRules container references)
  if (options.importSidebar !== false && cloned.sidebar) {
    const existingSidebar = existingStorage.sidebar ?? SidebarConfig.reactive
    const nav = cloned.sidebar.nav ? [...cloned.sidebar.nav] : []
    const panels: Record<ID, PanelConfig> = cloned.sidebar.panels
      ? Utils.clone(cloned.sidebar.panels)
      : {}

    const oldNav: ID[] = []
    for (const id of existingSidebar.nav ?? []) {
      if (!nav.includes(id)) {
        const oldPanel = existingSidebar.panels?.[id]
        if (!oldPanel) continue
        panels[id] = Utils.clone(oldPanel)
        oldNav.push(id)
      }
    }
    if (oldNav.length) nav.unshift(...oldNav)

    normalizeImportedSidebarPanels(panels)

    for (const id of nav) {
      const panel = panels[id]
      if (!Utils.isTabsPanel(panel)) continue

      if (panel.newTabCtx && panel.newTabCtx !== 'none') {
        const mappedCtx = containersIds[panel.newTabCtx]
        if (mappedCtx) {
          panel.newTabCtx = mappedCtx
        } else if (!mergedContainers[panel.newTabCtx]) {
          panel.newTabCtx = 'none'
        }
      } else if (!panel.newTabCtx) {
        panel.newTabCtx = 'none'
      }

      if (!Array.isArray(panel.moveRules)) {
        panel.moveRules = []
      } else {
        panel.moveRules = panel.moveRules.map(rule => {
          if (rule.containerId) {
            const mapped = containersIds[rule.containerId]
            if (mapped) {
              rule.containerId = mapped
            } else if (!mergedContainers[rule.containerId]) {
              rule.containerId = undefined
              rule.active = false
            }
          }
          return rule
        })
      }
    }

    const nextSidebar = { panels, nav }
    SidebarConfig.updateSidebarConfig(nextSidebar)
    await storeSet({ sidebar: nextSidebar })
  }

  // 4. Context menu
  if (options.importContextMenu !== false && cloned.contextMenu) {
    await storeSet({ contextMenu: Utils.clone(cloned.contextMenu) })
  }

  // 5. Styles
  if (
    options.importStyles !== false &&
    (cloned.sidebarCSS !== undefined || cloned.groupCSS !== undefined)
  ) {
    const styleStorage = await getStoredKeys('sidebarCSS', 'groupCSS')
    let sidebarCSS = ''
    let groupCSS = ''

    if (styleStorage.sidebarCSS) {
      sidebarCSS = `/* OLD STYLES\n${styleStorage.sidebarCSS.trim()}\n*/`
    }
    if (cloned.sidebarCSS) {
      sidebarCSS = cloned.sidebarCSS + (sidebarCSS ? '\n\n' + sidebarCSS : '')
    }
    sidebarCSS = sidebarCSS.trim()

    if (styleStorage.groupCSS) {
      groupCSS = `/* OLD STYLES\n${styleStorage.groupCSS.trim()}\n*/`
    }
    if (cloned.groupCSS) {
      groupCSS = cloned.groupCSS + (groupCSS ? '\n\n' + groupCSS : '')
    }
    groupCSS = groupCSS.trim()

    await storeSet({ sidebarCSS, groupCSS })
  }

  // 6. Snapshots (deduplicate, normalize, update internal URLs while preserving originalUrl, sort & minimize)
  if (options.importSnapshots !== false && cloned.snapshots?.length) {
    const snapStorage = await getStoredKeys('snapshots')
    const storedSnapshotsRaw = snapStorage.snapshots ?? []

    const seenIds = new Set<ID>()
    for (const s of storedSnapshotsRaw) {
      if (s?.id !== undefined) seenIds.add(s.id)
    }

    const backupSnapshots: NormalizedSnapshot[] = []
    for (let i = 0; i < cloned.snapshots.length; i++) {
      const rawSnap = cloned.snapshots[i]
      if (!rawSnap || seenIds.has(rawSnap.id)) continue

      const normSnap = Snapshots.getNormalizedSnapshot(cloned.snapshots, i)
      if (!normSnap) continue

      for (const win of normSnap.tabs) {
        for (const panel of win) {
          for (const rawTab of panel) {
            const tab = rawTab as AnySnapTab
            if (Utils.isGroupUrl(tab.url)) {
              const updated = Utils.updateGroupUrlBase(tab.url)
              if (updated !== tab.url && !tab.originalUrl) tab.originalUrl = tab.url
              tab.url = updated
            } else if (Utils.isPlaceholderUrl(tab.url)) {
              const updated = Utils.updatePlaceholderUrlBase(tab.url)
              if (updated !== tab.url && !tab.originalUrl) tab.originalUrl = tab.url
              tab.url = updated
            }
          }
        }
      }

      seenIds.add(normSnap.id)
      backupSnapshots.push(normSnap)
    }

    importedSnapshotsCount = backupSnapshots.length

    if (backupSnapshots.length) {
      const storedSnapshots: NormalizedSnapshot[] = []
      for (let i = 0; i < storedSnapshotsRaw.length; i++) {
        const normStored = Snapshots.getNormalizedSnapshot(storedSnapshotsRaw, i)
        if (normStored) storedSnapshots.push(normStored)
      }

      const allNormSnapshots = storedSnapshots.concat(backupSnapshots)
      allNormSnapshots.sort((a, b) => a.time - b.time)

      const allSnapshots: Snapshot[] = []
      for (const normSnap of allNormSnapshots) {
        Snapshots.minimizeSnapshot(allSnapshots, normSnap)
        allSnapshots.push(normSnap)
      }

      await storeSet({ snapshots: allSnapshots })
    }
  }

  // 7. Favicons
  if (
    options.importFavicons !== false &&
    cloned.favicons &&
    cloned.favHashes &&
    cloned.favDomains
  ) {
    const favData = await Favicons.loadFaviconsData()
    let index = favData.favicons.length

    if (index < Favicons.MAX_COUNT_LIMIT) {
      const oldNewIndexes = new Map<number, number>()

      for (const backupDomain of Object.keys(cloned.favDomains)) {
        const backupDomainInfo = cloned.favDomains[backupDomain]
        if (!backupDomainInfo || favData.favDomains[backupDomain]) continue

        const backupIndex = backupDomainInfo.index
        const backupFavicon = cloned.favicons[backupIndex]
        const backupHash = cloned.favHashes[backupIndex]
        if (!backupFavicon || backupHash === undefined) continue

        const existedIndex = favData.favHashes.indexOf(backupHash)
        const reusedIndex = oldNewIndexes.get(backupIndex)

        if (existedIndex !== -1) {
          backupDomainInfo.index = existedIndex
          favData.favicons[existedIndex] = backupFavicon
          favData.favHashes[existedIndex] = backupHash
          favData.favDomains[backupDomain] = backupDomainInfo
        } else if (reusedIndex !== undefined) {
          backupDomainInfo.index = reusedIndex
          favData.favicons[reusedIndex] = backupFavicon
          favData.favHashes[reusedIndex] = backupHash
          favData.favDomains[backupDomain] = backupDomainInfo
        } else {
          if (index >= Favicons.MAX_COUNT_LIMIT) break
          oldNewIndexes.set(backupIndex, index)
          backupDomainInfo.index = index
          favData.favicons[index] = backupFavicon
          favData.favHashes[index] = backupHash
          favData.favDomains[backupDomain] = backupDomainInfo
          index++
        }
      }

      const favUpdate: Stored = {
        favicons_01: favData.favicons.slice(0, Favicons.SHARD_SIZE),
        favHashes: favData.favHashes,
        favDomains: favData.favDomains,
      }
      if (favData.favicons.length > Favicons.SHARD_SIZE) {
        favUpdate.favicons_02 = favData.favicons.slice(
          Favicons.SHARD_SIZE,
          Favicons.SHARD_SIZE * 2
        )
      }
      if (favData.favicons.length > Favicons.SHARD_SIZE * 2) {
        favUpdate.favicons_03 = favData.favicons.slice(
          Favicons.SHARD_SIZE * 2,
          Favicons.SHARD_SIZE * 3
        )
      }
      if (favData.favicons.length > Favicons.SHARD_SIZE * 3) {
        favUpdate.favicons_04 = favData.favicons.slice(
          Favicons.SHARD_SIZE * 3,
          Favicons.SHARD_SIZE * 4
        )
      }
      if (favData.favicons.length > Favicons.SHARD_SIZE * 4) {
        favUpdate.favicons_05 = favData.favicons.slice(
          Favicons.SHARD_SIZE * 4,
          Favicons.SHARD_SIZE * 5
        )
      }

      await storeSet(favUpdate)
    }
  }

  // 8. Keybindings
  if (
    options.importKeybindings !== false &&
    cloned.keybindings &&
    typeof browser?.commands?.getAll === 'function'
  ) {
    const commands = (await browser.commands.getAll().catch(() => [])) ?? []
    const canUpdate = typeof browser.commands.update === 'function'
    if (canUpdate) {
      const waiting: Promise<void>[] = []
      for (const k of commands) {
        if (!k.name) continue
        const name = k.name
        const shortcut = cloned.keybindings[name]

        if (shortcut) {
          const conflicting = commands.find(
            other => other.shortcut === shortcut && other.name && other.name !== name
          )
          if (conflicting?.name) {
            await browser.commands.update({ name: conflicting.name, shortcut: '' }).catch(() => {})
          }
          waiting.push(browser.commands.update({ name, shortcut }).catch(() => {}))
        } else {
          waiting.push(browser.commands.update({ name, shortcut: '' }).catch(() => {}))
        }
      }
      await Promise.allSettled(waiting)
    }
  }

  return {
    containersIds,
    importedSnapshotsCount,
  }
}

/**
 * Export Sidebery v5 compatible BackupData JSON, filename, and parsed backup object.
 */
export async function exportBackupData(
  options: ExportBackupOptions = {}
): Promise<{ backup: BackupData; filename: string; json: string }> {
  const wantContainers = options.containers !== false
  const wantSettings = options.settings !== false
  const wantNav = options.nav !== false
  const wantMenu = options.menu !== false
  const wantStyles = options.styles !== false
  const wantSnapshots = options.snapshots !== false
  const wantFavicons = options.favicons !== false
  const wantKeybindings = options.keybindings !== false

  const storageKeys: (keyof Stored)[] = []
  if (wantContainers) storageKeys.push('containers')
  if (wantSettings) storageKeys.push('settings')
  if (wantNav) storageKeys.push('sidebar')
  if (wantMenu) storageKeys.push('contextMenu')
  if (wantStyles) {
    storageKeys.push('sidebarCSS', 'groupCSS')
  }
  if (wantSnapshots) storageKeys.push('snapshots')
  if (wantFavicons) {
    storageKeys.push(
      'favicons_01',
      'favicons_02',
      'favicons_03',
      'favicons_04',
      'favicons_05',
      'favHashes',
      'favDomains'
    )
  }

  const data = await getStoredKeys(...storageKeys)
  const backup: BackupData = {}

  if (wantContainers && data.containers) backup.containers = Utils.clone(data.containers)
  if (wantSettings && data.settings) backup.settings = Utils.clone(data.settings)
  if (wantNav && data.sidebar) backup.sidebar = Utils.clone(data.sidebar)
  if (wantMenu && data.contextMenu) backup.contextMenu = Utils.clone(data.contextMenu)
  if (wantStyles) {
    if (data.sidebarCSS) backup.sidebarCSS = data.sidebarCSS
    if (data.groupCSS) backup.groupCSS = data.groupCSS
  }

  if (wantSnapshots && data.snapshots) {
    const exportedSnapshots = Utils.clone(data.snapshots)
    for (const snap of exportedSnapshots) {
      if (!snap?.tabs) continue
      for (const win of snap.tabs) {
        if (!win) continue
        for (const panel of win) {
          if (!panel) continue
          for (const rawTab of panel) {
            if (!rawTab || typeof rawTab !== 'object') continue
            const tab = rawTab as AnySnapTab
            if (tab.originalUrl) {
              tab.url = Utils.restoreOriginalUrlForExport(tab.url, tab.originalUrl)
              delete tab.originalUrl
            } else {
              tab.url = Utils.restoreOriginalUrlForExport(tab.url)
            }
          }
        }
      }
    }
    backup.snapshots = exportedSnapshots
  }

  if (wantFavicons && data.favicons_01?.length && data.favDomains && data.favHashes) {
    const fullList = [...data.favicons_01]
    if (data.favicons_02?.length) fullList.push(...data.favicons_02)
    if (data.favicons_03?.length) fullList.push(...data.favicons_03)
    if (data.favicons_04?.length) fullList.push(...data.favicons_04)
    if (data.favicons_05?.length) fullList.push(...data.favicons_05)
    backup.favicons = fullList
    backup.favDomains = Utils.clone(data.favDomains)
    backup.favHashes = [...data.favHashes]
  }

  backup.ver = browser.runtime?.getManifest?.()?.version ?? '5.6.1'

  if (wantKeybindings) {
    backup.keybindings = {}
    if (typeof browser?.commands?.getAll === 'function') {
      const cmds = (await browser.commands.getAll().catch(() => [])) ?? []
      for (const cmd of cmds) {
        if (cmd.name && cmd.shortcut) backup.keybindings[cmd.name] = cmd.shortcut
      }
    }
  }

  const json = JSON.stringify(backup)
  const now = Date.now()
  const date = Utils.uDate(now, '.')
  const time = Utils.uTime(now, '.')
  const filename = `sidebery-data-${date}-${time}.json`

  return { backup, filename, json }
}
