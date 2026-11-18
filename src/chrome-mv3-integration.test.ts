import { beforeEach, describe, expect, test } from 'vitest'
import * as E from 'src/enums'
import * as D from 'src/defaults'
import * as Utils from 'src/utils'
import * as Info from 'src/services/info'
import * as Settings from 'src/services/settings'
import * as Containers from 'src/services/containers.bg'
import * as SidebarConfig from 'src/services/sidebar-config'
import * as SidebarBg from 'src/services/sidebar.bg'
import * as WindowsBg from 'src/services/windows.bg'
import * as TabsBg from 'src/services/tabs.bg'
import * as SnapshotsBg from 'src/services/snapshots.bg'
import * as TabTreeAnchor from 'src/services/tab-tree-anchor'
import * as ContainerBridge from 'src/polyfill/container-bridge'
import * as PanelIsolation from 'src/polyfill/panel-isolation'
import {
  importBackupData,
  exportBackupData,
  normalizeSnapshot,
  convertToMarkdown,
  prepareExport,
  applySnapshot,
} from 'src/services/compat-backup-snapshot'
import type { AnySnapshot } from 'src/services/snapshots'
import type { BackupData, NormalizedSnapshot, Snapshot } from 'src/types'
import type { ChromeMockEnv } from '../tests/env-setup'

function getEnv(): ChromeMockEnv {
  return (globalThis as unknown as { __chromeMockEnv: ChromeMockEnv }).__chromeMockEnv
}

function createSampleFirefoxBackup(): BackupData {
  const workContainer = {
    ...Utils.clone(D.DEFAULT_CONTAINER),
    id: 'firefox-container-1',
    cookieStoreId: 'firefox-container-1',
    name: 'Work',
    icon: 'briefcase',
    color: 'blue',
    colorCode: '#37adff',
    proxified: true,
    proxy: {
      type: 'socks' as const,
      host: '127.0.0.1',
      port: '1080',
      proxyDNS: true,
    },
    reopenRulesActive: true,
    reopenRules: [
      {
        id: 'rule-1',
        type: E.TabReopenRuleType.Include,
        active: true,
        name: 'Corp Intranet',
        url: 'corp.example.com',
      },
    ],
    userAgentActive: true,
    userAgent: 'Sidebery-Work-UA/1.0',
  }

  const personalContainer = {
    ...Utils.clone(D.DEFAULT_CONTAINER),
    id: 'firefox-container-2',
    cookieStoreId: 'firefox-container-2',
    name: 'Personal',
    icon: 'chill',
    color: 'turquoise',
    colorCode: '#00c79a',
  }

  const workPanel = {
    ...Utils.clone(D.TABS_PANEL_CONFIG),
    id: 'panel-work',
    name: 'Work Tabs',
    iconSVG: 'icon_tabs',
    color: 'blue',
    newTabCtx: 'firefox-container-1',
    moveRules: [
      {
        id: 'mr-1',
        active: true,
        name: 'Move Work Container',
        containerId: 'firefox-container-1',
      },
    ],
  }

  const researchPanel = {
    ...Utils.clone(D.TABS_PANEL_CONFIG),
    id: 'panel-research',
    name: 'Research',
    iconSVG: 'icon_books',
    color: 'green',
    newTabCtx: 'firefox-container-2',
  }

  const bookmarksPanel = {
    ...Utils.clone(D.BOOKMARKS_PANEL_CONFIG),
    id: 'panel-bkm',
    name: 'Bookmarks',
    rootId: D.BKM_OTHER_ID,
  }

  const sidebar = {
    panels: {
      'panel-work': workPanel,
      'panel-research': researchPanel,
      'panel-bkm': bookmarksPanel,
    },
    nav: ['panel-work', 'panel-research', 'panel-bkm'],
  }

  const ffExtBase = 'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579'
  const ffSettings = Utils.clone(D.DEFAULT_SETTINGS) as any
  delete ffSettings.syncContainersTabGroups
  delete ffSettings.panelIsolationMode
  ffSettings.tabsTree = true
  ffSettings.snapMdFullTree = true
  ffSettings.snapAutoExport = true
  ffSettings.snapAutoExportType = 'both'
  ffSettings.snapAutoExportPath = 'Sidebery/snap-%Y.%M.%D'

  const snap1: NormalizedSnapshot = {
    id: 'snap-ff-1',
    time: 1700000000000,
    containers: {
      'firefox-container-1': workContainer,
      'firefox-container-2': personalContainer,
    },
    sidebar,
    tabs: [
      [
        // Pinned tab
        [
          {
            url: 'https://mail.corp.example.com/',
            title: 'Work Mail',
            panelId: -1,
            pinned: true,
            containerId: 'firefox-container-1',
          },
        ],
        // Work panel nested tree
        [
          {
            url: `${ffExtBase}/sidebery/group.html#Sprint%20Planning`,
            title: 'Sprint Planning',
            panelId: 'panel-work',
            folded: false,
            customTitle: 'Sprint Root',
            customColor: 'blue',
            containerId: 'firefox-container-1',
          },
          {
            url: 'https://docs.corp.example.com/spec',
            title: 'Architecture Spec',
            panelId: 'panel-work',
            lvl: 1,
            folded: true,
            containerId: 'firefox-container-1',
          },
          {
            url: 'https://docs.corp.example.com/spec#api',
            title: 'API Schema',
            panelId: 'panel-work',
            lvl: 2,
            containerId: 'firefox-container-1',
          },
        ],
        // Research panel with Firefox internal URLs & placeholder
        [
          {
            url: 'about:config',
            title: 'Advanced Preferences',
            panelId: 'panel-research',
            containerId: 'firefox-container-2',
          },
          {
            url: 'about:addons',
            title: 'Add-ons Manager',
            panelId: 'panel-research',
            lvl: 1,
          },
          {
            url: `${ffExtBase}/page.url.html#${encodeURIComponent(
              JSON.stringify(['file:///Users/demo/notes.pdf', 'Local Notes PDF'])
            )}`,
            title: 'Local Notes PDF',
            panelId: 'panel-research',
          },
        ],
      ],
    ],
  }

  // Snapshot 2: Sidebery standard Unchanged (-1) delta snapshot
  const snap2: Snapshot = {
    id: 'snap-ff-2',
    time: 1700000600000,
    containers: E.SnapStoreMode.Unchanged,
    sidebar: E.SnapStoreMode.Unchanged,
    tabs: [
      [
        [E.SnapStoreMode.Unchanged],
        [
          E.SnapStoreMode.Unchanged,
          E.SnapStoreMode.Unchanged,
          {
            url: 'https://docs.corp.example.com/spec#updated',
            title: 'Updated API Schema',
            panelId: 'panel-work',
            lvl: 2,
            containerId: 'firefox-container-1',
          },
        ],
        [E.SnapStoreMode.Unchanged, E.SnapStoreMode.Unchanged, E.SnapStoreMode.Unchanged],
      ],
    ],
  }

  // Snapshot 3: Compact delta array snapshot (containers as string[] / panels as string[] / numeric tab index refs)
  const snap3: AnySnapshot = {
    id: 'snap-ff-3',
    time: 1700001200000,
    containers: ['firefox-container-1', 'firefox-container-2'],
    sidebar: ['panel-work', 'panel-research', 'panel-bkm'],
    tabs: [
      [
        [0],
        [0, 1, 2],
        [0, 1, 2],
      ],
    ],
  }

  return {
    ver: '5.6.1',
    settings: ffSettings,
    sidebar,
    containers: {
      'firefox-container-1': workContainer,
      'firefox-container-2': personalContainer,
    },
    contextMenu: {
      tabs: ['undoRmTab', 'separator-1', { name: 'Tree', opts: ['foldBranch', 'expandBranch'] }],
    },
    sidebarCSS: `
:root {
  --tabs-indent: 14px;
  --tabs-height: 30px;
  --frame-bg: #1c1b22;
}
.Tab[data-lvl="1"][data-folded="true"] {
  opacity: 0.85;
}
`.trim(),
    groupCSS: '.group-title { font-weight: 600; }',
    keybindings: {
      _execute_sidebar_action: 'Ctrl+E',
      next_panel: 'Alt+Period',
      prev_panel: 'Alt+Comma',
      create_snapshot: 'Alt+Shift+S',
    },
    snapshots: [snap1, snap2, snap3 as unknown as Snapshot],
  }
}

