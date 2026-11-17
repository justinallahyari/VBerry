import type {
  SnapTab,
  Snapshot,
  NormalizedSnapshot,
  SnapExportInfo,
  SnapExportTypes,
  Container,
  SidebarConfig,
  PanelConfig,
} from 'src/types'
import type {
  Snapshot as ContractSnapshot,
  SnapTab as ContractSnapTab,
} from 'src/contracts/sidebery-schema'
import { SnapStoreMode } from 'src/enums'
import { translate } from 'src/dict'
import * as Utils from 'src/utils'
import * as Settings from 'src/services/settings'

export const MAX_SIZE_LIMIT = 10_240
export const GLOB_PINNED_ID = 'global_pinned'

export type AnySnapshot = Snapshot | ContractSnapshot
export type AnySnapTab = SnapTab & { originalUrl?: string }

export { SnapStoreMode }

export function isUnchangedSnapEntry(val: unknown): val is SnapStoreMode.Unchanged {
  return val === SnapStoreMode.Unchanged
}

export function isSnapDeltaIndex(val: unknown): val is number {
  return typeof val === 'number' && val >= 0
}

function resolveContainers(
  snapshots: readonly AnySnapshot[],
  index: number
): Record<ID, Container> | undefined {
  for (let i = index; i >= 0; i--) {
    const snap = snapshots[i]
    if (!snap || snap.containers === undefined || snap.containers === SnapStoreMode.Unchanged) {
      continue
    }

    if (Array.isArray(snap.containers)) {
      const resolved: Record<ID, Container> = {}
      const prevContainers = i > 0 ? resolveContainers(snapshots, i - 1) : undefined
      for (const item of snap.containers) {
        if (typeof item === 'string') {
          const found = prevContainers?.[item]
          if (found) resolved[item] = Utils.clone(found)
        } else if (item && typeof item === 'object') {
          const id = item.id || item.cookieStoreId
          if (id) resolved[id] = Utils.clone(item as Container)
        }
      }
      return resolved
    }

    return Utils.clone(snap.containers as Record<ID, Container>)
  }

  return undefined
}

function resolveSidebar(
  snapshots: readonly AnySnapshot[],
  index: number
): SidebarConfig | undefined {
  for (let i = index; i >= 0; i--) {
    const snap = snapshots[i]
    if (!snap || snap.sidebar === undefined || snap.sidebar === SnapStoreMode.Unchanged) {
      continue
    }

    if (Array.isArray(snap.sidebar)) {
      const panels: Record<ID, PanelConfig> = {}
      const nav: ID[] = []
      const prevSidebar = i > 0 ? resolveSidebar(snapshots, i - 1) : undefined
      for (const entry of snap.sidebar) {
        if (typeof entry === 'string') {
          const found = prevSidebar?.panels?.[entry]
          if (found) panels[entry] = Utils.clone(found)
          nav.push(entry)
        } else if (entry && typeof entry === 'object') {
          panels[entry.id] = Utils.clone(entry as PanelConfig)
          nav.push(entry.id)
        }
      }
      return { panels, nav }
    }

    return Utils.clone(snap.sidebar as SidebarConfig)
  }

  return undefined
}

function resolveTabAt(
  snapshots: readonly AnySnapshot[],
  index: number,
  wi: number,
  pi: number,
  ti: number
): AnySnapTab | undefined {
  for (let i = index; i >= 0; i--) {
    const snap = snapshots[i]
    const entry = snap?.tabs?.[wi]?.[pi]?.[ti]
    if (entry === undefined) return undefined

    if (entry === SnapStoreMode.Unchanged) {
      if (i === 0) return undefined
      continue
    }

    if (typeof entry === 'number') {
      if (i === 0 || entry < 0) return undefined
      return resolveTabAt(snapshots, i - 1, wi, pi, entry)
    }

    if (typeof entry === 'object') {
      return Utils.clone(entry as AnySnapTab)
    }

    return undefined
  }

  return undefined
}

