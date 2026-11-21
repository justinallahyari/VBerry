import {
  DEFAULT_SETTINGS,
  type SavedPanel,
  type Settings,
  type TabTreeMap,
  type VBerrySnapshot,
} from './types'

export const STORAGE_KEYS = {
  settings: 'vberry_settings',
  savedPanels: 'vberry_saved_panels',
  snapshots: 'vberry_snapshots',
  treeMeta: 'vberry_tree_meta',
  virtualGroups: 'vberry_virtual_groups',
  lastSession: 'vberry_last_session',
  sessionRestored: 'vberry_session_restored',
  recentBookmarks: 'vberry_recent_bookmarks',
} as const

/**
 * Unwrap Vue reactive Proxies into plain JSON-safe values before writing to chrome.storage
 * (Chromium's extension storage serializer can turn Proxy(Array) into a plain `{}` object).
 */
function toPlain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value))
}

export function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[]
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, T>).filter(
      v => v !== null && typeof v === 'object'
    )
  }
  return []
}

function normalizeSettings(raw: unknown): Settings {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>
  return {
    ...DEFAULT_SETTINGS,
    ...obj,
  }
}

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.settings)
  return normalizeSettings(res[STORAGE_KEYS.settings])
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next = toPlain({ ...current, ...patch })
  await chrome.storage.local.set({ [STORAGE_KEYS.settings]: next })
  return next
}

export async function loadSavedPanels(): Promise<SavedPanel[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.savedPanels)
  return toArray<SavedPanel>(res[STORAGE_KEYS.savedPanels])
}

export async function saveSavedPanels(panels: SavedPanel[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.savedPanels]: toPlain(Array.from(panels)) })
}

export async function loadSnapshots(): Promise<VBerrySnapshot[]> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.snapshots)
  return toArray<VBerrySnapshot>(res[STORAGE_KEYS.snapshots])
}

export async function saveSnapshots(snapshots: VBerrySnapshot[]): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.snapshots]: toPlain(Array.from(snapshots)) })
}

export async function loadRecentBookmarkUrls(): Promise<string[]> {
  try {
    const res = await chrome.storage.local.get(STORAGE_KEYS.recentBookmarks)
    const raw = res[STORAGE_KEYS.recentBookmarks]
    return Array.isArray(raw) ? raw.filter((u): u is string => typeof u === 'string') : []
  } catch {
    return []
  }
}

export async function recordRecentBookmark(url: string): Promise<void> {
  if (!url) return
  try {
    const prev = await loadRecentBookmarkUrls()
    const next = [url, ...prev.filter(u => u !== url)].slice(0, 50)
    await chrome.storage.local.set({ [STORAGE_KEYS.recentBookmarks]: next })
  } catch {
    // Ignore storage errors
  }
}

let sessionLockChain: Promise<unknown> = Promise.resolve()

/**
 * Serialize read-modify-write operations on chrome.storage.session so bursty
 * Chrome events (bulk discard onReplaced, bulk close onRemoved, bulk onCreated)
 * can never read stale state and overwrite each other.
 */
export function withSessionLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = sessionLockChain.then(fn, fn)
  sessionLockChain = next.catch(() => {})
  return next
}

export async function updateTreeMeta(
  updater: (meta: TabTreeMap) => TabTreeMap | null
): Promise<TabTreeMap> {
  return withSessionLock(async () => {
    const current = await loadTreeMeta()
    const next = updater({ ...current })
    if (next === null) return current
    await saveTreeMeta(next)
    return next
  })
}

export async function updateVirtualGroupMap(
  updater: (map: Record<number, string>) => Record<number, string> | null
): Promise<Record<number, string>> {
  return withSessionLock(async () => {
    const current = await loadVirtualGroupMap()
    const next = updater({ ...current })
    if (next === null) return current
    await saveVirtualGroupMap(next)
    return next
  })
}

/**
 * Atomically remap tab IDs in both `treeMeta` (entry keys + all `parentId` pointers,
 * including unfolded root parents) and `virtualGroups` after Chrome replaces tab IDs
 * on `chrome.tabs.discard()` or prerender swap.
 */
