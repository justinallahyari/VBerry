/**
 * Sidebery v5 <-> Chrome MV3 Architectural Schema Contract
 * Extracted directly from ./_upstream_sidebery/src/types/ and ./_upstream_sidebery/src/services/
 * All 4 specialized sub-agents compile against these exact data structures to guarantee
 * 100% lossless bidirectional compatibility with Firefox Sidebery v5 backups and snapshots.
 */

import type * as E from 'src/enums'
import type * as D from 'src/defaults'
import type { ParsedTheme } from 'src/services/styles'

export type SideberyID = string | number

// ============================================================================
// Chrome MV3 Bridging Contracts
// ============================================================================

export type PanelIsolationMode = 'virtual' | 'tabGroups' | 'windowParking'

export interface TabCompositeFingerprint {
  windowId: ID
  index: number
  normalizedUrl: string
  title: string
  openerTabId?: ID
}

export interface TabTreeAnchorRecord {
  id: ID
  panelId: ID
  parentId: ID
  folded: boolean
  lvl?: number
  customTitle?: string
  customColor?: string
  containerId?: string
  originalUrl?: string
  chromeUrl?: string
  fingerprint: string
  windowId: ID
  index: number
  normalizedUrl: string
  title: string
  openerTabId?: ID
  pinned?: boolean
  updatedAt: number
}

// ============================================================================
// Containers (./_upstream_sidebery/src/types/containers.ts)
// ============================================================================

export interface ContainerContract extends browser.contextualIdentities.Container {
  id: string
  proxified: boolean
  proxy: browser.proxy.ProxyInfo | null
  reopenRulesActive: boolean
  reopenRules: TabReopenRuleConfigContract[]
  userAgentActive: boolean
  userAgent: string
}

export interface NewContainerConfContract {
  id?: string
  cookieStoreId?: string
  name: string
  color: string
  icon: string
  proxified?: boolean
  proxy?: browser.proxy.ProxyInfo | null
  reopenRulesActive?: boolean
  reopenRules?: TabReopenRuleConfigContract[]
  userAgentActive?: boolean
  userAgent?: string
}

// ============================================================================
// Sidebar & Panels (./_upstream_sidebery/src/types/sidebar.ts)
// ============================================================================

export interface TabToPanelMoveRuleConfigContract {
  id: ID
  active: boolean
  name?: string
  url?: string
  containerId?: string
  topLvlOnly?: boolean
}

export interface TabReopenRuleConfigContract {
  id: ID
  type: E.TabReopenRuleType
  active: boolean
  url: string
  name?: string
}

export interface SrcBookmarksPanelConfigContract {
  id: ID
  viewMode: string
  tempMode: boolean
  autoConvert: boolean
}

export interface SrcTabsPanelConfigContract {
  id: ID
  noEmpty: boolean
  newTabCtx: string
  dropTabCtx: string
  moveRules: TabToPanelMoveRuleConfigContract[]
  newTabBtns: string[]
}

export interface PanelConfigCommonPropsContract {
  id: ID
  name: string
  iconSVG: string
  iconIMG?: string
  iconIMGSrc?: string
  color: string
  skipOnSwitching: boolean
  lockedPanel: boolean
}

export interface TabsPanelConfigContract extends PanelConfigCommonPropsContract {
  type: E.PanelType.tabs
  noEmpty: boolean
  newTabCtx: string
  dropTabCtx: string
  moveRules: TabToPanelMoveRuleConfigContract[]
  moveExcludedTo: ID
  bookmarksFolderId: ID
  newTabBtns: string[]
  srcPanelConfig: SrcBookmarksPanelConfigContract | null
}

export interface BookmarksPanelConfigContract extends PanelConfigCommonPropsContract {
  type: E.PanelType.bookmarks
  rootId: ID
  viewMode: string
  tempMode: boolean
  autoConvert: boolean
  srcPanelConfig: SrcTabsPanelConfigContract | null
}