export function getNormalizedSnapshot(
  snapshots: readonly AnySnapshot[],
  index: number
): NormalizedSnapshot | undefined {
  const srcSnapshot = snapshots[index]
  if (!srcSnapshot) return

  const containers = resolveContainers(snapshots, index)
  if (!containers) return

  const sidebar = resolveSidebar(snapshots, index)
  if (!sidebar) return

  const normalizedTabs: AnySnapTab[][][] = []
  const srcTabs = srcSnapshot.tabs ?? []

  for (let wi = 0; wi < srcTabs.length; wi++) {
    const win = srcTabs[wi]
    if (!win) continue
    const normWin: AnySnapTab[][] = []

    for (let pi = 0; pi < win.length; pi++) {
      const panel = win[pi]
      if (!panel) continue
      const normPanel: AnySnapTab[] = []

      for (let ti = 0; ti < panel.length; ti++) {
        const tab = panel[ti]

        if (tab === SnapStoreMode.Unchanged) {
          if (index === 0) return
          const resolved = resolveTabAt(snapshots, index - 1, wi, pi, ti)
          if (!resolved) return
          normPanel.push(resolved)
        } else if (typeof tab === 'number') {
          if (tab < 0 || index === 0) return
          const resolved = resolveTabAt(snapshots, index - 1, wi, pi, tab)
          if (!resolved) return
          normPanel.push(resolved)
        } else if (tab && typeof tab === 'object') {
          normPanel.push(Utils.clone(tab as AnySnapTab))
        } else {
          return
        }
      }

      normWin.push(normPanel)
    }

    normalizedTabs.push(normWin)
  }

  return {
    id: srcSnapshot.id,
    time: srcSnapshot.time,
    containers,
    sidebar,
    tabs: normalizedTabs,
  }
}

export const normalizeSnapshot = getNormalizedSnapshot

export function prepareExport(snapshot: NormalizedSnapshot, type: SnapExportTypes) {
  const { id, time, containers, sidebar, tabs } = snapshot
  const expInfo: SnapExportInfo = { id, time, containers, sidebar, tabs }

  if (type.JSON) {
    const jsonStr = JSON.stringify(snapshot)
    expInfo.jsonFile = new Blob([jsonStr], { type: 'application/json' })
  }

  if (type.Markdown) {
    expInfo.md = convertToMarkdown(snapshot)
    expInfo.mdFile = new Blob([expInfo.md], { type: 'text/markdown' })
  }

  return expInfo
}

export function convertToMarkdown(snapshot: NormalizedSnapshot): string {
  const dateStr = Utils.uDate(snapshot.time, '.')
  const timeStr = Utils.uTime(snapshot.time, '.')
  const dateTimeStr = `${dateStr} - ${timeStr}`
  const md = [`# ${dateTimeStr}`, '']
  const globalPinnedTabs = []
  const pinnedTabsByPanelId: Map<ID, SnapTab[]> = new Map()

  const indent = '  '
  const pinMark = '📌 '
  const winIndent = ''
  const panelsIndent = Settings.state.snapMdFullTree ? indent : ''
  const tabsIndent = Settings.state.snapMdFullTree ? indent.repeat(2) : ''
  const winBullet = Settings.state.snapMdFullTree ? '- ' : ''
  const panelBullet = Settings.state.snapMdFullTree ? '- ' : ''
  const tabBullet = '- '

  // Gather pinned tabs
  if (snapshot.tabs[0]?.[0]?.[0]?.pinned) {
    const pinnedTabs = snapshot.tabs[0]?.[0]
    for (const tab of pinnedTabs) {
      const panelConfig = snapshot.sidebar.panels[tab.panelId]
      if (panelConfig) {
        let panelPinnedTabs = pinnedTabsByPanelId.get(tab.panelId)
        if (!panelPinnedTabs) panelPinnedTabs = []
        panelPinnedTabs.push(tab)
        pinnedTabsByPanelId.set(tab.panelId, panelPinnedTabs)
      } else {
        globalPinnedTabs.push(tab)
      }
    }
  }

  // Per-window
  for (let i = 0; i < snapshot.tabs.length; i++) {
    const win = snapshot.tabs[i]
    const winTitle = `## ${translate('snapshot.window_title')} ${i + 1}`
    md.push(winIndent + winBullet + winTitle)

    // Global pinned tabs
    if (globalPinnedTabs.length) {
      const globalPinnedTitle = `### ${translate('snapshot.global_pin_title')}`
      md.push(panelsIndent + panelBullet + globalPinnedTitle)

      for (const tab of globalPinnedTabs) {
        const tabLink = `[${tab.title}](${tab.url})`
        md.push(tabsIndent + tabBullet + pinMark + tabLink)
      }
    }

    // Per-panel
    for (const id of snapshot.sidebar.nav) {
      const panel = snapshot.sidebar.panels[id]
      if (!Utils.isTabsPanel(panel)) continue

      // Get tabs
      const pinnedTabs = pinnedTabsByPanelId.get(id)
      const normalTabs = win.find(p => p[0] && p[0].panelId === id && !p[0].pinned)
      if (!pinnedTabs?.length && !normalTabs) continue

      // Create panel title
      const panelTitle = `### ${panel.name}`
      md.push(panelsIndent + panelBullet + panelTitle)

      // Pinned tabs
      if (pinnedTabs?.length) {
        for (const tab of pinnedTabs) {
          const tabLink = `[${tab.title}](${tab.url})`
          md.push(tabsIndent + tabBullet + pinMark + tabLink)
        }
      }

      // Normal tabs
      if (normalTabs?.length) {
        for (const tab of normalTabs) {
          const tabLink = `[${tab.customTitle ?? tab.title}](${tab.url})`
          md.push(tabsIndent + indent.repeat(tab.lvl ?? 0) + tabBullet + tabLink)
        }
      }
    }
  }

  return md.join('\n')
}

