import {
  DEFAULT_SETTINGS,
  type ChromeGroupColor,
  type MoveRule,
  type SavedPanel,
  type Settings,
  type SnapshotGroup,
  type SnapshotTab,
  type SnapshotWindow,
  type VBerrySnapshot,
} from './types'
import {
  loadSavedPanels,
  loadSettings,
  loadSnapshots,
  saveSavedPanels,
  saveSettings,
  saveSnapshots,
  uid,
} from './storage'

// Sidebery v5 PanelType enum values
const SIDEBERY_PANEL_TABS = 2
const SIDEBERY_PANEL_BOOKMARKS = 1
const SIDEBERY_PANEL_HISTORY = 4
// Sidebery SnapStoreMode.Unchanged = 0
const SNAP_UNCHANGED = 0

export interface SideberyPanelRaw {
  id: string
  type?: number | string
  name?: string
  color?: string
  moveRules?: Array<{
    id?: string
    active?: boolean
    url?: string
    name?: string
  }>
}

export interface SideberySnapTabRaw {
  url: string
  title?: string
  panelId?: string
  lvl?: number
  pinned?: boolean
  folded?: boolean
  customTitle?: string
  originalUrl?: string
}

export interface SideberySnapshotRaw {
  id: string
  time: number
  containers?: Record<string, unknown> | unknown[] | 0
  sidebar?:
    | { panels?: Record<string, SideberyPanelRaw>; nav?: string[] }
    | Array<string | SideberyPanelRaw>
    | 0
  tabs?: Array<Array<Array<SideberySnapTabRaw | number>>>
}

export interface SideberyBackupRaw {
  ver?: string
  settings?: Record<string, unknown>
  sidebar?: {
    panels?: Record<string, SideberyPanelRaw>
    nav?: string[]
  }
  sidebarCSS?: string
  snapshots?: SideberySnapshotRaw[]
  // Also allow native VBerry backup format
  vberryVersion?: string
  savedPanels?: SavedPanel[]
  vberrySnapshots?: VBerrySnapshot[]
}

export interface ImportPreview {
  format: 'sidebery-backup' | 'sidebery-snapshot' | 'vberry-backup'
  version?: string
  panelsCount: number
  snapshotsCount: number
  hasSettings: boolean
  hasCustomCss: boolean
  parsed: SideberyBackupRaw
}

export interface ImportOptions {
  importPanels?: boolean
  importSnapshots?: boolean
  importSettings?: boolean
  importCustomCss?: boolean
}

export interface ImportResult {
  panelsImported: number
  snapshotsImported: number
  settingsImported: boolean
  customCssImported: boolean
}

/**
 * Map Firefox Sidebery / container color names to Chrome's 9 native Tab Group colors.
 */
export function mapSideberyColor(color?: string): ChromeGroupColor {
  switch ((color ?? '').toLowerCase()) {
    case 'blue':
      return 'blue'
    case 'turquoise':
    case 'cyan':
    case 'teal':
      return 'cyan'
    case 'green':
      return 'green'
    case 'yellow':
      return 'yellow'
    case 'orange':
      return 'orange'
    case 'red':
      return 'red'
    case 'pink':
    case 'magenta':
      return 'pink'
    case 'purple':
    case 'violet':
      return 'purple'
    default:
      return 'grey'
  }
}

function isSideberyTabsPanel(panel: SideberyPanelRaw | undefined): boolean {
  if (!panel) return false
  return panel.type === SIDEBERY_PANEL_TABS || panel.type === 'tabs'
}

/**
 * Decompress Sidebery's delta-encoded snapshot sidebar at index `idx`.
 */
function resolveSideberySidebar(
  snapshots: SideberySnapshotRaw[],
  idx: number
): { panels: Record<string, SideberyPanelRaw>; nav: string[] } {
  for (let i = idx; i >= 0; i--) {
    const sb = snapshots[i]?.sidebar
    if (!sb) continue
    if (Array.isArray(sb)) {
      const panels: Record<string, SideberyPanelRaw> = {}
      const nav: string[] = []
      const prev = i > 0 ? resolveSideberySidebar(snapshots, i - 1) : { panels: {}, nav: [] }
      for (const entry of sb) {
        if (typeof entry === 'string') {
          if (prev.panels[entry]) panels[entry] = prev.panels[entry]
          nav.push(entry)
        } else if (entry && typeof entry === 'object' && entry.id) {
          panels[entry.id] = entry
          nav.push(entry.id)
        }
      }
      return { panels, nav }
    }
    return {
      panels: sb.panels ?? {},
      nav: sb.nav ?? Object.keys(sb.panels ?? {}),
    }
  }
  return { panels: {}, nav: [] }
}

/**
 * Decompress a single delta-encoded Sidebery SnapTab entry.
 */