export interface HistoryPanelConfigContract extends PanelConfigCommonPropsContract {
  type: E.PanelType.history
  viewMode: string
  tempMode: boolean
}

export interface SyncPanelConfigContract extends PanelConfigCommonPropsContract {
  type: E.PanelType.sync
  viewMode: string
  tempMode: boolean
}

export type PanelConfigContract =
  | BookmarksPanelConfigContract
  | TabsPanelConfigContract
  | HistoryPanelConfigContract
  | SyncPanelConfigContract

export interface SidebarConfigContract {
  panels: Record<ID, PanelConfigContract>
  nav: ID[]
}

// ============================================================================
// Settings (./_upstream_sidebery/src/types/settings.ts)
// ============================================================================

export interface SettingsStateContract {
  // General
  nativeScrollbars: boolean
  nativeScrollbarsThin: boolean
  nativeScrollbarsLeft: boolean
  selWinScreenshots: boolean
  updateSidebarTitle: boolean
  markWindow: boolean
  markWindowPreface: string
  copyTreeIndent: string
  copyMultiBullet: string
  copyTemplates: string
  updTooltipDelay: number
  selLen: boolean

  // Context menu
  ctxMenuNative: boolean
  ctxMenuRenderInact: boolean
  ctxMenuRenderIcons: boolean
  ctxMenuIgnoreContainers: string

  // Address bar (Omnibox)
  omniReopenInCtr: boolean
  omniReopenInCtrPrefix: string
  omniSwitchToPanel: boolean
  omniSwitchToPanelPrefix: string
  omniMoveToPanel: boolean
  omniMoveToPanelPrefix: string
  omniMoveToGroup: boolean
  omniMoveToGroupPrefix: string

  // Nav bar
  navBarLayout: (typeof D.SETTINGS_OPTIONS.navBarLayout)[number]
  navBarInline: boolean
  navBarSide: (typeof D.SETTINGS_OPTIONS.navBarSide)[number]
  navBtnCount: boolean
  skipEmptyPanels: boolean
  hideEmptyPanels: boolean
  hideDiscardedTabPanels: boolean
  navSwitchPanelsWheel: boolean
  navSwitchPanelsDelay: number
  navActTabsPanelLeftClickAction: (typeof D.SETTINGS_OPTIONS.navActTabsPanelLeftClickAction)[number]
  navActTabsPanelLeftClickTabPos: (typeof D.SETTINGS_OPTIONS.newTabInPanelPos)[number]
  navActBookmarksPanelLeftClickAction: (typeof D.SETTINGS_OPTIONS.navActBookmarksPanelLeftClickAction)[number]
  navTabsPanelMidClickAction: (typeof D.SETTINGS_OPTIONS.navTabsPanelMidClickAction)[number]
  navBookmarksPanelMidClickAction: (typeof D.SETTINGS_OPTIONS.navBookmarksPanelMidClickAction)[number]
  subPanelRecentlyClosedBar: boolean
  subPanelBookmarks: boolean
  subPanelHistory: boolean
  subPanelSync: boolean

  // Group page
  groupLayout: (typeof D.SETTINGS_OPTIONS.groupLayout)[number]

  // Containers
  containersSortByName: boolean
  syncContainersTabGroups?: boolean

  // Drag and drop
  dndTabAct: boolean
  dndTabActDelay: number
  dndTabActMod: (typeof D.SETTINGS_OPTIONS.dndTabActMod)[number]
  dndExp: (typeof D.SETTINGS_OPTIONS.dndExp)[number]
  dndExpDelay: number
  dndExpMod: (typeof D.SETTINGS_OPTIONS.dndExpMod)[number]
  dndOutside: (typeof D.SETTINGS_OPTIONS.dndOutside)[number]
  dndOutsideThresholdTimeout: number
  dndActTabFromLink: boolean
  dndActSearchTab: boolean
  dndMoveTabs: boolean
  dndMoveBookmarks: boolean
  dndTabToPanelPos: (typeof D.SETTINGS_OPTIONS.dndTabToPanelPos)[number]