export function minimizeSnapshot(
  snapshots: readonly AnySnapshot[],
  snapshot: AnySnapshot
): void {
  const newContainersObj = Array.isArray(snapshot.containers)
    ? resolveContainers([snapshot], 0)
    : snapshot.containers
  const newSidebarObj = Array.isArray(snapshot.sidebar)
    ? resolveSidebar([snapshot], 0)
    : snapshot.sidebar
  const newContainersJSON = JSON.stringify(newContainersObj)
  const newSidebarJSON = JSON.stringify(newSidebarObj)

  // Containers
  for (let i = snapshots.length; i--;) {
    const snapN = snapshots[i]
    if (!snapN || !snapN.containers) break

    if (snapN.containers === SnapStoreMode.Unchanged) continue

    const prevContainers = resolveContainers(snapshots, i)
    const lastContainersJSON = JSON.stringify(prevContainers)
    if (newContainersJSON === lastContainersJSON) {
      snapshot.containers = SnapStoreMode.Unchanged
    }

    break
  }

  // Nav and panels
  for (let i = snapshots.length; i--;) {
    const snapN = snapshots[i]
    if (!snapN || !snapN.sidebar) break

    if (snapN.sidebar === SnapStoreMode.Unchanged) continue

    const prevSidebar = resolveSidebar(snapshots, i)
    const lastSidebarJSON = JSON.stringify(prevSidebar)
    if (newSidebarJSON === lastSidebarJSON) {
      snapshot.sidebar = SnapStoreMode.Unchanged
    }

    break
  }

  // Tabs (by relative index)
  // per win (current)
  per_win: for (let wi = 0; wi < snapshot.tabs.length; wi++) {
    const win = snapshot.tabs[wi]
    if (!win) break per_win // stop tabs minimizing

    // per group (current)
    per_panel: for (let gi = 0; gi < win.length; gi++) {
      const tabs = win[gi]
      if (!tabs) break per_win // stop tabs minimizing

      // per tab (current)
      per_tab: for (let ti = 0; ti < tabs.length; ti++) {
        const tab = tabs[ti]
        if (!tab) break per_win // stop tabs minimizing
        if (tab === SnapStoreMode.Unchanged || typeof tab === 'number') continue

        const curTab = tab as ContractSnapTab

        // per snapshot (previous)
        for (let i = snapshots.length; i--;) {
          const snapN = snapshots[i]
          if (!snapN) break per_win // stop tabs minimizing

          const winN = snapN.tabs[wi]
          if (!winN) break per_win // stop tabs minimizing

          const panelN = winN[gi]
          if (!panelN) break per_panel // go to the next win

          const rawTabN = panelN[ti]
          if (rawTabN === undefined) break per_tab // go to the next panel

          if (rawTabN === SnapStoreMode.Unchanged) continue // go to the prev snapshot

          const tabN =
            typeof rawTabN === 'number'
              ? resolveTabAt(snapshots, i - 1, wi, gi, rawTabN)
              : (rawTabN as ContractSnapTab)
          if (!tabN) break per_tab

          if (
            curTab.url === tabN.url &&
            curTab.title === tabN.title &&
            curTab.pinned === tabN.pinned &&
            curTab.containerId === tabN.containerId &&
            curTab.panelId === tabN.panelId &&
            curTab.lvl === tabN.lvl &&
            curTab.folded === tabN.folded &&
            curTab.customTitle === tabN.customTitle &&
            curTab.customColor === tabN.customColor &&
            curTab.originalUrl === tabN.originalUrl
          ) {
            tabs[ti] = SnapStoreMode.Unchanged
          }

          break // go to the next tab
        }
      }
    }
  }
}
