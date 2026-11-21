import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  DEFAULT_SETTINGS,
  type ActiveView,
  type RuntimeMessage,
  type SavedPanel,
  type Settings,
  type TabTreeMap,
} from '@/shared/types'
import {
  loadInitialSidepanelState,
  loadVirtualGroupMap,
  STORAGE_KEYS,
  toArray,
} from '@/shared/storage'
import { createNewTab, getTargetWindowId } from '@/shared/env'
import {
  materializeSavedPanel,
  safeQueryTabGroups,
  syncCollapseOnSwitch,
  UNGROUPED_ID,
} from '@/shared/groups'
import { restorePersistedSessionIfNeeded } from '@/shared/session-state'

export type TabPanelView =
  | { kind: 'ungrouped' }
  | { kind: 'group'; groupId: number }
  | { kind: 'saved'; savedId: string }

export function applyThemeAndCss(s: Settings): void {
  const root = document.documentElement
  if (s.theme === 'auto') root.removeAttribute('data-theme')
  else root.setAttribute('data-theme', s.theme)
  root.setAttribute('data-density', s.density)
  root.style.setProperty('--font-size', `${s.fontSize}px`)
  root.style.setProperty('--icon-size', `${s.iconSize}px`)
  root.style.setProperty('--ui-icon-size', `${s.uiIconSize}px`)
  root.style.setProperty('--tab-ctrl-icon-size', `${s.tabControlIconSize}px`)

  let styleEl = document.getElementById('vberry-custom-css') as HTMLStyleElement | null
  if (s.customCss.trim()) {
    if (!styleEl) {
      styleEl = document.createElement('style')
      styleEl.id = 'vberry-custom-css'
      document.head.appendChild(styleEl)
    }
    styleEl.textContent = s.customCss
  } else if (styleEl) {
    styleEl.remove()
  }
}