  // Search
  searchBarMode: (typeof D.SETTINGS_OPTIONS.searchBarMode)[number]
  searchPanelSwitch: (typeof D.SETTINGS_OPTIONS.searchPanelSwitch)[number]
  searchTabSwitch: boolean
  searchMenuTrig: boolean
  searchBookmarksShortcut: string
  searchHistoryShortcut: string
  searchInputTimeout: number

  // Tabs
  warnOnMultiTabClose: (typeof D.SETTINGS_OPTIONS.warnOnMultiTabClose)[number]
  activateLastTabOnPanelSwitching: boolean
  activateLastTabOnPanelSwitchingLoadedOnly: boolean
  switchPanelAfterSwitchingTab: (typeof D.SETTINGS_OPTIONS.switchPanelAfterSwitchingTab)[number]
  scrollPanelAfterSwitchingTab: (typeof D.SETTINGS_OPTIONS.scrollPanelAfterSwitchingTab)[number]
  tabRmBtn: (typeof D.SETTINGS_OPTIONS.tabRmBtn)[number]
  activateAfterClosing: (typeof D.SETTINGS_OPTIONS.activateAfterClosing)[number]
  activateAfterClosingStayInPanel: boolean
  activateAfterClosingGlobal: boolean
  activateAfterClosingNoFolded: boolean
  activateAfterClosingNoDiscarded: boolean
  tabsRmUndoNote: boolean
  tabsUnreadMark: boolean
  tabsUpdateMark?: (typeof D.SETTINGS_OPTIONS.tabsUpdateMark)[number]
  tabsUpdateMarkFirst?: boolean
  tabsBadge: boolean
  tabsBadgeRules: string
  tabsReloadLimit: number
  tabsReloadLimitNotif: boolean
  showNewTabBtns: boolean
  newTabBarPosition: (typeof D.SETTINGS_OPTIONS.newTabBarPosition)[number]
  tabsPanelSwitchActMove: boolean
  tabsPanelSwitchActMoveAuto: boolean
  tabsUrlInTooltip: (typeof D.SETTINGS_OPTIONS.tabsUrlInTooltip)[number]
  tabsContainerInTooltip: boolean
  newTabCtxReopen: boolean
  tabWarmupOnHover: boolean
  tabSwitchDelay: number
  forceDiscard: boolean
  tabUpdDelay: number
  forceUpdTooltip: boolean
  stickyActiveTab: boolean
  tabsTitleLinesMax: number
  tabsTitleLinesBr: (typeof D.SETTINGS_OPTIONS.tabsTitleLinesBr)[number]

  // New tab position
  moveNewTabPin: (typeof D.SETTINGS_OPTIONS.moveNewTabPin)[number]
  moveNewTabParent: (typeof D.SETTINGS_OPTIONS.moveNewTabParent)[number]
  moveNewTabParentIndent: boolean
  moveNewTabParentActPanel: boolean
  moveNewTabButton: (typeof D.SETTINGS_OPTIONS.moveNewTab)[number]
  moveNewTabButtonActivePin: (typeof D.SETTINGS_OPTIONS.moveNewTabActivePin)[number]
  moveNewTab: (typeof D.SETTINGS_OPTIONS.moveNewTab)[number]
  moveNewTabActivePin: (typeof D.SETTINGS_OPTIONS.moveNewTabActivePin)[number]
  autoScrollToNewTab: boolean

  // Pinned tabs
  pinnedTabsPosition: (typeof D.SETTINGS_OPTIONS.pinnedTabsPosition)[number]
  pinnedTabsList: boolean
  pinnedAutoGroup: boolean
  pinnedNoUnload: boolean
  pinnedNoUnloadExplicit: boolean
  pinnedForcedDiscard: boolean

