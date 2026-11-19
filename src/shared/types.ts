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

export const GROUP_COLOR_HEX: Record<ChromeGroupColor, { light: string; dark: string }> = {
  grey: { light: '#5f6368', dark: '#dadce0' },
  blue: { light: '#1a73e8', dark: '#8ab4f8' },
  red: { light: '#d93025', dark: '#f28b82' },
  yellow: { light: '#e37400', dark: '#fdd663' },
  green: { light: '#188038', dark: '#81c995' },
  pink: { light: '#d01884', dark: '#ff8bcb' },
  purple: { light: '#9334e6', dark: '#c58af9' },
  cyan: { light: '#007b83', dark: '#78d9ec' },
  orange: { light: '#fa7b17', dark: '#fcad70' },
}

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

export interface Settings {
  theme: 'auto' | 'light' | 'dark'
  density: 'compact' | 'comfortable'
  browserMode: 'auto' | 'chrome' | 'vivaldi'
  fontSize: number
  iconSize: number
  uiIconSize: number
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

export interface RuntimeCommandMessage {
  type: 'vberry:command'
  command: string
}