export async function remapReplacedTabIds(remaps: Map<number, number>): Promise<void> {
  if (remaps.size === 0) return
  await withSessionLock(async () => {
    const [meta, vmap] = await Promise.all([loadTreeMeta(), loadVirtualGroupMap()])

    // Resolve chains (e.g. A -> B -> C) to final target IDs
    const resolve = (id: number): number => {
      let cur = id
      let guard = 0
      while (remaps.has(cur) && guard++ < 10) cur = remaps.get(cur)!
      return cur
    }

    let metaChanged = false
    const nextMeta: TabTreeMap = {}
    for (const [keyStr, entry] of Object.entries(meta)) {
      const oldKey = Number(keyStr)
      const newKey = resolve(oldKey)
      const oldParent = entry.parentId
      const newParent = oldParent !== undefined ? resolve(oldParent) : undefined
      if (newKey !== oldKey || newParent !== oldParent) metaChanged = true
      nextMeta[newKey] = newParent !== undefined ? { ...entry, parentId: newParent } : { ...entry }
    }

    let vmapChanged = false
    const nextVmap: Record<number, string> = {}
    for (const [keyStr, panelId] of Object.entries(vmap)) {
      const oldKey = Number(keyStr)
      const newKey = resolve(oldKey)
      if (newKey !== oldKey) vmapChanged = true
      nextVmap[newKey] = panelId
    }

    await Promise.all([
      metaChanged ? saveTreeMeta(nextMeta) : Promise.resolve(),
      vmapChanged ? saveVirtualGroupMap(nextVmap) : Promise.resolve(),
    ])
  })
}

export async function loadTreeMeta(): Promise<TabTreeMap> {
  try {
    const res = await chrome.storage.session.get(STORAGE_KEYS.treeMeta)
    return (res[STORAGE_KEYS.treeMeta] as TabTreeMap) ?? {}
  } catch {
    return {}
  }
}

export async function saveTreeMeta(meta: TabTreeMap): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.treeMeta]: toPlain(meta) })
  } catch {
    // Ignore if session storage is temporarily unavailable
  }
}

/**
 * Fallback tabId -> savedPanelId map used on browsers like Vivaldi where
 * Chrome's native `chrome.tabGroups` API is unavailable or unsupported.
 */
export async function loadVirtualGroupMap(): Promise<Record<number, string>> {
  try {
    const res = await chrome.storage.session.get(STORAGE_KEYS.virtualGroups)
    return (res[STORAGE_KEYS.virtualGroups] as Record<number, string>) ?? {}
  } catch {
    return {}
  }
}

export async function saveVirtualGroupMap(map: Record<number, string>): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEYS.virtualGroups]: toPlain(map) })
  } catch {
    // Ignore if session storage is temporarily unavailable
  }
}

/**
 * Batched initial state read (2 storage IPCs instead of 4).
 */
export async function loadInitialSidepanelState(): Promise<{
  settings: Settings
  savedPanels: SavedPanel[]
  treeMeta: TabTreeMap
  virtualGroups: Record<number, string>
}> {
  const [localRes, sessionRes] = await Promise.all([
    chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.savedPanels]),
    chrome.storage.session
      .get([STORAGE_KEYS.treeMeta, STORAGE_KEYS.virtualGroups])
      .catch(() => ({}) as Record<string, unknown>),
  ])
  return {
    settings: normalizeSettings(localRes[STORAGE_KEYS.settings]),
    savedPanels: toArray<SavedPanel>(localRes[STORAGE_KEYS.savedPanels]),
    treeMeta: (sessionRes[STORAGE_KEYS.treeMeta] as TabTreeMap) ?? {},
    virtualGroups: (sessionRes[STORAGE_KEYS.virtualGroups] as Record<number, string>) ?? {},
  }
}

let cachedFaviconBase: string | null = null

/**
 * Chrome native /_favicon/ endpoint (MV3 `favicon` permission).
 * Zero storage bloat, instant, always fresh.
 */
export function getChromeFaviconUrl(pageUrl?: string, size = 32): string {
  if (!pageUrl || pageUrl.startsWith('chrome://') || pageUrl.startsWith('chrome-extension://')) {
    return ''
  }
  try {
    if (cachedFaviconBase === null) {
      cachedFaviconBase = chrome.runtime.getURL('/_favicon/')
    }
    return `${cachedFaviconBase}?pageUrl=${encodeURIComponent(pageUrl)}&size=${size}`
  } catch {
    return ''
  }
}

export function downloadTextFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function uid(prefix = 'vb'): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}