  // Tabs tree
  tabsTree: boolean
  groupOnOpen?: boolean
  tabsTreeLimit: (typeof D.SETTINGS_OPTIONS.tabsTreeLimit)[number]
  stickyAncestorTabs: boolean
  stickyAncestorTabsLimit: (typeof D.SETTINGS_OPTIONS.stickyAncestorTabsLimit)[number]
  stickyAncestorTabsLayout: (typeof D.SETTINGS_OPTIONS.stickyAncestorTabsLayout)[number]
  autoFoldTabs: boolean
  autoFoldTabsExcept: (typeof D.SETTINGS_OPTIONS.autoFoldTabsExcept)[number]
  autoExpandTabs: boolean
  autoExpandTabsOnNew: boolean
  rmChildTabs: (typeof D.SETTINGS_OPTIONS.rmChildTabs)[number]
  tabsLvlDots: boolean
  discardFolded: boolean
  discardFoldedDelay: number
  discardFoldedDelayUnit: (typeof D.SETTINGS_OPTIONS.discardFoldedDelayUnit)[number]
  tabsTreeBookmarks: boolean
  treeRmOutdent: (typeof D.SETTINGS_OPTIONS.treeRmOutdent)[number]
  autoGroupOnClose: boolean
  autoGroupOnClose0Lvl: boolean
  autoGroupOnCloseMouseOnly: boolean
  ignoreFoldedParent: boolean
  showNewGroupConf: boolean
  sortGroupsFirst: boolean

  // Tabs colorization
  colorizeTabs: boolean
  colorizeTabsSrc: (typeof D.SETTINGS_OPTIONS.colorizeTabsSrc)[number]
  colorizeTabsBranches: boolean
  colorizeTabsBranchesSrc: (typeof D.SETTINGS_OPTIONS.colorizeTabsBranchesSrc)[number]
  inheritCustomColor: boolean

  // Tabs preview
  previewTabs: boolean
  previewTabsMode: (typeof D.SETTINGS_OPTIONS.previewTabsMode)[number]
  previewTabsPageModeFallback: (typeof D.SETTINGS_OPTIONS.previewTabsPageModeFallback)[number]
  previewTabsInlineHeight: number
  previewTabsPopupWidth: number
  previewTabsTitle: number
  previewTabsUrl: number
  previewTabsSide: (typeof D.SETTINGS_OPTIONS.previewTabsSide)[number]
  previewTabsDelay: number
  previewTabsFollowMouse: boolean
  previewTabsInPageOffsetY: number
  previewTabsInPageOffsetX: number
  previewTabsCropRight: number

  // Native tabs
  hideInact: boolean
  panelIsolationMode?: PanelIsolationMode
  hideFoldedTabs: boolean
  hideFoldedParent: (typeof D.SETTINGS_OPTIONS.hideFoldedParent)[number]
  hideUnloadedTabs: boolean
  nativeHighlight: boolean

  // Bookmarks
  warnOnMultiBookmarkDelete: (typeof D.SETTINGS_OPTIONS.warnOnMultiBookmarkDelete)[number]
  askNewBookmarkPlace: boolean
  autoCloseBookmarks: boolean
  autoRemoveOther: boolean
  highlightOpenBookmarks: boolean
  activateOpenBookmarkTab: boolean
  showBookmarkLen: boolean
  bookmarksRmUndoNote: boolean
  loadBookmarksOnDemand: boolean
  pinOpenedBookmarksFolder: boolean
  oldBookmarksAfterSave: (typeof D.SETTINGS_OPTIONS.oldBookmarksAfterSave)[number]

  // History
  historyTitleUpdInterval: number

  // Appearance
  fontSize: (typeof D.SETTINGS_OPTIONS.fontSize)[number]
  fontFamily: string
  animations: boolean
  animationSpeed: (typeof D.SETTINGS_OPTIONS.animationSpeed)[number]
  theme: (typeof D.SETTINGS_OPTIONS.theme)[number]
  density: (typeof D.SETTINGS_OPTIONS.density)[number]
  colorScheme: (typeof D.SETTINGS_OPTIONS.colorScheme)[number]

