import { installBrowserPolyfill } from 'src/polyfill/browser-polyfill'
import { createApp, reactive, shallowReactive } from 'vue'
import * as E from 'src/enums'
import * as Utils from 'src/utils'
import * as IPC from 'src/services/ipc'
import * as IPPC from 'src/services/ippc.addon'
import * as Logs from 'src/services/logs'
import * as Popups from 'src/services/popups.fg'
import * as Favicons from 'src/services/favicons.fg'
import * as Preview from 'src/services/tabs.fg.preview'
import * as Windows from 'src/services/windows.fg'
import * as Settings from 'src/services/settings.fg'
import * as Sidebar from 'src/services/sidebar.fg'
import * as Containers from 'src/services/containers.fg'
import * as Styles from 'src/services/styles.fg'
import * as Bookmarks from 'src/services/bookmarks.fg'
import * as Menu from 'src/services/menu.fg'
import * as Tabs from 'src/services/tabs.fg'
import * as Store from 'src/services/storage.fg'
import * as DnD from 'src/services/drag-and-drop.fg'
import * as Permissions from 'src/services/permissions.fg'
import * as Notifications from 'src/services/notifications.fg'
import * as History from 'src/services/history.fg'
import * as Search from 'src/services/search.fg'
import * as Info from 'src/services/info'
import * as Snapshots from 'src/services/snapshots.fg'
import * as Sync from 'src/services/sync.fg'
import * as Keybindings from 'src/services/keybindings.fg'
import * as WebReq from 'src/services/web-req.fg'
import SidebarRoot from './sidebar.vue'

