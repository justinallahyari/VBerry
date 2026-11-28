export type ChromeGroupColor =
  | 'grey'
  | 'blue'
  | 'red'
  | 'yellow'
  | 'green'
  | 'pink'
  | 'purple'
  | 'cyan'
  | 'orange'

export const CHROME_GROUP_COLORS: ChromeGroupColor[] = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]

export interface MoveRule {
  id: string
  active: boolean
  pattern: string
  name?: string
}

/**
 * Persisted panel metadata that pairs 1:1 with Chrome Tab Groups by title/id,
 * and allows empty or Sidebery-imported panels to persist until tabs are added.
 */
export interface SavedPanel {
  id: string
  title: string
  color: ChromeGroupColor
  moveRules: MoveRule[]
  sourceSideberyId?: string
}

type PopupDefaultView = 'search' | 'tabs' | 'bookmarks' | 'history' | 'snapshots'

export type AutoThemeId = 'auto' | 'vivaldi' | 'chrome'

export type PresetThemeId =
  | 'vivaldi-light'
  | 'vivaldi-dark'
  | 'chrome-light'
  | 'chrome-dark'
  | 'light'
  | 'dark'
  | 'paper'
  | 'dawn'
  | 'nordic'
  | 'pine'
  | 'tokyo'
  | 'espresso'

export type ThemeId = AutoThemeId | PresetThemeId | string

export interface ThemeColors {
  scheme: 'light' | 'dark'
  bg: string
  surface: string
  bgSubtle: string
  border: string
  text: string
  textMuted: string
  defaultAccent: string
}

export interface CustomTheme extends ThemeColors {
  id: string
  name: string
}

export interface Settings {
  theme: ThemeId
  customThemes: CustomTheme[]
  themeOverrides: Record<string, Partial<ThemeColors>>
  density: 'compact' | 'comfortable'
  browserMode: 'auto' | 'chrome' | 'vivaldi'
  popupDefaultView: PopupDefaultView
  fontSize: number
  iconSize: number
  uiIconSize: number
  tabControlIconSize: number
  focusSearchOnPanelSwitch: boolean
  clearSearchOnPanelSwitch: boolean
  clearSearchOnSelect: boolean
  searchAllGroups: boolean
  autoHighlightSearchMatch: boolean
  unifiedSearch: boolean
  hideUnifiedSearchInSidePanel: boolean
  unifiedSearchTabs: boolean
  unifiedSearchBookmarks: boolean
  unifiedSearchHistory: boolean
  unifiedEmptyShowTabs: boolean
  unifiedEmptyShowBookmarks: boolean
  unifiedEmptyShowHistory: boolean
  historyDays: number // 0 = all time
  autoCollapseInactiveGroups: boolean
  autoNestChildTabs: boolean
  showTabCounts: boolean
  showBookmarksPanel: boolean
  showHistoryPanel: boolean
  showSnapshotsPanel: boolean
  confirmCloseGroup: boolean
  autoSnapshotMinutes: number // 0 = disabled
  maxSnapshots: number
  customCss: string
}

export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  customThemes: [],
  themeOverrides: {},
  density: 'comfortable',
  browserMode: 'auto',
  popupDefaultView: 'search',
  fontSize: 13,
  iconSize: 16,
  uiIconSize: 19,
  tabControlIconSize: 12,
  focusSearchOnPanelSwitch: true,
  clearSearchOnPanelSwitch: false,
  clearSearchOnSelect: true,
  searchAllGroups: true,
  autoHighlightSearchMatch: true,
  unifiedSearch: true,
  hideUnifiedSearchInSidePanel: false,
  unifiedSearchTabs: true,
  unifiedSearchBookmarks: true,
  unifiedSearchHistory: true,
  unifiedEmptyShowTabs: false,
  unifiedEmptyShowBookmarks: true,
  unifiedEmptyShowHistory: false,
  historyDays: 7,
  autoCollapseInactiveGroups: false,
  autoNestChildTabs: true,
  showTabCounts: true,
  showBookmarksPanel: true,
  showHistoryPanel: true,
  showSnapshotsPanel: true,
  confirmCloseGroup: true,
  autoSnapshotMinutes: 0,
  maxSnapshots: 30,
  customCss: '',
}

interface TabTreeEntry {
  parentId?: number
  folded?: boolean
}

export type TabTreeMap = Record<number, TabTreeEntry>

export interface TreeTabNode {
  tab: chrome.tabs.Tab
  id: number
  level: number
  parentId?: number
  hasChildren: boolean
  childCount: number
  folded: boolean
  hidden: boolean
}

export interface SnapshotTab {
  url: string
  title: string
  level: number
  pinned?: boolean
  folded?: boolean
}

export interface SnapshotGroup {
  id: string
  title: string
  color: ChromeGroupColor
  ungrouped?: boolean
  tabs: SnapshotTab[]
}

export interface SnapshotWindow {
  pinned: SnapshotTab[]
  groups: SnapshotGroup[]
}

export interface VBerrySnapshot {
  id: string
  time: number
  source?: 'vberry' | 'sidebery'
  windows: SnapshotWindow[]
}

export interface SyncConfig {
  enabled: boolean
  syncSettings: boolean
  syncSnapshots: boolean
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  enabled: true,
  syncSettings: true,
  syncSnapshots: true,
}

export interface SyncStateMeta {
  deviceId: string
  settingsUpdatedAt: number
  snapshotsUpdatedAt: number
  appliedSettingsRev: number
  appliedSnapshotsRev: number
  deletedSnapshotIds: string[]
  lastSyncedAt: number | null
  lastError: string | null
  bytesInUse: number
  syncedSnapshotCount: number
  totalSnapshotCount: number
}

export type ActiveView =
  | { kind: 'ungrouped' }
  | { kind: 'group'; groupId: number }
  | { kind: 'saved'; savedId: string }
  | { kind: 'search' }
  | { kind: 'bookmarks' }
  | { kind: 'history' }
  | { kind: 'snapshots' }

export type RuntimeMessage =
  | { type: 'vberry:command'; command: string; windowId?: number }
  | { type: 'vberry:close-panel'; windowId: number; openedBefore?: number }
  | { type: 'vberry:restore-snapshot'; snapshot: VBerrySnapshot; inNewWindow: boolean }
  | { type: 'vberry:discard-tabs'; tabIds: number[]; windowId: number }
  | { type: 'vberry:sync-now'; forcePush?: boolean }