  // Snapshots
  snapNotify: boolean
  snapExcludePrivate: boolean
  snapInterval: number
  snapIntervalUnit: (typeof D.SETTINGS_OPTIONS.snapIntervalUnit)[number]
  snapLimit: number
  snapLimitUnit: (typeof D.SETTINGS_OPTIONS.snapLimitUnit)[number]
  snapAutoExport: boolean
  snapAutoExportPath: string
  snapAutoExportType: (typeof D.SETTINGS_OPTIONS.snapAutoExportType)[number]
  snapMdFullTree: boolean

  // Mouse
  hScrollAction: (typeof D.SETTINGS_OPTIONS.hScrollAction)[number]
  onePanelSwitchPerScroll: boolean
  wheelAccumulationX: boolean
  wheelAccumulationY: boolean
  scrollThroughTabs: (typeof D.SETTINGS_OPTIONS.scrollThroughTabs)[number]
  scrollThroughTabsGlobPinIsolate: boolean
  scrollThroughVisibleTabs: boolean
  scrollThroughTabsSkipDiscarded: boolean
  scrollThroughTabsExceptOverflow: boolean
  scrollThroughTabsCyclic: boolean
  scrollThroughTabsScrollArea: number
  scrollThroughTabsPreselAct: boolean
  scrollThroughTabsPreselDelay: number
  autoMenuMultiSel: boolean
  multipleMiddleClose: boolean
  longClickDelay: number
  wheelThreshold: boolean
  wheelThresholdX: number
  wheelThresholdY: number
  tabDoubleClick: (typeof D.SETTINGS_OPTIONS.tabDoubleClick)[number]
  tabsSecondClickActPrev: boolean
  tabsSecondClickActPrevPanelOnly: boolean
  tabsSecondClickActPrevNoUnload: boolean
  shiftSelAct: boolean
  ctrlSelAct: boolean
  activateOnMouseUp: boolean
  tabCloseOnMouseUp: boolean
  tabLongLeftClick: (typeof D.SETTINGS_OPTIONS.tabLongLeftClick)[number]
  tabLongRightClick: (typeof D.SETTINGS_OPTIONS.tabLongRightClick)[number]
  tabMiddleClick: (typeof D.SETTINGS_OPTIONS.tabMiddleClick)[number]
  tabPinnedMiddleClick: (typeof D.SETTINGS_OPTIONS.tabPinnedMiddleClick)[number]
  tabMiddleClickCtrl: (typeof D.SETTINGS_OPTIONS.tabMiddleClickModifier)[number]
  tabMiddleClickShift: (typeof D.SETTINGS_OPTIONS.tabMiddleClickModifier)[number]
  tabCloseMiddleClick: (typeof D.SETTINGS_OPTIONS.tabCloseMiddleClick)[number]
  tabsPanelLeftClickAction: (typeof D.SETTINGS_OPTIONS.tabsPanelLeftClickAction)[number]
  tabsPanelLeftClickTabPos: (typeof D.SETTINGS_OPTIONS.newTabInPanelPos)[number]
  tabsPanelDoubleClickAction: (typeof D.SETTINGS_OPTIONS.tabsPanelDoubleClickAction)[number]
  tabsPanelDoubleClickTabPos: (typeof D.SETTINGS_OPTIONS.newTabInPanelPos)[number]
  tabsPanelRightClickAction: (typeof D.SETTINGS_OPTIONS.tabsPanelRightClickAction)[number]
  tabsPanelMiddleClickAction: (typeof D.SETTINGS_OPTIONS.tabsPanelMiddleClickAction)[number]
  tabsPanelMiddleClickTabPos: (typeof D.SETTINGS_OPTIONS.newTabInPanelPos)[number]
  newTabMiddleClickAction: (typeof D.SETTINGS_OPTIONS.newTabAction)[number]
  bookmarksLeftClickAction: (typeof D.SETTINGS_OPTIONS.bookmarksLeftClickAction)[number]
  bookmarksLeftClickActivate: boolean
  bookmarksLeftClickPos: (typeof D.SETTINGS_OPTIONS.bookmarksNewTabPos)[number]
  bookmarksMidClickAction: (typeof D.SETTINGS_OPTIONS.bookmarksMidClickAction)[number]
  bookmarksMidClickActivate: boolean
  bookmarksMidClickRemove: boolean
  bookmarksMidClickPos: (typeof D.SETTINGS_OPTIONS.bookmarksNewTabPos)[number]
  historyLeftClickAction: (typeof D.SETTINGS_OPTIONS.historyLeftClickAction)[number]
  historyLeftClickActivate: boolean
  historyLeftClickPos: (typeof D.SETTINGS_OPTIONS.historyNewTabPos)[number]
  historyMidClickAction: (typeof D.SETTINGS_OPTIONS.historyMidClickAction)[number]
  historyMidClickActivate: boolean
  historyMidClickPos: (typeof D.SETTINGS_OPTIONS.historyNewTabPos)[number]