async function main(): Promise<void> {
  installBrowserPolyfill()

  Info.setInstanceType(E.InstanceType.sidebar)
  IPC.setInstanceType(E.InstanceType.sidebar)
  IPPC.setInstanceType(E.InstanceType.sidebar)
  Logs.setInstanceType(E.InstanceType.sidebar)

  const ts = performance.now()
  Logs.info('Init start')

  IPC.registerActions({
    reloadTab: Tabs.reloadTab,
    queryTab: Tabs.queryTab,
    getTabs: Tabs.getTabs,
    detachTabs: Tabs.detachTabs,
    getTabsTreeData: Tabs.getTabsTreeData,
    moveTabsToThisWin: Tabs.moveToThisWin,
    moveTabToPanelViaOmnibox: Tabs.moveTabToPanelViaOmnibox,
    moveTabToGroupViaOmnibox: Tabs.moveTabToGroupViaOmnibox,
    openTabs: Tabs.open,
    handleReopening: Tabs.handleReopening,
    getActivePanelConfig: Sidebar.getActivePanelConfig,
    switchToPanel: Sidebar.switchToPanel,
    stopDrag: DnD.onExternalStop,
    setDragInfo: DnD.setDragInfo,
    getGroupInfo: Tabs.getGroupInfo,
    loadFavicons: Favicons.load,
    reloadFavicons: Favicons.load,
    setFavicon: Favicons.set,
    onOutsideSearchInput: Search.onOutsideSearchInput,
    onOutsideSearchNext: Search.next,
    onOutsideSearchPrev: Search.prev,
    onOutsideSearchEnter: Search.enter,
    onOutsideSearchSelectAll: Search.selectAll,
    onOutsideSearchMenu: Search.menu,
    onOutsideSearchExit: Search.onOutsideSearchExit,
    onOutsideSearchBookmarks: Search.bookmarks,
    onOutsideSearchHistory: Search.history,
    onOutsideEditingInput: Tabs.setEditingValue,
    onOutsideEditingEnter: Tabs.onOutsideEditingEnter,
    onOutsideEditingExit: Tabs.onOutsideEditingExit,
    notifyAboutNewSnapshot: Snapshots.notifyAboutNewSnapshot,
    notifyAboutWrongProxyAuthData: Notifications.notifyAboutWrongProxyAuthData,
    notify: Notifications.notify,
    storageChanged: Store.storageChangeListener,
    connectTo: IPC.connectTo,
    getSearchQuery: Search.getSearchQuery,
    getEditingValue: Tabs.getEditingValue,
    updWindowPreface: Windows.updWindowPreface,
  })

  const initResults = await Promise.allSettled([
    Utils.retry({
      action: async again => {
        try {
          await Windows.load()
          if (Windows.id === -1) again()
        } catch (err) {
          Logs.warn('Sidebar: Windows.load retrying...', err)
          again()
        }
      },
      interval: 150,
      increment: 50,
      count: 12,
    }),
    Settings.load(),
    Permissions.load(),
    Info.loadVersionInfo(),
    Info.loadBrowserInfo(),
  ])
  for (const res of initResults) {
    if (res.status === 'rejected') Logs.err('Sidebar: Init step failed:', res.reason)
  }

  IPC.setWinId(Windows.id)
  Logs.setWinId(Windows.id)

  IPC.setupGlobalMessageListener()
  IPC.setupConnectionListener()
  IPC.connectTo(E.InstanceType.bg)

  // Reactivate data for vue
  Containers.reactivate(shallowReactive)
  Sidebar.reactivate(reactive)
  Popups.reactivate(reactive)
  Windows.reactivate(reactive)
  Favicons.reactivate(reactive)
  Bookmarks.reactivate(reactive)
  Tabs.reactivate(reactive)
  DnD.reactivate(reactive)
  Permissions.reactivate(reactive)
  Notifications.reactivate(reactive)
  History.reactivate(reactive)
  Search.reactivate(reactive)
  Styles.reactivate(reactive)
  Sync.reactivate(reactive)

  Styles.updateGlobalFontSize()
  Styles.udpateGlobalFontFamily()

  const app = createApp(SidebarRoot)
  app.mount('#root_container')

  Settings.setupSettingsChangeListener()
  Permissions.setupListeners()
  Windows.setupWindowsListeners()

  Styles.setupListeners()
  Styles.loadCustomSidebarCSS()
  Styles.load()

  await Utils.retry({
    action: async again => {
      try {
        await Containers.load()
      } catch (err) {
        Logs.warn('Sidebar: Containers.load retrying...', err)
        again()
      }
    },
    interval: 150,
    increment: 100,
    count: 6,
  }).catch(err => Logs.err('Sidebar: Containers.load failed:', err))

  await Sidebar.loadPanels().catch(err => Logs.err('Sidebar: loadPanels failed:', err))
  Sidebar.setupListeners()

  if (Sidebar.hasTabs) {
    // Wait briefly if Vivaldi/Chrome is still restoring initial window tabs at startup
    await Utils.retry({
      action: async again => {
        const winId = Windows.id !== -1 ? Windows.id : browser.windows.WINDOW_ID_CURRENT
        const q = await browser.tabs.query({ windowId: winId }).catch(() => [])
        if (!q.length) again()
      },
      interval: 150,
      increment: 50,
      count: 12,
    })
    await Tabs.load().catch(err => Logs.err('Sidebar: Tabs.load failed:', err))
  } else {
    await Tabs.loadInShadowMode().catch(err => Logs.err('Sidebar: loadInShadowMode failed:', err))
  }

  const actPanel = Sidebar.panelsById[Sidebar.activePanelId]
  const initBookmarks = !Settings.state.loadBookmarksOnDemand || Utils.isBookmarksPanel(actPanel)
  const initHistory = Utils.isHistoryPanel(actPanel)
  const initSync = Utils.isSyncPanel(actPanel)
  if (Sidebar.hasBookmarks && initBookmarks) Bookmarks.load()
  if (Sidebar.hasHistory && initHistory) History.load()
  if (Sidebar.hasSync && initSync) Sync.load()

  WebReq.updateWebReqHandlers()

  Menu.loadCtxMenu()
  Menu.setupListeners()

  Favicons.load()

  Keybindings.load()
  Keybindings.setupListeners()

  Search.init()

  IPC.onDisconnected(E.InstanceType.editing, (id: ID) => {
    if (Windows.id !== id) return
    if (Tabs.byId[Tabs.editableTabId]) Tabs.onOutsideEditingExit()
  })

  IPC.onConnected(E.InstanceType.preview, () => {
    if (Preview.state.status === Preview.Status.Closed) {
      IPC.sendToPreview('close')
    }
  })

  if (Settings.state.updateSidebarTitle) Sidebar.updateSidebarTitle(0)

  if (Settings.state.previewTabs) Preview.resetMode()

  Info.loadPlatformInfo()

  Logs.info(`Init end: ${performance.now() - ts}ms`)

  window.getSideberyState = () => {
    return {
      Windows: Utils.clone({
        id: Windows.id,
        incognito: Windows.incognito,
        uniqWinId: Windows.uniqWinId,
        focused: Windows.focused,
        otherWindows: Windows.otherWindows,
        reactive: Windows.reactive,
      }),
      Sidebar: Utils.clone({
        activePanelId: Sidebar.activePanelId,
        prevActivePanelId: Sidebar.prevActivePanelId,
        prevTabsPanelId: Sidebar.prevTabsPanelId,
        panelsById: Sidebar.panelsById,
        panels: Sidebar.panels,
        nav: Sidebar.nav,
      }),
      Tabs: Utils.clone({
        list: Tabs.list,
        pinned: Tabs.pinned,
        byId: Tabs.byId,
      }),
      Bookmarks: Utils.clone({ reactive: Bookmarks.reactive, tree: Bookmarks.tree }),
      Containers: Utils.clone({ reactive: Containers.reactive }),
    }
  }
}
main()