function resolveSideberySnapTab(
  snapshots: SideberySnapshotRaw[],
  idx: number,
  wi: number,
  pi: number,
  ti: number
): SideberySnapTabRaw | undefined {
  for (let i = idx; i >= 0; i--) {
    const entry = snapshots[i]?.tabs?.[wi]?.[pi]?.[ti]
    if (entry === undefined) return undefined
    if (entry === SNAP_UNCHANGED) {
      if (i === 0) return undefined
      continue
    }
    if (typeof entry === 'number') {
      if (i === 0 || entry < 0) return undefined
      return resolveSideberySnapTab(snapshots, i - 1, wi, pi, entry)
    }
    if (typeof entry === 'object') return entry
    return undefined
  }
  return undefined
}

/**
 * Convert an array of raw Sidebery v5 snapshots (supporting delta compression)
 * into clean, self-contained VBerrySnapshots.
 */
export function normalizeSideberySnapshots(rawSnapshots: SideberySnapshotRaw[]): VBerrySnapshot[] {
  const result: VBerrySnapshot[] = []

  for (let i = 0; i < rawSnapshots.length; i++) {
    const raw = rawSnapshots[i]
    if (!raw || !Array.isArray(raw.tabs)) continue

    const sidebar = resolveSideberySidebar(rawSnapshots, i)
    const windows: SnapshotWindow[] = []

    for (let wi = 0; wi < raw.tabs.length; wi++) {
      const rawWin = raw.tabs[wi]
      if (!Array.isArray(rawWin)) continue

      const pinned: SnapshotTab[] = []
      const groupsByPanelId = new Map<string, SnapshotGroup>()
      const groupOrder: string[] = []

      for (let pi = 0; pi < rawWin.length; pi++) {
        const rawPanelTabs = rawWin[pi]
        if (!Array.isArray(rawPanelTabs)) continue

        for (let ti = 0; ti < rawPanelTabs.length; ti++) {
          const tab = resolveSideberySnapTab(rawSnapshots, i, wi, pi, ti)
          if (!tab || !tab.url) continue

          const snapTab: SnapshotTab = {
            url: tab.originalUrl || tab.url,
            title: tab.customTitle || tab.title || tab.url,
            level: Math.max(0, tab.lvl ?? 0),
            pinned: tab.pinned || undefined,
            folded: tab.folded || undefined,
          }

          if (tab.pinned) {
            pinned.push(snapTab)
            continue
          }

          const pid = tab.panelId || 'ungrouped'
          let group = groupsByPanelId.get(pid)
          if (!group) {
            const pConf = sidebar.panels[pid]
            const isDefault = pid === 'tabs-panel' || pid === 'ungrouped'
            group = {
              id: pid,
              title: pConf?.name || (isDefault ? 'Ungrouped' : pid),
              color: mapSideberyColor(pConf?.color),
              ungrouped: isDefault && !pConf?.name ? true : undefined,
              tabs: [],
            }
            groupsByPanelId.set(pid, group)
            groupOrder.push(pid)
          }
          group.tabs.push(snapTab)
        }
      }

      const groups = groupOrder
        .map(id => groupsByPanelId.get(id)!)
        .filter(g => g.tabs.length > 0)

      if (pinned.length || groups.length) {
        windows.push({ pinned, groups })
      }
    }

    if (windows.length) {
      result.push({
        id: raw.id || uid('sb_snap'),
        time: typeof raw.time === 'number' ? raw.time : Date.now(),
        source: 'sidebery',
        windows,
      })
    }
  }

  return result
}

/**
 * Extract VBerry SavedPanels from a Sidebery sidebar config.
 */
export function extractSideberyPanels(
  sidebar?: SideberyBackupRaw['sidebar']
): SavedPanel[] {
  if (!sidebar?.panels) return []
  const navOrder = sidebar.nav?.length ? sidebar.nav : Object.keys(sidebar.panels)
  const seen = new Set<string>()
  const result: SavedPanel[] = []

  for (const id of navOrder) {
    const raw = sidebar.panels[id]
    if (!raw || !isSideberyTabsPanel(raw) || seen.has(id)) continue
    seen.add(id)

    const moveRules: MoveRule[] = Array.isArray(raw.moveRules)
      ? raw.moveRules
          .filter(r => typeof r?.url === 'string' && r.url.trim().length > 0)
          .map(r => ({
            id: r.id || uid('rule'),
            active: r.active !== false,
            pattern: r.url!.trim(),
            name: r.name,
          }))
      : []

    result.push({
      id: uid('panel'),
      title: raw.name?.trim() || 'Tabs',
      color: mapSideberyColor(raw.color),
      moveRules,
      sourceSideberyId: id,
    })
  }

  return result
}