  // Sync
  syncName: string
  syncUseFirefox: boolean
  syncUseGoogleDrive: boolean
  syncUseGoogleDriveApi: boolean
  syncUseGoogleDriveApiClientId: string
  syncSaveSettings: boolean
  syncSaveCtxMenu: boolean
  syncSaveStyles: boolean
  syncSaveKeybindings: boolean

  // Keybindings
  selectActiveTabFirst: boolean
  selectCyclic: boolean
  loopPanelsIgnoreHidden: boolean
  kbNewTabInPanelPos: (typeof D.SETTINGS_OPTIONS.newTabInPanelPos)[number]
}

// ============================================================================
// Snapshots (./_upstream_sidebery/src/types/snapshots.ts)
// ============================================================================

export type SnapItem = SnapTab
export type SnapPanel = SnapTab[]
export type SnapWindow = SnapTab[][]
export type SnapStore = Snapshot[]

export interface SnapTab {
  url: string
  title: string
  panelId: ID
  lvl?: number
  pinned?: boolean
  folded?: boolean
  containerId?: string
  customTitle?: string
  customColor?: string
  priv?: boolean
  originalUrl?: string
}

export interface Snapshot {
  id: ID
  time: number
  containers: Record<ID, ContainerContract> | E.SnapStoreMode.Unchanged | (ContainerContract | string)[]
  sidebar: SidebarConfigContract | E.SnapStoreMode.Unchanged | (PanelConfigContract | string)[]
  tabs: (SnapTab | E.SnapStoreMode.Unchanged | number)[][][]
}

export interface NormalizedSnapshot extends Snapshot {
  containers: Record<ID, ContainerContract>
  sidebar: SidebarConfigContract
  tabs: SnapTab[][][]
}

export interface SnapWindowState {
  id: ID
  panels: SnapPanelState[]
  tabsLen: number
  folded: boolean
  private: boolean
}

export interface SnapPanelState {
  id: ID
  tabs: SnapTabState[]
  name: string
  iconSVG: string
  iconIMG?: string
  color?: string
  folded: boolean
}

export interface SnapTabState extends SnapTab {
  ref: SnapTab
  id?: ID
  parentId?: ID
  containerIcon?: string
  containerColor?: string
  domain?: string
  iconSVG?: string
  sel?: boolean
  folded: boolean
  isParent: boolean
  invisible: boolean
  branchLen: number
}

export interface SnapshotState extends NormalizedSnapshot {
  windows: SnapWindowState[]
  dateStr: string
  timeStr: string
  sizeStr: string
  winCount: number
  tabsCount: number
}

export interface SnapExportTypes {
  JSON?: boolean
  Markdown?: boolean
}

