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

export async function loadSettings(): Promise<Settings> {
  const res = await chrome.storage.local.get(STORAGE_KEYS.settings)
  return { ...DEFAULT_SETTINGS, ...(res[STORAGE_KEYS.settings] ?? {}) }
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
    settings: { ...DEFAULT_SETTINGS, ...(localRes[STORAGE_KEYS.settings] ?? {}) },
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