describe('Sidebery Chrome MV3 Integration & Lossless Compatibility', () => {
  beforeEach(async () => {
    getEnv().reset()
    TabTreeAnchor.clearInMemoryCacheForTest()
    Containers.reactive.byId = {}
    WindowsBg.byId.clear()
    for (const k of Object.keys(TabsBg.byId)) delete TabsBg.byId[k]
    for (const k of Object.keys(TabsBg.cacheByWin)) delete TabsBg.cacheByWin[k]
    Info.setInstanceType(E.InstanceType.bg)
    Utils.updateObject(Settings.state, Utils.clone(D.DEFAULT_SETTINGS), Settings.state)

    await TabTreeAnchor.init()
    await ContainerBridge.init()
    await PanelIsolation.init()
  })

  test('1. Imports Firefox Sidebery v5 BackupData JSON losslessly (nested trees, containers, CSS, keybindings, delta snapshots)', async () => {
    const ffBackup = createSampleFirefoxBackup()
    const rawJson = JSON.stringify(ffBackup)

    const result = await importBackupData(JSON.parse(rawJson))

    expect(result.containersIds['firefox-container-1']).toBe('firefox-container-1')
    expect(result.containersIds['firefox-container-2']).toBe('firefox-container-2')
    expect(result.importedSnapshotsCount).toBe(3)

    const stored = await browser.storage.local.get<any>([
      'containers',
      'settings',
      'sidebar',
      'contextMenu',
      'sidebarCSS',
      'groupCSS',
      'snapshots',
    ])

    // Container metadata preserved intact
    expect(stored.containers['firefox-container-1'].name).toBe('Work')
    expect(stored.containers['firefox-container-1'].proxy).toEqual({
      type: 'socks',
      host: '127.0.0.1',
      port: '1080',
      proxyDNS: true,
    })
    expect(stored.containers['firefox-container-1'].reopenRules[0].url).toBe('corp.example.com')
    expect(stored.containers['firefox-container-1'].userAgent).toBe('Sidebery-Work-UA/1.0')

    // Settings normalized with Chrome defaults
    expect(stored.settings.tabsTree).toBe(true)
    expect(stored.settings.snapMdFullTree).toBe(true)
    expect(stored.settings.syncContainersTabGroups).toBe(false)
    expect(stored.settings.panelIsolationMode).toBe('virtual')

    // Custom CSS & Context Menu preserved verbatim
    expect(stored.sidebarCSS).toContain('--tabs-indent: 14px')
    expect(stored.sidebarCSS).toContain('.Tab[data-lvl="1"][data-folded="true"]')
    expect(stored.groupCSS).toBe('.group-title { font-weight: 600; }')
    expect(stored.contextMenu.tabs).toHaveLength(3)

    // Keybindings preserved via virtual Chrome commands polyfill
    const cmds = await browser.commands.getAll()
    const snapCmd = cmds.find(c => c.name === 'create_snapshot')
    expect(snapCmd?.shortcut).toBe('Alt+Shift+S')

    // All 3 snapshots including delta-encoded (-1) and compact delta array normalize cleanly
    expect(stored.snapshots).toHaveLength(3)
    const norm2 = normalizeSnapshot(stored.snapshots, 1)
    const norm3 = normalizeSnapshot(stored.snapshots, 2)
    expect(norm2?.containers['firefox-container-1']?.name).toBe('Work')
    expect(norm2?.sidebar.nav).toEqual(['panel-work', 'panel-research', 'panel-bkm'])
    expect(norm2?.tabs[0][1][2].url).toBe('https://docs.corp.example.com/spec#updated')
    expect(norm3?.containers['firefox-container-2']?.name).toBe('Personal')
    expect(norm3?.tabs[0][1][0].customTitle).toBe('Sprint Root')
    expect(norm3?.tabs[0][1][0].url).toContain('chrome-extension://sidebery-chrome-ext-id/page.group.html#Sprint%20Planning')
    expect(norm3?.tabs[0][2][2].url).toContain('chrome-extension://sidebery-chrome-ext-id/page.url.html#')
  })

  test('2. Restores multi-window multi-panel Firefox snapshot into Chrome, translates URLs, and survives simulated MV3 SW restart + new runtime tab IDs', async () => {
    const ffExtBase = 'moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579'
    const baseBackup = createSampleFirefoxBackup()
    await importBackupData(baseBackup)
    await Containers.load()
    await SidebarBg.load()

    const multiWinSnap: NormalizedSnapshot = {
      id: 'snap-multi-win',
      time: Date.now(),
      containers: baseBackup.containers!,
      sidebar: baseBackup.sidebar!,
      tabs: [
        // Window 1
        [
          [
            {
              url: 'https://pinned.example.com/',
              title: 'Pinned Hub',
              panelId: -1,
              pinned: true,
              containerId: 'firefox-container-1',
            },
          ],
          [
            {
              url: `${ffExtBase}/page.group.html#Release%20Checklist`,
              title: 'Release Checklist',
              panelId: 'panel-work',
              customTitle: 'Release Group',
              customColor: 'purple',
              containerId: 'firefox-container-1',
            },
            {
              url: `${ffExtBase}/sidebery/group.html#Subgroup`,
              title: 'Subgroup',
              panelId: 'panel-work',
              lvl: 1,
              folded: true,
              containerId: 'firefox-container-1',
            },
            {
              url: 'https://ci.corp.example.com/build/42',
              title: 'Build 42',
              panelId: 'panel-work',
              lvl: 2,
              containerId: 'firefox-container-1',
            },
          ],
          [
            {
              url: 'about:config',
              title: 'about:config',
              panelId: 'panel-research',
              containerId: 'firefox-container-2',
            },
            {
              url: 'about:addons',
              title: 'about:addons',
              panelId: 'panel-research',
              lvl: 1,
            },
            {
              url: `${ffExtBase}/page.url.html#${encodeURIComponent(
                JSON.stringify(['file:///tmp/design.pdf', 'Design PDF'])
              )}`,
              title: 'Design PDF',
              panelId: 'panel-research',
            },
          ],
        ],
        // Window 2
        [
          [
            {
              url: 'https://second-window.example.com/',
              title: 'Second Window Root',
              panelId: 'panel-research',
              customTitle: 'Win2 Root',
              customColor: 'green',
            },
            {
              url: 'https://second-window.example.com/child',
              title: 'Second Window Child',
              panelId: 'panel-research',
              lvl: 1,
            },
          ],
        ],
      ],
    }

    await applySnapshot(multiWinSnap)

    const env = getEnv()
    expect(env.windows).toHaveLength(2)

    const win1Tabs = env.tabs.filter(t => t.windowId === env.windows[0].id).sort((a, b) => a.index - b.index)
    const win2Tabs = env.tabs.filter(t => t.windowId === env.windows[1].id).sort((a, b) => a.index - b.index)

    expect(win1Tabs).toHaveLength(7)
    expect(win2Tabs).toHaveLength(2)

    // Verify Firefox -> Chrome URL translations on created Chrome tabs
    expect(win1Tabs[1].url).toBe('chrome-extension://sidebery-chrome-ext-id/page.group.html#Release%20Checklist')
    expect(win1Tabs[2].url).toBe('chrome-extension://sidebery-chrome-ext-id/page.group.html#Subgroup')
    expect(win1Tabs[4].url).toBe('chrome://flags')
    expect(win1Tabs[5].url).toBe('chrome://extensions')
    expect(win1Tabs[6].url).toContain('chrome-extension://sidebery-chrome-ext-id/page.url.html#')

    // Simulate MV3 Service Worker termination/restart (wipe in-memory caches)
    TabTreeAnchor.clearInMemoryCacheForTest()
    await TabTreeAnchor.init()

    const restoredSameIds = await TabTreeAnchor.restoreOrMatchTabsState(win1Tabs)
    expect(restoredSameIds.tabsSessionData).toHaveLength(7)
    expect(restoredSameIds.tabsSessionData[1]?.panelId).toBe('panel-work')
    expect(restoredSameIds.tabsSessionData[1]?.customTitle).toBe('Release Group')
    expect(restoredSameIds.tabsSessionData[1]?.customColor).toBe('purple')
    expect(restoredSameIds.tabsSessionData[2]?.parentId).toBe(win1Tabs[1].id)
    expect(restoredSameIds.tabsSessionData[2]?.lvl).toBe(1)
    expect(restoredSameIds.tabsSessionData[2]?.folded).toBe(true)
    expect(restoredSameIds.tabsSessionData[3]?.parentId).toBe(win1Tabs[2].id)
    expect(restoredSameIds.tabsSessionData[3]?.lvl).toBe(2)
    expect(restoredSameIds.tabsSessionData[4]?.originalUrl).toBe('about:config')
    expect(restoredSameIds.tabsSessionData[5]?.originalUrl).toBe('about:addons')
    expect(restoredSameIds.tabsSessionData[4]?.containerId).toBe('firefox-container-2')

    // Simulate Chrome browser session restore assigning brand-new runtime tab.id & windowId
    TabTreeAnchor.clearInMemoryCacheForTest()
    await TabTreeAnchor.init()

    const renumberedTabs = win1Tabs.map(t => ({
      ...t,
      id: t.id + 9000,
      windowId: 88,
      openerTabId: t.openerTabId ? t.openerTabId + 9000 : undefined,
    }))
    const restoredNewIds = await TabTreeAnchor.restoreOrMatchTabsState(renumberedTabs)

    expect(restoredNewIds.tabsSessionData[1]?.panelId).toBe('panel-work')
    expect(restoredNewIds.tabsSessionData[1]?.customTitle).toBe('Release Group')
    expect(restoredNewIds.tabsSessionData[2]?.parentId).toBe(renumberedTabs[1].id)
    expect(restoredNewIds.tabsSessionData[2]?.lvl).toBe(1)
    expect(restoredNewIds.tabsSessionData[2]?.folded).toBe(true)
    expect(restoredNewIds.tabsSessionData[3]?.parentId).toBe(renumberedTabs[2].id)
    expect(restoredNewIds.tabsSessionData[3]?.lvl).toBe(2)
    expect(restoredNewIds.tabsSessionData[4]?.panelId).toBe('panel-research')
    expect(restoredNewIds.tabsSessionData[4]?.originalUrl).toBe('about:config')
    expect(restoredNewIds.tabsSessionData[4]?.containerId).toBe('firefox-container-2')
    expect(restoredNewIds.tabsSessionData[5]?.parentId).toBe(renumberedTabs[4].id)
    expect(restoredNewIds.tabsSessionData[5]?.lvl).toBe(1)
  })

  test('3. Captures live Chrome state into Snapshot (JSON + Markdown + chrome.alarms) and exports BackupData with 100% Firefox Sidebery v5 parity', async () => {
    const ffBackup = createSampleFirefoxBackup()
    await importBackupData(ffBackup)
    await Containers.load()
    await SidebarBg.load()

    // Apply snapshot 1 so Chrome windows/tabs reflect restored Firefox session
    const normSnap1 = normalizeSnapshot(ffBackup.snapshots!, 0)!
    await applySnapshot(normSnap1)

    // Schedule periodic snapshot via chrome.alarms and trigger alarm
    Settings.state.snapInterval = 15
    Settings.state.snapIntervalUnit = 'min'
    Settings.state.snapAutoExport = true
    Settings.state.snapAutoExportType = 'both'
    Settings.state.snapMdFullTree = true
    await SnapshotsBg.scheduleSnapshots()

    expect(getEnv().alarms[SnapshotsBg.SNAPSHOT_ALARM_NAME]).toBeDefined()

    // Create live snapshot directly (verifies auto-export via chrome.downloads, including MV3 SW data URL fallback)
    const origCreateObjectURL = URL.createObjectURL
    let createdSnap
    try {
      ;(URL as any).createObjectURL = undefined
      createdSnap = await SnapshotsBg.createSnapshot(false)
    } finally {
      URL.createObjectURL = origCreateObjectURL
    }
    expect(createdSnap).toBeDefined()

    // Verify auto-export triggered chrome.downloads.download for both JSON and Markdown with data URLs
    expect(getEnv().downloads.length).toBeGreaterThanOrEqual(2)
    const jsonDl = getEnv().downloads.find(d => d.filename.endsWith('.json'))
    const mdDl = getEnv().downloads.find(d => d.filename.endsWith('.md'))
    expect(jsonDl?.url.startsWith('data:application/json')).toBe(true)
    expect(mdDl?.url.startsWith('data:text/markdown')).toBe(true)

    // Also trigger chrome.alarms handler to verify periodic snapshot execution
    getEnv().triggerAlarm(SnapshotsBg.SNAPSHOT_ALARM_NAME)

    // Verify Markdown indentation with snapMdFullTree = true
    const storedAfter = await browser.storage.local.get<any>('snapshots')
    const latestNorm = normalizeSnapshot(storedAfter.snapshots, storedAfter.snapshots.length - 1)!
    const md = convertToMarkdown(latestNorm)
    expect(md).toContain('  - ### Work Tabs')
    expect(md).toContain('    - [Sprint Root]')
    expect(md).toContain('      - [Architecture Spec](https://docs.corp.example.com/spec)')
    expect(md).toContain('        - [API Schema](https://docs.corp.example.com/spec#api)')

    const expInfo = prepareExport(latestNorm, { JSON: true, Markdown: true })
    expect(expInfo.jsonFile).toBeInstanceOf(Blob)
    expect(expInfo.mdFile).toBeInstanceOf(Blob)

    // Export full BackupData and verify lossless Firefox Sidebery v5 schema parity
    const exported = await exportBackupData()
    expect(exported.filename).toMatch(/^sidebery-data-\d{4}\.\d{2}\.\d{2}-\d{2}\.\d{2}\.\d{2}\.json$/)

    const parsedExport = JSON.parse(exported.json) as BackupData
    expect(parsedExport.ver).toBe('5.6.1')
    expect(parsedExport.containers?.['firefox-container-1']?.name).toBe('Work')
    expect(parsedExport.containers?.['firefox-container-1']?.userAgent).toBe('Sidebery-Work-UA/1.0')
    expect(parsedExport.sidebar?.nav).toEqual(['panel-work', 'panel-research', 'panel-bkm'])
    expect(parsedExport.sidebarCSS).toContain('--tabs-indent: 14px')
    expect(parsedExport.groupCSS).toBe('.group-title { font-weight: 600; }')
    expect(parsedExport.contextMenu?.tabs).toHaveLength(3)
    expect(parsedExport.keybindings?.create_snapshot).toBe('Alt+Shift+S')

    // Verify round-trip URLs inside latest exported snapshot match original Firefox URLs
    const lastExportedNorm = normalizeSnapshot(parsedExport.snapshots!, parsedExport.snapshots!.length - 1)!
    const exportedWorkGroupTab = lastExportedNorm.tabs[0][1][0]
    const exportedResearchAboutConfig = lastExportedNorm.tabs[0][2][0]
    const exportedResearchAboutAddons = lastExportedNorm.tabs[0][2][1]
    const exportedResearchFileTab = lastExportedNorm.tabs[0][2][2]

    expect(exportedWorkGroupTab.url).toBe('moz-extension://c02055a8-a7a3-4076-bb5c-8d913619f579/sidebery/group.html#Sprint%20Planning')
    expect(exportedWorkGroupTab.customTitle).toBe('Sprint Root')
    expect(exportedWorkGroupTab.containerId).toBe('firefox-container-1')
    expect(exportedResearchAboutConfig.url).toBe('about:config')
    expect(exportedResearchAboutAddons.url).toBe('about:addons')
    expect(exportedResearchFileTab.url).toBe('file:///Users/demo/notes.pdf')
  })

  test('4. Bridges Virtual Containers to Native Chrome TabGroups and enforces all 3 Panel Isolation Modes', async () => {
    const env = getEnv()
    const win = await browser.windows.create({ url: 'https://alpha.example.com' })
    const tab1 = win.tabs![0]
    const tab2 = await browser.tabs.create({ windowId: win.id, url: 'https://beta.example.com', active: false })
    const tab3 = await browser.tabs.create({ windowId: win.id, url: 'https://gamma.example.com', active: false })

    // 4a. Sync Virtual Container to Native Chrome TabGroup
    Settings.state.syncContainersTabGroups = true
    await ContainerBridge.create({
      id: 'firefox-container-sync',
      name: 'Engineering',
      color: 'purple',
      icon: 'circle',
    })
    const syncedGroupId = await ContainerBridge.syncTabWithNativeTabGroup(
      tab1.id,
      win.id!,
      'firefox-container-sync'
    )
    expect(syncedGroupId).toBeDefined()
    const createdGrp = env.tabGroups.find(g => g.id === syncedGroupId)
    expect(createdGrp?.title).toBe('Engineering')
    expect(createdGrp?.color).toBe('purple')

    // 4b. Panel Isolation Mode: virtual (default)
    Settings.state.panelIsolationMode = 'virtual'
    const tabsInput = [
      { id: tab1.id, windowId: win.id!, index: 0, panelId: 'p1', active: true },
      { id: tab2.id, windowId: win.id!, index: 1, panelId: 'p2', active: false },
      { id: tab3.id, windowId: win.id!, index: 2, panelId: 'p2', active: false },
    ]
    const panelsById = {
      p1: { id: 'p1', name: 'Panel 1', color: 'blue' },
      p2: { id: 'p2', name: 'Panel 2', color: 'green' },
    }
    await PanelIsolation.syncWindowIsolation(win.id!, 'p1', tabsInput, panelsById)
    expect(PanelIsolation.isTabHidden(tab1.id)).toBe(false)
    expect(PanelIsolation.isTabHidden(tab2.id)).toBe(true)
    expect(PanelIsolation.isTabHidden(tab3.id)).toBe(true)

    const queried = await browser.tabs.query({ windowId: win.id })
    expect(queried.find(t => t.id === tab2.id)?.hidden).toBe(true)

    // 4c. Panel Isolation Mode: tabGroups (native Tab Group auto-collapse)
    Settings.state.panelIsolationMode = 'tabGroups'
    await PanelIsolation.syncWindowIsolation(win.id!, 'p1', tabsInput, panelsById)
    const p1Group = env.tabGroups.find(g => g.title === 'Panel 1')
    const p2Group = env.tabGroups.find(g => g.title === 'Panel 2')
    expect(p1Group?.collapsed).toBe(false)
    expect(p2Group?.collapsed).toBe(true)

    // Switch active panel to p2 (active tab moves to p2) -> p1 collapses, p2 expands
    const tabsInputP2 = [
      { id: tab1.id, windowId: win.id!, index: 0, panelId: 'p1', active: false },
      { id: tab2.id, windowId: win.id!, index: 1, panelId: 'p2', active: true },
      { id: tab3.id, windowId: win.id!, index: 2, panelId: 'p2', active: false },
    ]
    await PanelIsolation.syncWindowIsolation(win.id!, 'p2', tabsInputP2, panelsById)
    expect(p1Group?.collapsed).toBe(true)
    expect(p2Group?.collapsed).toBe(false)

    // 4d. Panel Isolation Mode: windowParking (moves inactive tabs to minimized helper window and restores them)
    Settings.state.panelIsolationMode = 'windowParking'
    await PanelIsolation.syncWindowIsolation(win.id!, 'p1', tabsInput, panelsById)
    const parkedWinId = PanelIsolation.getParkedWindowId()
    expect(parkedWinId).toBeDefined()
    expect(env.tabs.find(t => t.id === tab2.id)?.windowId).toBe(parkedWinId)
    expect(env.tabs.find(t => t.id === tab3.id)?.windowId).toBe(parkedWinId)
    expect(env.tabs.find(t => t.id === tab1.id)?.windowId).toBe(win.id)

    // Switch to p2 -> tab2 and tab3 move back to main window, tab1 parks
    await PanelIsolation.syncWindowIsolation(win.id!, 'p2', tabsInput, panelsById)
    expect(env.tabs.find(t => t.id === tab2.id)?.windowId).toBe(win.id)
    expect(env.tabs.find(t => t.id === tab3.id)?.windowId).toBe(win.id)
    expect(env.tabs.find(t => t.id === tab1.id)?.windowId).toBe(parkedWinId)
  })

  test('installBrowserPolyfill() replaces pre-existing Chromium native globalThis.browser alias', async () => {
    const { installBrowserPolyfill } = await import('src/polyfill/browser-polyfill')
    const g = globalThis as unknown as { browser: any; chrome: any }
    const origPermContains = g.chrome.permissions.contains
    const origOnUpdatedAdd = g.chrome.tabs.onUpdated.addListener

    try {
      // Simulate Chrome throwing on unrecognized Firefox permissions and onUpdated filters
      g.chrome.permissions.contains = async (q: { permissions?: string[] }) => {
        if (q.permissions?.some(p => p.toLowerCase() === 'tabhide')) {
          throw new Error("'tabHide' is not a recognized permission.")
        }
        return true
      }
      g.chrome.tabs.onUpdated.addListener = function (fn: any) {
        if (arguments.length > 1) {
          throw new TypeError('This event does not support filters.')
        }
        return origOnUpdatedAdd.call(this, fn)
      }

      // Simulate Chromium 126+ pre-populating globalThis.browser = chrome
      g.browser = g.chrome
      installBrowserPolyfill(false)

      await expect(browser.permissions.contains({ permissions: ['tabHide'] })).resolves.toBe(true)
      await expect(browser.permissions.contains({ permissions: ['tabhide'] })).resolves.toBe(true)

      const calls: any[] = []
      const listener: browser.tabs.UpdatedListener = (tabId, changeInfo) => {
        calls.push({ tabId, changeInfo })
      }
      expect(() =>
        browser.tabs.onUpdated.addListener(listener, { properties: ['url'] })
      ).not.toThrow()
      browser.tabs.onUpdated.removeListener(listener)

      // Also simulate a locked/getter-only globalThis.browser with getter-only tabs & onUpdated
      const lockedOnUpdated = Object.create(null)
      Object.defineProperty(lockedOnUpdated, 'addListener', {
        value: g.chrome.tabs.onUpdated.addListener,
        writable: false,
        configurable: true,
        enumerable: true,
      })
      Object.defineProperty(lockedOnUpdated, 'removeListener', {
        value: g.chrome.tabs.onUpdated.removeListener,
        writable: false,
        configurable: true,
        enumerable: true,
      })
      const lockedTabs = Object.create(null)
      Object.defineProperty(lockedTabs, 'onUpdated', {
        get: () => lockedOnUpdated,
        configurable: false,
        enumerable: true,
      })
      const lockedBrowser = Object.create(null)
      Object.defineProperty(lockedBrowser, 'tabs', {
        get: () => lockedTabs,
        configurable: false,
        enumerable: true,
      })
      Object.defineProperty(g, 'browser', {
        get: () => lockedBrowser,
        set: () => {},
        configurable: true,
        enumerable: true,
      })

      installBrowserPolyfill(true)
      expect(() =>
        g.browser.tabs.onUpdated.addListener(listener, { properties: ['url'] })
      ).not.toThrow()
      g.browser.tabs.onUpdated.removeListener(listener)
    } finally {
      g.chrome.permissions.contains = origPermContains
      g.chrome.tabs.onUpdated.addListener = origOnUpdatedAdd
      installBrowserPolyfill(true)
    }
  })

  test('Handles Chrome tabs.onReplaced when chrome.tabs.discard replaces tab ID', async () => {
    const env = getEnv()
    const win = await browser.windows.create({ url: 'https://example.com' })
    await WindowsBg.load()
    TabsBg.setupListeners()
    await TabsBg.load()

    const oldTab = await browser.tabs.create({ windowId: win.id, url: 'https://example.org', active: false })
    expect(TabsBg.byId[oldTab.id]?.discarded).toBe(false)

    // Simulate Chrome's chrome.tabs.discard replacing oldTab.id with a brand new discarded tab ID
    const newId = env.nextTabId++
    const raw = env.tabs.find(t => t.id === oldTab.id)
    raw.id = newId
    raw.discarded = true
    ;(globalThis as any).chrome.tabs.onReplaced.emit(newId, oldTab.id)

    expect(TabsBg.byId[oldTab.id]).toBeUndefined()
    expect(TabsBg.byId[newId]).toBeDefined()
    expect(TabsBg.byId[newId]?.discarded).toBe(true)
  })

  test('tabs.create returns discarded replacement ID and tabs.update strips self-openerTabId', async () => {
    const env = getEnv()
    const g = globalThis as unknown as { chrome: any }
    const origDiscard = g.chrome.tabs.discard
    const origUpdate = g.chrome.tabs.update

    try {
      g.chrome.tabs.discard = async (tabId: number) => {
        const t = env.tabs.find(x => x.id === tabId)
        if (!t) return undefined
        const newId = env.nextTabId++
        t.id = newId
        t.discarded = true
        return { ...t }
      }
      g.chrome.tabs.update = async (tabId: number, props: any) => {
        if (props?.openerTabId === tabId) {
          throw new Error("Cannot set a tab's opener to itself.")
        }
        return origUpdate(tabId, props)
      }

      const win = await browser.windows.create({ url: 'https://example.com' })
      const created = await browser.tabs.create({
        windowId: win.id,
        url: 'https://discarded.example.com',
        active: false,
        discarded: true,
      })
      expect(created.discarded).toBe(true)
      expect(env.tabs.some(t => t.id === created.id)).toBe(true)

      await expect(
        browser.tabs.update(created.id, { openerTabId: created.id })
      ).resolves.toMatchObject({ id: created.id })
    } finally {
      g.chrome.tabs.discard = origDiscard
      g.chrome.tabs.update = origUpdate
    }
  })

  test('tabs.create waits for URL commit before discarding so snapshot URLs are preserved and unloaded', async () => {
    const env = getEnv()
    const g = globalThis as unknown as { chrome: any }
    const origCreate = g.chrome.tabs.create
    const origDiscard = g.chrome.tabs.discard

    try {
      g.chrome.tabs.create = async (props: any) => {
        // Simulate real Chrome: tab initially has empty url + pendingUrl until navigation commits
        const created = await origCreate({ ...props, url: 'about:blank' })
        created.url = ''
        created.pendingUrl = props.url
        setTimeout(() => {
          created.url = props.url
          g.chrome.tabs.onUpdated.emit(created.id, { url: props.url }, created)
        }, 15)
        return created
      }
      g.chrome.tabs.discard = async (tabId: number) => {
        const t = env.tabs.find(x => x.id === tabId)
        if (!t) return undefined
        // Chrome loses URL if discarded while still uncommitted; assert URL is already committed
        expect(t.url).toBe('https://committed.example.com/page')
        const newId = env.nextTabId++
        t.id = newId
        t.discarded = true
        return { ...t }
      }

      const win = await browser.windows.create({ url: 'https://example.com' })
      const tab = await browser.tabs.create({
        windowId: win.id,
        url: 'https://committed.example.com/page',
        active: false,
        discarded: true,
      })
      expect(tab.discarded).toBe(true)
      expect(tab.url).toBe('https://committed.example.com/page')
    } finally {
      g.chrome.tabs.create = origCreate
      g.chrome.tabs.discard = origDiscard
    }
  })

  test('tabs.create defaults omitted url to chrome://newtab (or Vivaldi startpage when vivExtData is present)', async () => {
    const env = getEnv()
    const win = await browser.windows.create({ url: 'https://example.com' })
    const newTab = await browser.tabs.create({ windowId: win.id })
    expect(newTab.url).toBe('chrome://newtab')

    // Simulate Vivaldi tab metadata (`vivExtData`) in a fresh polyfill instance
    const { installBrowserPolyfill } = await import('src/polyfill/browser-polyfill')
    const origTab = env.tabs[0]
    origTab.vivExtData = {}
    installBrowserPolyfill(true)
    try {
      const vivTab = await browser.tabs.create({ windowId: win.id })
      expect(vivTab.url).toBe('chrome://vivaldi-webui/startpage?section=Speed-dials')
    } finally {
      delete origTab.vivExtData
      installBrowserPolyfill(true)
    }
  })

  test('Coexists safely with other addons: retries transient tab-drag locks, preserves foreign tab groups, and reconciles drifted tab indices', async () => {
    const env = getEnv()
    const g = globalThis as any
    const PanelIsolation = await import('src/polyfill/panel-isolation')
    const Settings = await import('src/services/settings')
    const WindowsBg = await import('src/services/windows.bg')
    const TabsBg = await import('src/services/tabs.bg')

    const win = await browser.windows.create({ url: 'https://tab1.example.com' })
    const tab1 = win.tabs![0]
    const tab2 = await browser.tabs.create({ windowId: win.id, url: 'https://tab2.example.com' })
    const tab3 = await browser.tabs.create({ windowId: win.id, url: 'https://tab3.example.com' })

    // 1. Transient Chrome tab-drag lock retry ("Tabs cannot be edited right now (user may be dragging a tab)")
    const origMove = g.chrome.tabs.move
    let moveAttempts = 0
    g.chrome.tabs.move = async (ids: number | number[], props: any) => {
      moveAttempts++
      if (moveAttempts === 1) {
        throw new Error('Tabs cannot be edited right now (user may be dragging a tab).')
      }
      return origMove(ids, props)
    }
    try {
      const moved = await browser.tabs.move(tab3.id, { index: 0 })
      expect(moveAttempts).toBe(2)
      expect((moved as browser.tabs.Tab).index).toBe(0)
    } finally {
      g.chrome.tabs.move = origMove
    }

    // 2. Preserve third-party/user native tab groups during PanelIsolation.syncWindowIsolation
    const foreignGroupId = await g.chrome.tabs.group({
      createProperties: { windowId: win.id },
      tabIds: [tab2.id],
    })
    await g.chrome.tabGroups.update(foreignGroupId, {
      title: 'External Addon Group',
      color: 'purple',
      collapsed: false,
    })

    Settings.state.panelIsolationMode = 'tabGroups'
    await PanelIsolation.init()
    await PanelIsolation.syncWindowIsolation(
      win.id!,
      'panel-work',
      [
        { id: tab1.id, panelId: 'panel-work', active: true, groupId: -1 },
        { id: tab2.id, panelId: 'panel-other', active: false, groupId: foreignGroupId },
      ],
      {
        'panel-work': { id: 'panel-work', name: 'Work', color: 'blue' },
        'panel-other': { id: 'panel-other', name: 'Other', color: 'green' },
      }
    )

    // tab2's foreign group must NOT be overwritten or collapsed by PanelIsolation
    const rawTab2 = env.tabs.find((t: any) => t.id === tab2.id)
    const rawForeignGroup = env.tabGroups.find((grp: any) => grp.id === foreignGroupId)
    expect(rawTab2.groupId).toBe(foreignGroupId)
    expect(rawForeignGroup.title).toBe('External Addon Group')
    expect(rawForeignGroup.collapsed).toBe(false)

    // 3. Reconcile drifted tab.index when another addon removes/moves tabs concurrently
    await WindowsBg.load()
    TabsBg.setupListeners()
    await TabsBg.load()

    // Simulate index drift caused by an external addon manipulating tabs out-of-band
    if (TabsBg.byId[tab2.id]) {
      TabsBg.byId[tab2.id].index = 99
    }
    await browser.tabs.remove(tab2.id)
    expect(TabsBg.byId[tab2.id]).toBeUndefined()
    const bgWinTabs = WindowsBg.byId.get(win.id!)?.tabs ?? []
    expect(bgWinTabs.some(t => t.id === tab2.id)).toBe(false)
  })

  test('Highlights newly focused tab when active tab is closed even if browser skips native onActivated event', async () => {
    const env = getEnv()
    const win = await browser.windows.create({ url: 'https://first.example.com' })
    const tab1 = win.tabs![0]
    const tab2 = await browser.tabs.create({
      windowId: win.id,
      url: 'https://second.example.com',
      active: true,
    })

    const activatedEvents: browser.tabs.ActiveInfo[] = []
    const listener = (info: browser.tabs.ActiveInfo) => {
      activatedEvents.push(info)
    }
    browser.tabs.onActivated.addListener(listener)

    try {
      // Simulate Vivaldi/browser closing the focused tab (tab2) and switching to tab1
      // WITHOUT emitting chrome.tabs.onActivated
      const rawTab2Idx = env.tabs.findIndex((t: any) => t.id === tab2.id)
      if (rawTab2Idx !== -1) env.tabs.splice(rawTab2Idx, 1)
      const rawTab1 = env.tabs.find((t: any) => t.id === tab1.id)
      if (rawTab1) rawTab1.active = true

      ;(globalThis as any).chrome.tabs.onRemoved.emit(tab2.id, {
        windowId: win.id,
        isWindowClosing: false,
      })

      await new Promise(r => setTimeout(r, 10))

      expect(activatedEvents.some(e => e.tabId === tab1.id && e.windowId === win.id)).toBe(true)
    } finally {
      browser.tabs.onActivated.removeListener(listener)
    }
  })
})