export function useChromeWindow(hooks: {
  mode?: 'sidepanel' | 'popup'
  onCommand?: (command: string) => void
  onTabActivatedReset?: (tabId: number) => void
  onViewChanged?: () => void
}) {
  const isPopup = hooks.mode === 'popup'
  const windowId = ref<number>(-1)
  const tabs = ref<chrome.tabs.Tab[]>([])
  const groups = ref<chrome.tabGroups.TabGroup[]>([])
  const savedPanels = ref<SavedPanel[]>([])
  const treeMeta = ref<TabTreeMap>({})
  const virtualGroupMap = ref<Record<number, string>>({})
  const settings = ref<Settings>({ ...DEFAULT_SETTINGS })

  const activeView = ref<ActiveView>(
    isPopup && DEFAULT_SETTINGS.unifiedSearch ? { kind: 'search' } : { kind: 'ungrouped' }
  )
  const lastTabView = ref<TabPanelView>({ kind: 'ungrouped' })
  const activeTabId = ref<number | null>(null)

  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let activeRetryTimers: ReturnType<typeof setTimeout>[] = []
  let refreshSeq = 0

  function clearActiveRetryTimers() {
    for (const t of activeRetryTimers) clearTimeout(t)
    activeRetryTimers = []
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      void refreshChromeState()
    }, 40)
  }

  const savedPanelIdSet = computed(() => new Set(savedPanels.value.map(p => p.id)))

  const partitionedTabs = computed(() => {
    const pinned: chrome.tabs.Tab[] = []
    const ungrouped: chrome.tabs.Tab[] = []
    const byGroupId = new Map<number, chrome.tabs.Tab[]>()
    const bySavedId = new Map<string, chrome.tabs.Tab[]>()
    const vmap = virtualGroupMap.value
    const validSaved = savedPanelIdSet.value

    for (const t of tabs.value) {
      if (t.pinned) {
        pinned.push(t)
      } else if (t.groupId !== UNGROUPED_ID) {
        const list = byGroupId.get(t.groupId)
        if (list) list.push(t)
        else byGroupId.set(t.groupId, [t])
      } else if (t.id !== undefined && vmap[t.id] && validSaved.has(vmap[t.id])) {
        const vid = vmap[t.id]
        const list = bySavedId.get(vid)
        if (list) list.push(t)
        else bySavedId.set(vid, [t])
      } else {
        ungrouped.push(t)
      }
    }
    return { pinned, ungrouped, byGroupId, bySavedId }
  })

  const pinnedTabs = computed(() => partitionedTabs.value.pinned)
  const ungroupedTabs = computed(() => partitionedTabs.value.ungrouped)
  const tabsByGroupId = computed(() => partitionedTabs.value.byGroupId)
  const tabsBySavedId = computed(() => partitionedTabs.value.bySavedId)

  const unmaterializedSavedPanels = computed(() => {
    const liveTitles = new Set(groups.value.map(g => (g.title ?? '').trim().toLowerCase()))
    return savedPanels.value.filter(p => !liveTitles.has(p.title.trim().toLowerCase()))
  })

  const activeSavedPanel = computed(() => {
    const view = activeView.value
    if (view.kind !== 'saved') return null
    return savedPanels.value.find(p => p.id === view.savedId) ?? null
  })

  const activeGroupTitle = computed(() => {
    const view = activeView.value
    if (view.kind === 'ungrouped') return 'Ungrouped'
    if (view.kind === 'group') {
      const g = groups.value.find(x => x.id === view.groupId)
      return g?.title?.trim() || 'Group'
    }
    if (view.kind === 'saved') return activeSavedPanel.value?.title || 'Group'
    return ''
  })

  function viewForTab(
    tab: chrome.tabs.Tab,
    liveGroups: chrome.tabGroups.TabGroup[] = groups.value
  ): TabPanelView {
    if (tab.groupId !== UNGROUPED_ID && liveGroups.some(g => g.id === tab.groupId)) {
      return { kind: 'group', groupId: tab.groupId }
    }
    const sid = tab.id !== undefined ? virtualGroupMap.value[tab.id] : undefined
    if (sid && savedPanelIdSet.value.has(sid)) {
      return { kind: 'saved', savedId: sid }
    }
    return { kind: 'ungrouped' }
  }

  async function resolveWindowActiveTabId(
    winTabs: chrome.tabs.Tab[],
    excludeIds?: Set<number>
  ): Promise<{ id: number | null; authoritative: boolean }> {
    const validIds = new Set(winTabs.map(t => t.id).filter((id): id is number => id !== undefined))
    const direct = winTabs.find(t => t.active && t.id !== undefined && !excludeIds?.has(t.id))
    if (direct?.id !== undefined) return { id: direct.id, authoritative: true }

    try {
      const activeInWin = await chrome.tabs.query({ windowId: windowId.value, active: true })
      const match = activeInWin.find(
        t => t.id !== undefined && validIds.has(t.id) && !excludeIds?.has(t.id)
      )
      if (match?.id !== undefined) return { id: match.id, authoritative: true }
    } catch {
      // Fallback below
    }

    try {
      const win = await chrome.windows.get(windowId.value, { populate: true })
      const match = win.tabs?.find(
        t => t.active && t.id !== undefined && validIds.has(t.id) && !excludeIds?.has(t.id)
      )
      if (match?.id !== undefined) return { id: match.id, authoritative: true }
    } catch {
      // Fallback below
    }

    try {
      const anyActive = await chrome.tabs.query({ active: true })
      const match = anyActive.find(
        t => t.id !== undefined && validIds.has(t.id) && !excludeIds?.has(t.id)
      )
      if (match?.id !== undefined) return { id: match.id, authoritative: true }
    } catch {
      // Fallback below
    }

    const highlighted = winTabs.find(
      t => t.highlighted && t.id !== undefined && !excludeIds?.has(t.id)
    )
    if (highlighted?.id !== undefined) return { id: highlighted.id, authoritative: false }

    const remaining = winTabs
      .filter(t => t.id !== undefined && !excludeIds?.has(t.id))
      .sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))
    return { id: remaining[0]?.id ?? null, authoritative: false }
  }

  async function refreshChromeState(followActive = false, excludeRemovedIds?: Set<number>) {
    const seq = ++refreshSeq
    if (windowId.value < 0) windowId.value = await getTargetWindowId()
    if (windowId.value < 0) return

    const [winTabs, winGroups] = await Promise.all([
      chrome.tabs.query({ windowId: windowId.value }),
      safeQueryTabGroups({ windowId: windowId.value }),
    ])
    if (seq !== refreshSeq) return

    const resolved = await resolveWindowActiveTabId(winTabs, excludeRemovedIds)
    if (seq !== refreshSeq) return

    if (resolved.authoritative && resolved.id !== null) {
      clearActiveRetryTimers()
      activeTabId.value = resolved.id
    } else if (
      activeTabId.value === null ||
      !winTabs.some(t => t.id === activeTabId.value) ||
      excludeRemovedIds?.has(activeTabId.value)
    ) {
      activeTabId.value = resolved.id
    }

    const effectiveActiveId = resolved.authoritative ? resolved.id : activeTabId.value
    tabs.value = winTabs
      .sort((a, b) => a.index - b.index)
      .map(t => (effectiveActiveId !== null ? { ...t, active: t.id === effectiveActiveId } : t))
    groups.value = winGroups

    const curView = activeView.value
    if (curView.kind === 'group' && !winGroups.some(g => g.id === curView.groupId)) {
      activeView.value = { kind: 'ungrouped' }
    } else if (curView.kind === 'saved' && !savedPanels.value.some(p => p.id === curView.savedId)) {
      activeView.value = { kind: 'ungrouped' }
    }

    if (followActive) {
      const activeTab = tabs.value.find(t => t.active)
      if (activeTab && !activeTab.pinned) {
        const nextView = viewForTab(activeTab, winGroups)
        lastTabView.value = nextView
        if (!(isPopup && settings.value.unifiedSearch)) {
          activeView.value = nextView
        }
      }
    }
  }

  function scheduleActiveSyncAfterRemove(removedIds: number[]) {
    const removedSet = new Set(removedIds)
    clearActiveRetryTimers()
    void refreshChromeState(false, removedSet)
    for (const delay of [60, 200, 450]) {
      activeRetryTimers.push(
        setTimeout(() => {
          void refreshChromeState(false, removedSet)
        }, delay)
      )
    }
  }

  async function selectView(view: ActiveView) {
    activeView.value = view
    if (view.kind === 'ungrouped' || view.kind === 'group' || view.kind === 'saved') {
      lastTabView.value = view
    }
    hooks.onViewChanged?.()
    if (settings.value.autoCollapseInactiveGroups && windowId.value >= 0) {
      if (view.kind === 'group') await syncCollapseOnSwitch(windowId.value, view.groupId)
      else if (view.kind === 'ungrouped') await syncCollapseOnSwitch(windowId.value, UNGROUPED_ID)
    }
  }

  async function openNewTabInActiveView(url?: string, background = false) {
    if (windowId.value < 0) windowId.value = await getTargetWindowId()
    if (windowId.value < 0) return

    const view = activeView.value
    const isUtility =
      view.kind === 'search' ||
      view.kind === 'bookmarks' ||
      view.kind === 'history' ||
      view.kind === 'snapshots'

    let target: TabPanelView = isUtility ? lastTabView.value : view
    if (target.kind === 'group') {
      const gid = target.groupId
      if (!groups.value.some(g => g.id === gid)) target = { kind: 'ungrouped' }
    } else if (target.kind === 'saved') {
      const sid = target.savedId
      if (!savedPanels.value.some(p => p.id === sid)) target = { kind: 'ungrouped' }
    }

    if (target.kind === 'group') {
      const tab = await createNewTab({ windowId: windowId.value, url, active: !background })
      if (tab.id !== undefined) {
        await chrome.tabs.group({ tabIds: tab.id, groupId: target.groupId }).catch(() => {})
      }
      if (!background) await selectView({ kind: 'group', groupId: target.groupId })
      return
    }

    if (target.kind === 'saved') {
      const panel = savedPanels.value.find(p => p.id === target.savedId)
      if (panel) {
        const res = await materializeSavedPanel(windowId.value, panel, url, !background)
        if (res.groupId !== null) {
          if (!background) await selectView({ kind: 'group', groupId: res.groupId })
        } else {
          virtualGroupMap.value = await loadVirtualGroupMap()
          if (!background) await selectView({ kind: 'saved', savedId: res.savedPanelId })
        }
        return
      }
    }

    const created = await createNewTab({ windowId: windowId.value, url, active: !background })
    if (!background) {
      await selectView(viewForTab(created))
    }
  }

  async function openUrlInSpecificTarget(
    url: string,
    target: number | SavedPanel,
    background = false
  ) {
    if (windowId.value < 0) windowId.value = await getTargetWindowId()
    if (windowId.value < 0) return

    if (typeof target === 'number') {
      const tab = await createNewTab({ windowId: windowId.value, url, active: !background })
      if (target !== UNGROUPED_ID && tab.id !== undefined) {
        await chrome.tabs.group({ tabIds: tab.id, groupId: target }).catch(() => {})
        if (!background) await selectView({ kind: 'group', groupId: target })
      } else if (!background) {
        await selectView({ kind: 'ungrouped' })
      }
      return
    }

    const res = await materializeSavedPanel(windowId.value, target, url, !background)
    if (res.groupId !== null) {
      if (!background) await selectView({ kind: 'group', groupId: res.groupId })
    } else {
      virtualGroupMap.value = await loadVirtualGroupMap()
      if (!background) await selectView({ kind: 'saved', savedId: res.savedPanelId })
    }
  }

  function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
    if (area === 'session') {
      if (changes[STORAGE_KEYS.treeMeta]) {
        treeMeta.value = (changes[STORAGE_KEYS.treeMeta].newValue as TabTreeMap) ?? {}
      }
      if (changes[STORAGE_KEYS.virtualGroups]) {
        virtualGroupMap.value =
          (changes[STORAGE_KEYS.virtualGroups].newValue as Record<number, string>) ?? {}
      }
    }
    if (area === 'local') {
      if (changes[STORAGE_KEYS.settings]) {
        const raw = changes[STORAGE_KEYS.settings].newValue ?? {}
        settings.value = {
          ...DEFAULT_SETTINGS,
          ...raw,
        }
        applyThemeAndCss(settings.value)
        if (
          activeView.value.kind === 'search' &&
          (!settings.value.unifiedSearch ||
            (!isPopup && settings.value.hideUnifiedSearchInSidePanel))
        ) {
          activeView.value = lastTabView.value
        }
      }
      if (changes[STORAGE_KEYS.savedPanels]) {
        const nextPanels = toArray<SavedPanel>(changes[STORAGE_KEYS.savedPanels].newValue)
        savedPanels.value = nextPanels
        const curView = activeView.value
        if (curView.kind === 'saved' && !nextPanels.some(p => p.id === curView.savedId)) {
          activeView.value = { kind: 'ungrouped' }
        }
      }
    }
  }

  function onTabRemoved(tabId: number, info: { windowId: number; isWindowClosing: boolean }) {
    if (info.isWindowClosing) return
    if (info.windowId !== windowId.value && !tabs.value.some(t => t.id === tabId)) return
    scheduleActiveSyncAfterRemove([tabId])
  }

  function onTabHighlighted(info: { tabIds: number[]; windowId: number }) {
    if (info.windowId !== windowId.value) return
    scheduleRefresh()
  }

  function onTabActivated(info: { tabId: number; windowId: number }) {
    if (info.windowId !== windowId.value && !tabs.value.some(t => t.id === info.tabId)) return
    refreshSeq++
    activeTabId.value = info.tabId
    hooks.onTabActivatedReset?.(info.tabId)
    if (tabs.value.some(t => t.id === info.tabId)) {
      tabs.value = tabs.value.map(t => ({ ...t, active: t.id === info.tabId }))
    }
    scheduleRefresh()
    const isUtility =
      activeView.value.kind === 'search' ||
      activeView.value.kind === 'bookmarks' ||
      activeView.value.kind === 'history' ||
      activeView.value.kind === 'snapshots'
    if (isUtility) return
    const tab = tabs.value.find(t => t.id === info.tabId)
    if (tab && !tab.pinned) {
      activeView.value = viewForTab(tab)
    }
  }

  function onRuntimeMessage(msg: RuntimeMessage) {
    if (!msg || typeof msg !== 'object') return
    if (msg.type === 'vberry:close-panel') {
      if (!isPopup && msg.windowId === windowId.value) window.close()
      return
    }
    if (msg.type !== 'vberry:command') return
    if (msg.windowId !== undefined && msg.windowId !== windowId.value) return
    hooks.onCommand?.(msg.command)
  }

  function onWindowFocusChanged() {
    scheduleRefresh()
  }

  function notifyPanelClosed() {
    if (!isPopup && windowId.value >= 0) {
      chrome.runtime
        .sendMessage({ type: 'vberry:panel-close', windowId: windowId.value })
        .catch(() => {})
    }
  }

  onMounted(async () => {
    await restorePersistedSessionIfNeeded()
    const state = await loadInitialSidepanelState()
    settings.value = state.settings
    savedPanels.value = state.savedPanels
    treeMeta.value = state.treeMeta
    virtualGroupMap.value = state.virtualGroups
    applyThemeAndCss(state.settings)

    await refreshChromeState(true)
    if (isPopup) {
      if (settings.value.unifiedSearch) {
        activeView.value = { kind: 'search' }
      } else if (activeView.value.kind === 'search') {
        activeView.value = lastTabView.value
      }
    } else if (windowId.value >= 0) {
      chrome.runtime
        .sendMessage({ type: 'vberry:panel-open', windowId: windowId.value })
        .catch(() => {})
    }

    chrome.tabs.onCreated.addListener(scheduleRefresh)
    chrome.tabs.onUpdated.addListener(scheduleRefresh)
    chrome.tabs.onRemoved.addListener(onTabRemoved)
    chrome.tabs.onReplaced.addListener(scheduleRefresh)
    chrome.tabs.onMoved.addListener(scheduleRefresh)
    chrome.tabs.onAttached.addListener(scheduleRefresh)
    chrome.tabs.onDetached.addListener(scheduleRefresh)
    chrome.tabs.onActivated.addListener(onTabActivated)
    chrome.tabs.onHighlighted?.addListener(onTabHighlighted)
    chrome.windows?.onFocusChanged?.addListener(onWindowFocusChanged)

    chrome.tabGroups?.onCreated?.addListener(scheduleRefresh)
    chrome.tabGroups?.onUpdated?.addListener(scheduleRefresh)
    chrome.tabGroups?.onRemoved?.addListener(scheduleRefresh)
    chrome.tabGroups?.onMoved?.addListener(scheduleRefresh)

    chrome.storage.onChanged.addListener(onStorageChanged)
    chrome.runtime.onMessage.addListener(onRuntimeMessage)
    window.addEventListener('focus', scheduleRefresh)
    window.addEventListener('pagehide', notifyPanelClosed)
  })

  onUnmounted(() => {
    notifyPanelClosed()
    clearTimeout(refreshTimer)
    clearActiveRetryTimers()
    chrome.tabs.onCreated.removeListener(scheduleRefresh)
    chrome.tabs.onUpdated.removeListener(scheduleRefresh)
    chrome.tabs.onRemoved.removeListener(onTabRemoved)
    chrome.tabs.onReplaced.removeListener(scheduleRefresh)
    chrome.tabs.onMoved.removeListener(scheduleRefresh)
    chrome.tabs.onAttached.removeListener(scheduleRefresh)
    chrome.tabs.onDetached.removeListener(scheduleRefresh)
    chrome.tabs.onActivated.removeListener(onTabActivated)
    chrome.tabs.onHighlighted?.removeListener(onTabHighlighted)
    chrome.windows?.onFocusChanged?.removeListener(onWindowFocusChanged)

    chrome.tabGroups?.onCreated?.removeListener(scheduleRefresh)
    chrome.tabGroups?.onUpdated?.removeListener(scheduleRefresh)
    chrome.tabGroups?.onRemoved?.removeListener(scheduleRefresh)
    chrome.tabGroups?.onMoved?.removeListener(scheduleRefresh)

    chrome.storage.onChanged.removeListener(onStorageChanged)
    chrome.runtime.onMessage.removeListener(onRuntimeMessage)
    window.removeEventListener('focus', scheduleRefresh)
    window.removeEventListener('pagehide', notifyPanelClosed)
  })

  return {
    windowId,
    tabs,
    groups,
    savedPanels,
    treeMeta,
    virtualGroupMap,
    settings,
    activeView,
    pinnedTabs,
    ungroupedTabs,
    tabsByGroupId,
    tabsBySavedId,
    unmaterializedSavedPanels,
    activeGroupTitle,
    refreshChromeState,
    scheduleActiveSyncAfterRemove,
    selectView,
    openNewTabInActiveView,
    openUrlInSpecificTarget,
  }
}
