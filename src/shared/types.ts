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

export interface PanelShortcuts {
  tabs: string
  bookmarks: string
  history: string
}

export const DEFAULT_PANEL_SHORTCUTS: PanelShortcuts = {
  tabs: 'Alt+1',
  bookmarks: 'Alt+2',
  history: 'Alt+3',
}

export type WebpageSearchMode = 'popup' | 'overlay'

export interface Settings {
  theme: 'auto' | 'light' | 'dark'
  density: 'compact' | 'comfortable'
  browserMode: 'auto' | 'chrome' | 'vivaldi'
  fontSize: number
  iconSize: number
  uiIconSize: number
  tabControlIconSize: number
  panelShortcuts: PanelShortcuts
  webpageSearchMode: WebpageSearchMode
  focusSearchOnPanelSwitch: boolean
  clearSearchOnPanelSwitch: boolean
  clearSearchOnSelect: boolean
  searchAllGroups: boolean
  autoHighlightSearchMatch: boolean
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
  density: 'comfortable',
  browserMode: 'auto',
  fontSize: 13,
  iconSize: 16,
  uiIconSize: 19,
  tabControlIconSize: 12,
  panelShortcuts: { ...DEFAULT_PANEL_SHORTCUTS },
  webpageSearchMode: 'popup',
  focusSearchOnPanelSwitch: true,
  clearSearchOnPanelSwitch: false,
  clearSearchOnSelect: true,
  searchAllGroups: true,
  autoHighlightSearchMatch: true,
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

export interface TabTreeEntry {
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

export type ActiveView =
  | { kind: 'ungrouped' }
  | { kind: 'group'; groupId: number }
  | { kind: 'saved'; savedId: string }
  | { kind: 'bookmarks' }
  | { kind: 'history' }
  | { kind: 'snapshots' }

export type SpotlightView = 'tabs' | 'bookmarks' | 'history'

export interface SpotlightGroup {
  key: string
  title: string
  color?: ChromeGroupColor
  count: number
}

export interface SpotlightItem {
  id: string
  kind: 'tab' | 'url' | 'folder'
  tabId?: number
  folderId?: string
  title: string
  url: string
  favIconUrl?: string
  active?: boolean
  discarded?: boolean
  level?: number
  hasChildren?: boolean
  childCount?: number
  folded?: boolean
  expanded?: boolean
  groupTitle?: string
  groupColor?: ChromeGroupColor
}

export type RuntimeMessage =
  | { type: 'vberry:command'; command: string; windowId?: number }
  | { type: 'vberry:open-quick-search'; view: SpotlightView; windowId: number }
  | { type: 'vberry:panel-open'; windowId: number }
  | { type: 'vberry:panel-close'; windowId: number }
  | { type: 'vberry:close-panel'; windowId: number }
  | { type: 'vberry:restore-snapshot'; snapshot: VBerrySnapshot; inNewWindow: boolean }
  | { type: 'vberry:discard-tabs'; tabIds: number[]; windowId: number }
  | {
      type: 'vberry:spotlight-query'
      query: string
      view: SpotlightView
      windowId: number
      groupKey?: string
      expandedFolderIds?: string[]
    }
  | { type: 'vberry:spotlight-toggle-fold'; tabId: number }
  | {
      type: 'vberry:spotlight-activate'
      kind: 'tab' | 'url'
      tabId?: number
      url?: string
      windowId: number
    }
