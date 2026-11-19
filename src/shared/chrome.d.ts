declare namespace chrome {
  namespace runtime {
    const id: string
    const lastError: { message?: string } | undefined
    function getURL(path: string): string
    function getManifest(): { version: string; name: string }
    function openOptionsPage(): Promise<void>
    function sendMessage<T = unknown>(message: unknown): Promise<T>
    const onMessage: {
      addListener(
        cb: (
          message: any,
          sender: { tab?: tabs.Tab; id?: string },
          sendResponse: (response?: any) => void
        ) => boolean | void
      ): void
      removeListener(cb: (...args: any[]) => any): void
    }
    const onInstalled: {
      addListener(cb: (details: { reason: string }) => void): void
    }
    const onStartup: {
      addListener(cb: () => void): void
    }
  }

  namespace sidePanel {
    function setPanelBehavior(options: { openPanelOnActionClick?: boolean }): Promise<void>
    function open(options: { windowId?: number; tabId?: number }): Promise<void>
  }

  namespace action {
    const onClicked: {
      addListener(cb: (tab: tabs.Tab) => void): void
      removeListener(cb: (tab: tabs.Tab) => void): void
    }
  }

  namespace tabGroups {
    type ColorEnum =
      | 'grey'
      | 'blue'
      | 'red'
      | 'yellow'
      | 'green'
      | 'pink'
      | 'purple'
      | 'cyan'
      | 'orange'
    const TAB_GROUP_ID_NONE: -1
    interface TabGroup {
      id: number
      windowId: number
      collapsed: boolean
      color: ColorEnum
      title?: string
    }
    function query(info: { windowId?: number; title?: string; color?: ColorEnum; collapsed?: boolean }): Promise<TabGroup[]>
    function get(groupId: number): Promise<TabGroup>
    function update(
      groupId: number,
      props: { collapsed?: boolean; color?: ColorEnum; title?: string }
    ): Promise<TabGroup>
    function move(groupId: number, props: { index: number; windowId?: number }): Promise<TabGroup>
    const onCreated: { addListener(cb: (group: TabGroup) => void): void; removeListener(cb: (group: TabGroup) => void): void }
    const onUpdated: { addListener(cb: (group: TabGroup) => void): void; removeListener(cb: (group: TabGroup) => void): void }
    const onRemoved: { addListener(cb: (group: TabGroup) => void): void; removeListener(cb: (group: TabGroup) => void): void }
    const onMoved: { addListener(cb: (group: TabGroup) => void): void; removeListener(cb: (group: TabGroup) => void): void }
  }

  namespace tabs {
    const TAB_ID_NONE: -1
    interface Tab {
      id?: number
      index: number
      windowId: number
      openerTabId?: number
      active: boolean
      pinned: boolean
      highlighted: boolean
      incognito: boolean
      groupId: number
      url?: string
      pendingUrl?: string
      title?: string
      favIconUrl?: string
      status?: 'unloaded' | 'loading' | 'complete'
      discarded?: boolean
      audible?: boolean
      mutedInfo?: { muted: boolean }
      lastAccessed?: number
    }
    function query(queryInfo: {
      active?: boolean
      currentWindow?: boolean
      windowId?: number
      groupId?: number
      pinned?: boolean
      url?: string | string[]
    }): Promise<Tab[]>
    function get(tabId: number): Promise<Tab>
    function create(props: {
      windowId?: number
      index?: number
      url?: string
      active?: boolean
      pinned?: boolean
      openerTabId?: number
    }): Promise<Tab>
    function update(
      tabId: number,
      props: { active?: boolean; pinned?: boolean; muted?: boolean; url?: string }
    ): Promise<Tab>
    function remove(tabIds: number | number[]): Promise<void>
    function move(
      tabIds: number | number[],
      props: { windowId?: number; index: number }
    ): Promise<Tab | Tab[]>
    function duplicate(tabId: number): Promise<Tab | undefined>
    function reload(tabId: number, props?: { bypassCache?: boolean }): Promise<void>
    function discard(tabId?: number): Promise<Tab | undefined>
    function group(options: {
      tabIds: number | number[]
      groupId?: number
      createProperties?: { windowId?: number }
    }): Promise<number>
    function ungroup(tabIds: number | number[]): Promise<void>
    const onCreated: { addListener(cb: (tab: Tab) => void): void; removeListener(cb: (tab: Tab) => void): void }
    const onUpdated: {
      addListener(cb: (tabId: number, changeInfo: Partial<Tab>, tab: Tab) => void): void
      removeListener(cb: (tabId: number, changeInfo: Partial<Tab>, tab: Tab) => void): void
    }
    const onRemoved: {
      addListener(cb: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void
      removeListener(cb: (tabId: number, removeInfo: { windowId: number; isWindowClosing: boolean }) => void): void
    }
    const onActivated: {
      addListener(cb: (info: { tabId: number; windowId: number }) => void): void
      removeListener(cb: (info: { tabId: number; windowId: number }) => void): void
    }
    const onHighlighted: {
      addListener(cb: (info: { tabIds: number[]; windowId: number }) => void): void
      removeListener(cb: (info: { tabIds: number[]; windowId: number }) => void): void
    }
    const onMoved: {
      addListener(cb: (tabId: number, moveInfo: { windowId: number; fromIndex: number; toIndex: number }) => void): void
      removeListener(cb: (tabId: number, moveInfo: { windowId: number; fromIndex: number; toIndex: number }) => void): void
    }
    const onAttached: {
      addListener(cb: (tabId: number, attachInfo: { newWindowId: number; newPosition: number }) => void): void
      removeListener(cb: (tabId: number, attachInfo: { newWindowId: number; newPosition: number }) => void): void
    }
    const onDetached: {
      addListener(cb: (tabId: number, detachInfo: { oldWindowId: number; oldPosition: number }) => void): void
      removeListener(cb: (tabId: number, detachInfo: { oldWindowId: number; oldPosition: number }) => void): void
    }
    const onReplaced: {
      addListener(cb: (addedTabId: number, removedTabId: number) => void): void
      removeListener(cb: (addedTabId: number, removedTabId: number) => void): void
    }
  }

  namespace windows {
    interface Window {
      id?: number
      focused: boolean
      incognito: boolean
      type?: string
      tabs?: tabs.Tab[]
    }
    function getCurrent(getInfo?: { populate?: boolean }): Promise<Window>
    function get(windowId: number, getInfo?: { populate?: boolean }): Promise<Window>
    function getLastFocused(getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<Window>
    function getAll(getInfo?: { populate?: boolean; windowTypes?: string[] }): Promise<Window[]>
    function create(createData?: { url?: string | string[]; focused?: boolean; incognito?: boolean }): Promise<Window>
    function update(windowId: number, updateInfo: { focused?: boolean }): Promise<Window>
    const onFocusChanged: {
      addListener(cb: (windowId: number) => void): void
      removeListener(cb: (windowId: number) => void): void
    }
    const onRemoved: {
      addListener(cb: (windowId: number) => void): void
      removeListener(cb: (windowId: number) => void): void
    }
  }

  namespace storage {
    interface StorageArea {
      get<T = Record<string, any>>(keys?: string | string[] | Record<string, any> | null): Promise<T>
      set(items: Record<string, any>): Promise<void>
      remove(keys: string | string[]): Promise<void>
      clear(): Promise<void>
    }
    const local: StorageArea
    const session: StorageArea
    const sync: StorageArea
    interface StorageChange {
      oldValue?: any
      newValue?: any
    }
    const onChanged: {
      addListener(cb: (changes: Record<string, StorageChange>, areaName: string) => void): void
      removeListener(cb: (changes: Record<string, StorageChange>, areaName: string) => void): void
    }
  }

  namespace bookmarks {
    interface BookmarkTreeNode {
      id: string
      parentId?: string
      index?: number
      url?: string
      title: string
      dateAdded?: number
      children?: BookmarkTreeNode[]
    }
    function getTree(): Promise<BookmarkTreeNode[]>
    function search(query: string): Promise<BookmarkTreeNode[]>
    function create(bookmark: { parentId?: string; title?: string; url?: string; index?: number }): Promise<BookmarkTreeNode>
    function remove(id: string): Promise<void>
    function removeTree(id: string): Promise<void>
    function update(id: string, changes: { title?: string; url?: string }): Promise<BookmarkTreeNode>
    const onCreated: { addListener(cb: () => void): void; removeListener(cb: () => void): void }
    const onRemoved: { addListener(cb: () => void): void; removeListener(cb: () => void): void }
    const onChanged: { addListener(cb: () => void): void; removeListener(cb: () => void): void }
    const onMoved: { addListener(cb: () => void): void; removeListener(cb: () => void): void }
  }

  namespace history {
    interface HistoryItem {
      id: string
      url?: string
      title?: string
      lastVisitTime?: number
      visitCount?: number
    }
    function search(query: { text: string; startTime?: number; endTime?: number; maxResults?: number }): Promise<HistoryItem[]>
    function deleteUrl(details: { url: string }): Promise<void>
  }

  namespace sessions {
    interface Session {
      lastModified: number
      tab?: tabs.Tab & { sessionId?: string }
      window?: windows.Window & { sessionId?: string }
    }
    function getRecentlyClosed(filter?: { maxResults?: number }): Promise<Session[]>
    function restore(sessionId?: string): Promise<Session>
  }

  namespace alarms {
    interface Alarm {
      name: string
      scheduledTime: number
      periodInMinutes?: number
    }
    function create(name: string, alarmInfo: { delayInMinutes?: number; periodInMinutes?: number }): Promise<void>
    function clear(name: string): Promise<boolean>
    const onAlarm: { addListener(cb: (alarm: Alarm) => void): void }
  }

  namespace contextMenus {
    function create(
      props: {
        id: string
        parentId?: string
        title?: string
        type?: 'normal' | 'separator'
        contexts?: string[]
      },
      callback?: () => void
    ): string | number
    function removeAll(callback?: () => void): Promise<void>
    const onClicked: {
      addListener(cb: (info: { menuItemId: string | number; linkUrl?: string; pageUrl?: string }, tab?: tabs.Tab) => void): void
    }
  }

  namespace commands {
    interface Command {
      name?: string
      description?: string
      shortcut?: string
    }
    function getAll(): Promise<Command[]>
    const onCommand: { addListener(cb: (command: string, tab?: tabs.Tab) => void): void }
  }

  namespace omnibox {
    interface SuggestResult {
      content: string
      description: string
    }
    function setDefaultSuggestion(suggestion: { description: string }): void
    const onInputChanged: {
      addListener(cb: (text: string, suggest: (suggestResults: SuggestResult[]) => void) => void): void
    }
    const onInputEntered: {
      addListener(cb: (text: string, disposition: string) => void): void
    }
  }
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module '*.css' {}