export interface SnapExportInfo {
  id: ID
  time: number
  containers: Record<ID, ContainerContract>
  sidebar: SidebarConfigContract
  tabs: SnapTab[][][]
  jsonFile?: Blob
  md?: string
  mdFile?: Blob
}

// ============================================================================
// Tabs (./_upstream_sidebery/src/types/tabs.ts)
// ============================================================================

export interface TabSessionDataContract {
  id: ID
  panelId: ID
  parentId: ID
  folded: boolean
  customTitle?: string
  customColor?: string
  lvl?: number
  containerId?: string
  originalUrl?: string
  chromeUrl?: string
}

export interface TabCacheContract {
  id: ID
  url: string
  pin?: boolean
  parentId?: ID
  panelId?: ID
  folded?: boolean
  ctx?: string
  uniqWinId?: ID
  customTitle?: string
  customColor?: string
  index?: number
  isMissedGroup?: boolean
  originalUrl?: string
  title?: string
}

export interface ItemInfoContract {
  id: ID
  url?: string
  index?: number
  title?: string
  active?: boolean
  pinned?: boolean
  folded?: boolean
  parentId?: ID
  panelId?: ID
  container?: string
  customTitle?: string
  customColor?: string
  originalUrl?: string
}

export interface PlaceholderInfoContract {
  url: string
  title?: string
  originalUrl?: string
  chromeUrl?: string
}

export interface GroupPageInitDataContract {
  theme?: (typeof D.SETTINGS_OPTIONS.theme)[number]
  parsedTheme?: ParsedTheme
  frameColorScheme?: 'dark' | 'light'
  toolbarColorScheme?: 'dark' | 'light'
  customCSS?: string
  groupLayout?: (typeof D.SETTINGS_OPTIONS.groupLayout)[number]
  animations?: boolean
  groupInfo?: any
  newTabPos?: 'first_child' | 'last_child'
  winId?: ID
  tabId?: ID
  labels?: Record<string, string>
}

// ============================================================================
// Storage & BackupData (./_upstream_sidebery/src/types/storage.ts & src/types.ts)
// ============================================================================

export type MenuConfOptionIdContract = string
export type MenuConfSubOptionsContract = { name?: string; opts: MenuConfOptionIdContract[] }
export type MenuConfContract = (MenuConfOptionIdContract | MenuConfSubOptionsContract)[]
export interface MenuConfsContract {
  tabs?: MenuConfContract
  bookmarks?: MenuConfContract
  tabsPanel?: MenuConfContract
  bookmarksPanel?: MenuConfContract
}

export interface FavDomainContract {
  index: number
  len: number
}

export interface BackupDataContract {
  ver?: string
  settings?: SettingsStateContract
  sidebar?: SidebarConfigContract
  contextMenu?: MenuConfsContract
  containers?: Record<string, ContainerContract>
  snapshots?: Snapshot[]
  sidebarCSS?: string
  groupCSS?: string
  favicons?: string[]
  favHashes?: number[]
  favDomains?: Record<string, FavDomainContract>
  keybindings?: Record<string, string>
}

export interface StoredContract {
  ver?: string
  settings?: SettingsStateContract
  containers?: Record<ID, ContainerContract>
  profileID?: string
  tabsDataCache?: TabCacheContract[][]
  favicons_01?: string[]
  favicons_02?: string[]
  favicons_03?: string[]
  favicons_04?: string[]
  favicons_05?: string[]
  favHashes?: number[]
  favDomains?: Record<string, FavDomainContract>
  sidebar?: SidebarConfigContract
  lastFocusedActivePanelId?: ID
  snapshots?: Snapshot[]
  lastSnapTime?: number
  contextMenu?: MenuConfsContract
  sidebarCSS?: string
  groupCSS?: string
  expandedBookmarkFolders?: Record<ID, Record<ID, boolean>>
  bookmarksRecentFolders?: ID[]
  googleDriveFileIds?: Record<string, string>
  omnibox?: { types: E.OmniCmdType[]; cmds: string[] }
}