/**
 * Map relevant Firefox Sidebery settings to VBerry's Chrome-native Settings.
 */
export function mapSideberySettings(raw?: Record<string, unknown>): Partial<Settings> {
  if (!raw) return {}
  const out: Partial<Settings> = {}

  if (raw.colorScheme === 'dark' || raw.colorScheme === 'light') {
    out.theme = raw.colorScheme
  } else if (raw.colorScheme === 'ff' || raw.colorScheme === 'sys') {
    out.theme = 'auto'
  }

  if (raw.density === 'compact') out.density = 'compact'
  else if (raw.density === 'default' || raw.density === 'loose') out.density = 'comfortable'

  if (typeof raw.tabsTree === 'boolean') {
    out.autoNestChildTabs = raw.tabsTree
  }

  if (typeof raw.snapInterval === 'number' && raw.snapInterval > 0) {
    const unit = raw.snapIntervalUnit
    if (unit === 'min') out.autoSnapshotMinutes = raw.snapInterval
    else if (unit === 'hr') out.autoSnapshotMinutes = raw.snapInterval * 60
    else if (unit === 'day') out.autoSnapshotMinutes = raw.snapInterval * 1440
  }

  if (typeof raw.snapLimit === 'number' && raw.snapLimit > 0 && raw.snapLimitUnit === 'snap') {
    out.maxSnapshots = Math.max(1, Math.min(500, Math.round(raw.snapLimit)))
  }

  return out
}

/**
 * Parse and inspect any JSON string (Sidebery v5 backup, standalone Sidebery snapshot, or VBerry backup).
 */
export function inspectImportJson(jsonStr: string): ImportPreview {
  const trimmed = jsonStr.trim()
  if (!trimmed) throw new Error('File is empty')

  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    throw new Error('Invalid JSON file')
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Expected a JSON object')
  }

  const obj = raw as Record<string, unknown>

  // 1. Native VBerry backup
  if (typeof obj.vberryVersion === 'string') {
    const backup = obj as unknown as SideberyBackupRaw
    return {
      format: 'vberry-backup',
      version: backup.vberryVersion,
      panelsCount: backup.savedPanels?.length ?? 0,
      snapshotsCount: backup.vberrySnapshots?.length ?? 0,
      hasSettings: Boolean(backup.settings),
      hasCustomCss: typeof backup.sidebarCSS === 'string' && backup.sidebarCSS.length > 0,
      parsed: backup,
    }
  }

  // 2. Standalone Sidebery snapshot (has `tabs` array + `time` + `sidebar` directly at root)
  if (Array.isArray(obj.tabs) && typeof obj.time === 'number') {
    const snap = obj as unknown as SideberySnapshotRaw
    const wrapped: SideberyBackupRaw = { snapshots: [snap] }
    return {
      format: 'sidebery-snapshot',
      panelsCount: 0,
      snapshotsCount: 1,
      hasSettings: false,
      hasCustomCss: false,
      parsed: wrapped,
    }
  }

  // 3. Sidebery v5 backup JSON
  const backup = obj as unknown as SideberyBackupRaw
  const panels = extractSideberyPanels(backup.sidebar)
  const hasAnyKnownField =
    panels.length > 0 ||
    Array.isArray(backup.snapshots) ||
    Boolean(backup.settings) ||
    typeof backup.sidebarCSS === 'string' ||
    Boolean(backup.sidebar)

  if (!hasAnyKnownField) {
    throw new Error('Unrecognized backup format (expected Sidebery v5 or VBerry JSON)')
  }

  return {
    format: 'sidebery-backup',
    version: typeof backup.ver === 'string' ? backup.ver : undefined,
    panelsCount: panels.length,
    snapshotsCount: Array.isArray(backup.snapshots) ? backup.snapshots.length : 0,
    hasSettings: Boolean(backup.settings),
    hasCustomCss: typeof backup.sidebarCSS === 'string' && backup.sidebarCSS.trim().length > 0,
    parsed: backup,
  }
}

/**
 * Execute the import into VBerry's chrome.storage.local.
 */
export async function executeImport(
  preview: ImportPreview,
  options: ImportOptions = {}
): Promise<ImportResult> {
  const { parsed, format } = preview
  const result: ImportResult = {
    panelsImported: 0,
    snapshotsImported: 0,
    settingsImported: false,
    customCssImported: false,
  }

  // 1. Panels
  if (options.importPanels !== false) {
    const incomingPanels: SavedPanel[] =
      format === 'vberry-backup'
        ? (parsed.savedPanels ?? [])
        : extractSideberyPanels(parsed.sidebar)

    if (incomingPanels.length) {
      const existing = await loadSavedPanels()
      const existingByTitle = new Map(existing.map(p => [p.title.toLowerCase(), p]))
      for (const panel of incomingPanels) {
        const key = panel.title.toLowerCase()
        if (existingByTitle.has(key)) {
          const prev = existingByTitle.get(key)!
          prev.color = panel.color
          if (panel.moveRules.length) {
            const seenPatterns = new Set(prev.moveRules.map(r => r.pattern))
            for (const r of panel.moveRules) {
              if (!seenPatterns.has(r.pattern)) prev.moveRules.push(r)
            }
          }
        } else {
          existing.push(panel)
          existingByTitle.set(key, panel)
        }
        result.panelsImported++
      }
      await saveSavedPanels(existing)
    }
  }

  // 2. Snapshots
  if (options.importSnapshots !== false) {
    const incomingSnapshots: VBerrySnapshot[] =
      format === 'vberry-backup'
        ? (parsed.vberrySnapshots ?? [])
        : normalizeSideberySnapshots(parsed.snapshots ?? [])

    if (incomingSnapshots.length) {
      const existing = await loadSnapshots()
      const seenIds = new Set(existing.map(s => s.id))
      const added: VBerrySnapshot[] = []
      for (const snap of incomingSnapshots) {
        if (!seenIds.has(snap.id)) {
          seenIds.add(snap.id)
          added.push(snap)
        }
      }
      if (added.length) {
        const merged = [...existing, ...added].sort((a, b) => b.time - a.time)
        await saveSnapshots(merged)
        result.snapshotsImported = added.length
      }
    }
  }

  // 3. Settings + Custom CSS
  const settingsPatch: Partial<Settings> = {}
  if (options.importSettings !== false && parsed.settings) {
    if (format === 'vberry-backup') {
      Object.assign(settingsPatch, parsed.settings as Partial<Settings>)
    } else {
      Object.assign(settingsPatch, mapSideberySettings(parsed.settings))
      // Check if Sidebery sidebar had bookmarks or history panels enabled
      if (parsed.sidebar?.panels) {
        const allPanels = Object.values(parsed.sidebar.panels)
        if (allPanels.some(p => p.type === SIDEBERY_PANEL_BOOKMARKS || p.type === 'bookmarks')) {
          settingsPatch.showBookmarksPanel = true
        }
        if (allPanels.some(p => p.type === SIDEBERY_PANEL_HISTORY || p.type === 'history')) {
          settingsPatch.showHistoryPanel = true
        }
      }
    }
    result.settingsImported = true
  }

  if (options.importCustomCss !== false && typeof parsed.sidebarCSS === 'string' && parsed.sidebarCSS.trim()) {
    settingsPatch.customCss = parsed.sidebarCSS.trim()
    result.customCssImported = true
  }

  if (Object.keys(settingsPatch).length) {
    await saveSettings(settingsPatch)
  }

  return result
}

/**
 * Export full VBerry data as JSON (including Sidebery-compatible `sidebar` & `snapshots` fields).
 */
export async function exportBackupJson(): Promise<{ filename: string; json: string }> {
  const [settings, savedPanels, snapshots] = await Promise.all([
    loadSettings(),
    loadSavedPanels(),
    loadSnapshots(),
  ])

  const payload = {
    vberryVersion: '6.5.0',
    exportedAt: Date.now(),
    settings: { ...DEFAULT_SETTINGS, ...settings },
    savedPanels,
    vberrySnapshots: snapshots,
    sidebarCSS: settings.customCss || undefined,
  }

  const now = new Date()
  const stamp = `${now.getFullYear()}.${String(now.getMonth() + 1).padStart(2, '0')}.${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}.${String(now.getMinutes()).padStart(2, '0')}`
  return {
    filename: `vberry-backup-${stamp}.json`,
    json: JSON.stringify(payload, null, 2),
  }
}

/**
 * Convert a VBerrySnapshot to clean Markdown for easy sharing/archiving.
 */
export function snapshotToMarkdown(snapshot: VBerrySnapshot): string {
  const d = new Date(snapshot.time)
  const lines = [`# Snapshot — ${d.toLocaleString()}`, '']
  snapshot.windows.forEach((win, wi) => {
    lines.push(`## Window ${wi + 1}`, '')
    if (win.pinned.length) {
      lines.push('### Pinned', '')
      for (const tab of win.pinned) {
        lines.push(`- 📌 [${tab.title}](${tab.url})`)
      }
      lines.push('')
    }
    for (const group of win.groups) {
      lines.push(`### ${group.title} (${group.color})`, '')
      for (const tab of group.tabs) {
        const pad = '  '.repeat(Math.max(0, tab.level))
        lines.push(`${pad}- [${tab.title}](${tab.url})`)
      }
      lines.push('')
    }
  })
  return lines.join('\n').trim() + '\n'
}
